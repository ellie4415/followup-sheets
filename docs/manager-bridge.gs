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
 * Columns: Date | Customer | Cashier | Items ("Seller — item" per line) |
 * Immediate Profit | Total Profit | Sale Total | Sale ID. Append-only; the app never edits
 * existing rows (the one-time fixColumns/flipItemLines migrations excepted).
 */

const SECRET = 'PASTE_SECRET_HERE';

const HEADERS = ['Date', 'Customer', 'Cashier', 'Items', 'Immediate Profit', 'Total Profit', 'Sale Total', 'Sale ID'];
const STORE_TABS = ['Reno', 'Rocklin'];
const SALE_ID_COL = 8; // column H — moved by addImmediateProfitColumn (v8); was G, before that F
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
  return json_({ ok: true, v: 8, existing: existing });
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
      // INSERT rows directly after the last row that has a Sale ID (not
      // getLastRow(), which counts stray content below the data). Inserting
      // inside the existing data block keeps the tab's Sheets *Table*
      // growing — the new rows join it and inherit its column types and
      // formatting — instead of piling plain rows underneath it.
      const anchor = lastDataRow_(sh);
      sh.insertRowsAfter(anchor, a.rows.length);
      const start = anchor + 1;
      sh.getRange(start, 1, a.rows.length, a.rows[0].length)
        .setValues(a.rows);
      for (let i = 0; i < a.rows.length; i++) {
        colorizeRow_(sh, start + i,
                     String(a.rows[i][ITEMS_COL - 1] || ''),
                     String(a.rows[i][CASHIER_COL - 1] || ''),
                     String(a.rows[i][0] || ''),
                     String(a.rows[i][SALE_ID_COL - 1] || ''));
      }
    });
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true });
}

// Month separation: every calendar month has its OWN Date-cell fill, so
// Data → Create a filter → "Filter by color" isolates a month in one click.
const MONTH_TINTS = [
  '#cfe2ff', // Jan  blue
  '#ffd6e7', // Feb  pink
  '#d3f5d6', // Mar  mint
  '#fff2b3', // Apr  yellow
  '#e5d9ff', // May  lavender
  '#ffdfc2', // Jun  peach
  '#c9f2f0', // Jul  aqua
  '#e9d5c3', // Aug  tan
  '#ffcccb', // Sep  salmon
  '#f0c9f5', // Oct  orchid
  '#d9dde6', // Nov  slate
  '#dcedc8', // Dec  lime
];
const WEEK_ROW_BG = '#fff2cc';                // Sales of the Week marker rows

