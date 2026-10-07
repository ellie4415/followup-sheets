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
 *   - Kits tab: the camera and lens names Mack should get for each kit
 *     (kits seen in the panel are added automatically, blank, to fill in).
 *   - Staff tab: who gets reminder emails.
 *   - Mack menu: make the file for Mack, load past warranties, import a
 *     Forms on Fire export, refresh, reminders on/off.
 *   - Problems column (Registrations): anything wrong with a row. A row with
 *     problems is "Needs fixing" and stays out of Mack's file until the
 *     problem is fixed and the cell is cleared.
 *
 * Install (same steps as the other bridges)
 *   1. Extensions > Apps Script > delete any code > paste this file.
 *   2. Fill in SECRET, STAFF_KEY and APP_URL below. Press Ctrl+S (Cmd+S).
 *   3. Deploy > New deployment > Web app > Execute as: Me > Who has
 *      access: Anyone > Deploy. Approve the permissions.
 *   4. Railway env vars: MACK_WEBAPP_URL = the /exec URL, MACK_SECRET = SECRET.
 *   5. Extension settings: Mack address = the /exec URL, Mack key = STAFF_KEY.
 *   Updating to a new version of this file: copy your SECRET, STAFF_KEY and
 *   APP_URL lines first, paste the new file, put the three lines back.
 *   After ANY later edit: Ctrl+S first, then Deploy > Manage deployments >
 *   pencil > Version: New version > Deploy. Saving alone does not change
 *   what the web app runs.
 */

const SECRET    = 'PASTE_SECRET_HERE';      // shared with Railway (MACK_SECRET)
const STAFF_KEY = 'PASTE_STAFF_KEY_HERE';   // shared with the Chrome extension
const APP_URL   = 'https://followup-sheets-production.up.railway.app';
const VERSION   = 3;

const REG_TAB = 'Registrations';
const SOLD_TAB = 'Sold';
const CODES_TAB = 'Codes';
const STAFF_TAB = 'Staff';
const KITS_TAB = 'Kits';
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
  'Cancelled with Mack', 'Notes', 'Registration ID', 'Problems'];
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
  'Needs WarrType code': '#fce5cd', 'Return: check': '#fce5cd', 'Needs fixing': '#f4cccc', 'Sent, needs fixing': '#f4cccc',
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
                          touches(M['WarrType'] + 1) || touches(T['Unit Key'] + 1) ||
                          touches(T['Problems'] + 1))) ||
    (name === CODES_TAB && touches(2));
  if (relevant) refreshStatuses();
}

function onOpen() {
  ensureSetup_();   // new tabs (like Kits) appear as soon as the sheet opens
  SpreadsheetApp.getUi().createMenu('Mack')
    .addItem('Make the file for Mack', 'makeMackFile')
    .addItem('Refresh statuses', 'refreshStatuses')
    .addSeparator()
    .addItem('Load past warranties from Lightspeed', 'loadPastWarranties')
    .addItem('Mark selected rows as registered before this sheet', 'markRegisteredBefore')
    .addItem('Import a Forms on Fire export', 'importFormsOnFire')
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
    if (!realSerial_(s.serial)) out.push('Item ' + (i + 1) + ' needs its serial number.');
  });
  if (!reg.gear_sale) out.push('The gear receipt number is missing.');
  if (reg.outside && !String(reg.original_invoice || '').trim()) {
    out.push('The receipt or order number from where the gear was bought is missing.');
  }
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
  // Gear bought somewhere else: DealerInvoice# is our warranty receipt and
  // the other seller's receipt/order number goes here.
  row[M['OriginalInvoiceNumber']] = String(reg.original_invoice || '');
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
    const problems = String(r[T['Problems']] || '').trim();
    if (sent) return problems ? 'Sent, needs fixing' : 'Sent';
    if (problems) return 'Needs fixing';
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
  addNewKits_(bundle.lines);
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
  addNewKits_(bundle.lines);
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
    kits: readKits_(),
  };
}

// ── The weekly file for Mack ───────────────────────────────────────────────

