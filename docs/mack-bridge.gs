/**
 * Mack Warranty sheet: lives INSIDE the Mack Google Sheet.
 *
 * What it does
 *   - Sold tab: every Mack warranty sold or returned, one row per warranty,
 *     added hourly by the follow-up app on Railway.
 *   - Registrations tab: Mack's own upload columns (A to AB, exactly like
 *     Melinda's file) plus our tracking columns to the right. Rows are
 *     added by the Chrome extension's Mack panel.
 *   - Codes tab: Lightspeed warranty item -> Mack WarrType code (Melinda
 *     fills these in by hand; new items appear automatically).
 *   - Staff tab: who gets reminder emails.
 *   - Mack menu: make the file for Mack, refresh, reminders on/off.
 *
 * Install (same steps as the other bridges)
 *   1. Extensions > Apps Script > delete any code > paste this file.
 *   2. Fill in SECRET, STAFF_KEY and APP_URL below. Press Ctrl+S (Cmd+S).
 *   3. Deploy > New deployment > Web app > Execute as: Me > Who has
 *      access: Anyone > Deploy. Approve the permissions.
 *   4. Railway env vars: MACK_WEBAPP_URL = the /exec URL, MACK_SECRET = SECRET.
 *   5. Extension settings: Mack address = the /exec URL, Mack key = STAFF_KEY.
 *   After ANY later edit: Ctrl+S first, then Deploy > Manage deployments >
 *   pencil > Version: New version > Deploy. Saving alone does not change
 *   what the web app runs.
 */

const SECRET    = 'PASTE_SECRET_HERE';      // shared with Railway (MACK_SECRET)
const STAFF_KEY = 'PASTE_STAFF_KEY_HERE';   // shared with the Chrome extension
const APP_URL   = 'https://followup-sheets-production.up.railway.app';
const VERSION   = 1;

const REG_TAB = 'Registrations';
const SOLD_TAB = 'Sold';
const CODES_TAB = 'Codes';
const STAFF_TAB = 'Staff';
const SETTINGS_TAB = 'Settings';
const FILE_TAB_NAME = 'API  use dates or po#';   // Mack's template tab name (two spaces)

// Mack's upload columns, A to AB, in Melinda's exact order.
const MACK_HEADERS = ['TranKey', 'First', 'Last', 'Company', 'Address', 'Address2', 'City',
  'State', 'Zip', 'Phone', 'Email', 'WarrType', 'EquipmentPurchaseDate',
  'ServiceContractPurchaseDate', 'EquipmentContractPurchasePrice', 'EquipmentValue',
  'Condition', 'DealerInvoice#', 'EQMake', 'EQModel', 'EQSerial', 'EQ2Make', 'EQ2Model',
  'EQ2Serial', 'EQ3Make', 'EQ3Model', 'EQ3Serial', 'OriginalInvoiceNumber'];
const M = {};   // column index (0-based) by Mack header
MACK_HEADERS.forEach(function (h, i) { M[h] = i; });

// Ours, starting at AC. Never sent to Mack.
const TRACK_HEADERS = ['Status', 'Store', 'Salesperson', 'Warranty Sale', 'Warranty Item',
  'Unit Key', 'Customer ID', 'Saved From', 'Saved At', 'Sent to Mack',
  'Cancelled with Mack', 'Notes', 'Registration ID'];
const T = {};
TRACK_HEADERS.forEach(function (h, i) { T[h] = MACK_HEADERS.length + i; });
const REG_WIDTH = MACK_HEADERS.length + TRACK_HEADERS.length;

const SOLD_HEADERS = ['Status', 'Days Waiting', 'Date', 'Store', 'Sale', 'Warranty Item',
  'Price', 'Qty', 'Customer', 'Salesperson', 'Registration', 'Handled Outside', 'Notes',
  'Customer ID', 'Line ID', 'Reverses Line', 'Unit Key'];
const S = {};
SOLD_HEADERS.forEach(function (h, i) { S[h] = i; });

const SETTINGS_ROWS = [
  ['Manager email (daily summary)', ''],
  ['Send reminders at this hour (0 to 23)', 17],
  ['Tell the manager when a warranty has waited this many days', 3],
  ['Urgent after this many days (Mack allows 30)', 25],
  ['Words that block an item (Mack does not cover it)', 'adapter, FTZ, drone, Mavic, Avata, cell phone, iPhone'],
  ['Words that mark a kit (camera + lens, two serials)', 'kit, w/'],
  ['Most items one warranty can cover', 3],
  ['Most days between the gear and the warranty', 30],
  ['Folder for the files sent to Mack', 'Mack files'],
];

const STATUS_COLORS = {
  'Waiting': '#fff2cc', 'Registered': '#d9ead3', 'Ready to send': '#d9ead3',
  'Sent': '#b6d7a8', 'Returned': '#efefef', "Returned, don't send": '#efefef',
  'Cancel with Mack': '#f4cccc', 'Cancelled': '#efefef', 'Handled outside': '#efefef',
  'Needs WarrType code': '#fce5cd', 'Return: check': '#fce5cd',
};