function colorizeRow_(sh, rowIdx, itemsText, cashierText, dateText, saleId) {
  // Sales of the Week rows (Sale ID "WEEK-…"): whole row gold + bold label.
  if (saleId && saleId.indexOf('WEEK-') === 0) {
    sh.getRange(rowIdx, 1, 1, HEADERS.length).setBackground(WEEK_ROW_BG);
    sh.getRange(rowIdx, 1, 1, 2).setFontWeight('bold');
  } else if (dateText) {
    // dateText is "M/D/YYYY" from the app, or the cell's DISPLAY value when
    // restyling (the cell itself holds a real Date, so getValue() would give
    // a Date object — that's why an earlier recolorAll skipped the months).
    let month = 0;
    const m = String(dateText).match(/^(\d{1,2})\/\d{1,2}\/\d{4}/);
    if (m) {
      month = parseInt(m[1], 10);
    } else {
      const d = new Date(dateText);
      if (!isNaN(d.getTime())) month = d.getMonth() + 1;
    }
    if (month >= 1 && month <= 12) {
      sh.getRange(rowIdx, 1).setBackground(MONTH_TINTS[month - 1]);
    }
  }
  // Items cell ("Name — item" per line): item text stays BLACK; only the
  // employee name BEFORE the first " — " takes that employee's color (bold).
  // Sheets cannot background-highlight PART of a cell — text styling is the
  // only per-character tool — so the true highlight lives on the Cashier cell.
  if (itemsText) {
    const black = SpreadsheetApp.newTextStyle()
      .setForegroundColor('#000000').setBold(false).build();
    const b = SpreadsheetApp.newRichTextValue().setText(itemsText)
      .setTextStyle(0, itemsText.length, black);
    let pos = 0;
    itemsText.split('\n').forEach(function (line) {
      const sep = line.indexOf(' — ');
      if (sep > 0) {
        const emp = line.substring(0, sep).trim();
        if (emp && emp !== '?') {
          b.setTextStyle(pos, pos + sep,
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
 * Wipe ALL data rows on both store tabs (headers stay) — for a clean
 * regeneration via the app's Re-import. Deliberate nuclear option: only run
 * when you intend to re-import immediately after.
 */
function clearAllDataRows() {
  const ss = SpreadsheetApp.getActive();
  dataSheets_(ss).forEach(function (sh) {
    const last = sh.getLastRow();
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, sh.getMaxColumns()).clearContent().setBackground(null);
    }
  });
}

/**
 * Delete duplicate transaction rows (same Sale ID in column G), keeping the
 * first occurrence. Run once after fixing the deployment; safe to re-run.
 */
function removeDuplicateRows() {
  const ss = SpreadsheetApp.getActive();
  dataSheets_(ss).forEach(function (sh) {
    const last = sh.getLastRow();
    if (last < 3) return;
    const ids = sh.getRange(2, SALE_ID_COL, last - 1, 1).getValues();
    const seen = {};
    const toDelete = [];
    for (let i = 0; i < ids.length; i++) {
      const id = String(ids[i][0] || '').trim();
      if (!id) continue;
      if (seen[id]) toDelete.push(i + 2);
      else seen[id] = true;
    }
    for (let j = toDelete.length - 1; j >= 0; j--) sh.deleteRow(toDelete[j]);
  });
}

/**
 * Wipe all stored employee-color assignments (e.g. after a bad script
 * version polluted them). Run it, then run recolorAll to reassign clean
 * colors in first-seen order.
 */
function resetColors() {
  const props = PropertiesService.getScriptProperties();
  props.getKeys().forEach(function (k) {
    if (k.indexOf('empcolor:') === 0) props.deleteProperty(k);
  });
}

/**
 * ONE-TIME migration (v8): insert the "Immediate Profit" column at E on
 * every data tab (existing Total Profit values shift to F, Sale Total → G,
 * Sale ID → H). Existing rows get a blank Immediate Profit — regenerate via
 * clearAllDataRows + Re-import to fill it. Guarded; safe to run once.
 */
function addImmediateProfitColumn() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('cols_v3')) {
    throw new Error('addImmediateProfitColumn already ran.');
  }
  const ss = SpreadsheetApp.getActive();
  dataSheets_(ss).forEach(function (sh) {
    if (String(sh.getRange(1, 5).getValue()) === 'Immediate Profit') return;
    sh.insertColumnBefore(5);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  });
  props.setProperty('cols_v3', '1');
}

/**
 * ONE-TIME migration for the Sale Total column: existing rows have
 * "Name ($total)" in Cashier (col C) and Sale ID in col F. This splits the
 * total out of the cashier cell into new col F, moves Sale ID to col G,
 * and rewrites the header row. Run once from the function dropdown.
 */
function fixColumns() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('cols_v2')) {
    throw new Error('fixColumns already ran — the columns are already migrated.');
  }
  const ss = SpreadsheetApp.getActive();
  dataSheets_(ss).forEach(function (sh) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    const last = sh.getLastRow();
    for (let r = 2; r <= last; r++) {
      const saleId = String(sh.getRange(r, 6).getValue() || '');
      if (!saleId) continue;
      const cashText = String(sh.getRange(r, CASHIER_COL).getValue() || '');
      let name = cashText, total = '';
      const p = cashText.lastIndexOf(' (');
      if (p > 0 && cashText.charAt(cashText.length - 1) === ')') {
        name  = cashText.substring(0, p).trim();
        total = cashText.substring(p + 2, cashText.length - 1);
      } else if (cashText.charAt(0) === '$' || cashText.charAt(0) === '−') {
        name = ''; total = cashText;   // cashier-less rows held only the total
      }
      sh.getRange(r, CASHIER_COL).setValue(name);
      sh.getRange(r, 6).setValue(total);   // F becomes Sale Total
      sh.getRange(r, 7).setValue(saleId);  // G becomes Sale ID
    }
  });
  props.setProperty('cols_v2', '1');
}