function makeMackFile() {
  const ui = menuUi_();
  const ss = SpreadsheetApp.getActive();
  const statuses = withLock_(refreshStatuses_);
  const regSh = sheet_(REG_TAB);
  const regs = readRows_(regSh, REG_WIDTH);
  const codes = readCodes_();
  const ready = [], needCode = [], cancel = [], fixing = [];
  regs.forEach(function (r, i) {
    const st = statuses.regs[i];
    if (st === 'Ready to send') ready.push(i);
    else if (st === 'Needs WarrType code') needCode.push(i);
    else if (st === 'Cancel with Mack') cancel.push(i);
    else if (st === 'Needs fixing') fixing.push(i);
  });
  if (!ready.length) {
    ui.alert('Nothing new to send.' + listNote_(needCode, regs, 'still need a WarrType code on the Codes tab') +
      listNote_(fixing, regs, 'need fixing first (see their Problems column)') +
      listNote_(cancel, regs, 'were returned after being sent: tell Mack to cancel them'));
    return;
  }
  if (fixing.length) {
    const go = ui.alert('Some warranties need fixing first',
      fixing.length + ' registration(s) are left out until their Problems cell is fixed and cleared:\n' +
      fixing.map(function (i) { return '  ' + describeReg_(regs[i]) + ': ' + regs[i][T['Problems']]; }).join('\n') +
      '\n\nMake the file with the other ' + ready.length + '?', ui.ButtonSet.OK_CANCEL);
    if (go !== ui.Button.OK) return;
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
    (fixing.length ? '<p>Left out until fixed (Problems column): ' + fixing.length + '</p>' : '') +
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

  const cancel = [], needCode = [], fixing = [];
  regs.forEach(function (r, i) {
    if (st.regs[i] === 'Cancel with Mack') cancel.push(describeReg_(r));
    if (st.regs[i] === 'Needs WarrType code') needCode.push(String(r[T['Warranty Item']]));
    if (st.regs[i] === 'Needs fixing') fixing.push(describeReg_(r) + ': ' + r[T['Problems']]);
  });
  const manager = String(settings[0] || '').trim();
  if (manager && (late.length || urgent.length || cancel.length || needCode.length || check.length || fixing.length)) {
    const parts = [];
    if (urgent.length) parts.push('URGENT, close to Mack\'s 30-day limit:\n' + bullets_(urgent));
    if (late.length) parts.push('Waiting ' + managerAfter + '+ days:\n' + bullets_(late));
    if (cancel.length) parts.push('Returned after being sent, tell Mack to cancel:\n' + bullets_(cancel));
    if (needCode.length) parts.push('Need a WarrType code on the Codes tab:\n' + bullets_(unique_(needCode)));
    if (fixing.length) parts.push('Need fixing before they can go to Mack (fix, then clear the Problems cell):\n' + bullets_(fixing));
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
  tell_(ui_(), 'Daily reminders are on. They go out around ' + hour + ':00 each day.');
}

function turnOffReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t);
  });
}

// ── Past warranties (moving over from the tablet) ──────────────────────────