// ── Web app entry points ───────────────────────────────────────────────────

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.secret === SECRET) return json_({ ok: true, v: VERSION });
    if (p.key !== STAFF_KEY) return json_({ error: 'bad key' });
    ensureSetup_();
    if (p.action === 'ping') return json_({ ok: true, v: VERSION });
    if (p.action === 'pending') return json_(pending_(p.store || ''));
    if (p.action === 'sale') return json_(saleForPanel_(p.n));
    if (p.action === 'gear') return json_(gearForPanel_(p.n));
    return json_({ error: 'unknown action' });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) {}
  try {
    if (body.secret === SECRET && body.action === 'sold') {
      ensureSetup_();
      return json_(withLock_(function () { return addSold_(body.units || []); }));
    }
    if (body.key === STAFF_KEY && body.action === 'register') {
      ensureSetup_();
      return json_(withLock_(function () { return register_(body.registration || {}); }));
    }
    if (body.secret) return json_({ error: body.secret === SECRET ? 'bad request' : 'bad secret' });
    return json_({ error: body.key === STAFF_KEY ? 'bad request' : 'bad key' });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

// Statuses follow hand edits to the columns they depend on.
function onEdit(e) {
  if (!e || !e.range) return;
  const name = e.range.getSheet().getName(), col = e.range.getColumn(), last = e.range.getLastColumn();
  function touches(c) { return c >= col && c <= last; }
  const relevant =
    (name === SOLD_TAB && touches(S['Handled Outside'] + 1)) ||
    (name === REG_TAB && (touches(T['Sent to Mack'] + 1) || touches(T['Cancelled with Mack'] + 1) ||
                          touches(M['WarrType'] + 1) || touches(T['Unit Key'] + 1))) ||
    (name === CODES_TAB && touches(2));
  if (relevant) refreshStatuses();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Mack')
    .addItem('Make the file for Mack', 'makeMackFile')
    .addItem('Refresh statuses', 'refreshStatuses')
    .addSeparator()
    .addItem('Send reminders now', 'sendReminders')
    .addItem('Turn on daily reminders', 'turnOnReminders')
    .addItem('Turn off daily reminders', 'turnOffReminders')
    .addToUi();
}

// ── Sold units (from Railway) ──────────────────────────────────────────────

function addSold_(units) {
  const sh = sheet_(SOLD_TAB);
  const have = {};
  readRows_(sh, SOLD_HEADERS.length).forEach(function (r) { have[String(r[S['Unit Key']])] = true; });
  const rows = [];
  units.forEach(function (u) {
    const key = String(u.key || '');
    if (!/^R?\d+-\d+$/.test(key) || have[key]) return;
    have[key] = true;
    const row = new Array(SOLD_HEADERS.length).fill('');
    row[S['Date']] = parseMackDate_(u.date) || u.date || '';
    row[S['Store']] = u.store || '';
    row[S['Sale']] = String(u.sale_id || '');
    row[S['Warranty Item']] = u.item || '';
    row[S['Price']] = Number(u.price) || 0;
    row[S['Qty']] = Number(u.qty) || 0;
    row[S['Customer']] = u.customer || '';
    row[S['Salesperson']] = u.salesperson || '';
    row[S['Customer ID']] = String(u.customer_id || '');
    row[S['Line ID']] = String(u.line_id || '');
    row[S['Reverses Line']] = String(u.reverses || '');
    row[S['Unit Key']] = key;
    rows.push(row);
  });
  if (rows.length) {
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, SOLD_HEADERS.length).setValues(rows);
    // Live day count: the formula keeps counting between refreshes.
    sh.getRange(start, S['Days Waiting'] + 1, rows.length, 1)
      .setFormulaR1C1('=IF(RC[-1]="Waiting",INT(TODAY()-RC[1]),"")');
    sh.getRange(start, S['Date'] + 1, rows.length, 1).setNumberFormat('mm-dd-yyyy');
    sh.getRange(start, S['Price'] + 1, rows.length, 1).setNumberFormat('"$"0.00');
    addNewCodesAndStaff_(units);
    refreshStatuses_();
  }
  return { ok: true, added: rows.length };
}

// ── Registration (from the extension) ──────────────────────────────────────