/**
 * ONE-TIME migration: flips existing "Item — Name" lines to "Name — Item"
 * and recolors them. Run it once from the function dropdown after updating
 * this script; a guard flag refuses a second run (which would swap the
 * lines back). Delete the 'flip_done' Script Property to override.
 */
function flipItemLines() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('flip_done')) {
    throw new Error('flipItemLines already ran — running again would swap lines back to Item — Name.');
  }
  const ss = SpreadsheetApp.getActive();
  dataSheets_(ss).forEach(function (sh) {
    const last = lastDataRow_(sh);
    for (let r = 2; r <= last; r++) {
      const cell = sh.getRange(r, ITEMS_COL);
      const text = String(cell.getValue() || '');
      if (!text) continue;
      const flipped = text.split('\n').map(function (line) {
        const sep = line.lastIndexOf(' — ');
        if (sep < 0) return line;
        return line.substring(sep + 3).trim() + ' — ' + line.substring(0, sep);
      }).join('\n');
      cell.setValue(flipped);
      colorizeRow_(sh, r, flipped,
                   String(sh.getRange(r, CASHIER_COL).getValue() || ''),
                   sh.getRange(r, 1).getDisplayValue(),
                   String(sh.getRange(r, SALE_ID_COL).getValue() || ''));
    }
  });
  props.setProperty('flip_done', '1');
}

/**
 * One-time restyle of every existing row (both store tabs) using the current
 * color rules — run it from the editor's function dropdown after updating
 * this script. Safe to run repeatedly; values are untouched, only styling.
 */
function recolorAll() {
  const ss = SpreadsheetApp.getActive();
  dataSheets_(ss).forEach(function (sh) {
    const last = lastDataRow_(sh);
    for (let r = 2; r <= last; r++) {
      colorizeRow_(sh, r,
                   String(sh.getRange(r, ITEMS_COL).getValue() || ''),
                   String(sh.getRange(r, CASHIER_COL).getValue() || ''),
                   sh.getRange(r, 1).getDisplayValue(),
                   String(sh.getRange(r, SALE_ID_COL).getValue() || ''));
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

// One tab per store per YEAR ("Reno 2026"). The app picks the tab from each
// sale's date, so the January rollover is automatic (doPost creates unknown
// tabs). ensureSetup_ makes the current year's tabs exist — RENAMING a
// legacy un-yeared "Reno"/"Rocklin" tab into place the first time, so the
// original data carries over with no manual migration.
function ensureSetup_() {
  const ss = SpreadsheetApp.getActive();
  const year = new Date().getFullYear();
  STORE_TABS.forEach(function (base) {
    const yearName = base + ' ' + year;
    if (ss.getSheetByName(yearName)) return;
    const legacy = ss.getSheetByName(base);
    if (legacy) {
      legacy.setName(yearName);
      return;
    }
    const sh = ss.insertSheet(yearName);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
  });
}

// Every data tab: "Reno", "Reno 2026", "Rocklin 2027", … (any tab whose
// name starts with a store name). Used by all the maintenance helpers.
function dataSheets_(ss) {
  return ss.getSheets().filter(function (sh) {
    const n = sh.getName();
    return STORE_TABS.some(function (base) { return n.indexOf(base) === 0; });
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