function loadPastWarranties() {
  const ui = ui_();
  let days = 14;   // run from the script editor: no prompt, 14 days
  if (ui) {
    const answer = ui.prompt('Load past warranties from Lightspeed',
      'How many days back? (up to 45)\n\nThey land on the Sold tab as Waiting. Warranties already registered on the ' +
      'tablet: select their rows on the Sold tab, then use Mack > Mark selected rows as registered before this sheet.',
      ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK) return;
    days = Math.min(45, Math.max(1, parseInt(answer.getResponseText(), 10) || 14));
  }
  const res = UrlFetchApp.fetch(APP_URL.replace(/\/$/, '') + '/mack/rescan?days=' + days, {
    method: 'post', headers: { 'X-Mack-Secret': SECRET }, muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  tell_(ui, data.ok
    ? 'Loading the last ' + days + ' days. The warranties appear on the Sold tab in a minute or two.'
    : 'The follow-up app could not start that: ' + (data.error || 'HTTP ' + res.getResponseCode()) +
      '\n\nIf it says a run is in progress, try again in a few minutes.');
}

function markRegisteredBefore() {
  const ui = menuUi_();
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SOLD_TAB) {
    ui.alert('Go to the Sold tab and select the rows (any cell in each row) first.');
    return;
  }
  const rows = {};
  (sh.getActiveRangeList() ? sh.getActiveRangeList().getRanges() : []).forEach(function (r) {
    for (let i = r.getRow(); i <= r.getLastRow(); i++) if (i >= 2) rows[i] = true;
  });
  const list = Object.keys(rows).map(Number);
  if (!list.length) { ui.alert('Select the rows to mark first.'); return; }
  let marked = 0;
  withLock_(function () {
    list.forEach(function (i) {
      const cell = sh.getRange(i, S['Handled Outside'] + 1);
      const status = String(sh.getRange(i, S['Status'] + 1).getValue());
      if (!String(cell.getValue()).trim() && status === 'Waiting') {
        cell.setValue('Registered before this sheet');
        marked++;
      }
    });
    refreshStatuses_();
  });
  ui.alert(marked + ' row(s) marked. Rows that were not Waiting were left alone.');
}

// ── Forms on Fire import (moving over from the tablet) ─────────────────────

const FOF_SENT_LABEL = 'Sent via Forms on Fire';
const EMAIL_TYPOS = {
  'gmai.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmal.com': 'gmail.com',
  'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'iclod.com': 'icloud.com', 'icloud.co': 'icloud.com', 'comcast.com': 'comcast.net',
  'att.com': 'att.net', 'sbcglobal.com': 'sbcglobal.net', 'charter.com': 'charter.net',
};

function importFormsOnFire() {
  const ui = menuUi_();
  const answer = ui.prompt('Import a Forms on Fire export',
    'Paste the Google Drive link of the export (.csv or Google Sheet).\n\n' +
    'Or leave this blank to import from the tab that is open now.', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  let records;
  try {
    records = readFofTable_(answer.getResponseText());
  } catch (err) {
    ui.alert(String(err && err.message || err));
    return;
  }
  const sent = ui.alert('Already sent to Mack?',
    'Has Melinda already sent these ' + records.length + ' warranties to Mack from Forms on Fire?\n\n' +
    'Yes: they are marked "' + FOF_SENT_LABEL + '" and stay out of the next file.\n' +
    'No: they go into the next file. Rows that need fixing wait until they are fixed.',
    ui.ButtonSet.YES_NO_CANCEL);
  if (sent !== ui.Button.YES && sent !== ui.Button.NO) return;

  const out = withLock_(function () {
    const regSh = sheet_(REG_TAB);
    const result = fofRegistrations_(records, readRows_(sheet_(SOLD_TAB), SOLD_HEADERS.length),
      readRows_(regSh, REG_WIDTH), readCodes_(), sent === ui.Button.YES ? FOF_SENT_LABEL : '', new Date());
    if (result.rows.length) {
      const start = regSh.getLastRow() + 1;
      regSh.getRange(start, 1, result.rows.length, REG_WIDTH)
        .setNumberFormats(result.rows.map(function () { return registrationFormats_(); }))
        .setValues(result.rows);
      refreshStatuses_();
    }
    return result;
  });

  function list(title, items, color) {
    if (!items.length) return '';
    return '<p style="color:' + (color || '#222') + '"><b>' + title + ' (' + items.length + ')</b><br>' +
      items.map(esc_).join('<br>') + '</p>';
  }
  const html = '<div style="font:13px Arial,sans-serif;line-height:1.45">' +
    '<p><b>' + out.imported.length + ' imported</b> to the Registrations tab, ' + out.linked +
    ' matched to their Lightspeed sale on the Sold tab (now marked Registered).</p>' +
    list('Need fixing before they go to Mack: fix the row, then clear its Problems cell', out.flagged, '#a61c00') +
    list('Send soon, close to Mack\'s 30-day limit', out.urgent, '#a61c00') +
    list('Not matched to a sale on the Sold tab (imported anyway)', out.unlinked) +
    list('Skipped', out.skipped) + '</div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(560).setHeight(480), 'Forms on Fire import');
}

// The export as a list of {header: value}. Text stays text, so serials
// like "015057" keep their leading zero (a Drive CSV is safest for that).
function readFofTable_(input) {
  const text = String(input || '').trim();
  let values;
  if (text) {
    const id = (text.match(/[-\w]{25,}/) || [])[0];
    if (!id) throw new Error('That does not look like a Google Drive link.');
    const file = DriveApp.getFileById(id);
    values = file.getMimeType() === MimeType.GOOGLE_SHEETS
      ? SpreadsheetApp.openById(id).getSheets()[0].getDataRange().getDisplayValues()
      : Utilities.parseCsv(file.getBlob().getDataAsString('UTF-8').replace(/^﻿/, ''));
  } else {
    values = SpreadsheetApp.getActiveSheet().getDataRange().getDisplayValues();
  }
  return fofRecords_(values);
}

function fofRecords_(values) {
  const head = (values[0] || []).map(function (h) { return String(h).replace(/^﻿/, '').trim(); });
  if (head.indexOf('Row Id') < 0 || head.indexOf('DealerInvoice') < 0) {
    throw new Error('That is not a Forms on Fire Mack export (it has no "Row Id" and "DealerInvoice" columns).');
  }
  return values.slice(1).filter(function (r) { return r.join('').trim(); }).map(function (r) {
    const o = {};
    head.forEach(function (h, i) { o[h] = String(r[i] === undefined || r[i] === null ? '' : r[i]).trim(); });
    return o;
  });
}

/**
 * Pure: Forms on Fire records -> Registrations rows. Each record is matched
 * to its warranty on the Sold tab (receipt number, else the receipt number's
 * last digits, else same last name within 3 days; ties go to the same price
 * and coverage) so that sale shows as Registered. Problems are listed in the
 * row's Problems cell, which holds it out of Mack's file until cleared.
 */
function fofRegistrations_(records, sold, regs, codes, sentLabel, now) {
  const haveIds = {}, regKeys = {}, taken = {};
  regs.forEach(function (r) {
    haveIds[String(r[T['Registration ID']])] = true;
    if (r[T['Unit Key']]) regKeys[String(r[T['Unit Key']])] = true;
  });
  const out = { rows: [], imported: [], flagged: [], unlinked: [], skipped: [], urgent: [], linked: 0 };
  records.forEach(function (f) {
    const id = 'FoF-' + f['Row Id'];
    const who = (f['First'] + ' ' + f['Last']).trim() + ', receipt ' + f['DealerInvoice'];
    if (!f['Row Id']) return;
    if (haveIds[id]) { out.skipped.push(who + ': already imported'); return; }
    const match = matchFofUnit_(f, sold, regKeys, taken);
    if (match && match.duplicate) {
      out.skipped.push(who + ': this sale is already registered in the sheet');
      return;
    }
    const unit = match;
    if (unit) { taken[String(unit[S['Unit Key']])] = true; out.linked++; }
    else out.unlinked.push(who);

    const problems = fofProblems_(f, unit);
    const years = Number(f['coverageLengthOfTime']) || '';
    const cov = numVal_(f['coverageAmount']);
    const item = unit ? String(unit[S['Warranty Item']]) : '';
    const row = new Array(REG_WIDTH).fill('');
    row[M['First']] = f['First']; row[M['Last']] = f['Last']; row[M['Company']] = f['Company'];
    row[M['Address']] = f['Address']; row[M['Address2']] = f['Address2']; row[M['City']] = f['City'];
    row[M['State']] = f['State']; row[M['Zip']] = f['zip']; row[M['Phone']] = f['phone'];
    row[M['Email']] = f['email'];
    row[M['WarrType']] = (item && (codes[normItem_(item)] || {}).code) ||
      codeForPlan_(codes, years, cov, f['Condition'] || 'New');
    row[M['EquipmentPurchaseDate']] = f['EquipmentPurchaseDate'];
    row[M['ServiceContractPurchaseDate']] = f['ServiceContractPurchaseDate'];
    row[M['EquipmentContractPurchasePrice']] = isNaN(numVal_(f['EquipmentContractPurchasePrice'])) ? '' : numVal_(f['EquipmentContractPurchasePrice']);
    row[M['EquipmentValue']] = isNaN(numVal_(f['EquipmentValue'])) ? '' : numVal_(f['EquipmentValue']);
    row[M['Condition']] = f['Condition'] || 'New';
    row[M['DealerInvoice#']] = f['DealerInvoice'];
    ['', '2', '3'].forEach(function (n) {
      row[M['EQ' + n + 'Make']] = f['EQ' + n + 'Make'] || '';
      row[M['EQ' + n + 'Model']] = f['EQ' + n + 'Model'] || '';
      row[M['EQ' + n + 'Serial']] = f['EQ' + n + 'Serial'] || '';
    });
    const lat = parseFloat(String(f['Completed At'] || ''));
    row[T['Store']] = unit ? unit[S['Store']] : (lat >= 39.2 ? 'Action Camera Reno' : lat ? 'Action Camera Rocklin' : '');
    row[T['Salesperson']] = unit ? unit[S['Salesperson']] : f['salesPersonName'];
    row[T['Warranty Sale']] = unit ? String(unit[S['Sale']]) : '';
    row[T['Warranty Item']] = item;
    row[T['Unit Key']] = unit ? String(unit[S['Unit Key']]) : '';
    row[T['Customer ID']] = unit ? String(unit[S['Customer ID']]) : '';
    row[T['Saved From']] = 'Forms on Fire';
    row[T['Saved At']] = parseFofTime_(f['Completed']) || now;
    row[T['Sent to Mack']] = sentLabel || '';
    row[T['Notes']] = 'Forms on Fire #' + f['Row Id'] + ': ' + (years ? years + ' yr, ' : '') +
      (cov ? 'up to ' + money_(cov) + ', ' : '') + 'entered by ' + (f['salesPersonName'] || 'unknown') + '.';
    row[T['Registration ID']] = id;
    row[T['Problems']] = problems.join(' ');
    out.rows.push(row);
    out.imported.push(who);
    if (problems.length) out.flagged.push(who + ': ' + problems.join(' '));

    const bought = parseMackDate_(f['EquipmentPurchaseDate']) || parseMackDate_(f['ServiceContractPurchaseDate']);
    if (!sentLabel && bought) {
      const deadline = new Date(bought.getTime() + 30 * 86400000);
      const daysLeft = Math.round((startOfDay_(deadline) - startOfDay_(now)) / 86400000);
      if (daysLeft <= 7) {
        out.urgent.push(who + ': bought ' + f['EquipmentPurchaseDate'] + ', Mack\'s 30 days end ' +
          mmddyyyy_(deadline) + (daysLeft < 0 ? ' (already passed)' : ''));
      }
    }
  });
  return out;
}

function matchFofUnit_(f, sold, regKeys, taken) {
  const inv = String(f['DealerInvoice'] || '').replace(/\D/g, '');
  const units = sold.filter(function (r) { return Number(r[S['Qty']]) > 0; });
  const keyOf = function (r) { return String(r[S['Unit Key']]); };
  const free = function (list) { return list.filter(function (r) { return !regKeys[keyOf(r)] && !taken[keyOf(r)]; }); };
  const bySale = units.filter(function (r) {
    const sale = String(r[S['Sale']] || '');
    return sale.length >= 4 && inv && (sale === inv || (inv.length > sale.length && inv.slice(-sale.length) === sale));
  });
  let cands = free(bySale);
  if (!cands.length && bySale.length && bySale.every(function (r) { return regKeys[keyOf(r)]; })) {
    return { duplicate: true };
  }
  if (!cands.length) {
    const last = lettersOnly_(f['Last']);
    const when = parseMackDate_(f['ServiceContractPurchaseDate']) || parseMackDate_(f['EquipmentPurchaseDate']);
    cands = free(units.filter(function (r) {
      const words = String(r[S['Customer']] || '').trim().split(/\s+/);
      const name = lettersOnly_(words[words.length - 1]);
      const d = r[S['Date']] instanceof Date ? r[S['Date']] : parseMackDate_(String(r[S['Date']]));
      const sameName = last && name && (name === last || last.slice(-name.length) === name || name.slice(-last.length) === last);
      return sameName && when && d && Math.abs(startOfDay_(d) - startOfDay_(when)) <= 3 * 86400000;
    }));
  }
  const price = numVal_(f['EquipmentContractPurchasePrice']), cov = numVal_(f['coverageAmount']);
  const score = function (r) {
    return (Math.abs(numVal_(r[S['Price']]) - price) < 0.01 ? 2 : 0) +
      (parsePlan_(String(r[S['Warranty Item']])).coverage === cov ? 1 : 0);
  };
  cands.sort(function (a, b) { return score(b) - score(a); });
  return cands[0] || null;
}

function fofProblems_(f, unit) {
  const p = [];
  const need = [['First', 'first name'], ['Last', 'last name'], ['Address', 'address'], ['City', 'city'],
    ['State', 'state'], ['zip', 'zip'], ['phone', 'phone'], ['email', 'email'],
    ['EquipmentPurchaseDate', 'gear purchase date'], ['ServiceContractPurchaseDate', 'warranty purchase date'],
    ['EquipmentContractPurchasePrice', 'warranty price'], ['EquipmentValue', 'equipment value'],
    ['DealerInvoice', 'receipt number']];
  const missing = need.filter(function (n) { return !String(f[n[0]] || '').trim(); })
    .map(function (n) { return n[1]; });
  if (missing.length) p.push('Missing ' + missing.join(', ') + '.');

  ['', '2', '3'].forEach(function (n, i) {
    const make = String(f['EQ' + n + 'Make'] || '').trim(), model = String(f['EQ' + n + 'Model'] || '').trim();
    const serial = String(f['EQ' + n + 'Serial'] || '').trim();
    if (!make && !model && !serial) {
      if (i === 0) p.push('No covered item listed.');
      return;
    }
    if (!make || !model) p.push('Item ' + (i + 1) + ' needs a brand and model.');
    if (!realSerial_(serial)) p.push('Item ' + (i + 1) + ' has no serial number' + (serial ? ' ("' + serial + '")' : '') + '.');
  });

  const email = String(f['email'] || '').trim();
  if (email) {
    const domain = email.split('@')[1] ? email.split('@')[1].toLowerCase() : '';
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) p.push('Email "' + email + '" looks invalid.');
    else if (EMAIL_TYPOS[domain]) p.push('Email ends in ' + domain + ', probably a typo for ' + EMAIL_TYPOS[domain] + '.');
  }
  const phone = String(f['phone'] || '').replace(/\D/g, '');
  if (phone && !(phone.length === 10 || (phone.length === 11 && phone.charAt(0) === '1'))) {
    p.push('Phone "' + f['phone'] + '" does not have 10 digits.');
  }
  const zip = String(f['zip'] || '').trim();
  if (zip && !/^\d{5}(-?\d{4})?$/.test(zip)) p.push('Zip "' + zip + '" looks wrong.');

  const inv = String(f['DealerInvoice'] || '').replace(/\D/g, '');
  if (inv && (inv.length < 5 || inv.length > 7)) {
    const sale = unit ? String(unit[S['Sale']]) : '';
    p.push('Receipt number ' + f['DealerInvoice'] + ' looks wrong' +
      (sale && sale !== inv ? ', the Lightspeed sale is ' + sale : '') + '.');
  }

  const value = numVal_(f['EquipmentValue']), price = numVal_(f['EquipmentContractPurchasePrice']);
  const formCov = numVal_(f['coverageAmount']);
  const unitCov = unit ? parsePlan_(String(unit[S['Warranty Item']])).coverage : null;
  const limit = unitCov || formCov;
  if (limit && value > limit) {
    p.push('Equipment value ' + money_(value) + ' is above the ' + money_(limit) + ' plan limit' +
      (String(Math.round(value)) === inv ? ' (it matches the receipt number, probably typed in the wrong box)'
        : ' (Mack voids a plan sold below the gear\'s price)') + '.');
  }
  if (unit && !isNaN(price) && Math.abs(numVal_(unit[S['Price']]) - price) > 0.009) {
    p.push('Warranty price ' + money_(price) + ' does not match Lightspeed (' + money_(numVal_(unit[S['Price']])) + ').');
  }
  if (unit && unitCov && formCov && unitCov !== formCov) {
    p.push('Form says coverage up to ' + money_(formCov) + ' but Lightspeed sold the ' + unit[S['Warranty Item']] + '.');
  }
  const gear = parseMackDate_(f['EquipmentPurchaseDate']), warranty = parseMackDate_(f['ServiceContractPurchaseDate']);
  if (gear && warranty) {
    const days = Math.round((startOfDay_(warranty) - startOfDay_(gear)) / 86400000);
    if (days > 30) p.push('Warranty bought ' + days + ' days after the gear (Mack allows 30).');
    if (days < 0) p.push('The warranty date is before the gear date.');
  }
  return p;
}

// A WarrType code from the plan's years, coverage and condition, only when
// the Codes tab has exactly one code for that combination.
function codeForPlan_(codes, years, coverage, condition) {
  const found = {};
  Object.keys(codes).forEach(function (k) {
    const c = codes[k];
    if (c.code && c.years === Number(years) && c.coverage === Number(coverage) &&
        String(c.condition || 'New').toLowerCase() === String(condition || 'New').toLowerCase()) found[c.code] = true;
  });
  const list = Object.keys(found);
  return list.length === 1 ? list[0] : '';
}

function numVal_(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v || '').replace(/[$,\s]/g, ''));
  return isNaN(n) ? NaN : n;
}