function register_(reg) {
  const problems = registrationProblems_(reg);
  if (problems.length) return { ok: false, error: problems.join(' ') };

  const soldRow = readRows_(sheet_(SOLD_TAB), SOLD_HEADERS.length).filter(function (r) {
    return String(r[S['Unit Key']]) === reg.key;
  })[0];
  if (soldRow && /^(Returned|Cancel|Handled)/.test(String(soldRow[S['Status']]))) {
    return { ok: false, error: 'This warranty shows as "' + soldRow[S['Status']] +
      '" on the Sold tab, so it should not be registered.' };
  }
  const regSh = sheet_(REG_TAB);
  const regs = readRows_(regSh, REG_WIDTH);
  for (let i = 0; i < regs.length; i++) {
    if (String(regs[i][T['Unit Key']]) === reg.key) {
      return { ok: false, error: 'This warranty was already registered on ' +
        fmtDate_(regs[i][T['Saved At']]) + '. To change it, ask Melinda to edit row ' + (i + 2) +
        ' of the Registrations tab before it is sent.' };
    }
  }
  const codes = readCodes_();
  const id = Utilities.getUuid().slice(0, 8);
  const row = registrationRow_(reg, codes, id, new Date());
  const start = regSh.getLastRow() + 1;
  regSh.getRange(start, 1, 1, REG_WIDTH).setValues([row]);
  regSh.getRange(start, 1, 1, REG_WIDTH).setNumberFormats([registrationFormats_()]);
  addNewCodesAndStaff_([{ item: reg.warranty_item, salesperson: reg.salesperson }]);
  refreshStatuses_();
  return { ok: true, id: id, row: start };
}

function registrationProblems_(reg) {
  const out = [];
  if (!/^\d+-\d+$/.test(String(reg.key || ''))) out.push('Pick which warranty this is.');
  const c = reg.customer || {};
  ['first', 'last', 'address1', 'city', 'state', 'zip', 'phone', 'email'].forEach(function (f) {
    if (!String(c[f] || '').trim()) out.push('Customer ' + f.replace('address1', 'address') + ' is missing.');
  });
  const slots = (reg.slots || []).filter(function (s) { return s && (s.make || s.model || s.serial); });
  if (!slots.length) out.push('Choose at least one covered item.');
  if (slots.length > 3) out.push('Mack files hold at most 3 items per warranty.');
  slots.forEach(function (s, i) {
    if (!s.make || !s.model) out.push('Item ' + (i + 1) + ' needs a brand and model.');
    if (!s.serial) out.push('Item ' + (i + 1) + ' needs a serial number (or N/A).');
  });
  if (!reg.gear_sale) out.push('The gear receipt number is missing.');
  if (!reg.gear_date || !reg.warranty_date) out.push('A purchase date is missing.');
  if (!(Number(reg.value) > 0)) out.push('The equipment value is missing.');
  return out;
}

function registrationRow_(reg, codes, id, now) {
  const row = new Array(REG_WIDTH).fill('');
  const c = reg.customer || {};
  row[M['First']] = c.first || '';
  row[M['Last']] = c.last || '';
  row[M['Company']] = c.company || '';
  row[M['Address']] = c.address1 || '';
  row[M['Address2']] = c.address2 || '';
  row[M['City']] = c.city || '';
  row[M['State']] = c.state || '';
  row[M['Zip']] = String(c.zip || '');
  row[M['Phone']] = String(c.phone || '');
  row[M['Email']] = c.email || '';
  row[M['WarrType']] = (codes[normItem_(reg.warranty_item)] || {}).code || '';
  row[M['EquipmentPurchaseDate']] = reg.gear_date || '';
  row[M['ServiceContractPurchaseDate']] = reg.warranty_date || '';
  row[M['EquipmentContractPurchasePrice']] = Number(reg.warranty_price) || 0;
  row[M['EquipmentValue']] = Math.round(Number(reg.value) * 100) / 100;
  row[M['Condition']] = reg.condition || 'New';
  row[M['DealerInvoice#']] = String(reg.gear_sale || '');
  (reg.slots || []).slice(0, 3).forEach(function (s, i) {
    const p = i === 0 ? 'EQ' : 'EQ' + (i + 1);
    row[M[p + 'Make']] = s.make || '';
    row[M[p + 'Model']] = s.model || '';
    row[M[p + 'Serial']] = String(s.serial || '');
  });
  row[T['Store']] = reg.store || '';
  row[T['Salesperson']] = reg.salesperson || '';
  row[T['Warranty Sale']] = String(reg.warranty_sale || '');
  row[T['Warranty Item']] = reg.warranty_item || '';
  row[T['Unit Key']] = reg.key;
  row[T['Customer ID']] = String(c.id || '');
  row[T['Saved From']] = reg.saved_from || '';
  row[T['Saved At']] = now;
  row[T['Notes']] = (reg.notes || []).join(' ');
  row[T['Registration ID']] = id;
  return row;
}

function registrationFormats_() {
  const f = new Array(REG_WIDTH).fill('@');
  f[M['EquipmentContractPurchasePrice']] = '"$"0.00';
  f[M['EquipmentValue']] = '"$"0.00';
  f[T['Saved At']] = 'mm-dd-yyyy h:mm am/pm';
  return f;
}

// ── Statuses ───────────────────────────────────────────────────────────────

function refreshStatuses() { withLock_(refreshStatuses_); }

