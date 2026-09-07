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

const HEADERS = ['Date', 'Customer', 'Cashier (Sale Total)', 'Items', 'Total Profit', 'Sale ID'];
const STORE_TABS = ['Reno', 'Rocklin'];
const SALE_ID_COL = 6; // column F
const CASHIER_COL = 3;
const ITEMS_COL   = 4;

// Each employee gets a stable color pair, assigned FIRST-COME FIRST-SERVED
// (not hashed — hashing made different people land on similar colors) and
// remembered forever in Script Properties. DARK is used for the name text
// in the Items column; PASTEL is the matching full-cell highlight for the
// Cashier column. The two lists are index-paired — keep them in sync.
const DARK   = ['#1155cc', '#b45309', '#188038', '#8e24aa', '#c2185b', '#00796b',
                '#e65100', '#283593', '#a50e0e', '#827717', '#0277bd', '#5d4037'];
const PASTEL = ['#d0e0fc', '#fde3c8', '#d3efdb', '#eed5f5', '#f9d3e2', '#ccebe7',
                '#fcdecb', '#d6d9f3', '#f7d1d1', '#eff0c3', '#cfeafc', '#e6dad6'];

function colorsFor_(name) {
  const props = PropertiesService.getScriptProperties();
  let idx = props.getProperty('empcolor:' + name);
  if (idx === null) {
    const next = parseInt(props.getProperty('empcolor:_next') || '0', 10);
    idx = String(next % DARK.length);
    props.setProperty('empcolor:' + name, idx);
    props.setProperty('empcolor:_next', String(next + 1));
  }
  return { text: DARK[+idx], bg: PASTEL[+idx] };
}

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
  return json_({ ok: true, v: 3, existing: existing });
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
      for (let i = 0; i < a.rows.length; i++) {
        colorizeRow_(sh, start + i,
                     String(a.rows[i][ITEMS_COL - 1] || ''),
                     String(a.rows[i][CASHIER_COL - 1] || ''));
      }
    });
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true });
}

function colorizeRow_(sh, rowIdx, itemsText, cashierText) {
  // Items cell: item text stays BLACK; only the employee name after the
  // final " — " takes that employee's color (bold, so it reads at a glance).
  // Sheets cannot background-highlight PART of a cell — text styling is the
  // only per-character tool — so the true highlight lives on the Cashier cell.
  if (itemsText) {
    const black = SpreadsheetApp.newTextStyle()
      .setForegroundColor('#000000').setBold(false).build();
    const b = SpreadsheetApp.newRichTextValue().setText(itemsText)
      .setTextStyle(0, itemsText.length, black);
    let pos = 0;
    itemsText.split('\n').forEach(function (line) {
      const sep = line.lastIndexOf(' — ');
      if (sep >= 0 && line.length) {
        const emp = line.substring(sep + 3).trim();
        if (emp && emp !== '?') {
          b.setTextStyle(pos + sep + 3, pos + line.length,
            SpreadsheetApp.newTextStyle()
              .setForegroundColor(colorsFor_(emp).text).setBold(true).build());
        }
      }
      pos += line.length + 1;
    });
    sh.getRange(rowIdx, ITEMS_COL).setRichTextValue(b.build());
  }
  // Cashier cell ("Name ($total)"): whole-cell pastel highlight in that
  // employee's color; text stays black.
  if (cashierText) {
    const paren = cashierText.indexOf(' (');
    const nm = (paren > 0 ? cashierText.substring(0, paren) : cashierText).trim();
    if (nm && nm !== '?' && nm.charAt(0) !== '$' && nm.charAt(0) !== '−') {
      sh.getRange(rowIdx, CASHIER_COL).setBackground(colorsFor_(nm).bg);
    }
  }
}

/**
 * One-time restyle of every existing row (both store tabs) using the current
 * color rules — run it from the editor's function dropdown after updating
 * this script. Safe to run repeatedly; values are untouched, only styling.
 */
function recolorAll() {
  const ss = SpreadsheetApp.getActive();
  STORE_TABS.forEach(function (tabName) {
    const sh = ss.getSheetByName(tabName);
    if (!sh) return;
    const last = lastDataRow_(sh);
    for (let r = 2; r <= last; r++) {
      colorizeRow_(sh, r,
                   String(sh.getRange(r, ITEMS_COL).getValue() || ''),
                   String(sh.getRange(r, CASHIER_COL).getValue() || ''));
    }
  });
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