function lettersOnly_(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

function money_(n) {
  return '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function mmddyyyy_(d) {
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' + d.getFullYear();
}

function parseFofTime_(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(s || '').trim());
  return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4] || 0), Number(m[5] || 0)) : null;
}

// ── Kits ───────────────────────────────────────────────────────────────────

function readKits_() {
  const out = {};
  readRows_(sheet_(KITS_TAB), 5).forEach(function (r) {
    const camera = String(r[1] || '').trim();
    const lenses = [r[2], r[3]].map(function (v) { return String(v || '').trim(); }).filter(String);
    if (r[0] && (camera || lenses.length)) out[normKit_(r[0])] = { camera: camera, lenses: lenses };
  });
  return out;
}

// Kit items seen in the panel get a blank row on the Kits tab to fill in.
function addNewKits_(lines) {
  const words = splitList_(readSettings_()[5]).map(function (w) { return w.toLowerCase(); });
  const sh = sheet_(KITS_TAB);
  const have = {};
  readRows_(sh, 1).forEach(function (r) { have[normKit_(r[0])] = true; });
  const add = [];
  (lines || []).forEach(function (l) {
    if (l.is_mack || l.qty <= 0 || !isKitName_(l.name, words)) return;
    const key = normKit_(l.name);
    if (have[key]) return;
    have[key] = true;
    add.push([String(l.name).replace(/\s*\++\s*$/, ''), '', '', '', '']);
  });
  if (add.length) {
    withLock_(function () { sh.getRange(sh.getLastRow() + 1, 1, add.length, 5).setValues(add); });
  }
}