function refreshStatuses_() {
  const soldSh = sheet_(SOLD_TAB), regSh = sheet_(REG_TAB);
  const sold = readRows_(soldSh, SOLD_HEADERS.length);
  const regs = readRows_(regSh, REG_WIDTH);
  const result = computeStatuses_(sold, regs, readCodes_());
  if (sold.length) {
    soldSh.getRange(2, S['Status'] + 1, sold.length, 1)
      .setValues(result.sold.map(function (r) { return [r.status]; }));
    soldSh.getRange(2, S['Registration'] + 1, sold.length, 1)
      .setValues(result.sold.map(function (r) { return [r.registration]; }));
  }
  if (regs.length) {
    regSh.getRange(2, T['Status'] + 1, regs.length, 1)
      .setValues(result.regs.map(function (s) { return [s]; }));
  }
  return result;
}

/**
 * Pure: the status of every Sold row and Registration row.
 *   Sold (a warranty sold):  Waiting / Registered / Sent / Returned /
 *                            Cancel with Mack / Cancelled / Handled outside
 *   Sold (a return):         'Return of <sale>' / 'Return: check'
 *   Registration:            Ready to send / Needs WarrType code / Sent /
 *                            Returned, don't send / Cancel with Mack / Cancelled
 * A return cancels the unit whose line it reverses (Lightspeed's
 * parentSaleLineID); without that link it falls back to the same customer
 * and the same warranty item. Among candidates it prefers a unit not yet
 * sent, then one not yet registered, so a return never cancels a
 * registration when an unregistered twin exists.
 */
function computeStatuses_(sold, regs, codes) {
  const regByKey = {};
  regs.forEach(function (r, i) {
    const key = String(r[T['Unit Key']] || '');
    if (key && !(key in regByKey)) regByKey[key] = i;
  });
  const units = [], returns = [];
  sold.forEach(function (r, i) {
    (Number(r[S['Qty']]) < 0 ? returns : units).push(i);
  });
  const reversedBy = {};   // unit row index -> return row index
  const returnOf = {};     // return row index -> unit row index
  function regOf(i) {
    const ri = regByKey[String(sold[i][S['Unit Key']])];
    return ri === undefined ? null : regs[ri];
  }
  function rank(i) {
    const reg = regOf(i);
    return (reg && reg[T['Sent to Mack']] ? 2 : 0) + (reg ? 1 : 0);
  }
  function pick(cands) {
    cands = cands.filter(function (i) { return !(i in reversedBy); });
    cands.sort(function (a, b) { return rank(a) - rank(b) || a - b; });
    return cands.length ? cands[0] : -1;
  }
  returns.forEach(function (ri) {
    const r = sold[ri];
    let u = -1;
    const parent = String(r[S['Reverses Line']] || '');
    if (parent) {
      u = pick(units.filter(function (i) { return String(sold[i][S['Line ID']]) === parent; }));
    }
    if (u < 0 && r[S['Customer ID']]) {
      u = pick(units.filter(function (i) {
        return String(sold[i][S['Customer ID']]) === String(r[S['Customer ID']]) &&
          normItem_(sold[i][S['Warranty Item']]) === normItem_(r[S['Warranty Item']]);
      }));
    }
    if (u >= 0) { reversedBy[u] = ri; returnOf[ri] = u; }
  });

  const soldOut = sold.map(function (r, i) {
    if (Number(r[S['Qty']]) < 0) {
      return { status: i in returnOf ? 'Return of ' + sold[returnOf[i]][S['Sale']] : 'Return: check',
               registration: '' };
    }
    const reg = regOf(i);
    const regId = reg ? String(reg[T['Registration ID']] || '') : '';
    let status;
    if (i in reversedBy) {
      if (reg && reg[T['Sent to Mack']]) status = reg[T['Cancelled with Mack']] ? 'Cancelled' : 'Cancel with Mack';
      else status = 'Returned';
    } else if (String(r[S['Handled Outside']] || '').trim()) status = 'Handled outside';
    else if (reg) status = reg[T['Sent to Mack']] ? 'Sent' : 'Registered';
    else status = 'Waiting';
    return { status: status, registration: regId };
  });

  const returnedKeys = {};
  Object.keys(reversedBy).forEach(function (i) { returnedKeys[String(sold[i][S['Unit Key']])] = true; });
  const regsOut = regs.map(function (r) {
    const sent = !!r[T['Sent to Mack']];
    if (returnedKeys[String(r[T['Unit Key']])]) {
      if (!sent) return "Returned, don't send";
      return r[T['Cancelled with Mack']] ? 'Cancelled' : 'Cancel with Mack';
    }
    if (sent) return 'Sent';
    const code = String(r[M['WarrType']] || '') || (codes[normItem_(r[T['Warranty Item']])] || {}).code;
    return code ? 'Ready to send' : 'Needs WarrType code';
  });
  return { sold: soldOut, regs: regsOut };
}

