/**
 * MANAGER performance sheet bridge — lives INSIDE the manager's Google Sheet
 * (a SEPARATE spreadsheet from the follow-up sheet; it holds profit data, so
 * share it with managers only).
 *
 * Install: open the manager spreadsheet → Extensions → Apps Script → delete
 * any code there → paste this whole file → set SECRET below → Deploy → New
 * deployment → type "Web app" → Execute as: Me → Who has access: Anyone →
 * Deploy. Copy the /exec URL into Railway env var MANAGER_WEBAPP_URL, and
 * put the same SECRET value in env var MANAGER_SECRET.
 *
 * Columns: Date | Customer | Cashier | Items (one per line, each tagged with
 * who sold it) | Total Profit | Sale ID. Append-only; the app never edits
 * existing rows.
 */

const SECRET = 'PASTE_SECRET_HERE';

const HEADERS = ['Date', 'Customer', 'Cashier', 'Items', 'Total Profit', 'Sale ID'];
const STORE_TABS = ['Reno', 'Rocklin'];
const SALE_ID_COL = 6; // column F

function doGet(e) {
  if (!e || !e.parameter || e.parameter.secret !== SECRET) {
    return json_({ error: 'bad secret' });
  }
  ensureSetup_();
  const ss = SpreadsheetApp.getActive();
  const existing = {};
  ss.getSheets().forEach(function (sh) {
    const last = sh.getLastRow();
    existing[sh.getName()] = last >= 2
      ? sh.getRange(2, SALE_ID_COL, last - 1, 1).getValues()
          .map(function (r) { return String(r[0] || '').trim(); })
          .filter(String)
      : [];
  });
  return json_({ ok: true, v: 1, existing: existing });
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
      if (!a.tab || !a.rows || !a.rows.length) return;
      let sh = ss.getSheetByName(a.tab);
      if (!sh) {
        sh = ss.insertSheet(a.tab);
        sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
          .setFontWeight('bold');
        sh.setFrozenRows(1);
      }
      // Append after the last row that has a Sale ID — not getLastRow(),
      // which counts stray content/validation below the data.
      const start = lastDataRow_(sh) + 1;
      const overflow = start + a.rows.length - 1 - sh.getMaxRows();
      if (overflow > 0) sh.insertRowsAfter(sh.getMaxRows(), overflow);
      sh.getRange(start, 1, a.rows.length, a.rows[0].length)
        .setValues(a.rows);
    });
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true });
}

function lastDataRow_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const ids = sh.getRange(2, SALE_ID_COL, last - 1, 1).getValues();
  let lastData = 1;
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim()) lastData = i + 2;
  }
  return lastData;
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
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