function isKitName_(name, words) {
  const text = ' ' + String(name || '').toLowerCase() + ' ';
  return words.some(function (w) {
    if (/^[a-z0-9 ]+$/.test(w)) return new RegExp('[^a-z0-9]' + w.replace(/ /g, '\\s+') + '[^a-z0-9]').test(text);
    return text.indexOf(w) >= 0;
  });
}

function normKit_(s) { return normItem_(s).replace(/\s*\++$/, ''); }

function realSerial_(s) {
  const v = String(s || '').trim();
  return !!v && !/^(n\/?a|none|no serial|-+|0+)$/i.test(v);
}

// ── Codes, staff, settings ─────────────────────────────────────────────────

function readCodes_() {
  const out = {};
  readRows_(sheet_(CODES_TAB), 6).forEach(function (r) {
    if (r[0]) {
      out[normItem_(r[0])] = { code: String(r[1] || '').trim(), years: Number(r[2]) || null,
        coverage: Number(String(r[3]).replace(/[$,\s]/g, '')) || null, condition: String(r[4] || 'New') };
    }
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
  const existingReg = ss.getSheetByName(REG_TAB);
  if (existingReg && !String(existingReg.getRange(1, T['Problems'] + 1).getValue())) {
    // Sheets made before v3: add the Problems column and its status color.
    existingReg.getRange(1, T['Problems'] + 1).setValue('Problems').setFontWeight('bold').setBackground('#d9d9d9');
    existingReg.getRange(2, T['Problems'] + 1, existingReg.getMaxRows() - 1, 1).setNumberFormat('@');
    statusColors_(existingReg, T['Status'] + 1);
  }
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
  if (!ss.getSheetByName(KITS_TAB)) {
    const sh = ss.insertSheet(KITS_TAB);
    sh.getRange(1, 1, 1, 5).setValues([['Lightspeed kit item', 'Camera model for Mack', 'Lens 1 model for Mack',
      'Lens 2 model for Mack (two-lens kits)', 'Notes']]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 340);
    [2, 3, 4].forEach(function (c) { sh.setColumnWidth(c, 220); });
    sh.getRange(1, 1).setNote('Type or paste the kit name as it appears in Lightspeed (a "+" at the end does not matter). ' +
      'The panel uses these names instead of splitting the item name. Kits looked up in the panel are added here automatically.');
    sh.setConditionalFormatRules([SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($A2<>"",$B2="")').setBackground('#fce5cd')
      .setRanges([sh.getRange('B2:C')]).build()]);
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

// Pop-ups only exist when an action starts from the sheet's Mack menu; run
// from the script editor, getUi() throws.
function ui_() {
  try { return SpreadsheetApp.getUi(); } catch (err) { return null; }
}

function menuUi_() {
  const ui = ui_();
  if (!ui) throw new Error('Run this from the Mack menu in the spreadsheet, not from the script editor.');
  return ui;
}

function tell_(ui, message) {
  if (ui) ui.alert(message); else Logger.log(message);
}

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