// ── For the extension ──────────────────────────────────────────────────────

function pending_(store) {
  const sold = readRows_(sheet_(SOLD_TAB), SOLD_HEADERS.length);
  const today = startOfDay_(new Date());
  const want = String(store || '').toLowerCase();
  const waiting = [];
  sold.forEach(function (r) {
    if (r[S['Status']] !== 'Waiting') return;
    if (want && String(r[S['Store']]).toLowerCase().indexOf(want) < 0) return;
    const d = r[S['Date']] instanceof Date ? r[S['Date']] : null;
    waiting.push({
      key: String(r[S['Unit Key']]), sale: String(r[S['Sale']]), date: d ? fmtDate_(d) : String(r[S['Date']]),
      days: d ? Math.max(0, Math.round((today - startOfDay_(d)) / 86400000)) : null,
      store: r[S['Store']], item: r[S['Warranty Item']], customer: shortName_(r[S['Customer']]),
      salesperson: r[S['Salesperson']],
    });
  });
  waiting.sort(function (a, b) { return (b.days || 0) - (a.days || 0); });
  return { ok: true, v: VERSION, waiting: waiting, count: waiting.length };
}

function saleForPanel_(n) {
  const bundle = fetchSale_(n);
  if (bundle.error) return { ok: false, error: bundle.error };
  const sold = readRows_(sheet_(SOLD_TAB), SOLD_HEADERS.length);
  const regs = readRows_(sheet_(REG_TAB), REG_WIDTH);
  const codes = readCodes_();
  const soldByKey = {}, regByKey = {};
  sold.forEach(function (r) { soldByKey[String(r[S['Unit Key']])] = r; });
  regs.forEach(function (r) { regByKey[String(r[T['Unit Key']])] = r; });

  const units = [];
  bundle.lines.forEach(function (l) {
    if (!l.is_mack || l.qty <= 0) return;
    for (let k = 1; k <= l.qty; k++) {
      const key = l.line_id + '-' + k;
      const reg = regByKey[key], s = soldByKey[key];
      units.push({
        key: key, item: l.name, price: l.price, plan: l.plan, salesperson: l.salesperson,
        code: (codes[normItem_(l.name)] || {}).code || '',
        status: s ? s[S['Status']] : (reg ? 'Registered' : 'Waiting'),
        registered: reg ? { on: fmtDate_(reg[T['Saved At']]), id: reg[T['Registration ID']],
                            sent: reg[T['Sent to Mack']] ? fmtDate_(reg[T['Sent to Mack']]) : '' } : null,
      });
    }
  });

  // Earlier registrations for this customer: offered as "same gear as
  // before" when a returned warranty is being replaced.
  const cid = bundle.customer && bundle.customer.id;
  const previous = [];
  if (cid) {
    regs.forEach(function (r) {
      if (String(r[T['Customer ID']]) !== String(cid)) return;
      previous.push({
        id: r[T['Registration ID']], status: r[T['Status']], item: r[T['Warranty Item']],
        warranty_sale: String(r[T['Warranty Sale']]), gear_sale: String(r[M['DealerInvoice#']]),
        gear_date: String(r[M['EquipmentPurchaseDate']]), value: r[M['EquipmentValue']],
        slots: [0, 1, 2].map(function (i) {
          const p = i === 0 ? 'EQ' : 'EQ' + (i + 1);
          return { make: r[M[p + 'Make']], model: r[M[p + 'Model']], serial: String(r[M[p + 'Serial']]) };
        }).filter(function (s) { return s.make || s.model || s.serial; }),
      });
    });
  }
  return { ok: true, v: VERSION, sale: bundle, units: units, previous: previous, rules: rules_() };
}

function gearForPanel_(n) {
  const bundle = fetchSale_(n);
  if (bundle.error) return { ok: false, error: bundle.error };
  return { ok: true, v: VERSION, sale: bundle };
}

