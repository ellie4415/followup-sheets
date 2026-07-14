/**
 * Follow-Up Sheets bridge — lives INSIDE the Google Sheet.
 *
 * Install: open the spreadsheet → Extensions → Apps Script → delete any code
 * there → paste this whole file → set SECRET below → Deploy → New deployment
 * → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy.
 * Copy the /exec URL into Railway env var SHEETS_WEBAPP_URL, and put the
 * same SECRET value in env var SHEETS_SECRET.
 *
 * The Railway app is the only caller: GET returns settings + existing sale
 * IDs (creating missing tabs on the way), POST appends rows. Nothing here
 * ever edits or deletes existing rows.
 */

const SECRET = 'PASTE_SECRET_HERE';

const HEADERS = ['Date', 'Customer', 'Phone', 'Email', 'Purchased', 'Sale Total',
                 'Salesperson', 'Emailed?', 'Notes', 'Sale ID', 'Store'];
const STORE_TABS = ['Reno', 'Rocklin'];
const SETTINGS_TAB = 'Settings';
const SETTINGS_DEFAULTS = [
  ['Dollar threshold — qualifying items (pre-tax, excluded categories don\'t count) at/over this qualifies (blank or 0 = off)', '300'],
  ['Qualifying categories — Lightspeed category names, comma-separated (items anywhere under these count)', 'Cameras, Lenses'],
  ['Skip shops — sales from these Lightspeed shops are ignored, comma-separated', 'Action Camera Online'],
  ['Excluded categories — never count toward qualifying; still listed on qualifying rows', 'Service, Lab, Lab / Developing & Printing'],
  ['', ''],
  ['The app re-reads this tab on every run. Edit values in column B only. Category names must match Lightspeed exactly — typos show as a warning on the app page.', ''],
];
const SALE_ID_COL = 10; // column J

function doGet(e) {
  if (!e || !e.parameter || e.parameter.secret !== SECRET) {
    return json_({ error: 'bad secret' });
  }
  ensureSetup_();
  const ss = SpreadsheetApp.getActive();

  const settingsRaw = ss.getSheetByName(SETTINGS_TAB)
    .getRange('B1:B4').getValues().map(function (r) { return String(r[0] || ''); });

  // Sale IDs from EVERY data tab (store tabs + per-employee tabs) so the
  // app's dedup covers them all.
  const existing = {};
  ss.getSheets().forEach(function (sh) {
    const name = sh.getName();
    if (name === SETTINGS_TAB) return;
    const last = sh.getLastRow();
    existing[name] = last >= 2
      ? sh.getRange(2, SALE_ID_COL, last - 1, 1).getValues()
          .map(function (r) { return String(r[0] || '').trim(); })
          .filter(String)
      : [];
  });

  // v3: Store column; v2: employee tabs (doPost auto-creates unknown tabs).
  return json_({ ok: true, v: 3, settings_raw: settingsRaw, existing: existing });
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) {}
  if (body.secret !== SECRET) {
    return json_({ error: 'bad secret' });
  }
  ensureSetup_();
  const ss = SpreadsheetApp.getActive();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    (body.appends || []).forEach(function (a) {
      if (!a.tab || a.tab === SETTINGS_TAB || !a.rows || !a.rows.length) return;
      let sh = ss.getSheetByName(a.tab);
      if (!sh) {   // per-employee tabs are created on first use
        sh = ss.insertSheet(a.tab);
        sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
          .setFontWeight('bold');
        sh.setFrozenRows(1);
      }
      sh.getRange(sh.getLastRow() + 1, 1, a.rows.length, a.rows[0].length)
        .setValues(a.rows);
    });
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true });
}

function ensureSetup_() {
  const ss = SpreadsheetApp.getActive();
  STORE_TABS.forEach(function (tab) {
    if (!ss.getSheetByName(tab)) {
      const sh = ss.insertSheet(tab);
      sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
        .setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  // Backfill header cells added after a tab was created (e.g. K1 "Store").
  ss.getSheets().forEach(function (sh) {
    if (sh.getName() === SETTINGS_TAB) return;
    const last = sh.getRange(1, HEADERS.length);
    if (!String(last.getValue() || '')) {
      last.setValue(HEADERS[HEADERS.length - 1]).setFontWeight('bold');
    }
  });
  if (!ss.getSheetByName(SETTINGS_TAB)) {
    const sh = ss.insertSheet(SETTINGS_TAB);
    sh.getRange(1, 1, SETTINGS_DEFAULTS.length, 2).setValues(SETTINGS_DEFAULTS);
    sh.setColumnWidth(1, 620);
  } else {
    // Sheets set up before the excluded-categories feature: add row 4 once.
    const sh = ss.getSheetByName(SETTINGS_TAB);
    if (!String(sh.getRange('A4').getValue() || '')) {
      sh.getRange(4, 1, 1, 2).setValues([SETTINGS_DEFAULTS[3]]);
    }
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
