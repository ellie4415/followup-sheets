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
                 'Salesperson', 'Emailed?', 'Notes', 'Sale ID'];
const STORE_TABS = ['Reno', 'Rocklin'];
const SETTINGS_TAB = 'Settings';
const SETTINGS_DEFAULTS = [
  ['Dollar threshold — any sale at/over this total qualifies (blank or 0 = off)', '300'],
  ['Qualifying categories — Lightspeed category names, comma-separated (items anywhere under these count)', 'Cameras, Lenses'],
  ['Skip shops — sales from these Lightspeed shops are ignored, comma-separated', 'Action Camera Online'],
  ['', ''],
  ['The app re-reads this tab on every run. Edit values in column B only.', ''],
];
const SALE_ID_COL = 10; // column J

function doGet(e) {
  if (!e || !e.parameter || e.parameter.secret !== SECRET) {
    return json_({ error: 'bad secret' });
  }
  ensureSetup_();
  const ss = SpreadsheetApp.getActive();

  const settingsRaw = ss.getSheetByName(SETTINGS_TAB)
    .getRange('B1:B3').getValues().map(function (r) { return String(r[0] || ''); });

  const existing = {};
  STORE_TABS.forEach(function (tab) {
    const sh = ss.getSheetByName(tab);
    const last = sh.getLastRow();
    existing[tab] = last >= 2
      ? sh.getRange(2, SALE_ID_COL, last - 1, 1).getValues()
          .map(function (r) { return String(r[0] || '').trim(); })
          .filter(String)
      : [];
  });

  return json_({ ok: true, settings_raw: settingsRaw, existing: existing });
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
      const sh = ss.getSheetByName(a.tab);
      if (!sh || !a.rows || !a.rows.length) return;
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
  if (!ss.getSheetByName(SETTINGS_TAB)) {
    const sh = ss.insertSheet(SETTINGS_TAB);
    sh.getRange(1, 1, SETTINGS_DEFAULTS.length, 2).setValues(SETTINGS_DEFAULTS);
    sh.setColumnWidth(1, 620);
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