function fetchSale_(n) {
  n = String(n || '').replace(/^#/, '').trim();
  if (!/^\d{1,14}$/.test(n)) return { error: 'Enter the receipt number (digits only).' };
  const res = UrlFetchApp.fetch(APP_URL.replace(/\/$/, '') + '/mack/sale/' + n, {
    headers: { 'X-Mack-Secret': SECRET }, muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {
    return { error: 'The follow-up app did not answer (HTTP ' + res.getResponseCode() + ').' };
  }
  if (data.error === 'bad secret') return { error: 'SECRET here does not match MACK_SECRET on Railway.' };
  return data;
}

function rules_() {
  const s = readSettings_();
  return {
    block_words: splitList_(s[4]), kit_words: splitList_(s[5]),
    max_items: Number(s[6]) || 3, max_days: Number(s[7]) || 30,
  };
}

// ── The weekly file for Mack ───────────────────────────────────────────────

function makeMackFile() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const statuses = withLock_(refreshStatuses_);
  const regSh = sheet_(REG_TAB);
  const regs = readRows_(regSh, REG_WIDTH);
  const codes = readCodes_();
  const ready = [], needCode = [], cancel = [];
  regs.forEach(function (r, i) {
    const st = statuses.regs[i];
    if (st === 'Ready to send') ready.push(i);
    else if (st === 'Needs WarrType code') needCode.push(i);
    else if (st === 'Cancel with Mack') cancel.push(i);
  });
  if (!ready.length) {
    ui.alert('Nothing new to send.' + listNote_(needCode, regs, 'still need a WarrType code on the Codes tab') +
      listNote_(cancel, regs, 'were returned after being sent: tell Mack to cancel them'));
    return;
  }
  if (needCode.length) {
    const go = ui.alert('Some warranties are missing a WarrType code',
      needCode.length + ' registration(s) are left out until their code is filled in on the Codes tab:\n' +
      needCode.map(function (i) { return '  ' + regs[i][T['Warranty Item']]; }).join('\n') +
      '\n\nMake the file with the other ' + ready.length + '?', ui.ButtonSet.OK_CANCEL);
    if (go !== ui.Button.OK) return;
  }

  const today = fmtDate_(new Date());
  const file = SpreadsheetApp.create('Mack ' + today);
  const out = file.getSheets()[0].setName(FILE_TAB_NAME);
  const rows = ready.map(function (i) {
    const r = regs[i].slice(0, MACK_HEADERS.length);
    if (!r[M['WarrType']]) r[M['WarrType']] = (codes[normItem_(regs[i][T['Warranty Item']])] || {}).code || '';
    return r;
  });
  out.getRange(1, 1, 1, MACK_HEADERS.length).setValues([MACK_HEADERS]).setFontWeight('bold');
  const fmt = new Array(MACK_HEADERS.length).fill('@');
  fmt[M['EquipmentContractPurchasePrice']] = '"$"0.00';
  fmt[M['EquipmentValue']] = '"$"0.00';
  out.getRange(2, 1, rows.length, MACK_HEADERS.length)
    .setNumberFormats(rows.map(function () { return fmt; })).setValues(rows);
  out.autoResizeColumns(1, MACK_HEADERS.length);
  moveToFolder_(file.getId(), String(readSettings_()[8] || 'Mack files'));

  withLock_(function () {
    ready.forEach(function (i, k) {
      regSh.getRange(i + 2, T['Sent to Mack'] + 1).setNumberFormat('@').setValue(today);
      regSh.getRange(i + 2, M['WarrType'] + 1).setValue(rows[k][M['WarrType']]);
    });
    refreshStatuses_();
  });

  const url = 'https://docs.google.com/spreadsheets/d/' + file.getId();
  const html = '<div style="font:14px Arial,sans-serif;line-height:1.5">' +
    '<p><b>' + rows.length + ' warranties</b> are in the file and marked as sent today.</p>' +
    '<p><a href="' + url + '/export?format=xlsx" target="_blank">Download the .xlsx for Mack</a><br>' +
    '<a href="' + url + '" target="_blank">Open it in Google Sheets</a></p>' +
    (cancel.length ? '<p style="color:#a61c00"><b>Also tell Mack to cancel these (returned after they were sent):</b><br>' +
      cancel.map(function (i) { return esc_(describeReg_(regs[i])); }).join('<br>') +
      '<br>Then type the date in the "Cancelled with Mack" column.</p>' : '') +
    (needCode.length ? '<p>Left out until they have a WarrType code: ' + needCode.length + '</p>' : '') +
    '</div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(460).setHeight(260), 'File for Mack');
}

function listNote_(idx, regs, what) {
  if (!idx.length) return '';
  return '\n\n' + idx.length + ' ' + what + ':\n' +
    idx.map(function (i) { return '  ' + describeReg_(regs[i]); }).join('\n');
}

function describeReg_(r) {
  return r[M['First']] + ' ' + r[M['Last']] + ', receipt ' + r[M['DealerInvoice#']] + ', ' +
    r[M['EQMake']] + ' ' + r[M['EQModel']] + ' (' + r[T['Warranty Item']] + ')';
}

function moveToFolder_(fileId, folderName) {
  const file = DriveApp.getFileById(fileId);
  const parents = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents();
  const home = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const found = home.getFoldersByName(folderName);
  file.moveTo(found.hasNext() ? found.next() : home.createFolder(folderName));
}

// ── Reminders ──────────────────────────────────────────────────────────────

function sendReminders() {
  const st = withLock_(refreshStatuses_);
  const sold = readRows_(sheet_(SOLD_TAB), SOLD_HEADERS.length);
  const regs = readRows_(sheet_(REG_TAB), REG_WIDTH);
  const settings = readSettings_();
  const managerAfter = Number(settings[2]) || 3, urgentAfter = Number(settings[3]) || 25;
  const today = startOfDay_(new Date());
  const staff = readStaff_();

  const bySeller = {}, late = [], urgent = [], check = [];
  sold.forEach(function (r, i) {
    const status = st.sold[i].status;
    if (status === 'Return: check') check.push(r);
    if (status !== 'Waiting') return;
    const d = r[S['Date']] instanceof Date ? r[S['Date']] : null;
    const days = d ? Math.round((today - startOfDay_(d)) / 86400000) : 0;
    const line = 'Sale ' + r[S['Sale']] + ' on ' + (d ? fmtDate_(d) : r[S['Date']]) + ': ' +
      r[S['Warranty Item']] + ' for ' + (shortName_(r[S['Customer']]) || 'a walk-in customer') +
      ' (' + r[S['Store']] + ', ' + days + (days === 1 ? ' day' : ' days') + ')';
    const seller = String(r[S['Salesperson']] || '');
    (bySeller[seller] = bySeller[seller] || []).push(line);
    if (days >= urgentAfter) urgent.push(line + ', sold by ' + (seller || 'unknown'));
    else if (days >= managerAfter) late.push(line + ', sold by ' + (seller || 'unknown'));
  });

  let sent = 0;
  Object.keys(bySeller).forEach(function (name) {
    const who = staff[name.toLowerCase()];
    if (!who || !who.email || !who.on) return;
    const items = bySeller[name];
    MailApp.sendEmail(who.email,
      items.length === 1 ? 'A Mack warranty is waiting to be registered' :
        items.length + ' Mack warranties are waiting to be registered',
      'Hi ' + name.split(' ')[0] + ',\n\n' +
      'These Mack warranties you sold still need to be registered:\n\n' +
      items.map(function (l) { return '  * ' + l; }).join('\n') + '\n\n' +
      'To register one, click Mack in the Lightspeed sidebar and pick it from the waiting list. ' +
      'It takes about a minute. Mack only accepts registrations within 30 days of the sale.\n\nThank you!');
    sent++;
  });

  const cancel = [], needCode = [];
  regs.forEach(function (r, i) {
    if (st.regs[i] === 'Cancel with Mack') cancel.push(describeReg_(r));
    if (st.regs[i] === 'Needs WarrType code') needCode.push(String(r[T['Warranty Item']]));
  });
  const manager = String(settings[0] || '').trim();
  if (manager && (late.length || urgent.length || cancel.length || needCode.length || check.length)) {
    const parts = [];
    if (urgent.length) parts.push('URGENT, close to Mack\'s 30-day limit:\n' + bullets_(urgent));
    if (late.length) parts.push('Waiting ' + managerAfter + '+ days:\n' + bullets_(late));
    if (cancel.length) parts.push('Returned after being sent, tell Mack to cancel:\n' + bullets_(cancel));
    if (needCode.length) parts.push('Need a WarrType code on the Codes tab:\n' + bullets_(unique_(needCode)));
    if (check.length) parts.push('Returns the sheet could not match to a sale (check the Sold tab):\n' +
      bullets_(check.map(function (r) { return 'Sale ' + r[S['Sale']] + ': ' + r[S['Warranty Item']]; })));
    MailApp.sendEmail(manager, 'Mack warranties: daily check', parts.join('\n\n') + '\n\n' +
      SpreadsheetApp.getActive().getUrl());
    sent++;
  }
  return sent;
}

function turnOnReminders() {
  turnOffReminders();
  const hour = Math.min(23, Math.max(0, Number(readSettings_()[1]) || 17));
  ScriptApp.newTrigger('sendReminders').timeBased().everyDays(1).atHour(hour).create();
  SpreadsheetApp.getUi().alert('Daily reminders are on. They go out around ' + hour + ':00 each day.');
}

function turnOffReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t);
  });
}

// ── Codes, staff, settings ─────────────────────────────────────────────────

function readCodes_() {
  const out = {};
  readRows_(sheet_(CODES_TAB), 6).forEach(function (r) {
    if (r[0]) out[normItem_(r[0])] = { code: String(r[1] || '').trim() };
  });
  return out;
}

function readStaff_() {
  const out = {};
  readRows_(sheet_(STAFF_TAB), 3).forEach(function (r) {
    if (r[0]) out[String(r[0]).trim().toLowerCase()] = { email: String(r[1] || '').trim(), on: r[2] !== false };
  });
  return out;
}

function readSettings_() {
  return sheet_(SETTINGS_TAB).getRange(1, 2, SETTINGS_ROWS.length, 1).getValues()
    .map(function (r) { return r[0]; });
}

function addNewCodesAndStaff_(units) {
  const codesSh = sheet_(CODES_TAB), staffSh = sheet_(STAFF_TAB);
  const codes = readCodes_(), staff = readStaff_();
  const newCodes = [], newStaff = [];
  units.forEach(function (u) {
    const item = String(u.item || '').trim();
    if (item && !codes[normItem_(item)]) {
      const plan = parsePlan_(item);
      codes[normItem_(item)] = {};
      newCodes.push([item, '', plan.years || '', plan.coverage || '', plan.condition, '']);
    }
    const name = String(u.salesperson || '').trim();
    if (name && !staff[name.toLowerCase()]) {
      staff[name.toLowerCase()] = {};
      newStaff.push([name, '', true]);
    }
  });
  if (newCodes.length) {
    codesSh.getRange(codesSh.getLastRow() + 1, 1, newCodes.length, 6).setValues(newCodes);
  }
  if (newStaff.length) {
    const start = staffSh.getLastRow() + 1;
    staffSh.getRange(start, 1, newStaff.length, 3).setValues(newStaff);
    staffSh.getRange(start, 3, newStaff.length, 1).insertCheckboxes();
    staffSh.getRange(start, 3, newStaff.length, 1).setValue(true);
  }
}

function parsePlan_(name) {
  const years = /(\d+)\s*-?\s*(?:yr|year)/i.exec(name || '');
  const under = /under\s*\$?\s*([\d,]+)/i.exec(name || '');
  return {
    years: years ? Number(years[1]) : null,
    coverage: under ? Number(under[1].replace(/,/g, '')) : null,
    condition: /\bused\b/i.test(name || '') ? 'Used' : 'New',
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

function ensureSetup_() {
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName(REG_TAB)) {
    const sh = ss.insertSheet(REG_TAB, 0);
    sh.getRange(1, 1, 1, REG_WIDTH).setValues([MACK_HEADERS.concat(TRACK_HEADERS)]).setFontWeight('bold');
    sh.getRange(1, MACK_HEADERS.length + 1, 1, TRACK_HEADERS.length).setBackground('#d9d9d9');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, sh.getMaxRows() - 1, REG_WIDTH).setNumberFormat('@');
    statusColors_(sh, T['Status'] + 1);
  }
  if (!ss.getSheetByName(SOLD_TAB)) {
    const sh = ss.insertSheet(SOLD_TAB, 1);
    sh.getRange(1, 1, 1, SOLD_HEADERS.length).setValues([SOLD_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    statusColors_(sh, S['Status'] + 1);
    sh.getRange(1, S['Handled Outside'] + 1).setNote(
      'Type anything here (e.g. "registered by phone") when this warranty was handled some other way.');
  }
  if (!ss.getSheetByName(CODES_TAB)) {
    const sh = ss.insertSheet(CODES_TAB);
    sh.getRange(1, 1, 1, 6).setValues([['Lightspeed warranty item', 'WarrType code', 'Years',
      'Coverage up to', 'New/Used', 'Notes']]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 320);
    sh.getRange('B2:B').setNumberFormat('@');
    sh.setConditionalFormatRules([SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($A2<>"",$B2="")').setBackground('#fce5cd')
      .setRanges([sh.getRange('B2:B')]).build()]);
  }
  if (!ss.getSheetByName(STAFF_TAB)) {
    const sh = ss.insertSheet(STAFF_TAB);
    sh.getRange(1, 1, 1, 3).setValues([['Salesperson (as in Lightspeed)', 'Email', 'Send reminders']])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 240);
    sh.setColumnWidth(2, 260);
  }
  if (!ss.getSheetByName(SETTINGS_TAB)) {
    const sh = ss.insertSheet(SETTINGS_TAB);
    sh.getRange(1, 1, SETTINGS_ROWS.length, 2).setValues(SETTINGS_ROWS);
    sh.setColumnWidth(1, 440);
    sh.setColumnWidth(2, 380);
    sh.getRange(SETTINGS_ROWS.length + 2, 1).setValue('Edit column B only. The extension and the reminders read this tab every time.');
  }
}

function statusColors_(sh, col) {
  const range = sh.getRange(2, col, sh.getMaxRows() - 1, 1);
  const rules = Object.keys(STATUS_COLORS).map(function (text) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text)
      .setBackground(STATUS_COLORS[text]).setRanges([range]).build();
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('Return of')
    .setBackground('#efefef').setRanges([range]).build());
  sh.setConditionalFormatRules(rules);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }

function readRows_(sh, width) {
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, width).getValues();
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function normItem_(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }

function splitList_(s) {
  return String(s || '').split(',').map(function (w) { return w.trim(); }).filter(String);
}

function parseMackDate_(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || ''));
  return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
}

function fmtDate_(d) {
  if (!(d instanceof Date)) return String(d || '');
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MM-dd-yyyy');
}

function startOfDay_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function shortName_(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(String);
  if (!parts.length) return '';
  return parts.length > 1 ? parts[0] + ' ' + parts[parts.length - 1].charAt(0) + '.' : parts[0];
}

function bullets_(lines) { return lines.map(function (l) { return '  * ' + l; }).join('\n'); }

function unique_(list) { return list.filter(function (v, i) { return list.indexOf(v) === i; }); }

function esc_(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
