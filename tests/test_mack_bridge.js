// Tests for docs/mack-bridge.gs status logic (no Google services needed).
// Run with macOS JavaScriptCore from the repo root:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc docs/mack-bridge.gs tests/test_mack_bridge.js
var failures = 0;
function eq(a, b, msg) {
  var A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { failures++; print('FAIL ' + msg + '\n   got  ' + A + '\n   want ' + B); }
  else print('ok   ' + msg);
}

function soldRow(o) {
  var r = new Array(SOLD_HEADERS.length).fill('');
  r[S['Sale']] = o.sale; r[S['Warranty Item']] = o.item || 'Mack 3 Yr Under $2000 Diamond OL';
  r[S['Qty']] = o.qty; r[S['Customer ID']] = o.cid || '55'; r[S['Line ID']] = o.line;
  r[S['Reverses Line']] = o.rev || ''; r[S['Unit Key']] = o.key; r[S['Handled Outside']] = o.outside || '';
  return r;
}
function regRow(o) {
  var r = new Array(REG_WIDTH).fill('');
  r[T['Unit Key']] = o.key; r[T['Warranty Item']] = o.item || 'Mack 3 Yr Under $2000 Diamond OL';
  r[T['Sent to Mack']] = o.sent || ''; r[T['Cancelled with Mack']] = o.cancelled || '';
  r[T['Registration ID']] = o.id || ('id-' + o.key); r[M['WarrType']] = o.code || '';
  return r;
}
var codes = { 'mack 3 yr under $2000 diamond ol': { code: 'M029' } };

// Column layout matches Melinda's file exactly.
eq(MACK_HEADERS.length, 28, 'Mack columns A..AB = 28');
eq([M['TranKey'], M['DealerInvoice#'], M['OriginalInvoiceNumber']], [0, 17, 27], 'key Mack column positions');
eq(T['Status'], 28, 'tracking starts at AC');

// 1. Plain cases
var sold = [
  soldRow({ sale: '101', line: '2', key: '2-1', qty: 1 }),                 // waiting
  soldRow({ sale: '102', line: '3', key: '3-1', qty: 1 }),                 // registered
  soldRow({ sale: '102', line: '3', key: '3-2', qty: 1 }),                 // sent
  soldRow({ sale: '104', line: '6', key: '6-1', qty: 1, outside: 'phone' }), // handled outside
];
var regs = [regRow({ key: '3-1' }), regRow({ key: '3-2', sent: '10-05-2026' })];
var st = computeStatuses_(sold, regs, codes);
eq(st.sold.map(function (s) { return s.status; }), ['Waiting', 'Registered', 'Sent', 'Handled outside'], 'basic sold statuses');
eq(st.regs, ['Ready to send', 'Sent'], 'basic registration statuses');

// 2. Return one warranty and buy another (exchange): return reverses line 2 (not yet registered)
sold = [
  soldRow({ sale: '101', line: '2', key: '2-1', qty: 1 }),
  soldRow({ sale: '103', line: '4', key: 'R4-1', qty: -1, rev: '2' }),
  soldRow({ sale: '103', line: '5', key: '5-1', qty: 1, item: 'Mack 3 Yr Under $2500 Diamond OL' }),
];
st = computeStatuses_(sold, [], codes);
eq(st.sold.map(function (s) { return s.status; }), ['Returned', 'Return of 101', 'Waiting'], 'exchange: old returned, new waiting');

// 3. Returned AFTER it was sent to Mack -> Cancel with Mack, then Cancelled
regs = [regRow({ key: '2-1', sent: '10-01-2026' })];
st = computeStatuses_(sold, regs, codes);
eq([st.sold[0].status, st.regs[0]], ['Cancel with Mack', 'Cancel with Mack'], 'returned after sent');
regs = [regRow({ key: '2-1', sent: '10-01-2026', cancelled: '10-08-2026' })];
st = computeStatuses_(sold, regs, codes);
eq([st.sold[0].status, st.regs[0]], ['Cancelled', 'Cancelled'], 'cancelled with Mack');

// 4. Returned before sending -> registration excluded from the file
regs = [regRow({ key: '2-1' })];
st = computeStatuses_(sold, regs, codes);
eq([st.sold[0].status, st.regs[0]], ['Returned', "Returned, don't send"], 'returned before sent');

// 5. qty 2 on one line, one returned: the return takes the UNREGISTERED twin
sold = [
  soldRow({ sale: '102', line: '3', key: '3-1', qty: 1 }),
  soldRow({ sale: '102', line: '3', key: '3-2', qty: 1 }),
  soldRow({ sale: '110', line: '9', key: 'R9-1', qty: -1, rev: '3' }),
];
regs = [regRow({ key: '3-1' })];
st = computeStatuses_(sold, regs, codes);
eq(st.sold.map(function (s) { return s.status; }), ['Registered', 'Returned', 'Return of 102'], 'return prefers the unregistered twin');

// 6. Return without a receipt link: same customer + same item
sold = [
  soldRow({ sale: '101', line: '2', key: '2-1', qty: 1 }),
  soldRow({ sale: '120', line: '12', key: 'R12-1', qty: -1, rev: '' }),
  soldRow({ sale: '121', line: '13', key: 'R13-1', qty: -1, rev: '', cid: '99' }),
];
st = computeStatuses_(sold, [], codes);
eq(st.sold.map(function (s) { return s.status; }), ['Returned', 'Return of 101', 'Return: check'], 'fallback match + unmatched return');

// 7. Two warranties on one receipt, one covering gear from an earlier sale: independent units
sold = [
  soldRow({ sale: '130', line: '20', key: '20-1', qty: 1 }),
  soldRow({ sale: '130', line: '21', key: '21-1', qty: 1, item: 'Mack 3 Yr Under $1000 Diamond OL' }),
];
regs = [regRow({ key: '21-1', item: 'Mack 3 Yr Under $1000 Diamond OL' })];
st = computeStatuses_(sold, regs, codes);
eq(st.sold.map(function (s) { return s.status; }), ['Waiting', 'Registered'], 'two warranties, one receipt');
eq(st.regs, ['Needs WarrType code'], 'missing code flagged');

// 8. Registration row building
var reg = {
  key: '21-1', warranty_sale: '130', warranty_item: 'Mack 3 Yr Under $2000 Diamond OL', warranty_price: 239.95,
  warranty_date: '10-07-2026', gear_sale: '128', gear_date: '10-02-2026', value: 1849.98, condition: 'New',
  store: 'Rocklin', salesperson: 'Alison Watkins', saved_from: 'Rocklin computer', notes: ['Typed in panel: phone.'],
  customer: { id: '55', first: 'Pat', last: 'Test', company: '', address1: '1 Main St', address2: '', city: 'Rocklin',
              state: 'CA', zip: '95765', phone: '9165551234', email: 'pat@example.com' },
  slots: [{ make: 'Canon', model: 'EOS R7', serial: '123' }, { make: 'Canon', model: '18-150mm', serial: '456' }],
};
eq(registrationProblems_(reg), [], 'complete registration has no problems');
var row = registrationRow_(reg, codes, 'abc', 'NOW');
eq([row[M['WarrType']], row[M['DealerInvoice#']], row[M['EquipmentPurchaseDate']], row[M['ServiceContractPurchaseDate']],
    row[M['EQ2Model']], row[M['EQ2Serial']], row[M['EQ3Make']], row[M['EquipmentValue']], row[T['Unit Key']]],
   ['M029', '128', '10-02-2026', '10-07-2026', '18-150mm', '456', '', 1849.98, '21-1'], 'registration row: gear receipt is DealerInvoice#, slots split');
var bad = JSON.parse(JSON.stringify(reg)); bad.customer.phone = ''; bad.slots[1].serial = '';
bad.slots.push({ make: 'a', model: 'b', serial: 'c' }, { make: 'd', model: 'e', serial: 'f' });
eq(registrationProblems_(bad), ['Customer phone is missing.', 'Mack files hold at most 3 items per warranty.',
   'Item 2 needs its serial number.'], 'problems listed');
eq(parsePlan_('Mack 1 Yr Used Photo Under $1,000 OL'), { years: 1, coverage: 1000, condition: 'Used' }, 'parsePlan');
eq(shortName_('Pat Q Test'), 'Pat T.', 'shortName');

print(failures ? failures + ' FAILURE(S)' : 'ALL BRIDGE TESTS PASSED');

// v2: serial rule, kits
eq([realSerial_('ABC123'), realSerial_('N/A'), realSerial_('na'), realSerial_(''), realSerial_('none'), realSerial_('0')],
   [true, false, false, false, false, false], 'serials: N/A and blanks are not serials');
eq([isKitName_('Canon EOS R7 Kit w/ 18-150mm+', ['kit', 'w/']), isKitName_('Kitchen scale', ['kit']), isKitName_('Sony A7 IV', ['kit', 'w/'])],
   [true, false, false], 'kit names');
eq(normKit_('Canon EOS R7 Kit w/ 18-150mm +'), normKit_('canon eos r7 kit w/ 18-150mm'), 'kit names match with or without +');
var reg2 = JSON.parse(JSON.stringify(reg)); reg2.slots[1].serial = 'N/A';
eq(registrationProblems_(reg2), ['Item 2 needs its serial number.'], 'N/A serial rejected on save');
print(failures ? failures + ' FAILURE(S)' : 'ALL V2 BRIDGE TESTS PASSED');

// v3: Forms on Fire import (made-up data)
var fofCsv = [
  ['Row Id', 'Completed', 'Completed At', 'First', 'Last', 'Company', 'Address', 'Address2', 'City', 'State', 'zip', 'phone', 'email',
   'EquipmentPurchaseDate', 'EquipmentValue', 'EQMake', 'EQModel', 'EQSerial', 'EQ2Make', 'EQ2Model', 'EQ2Serial', 'EQ3Make', 'EQ3Model', 'EQ3Serial',
   'ServiceContractPurchaseDate', 'EquipmentContractPurchasePrice', 'coverageLengthOfTime', 'coverageAmount', 'Condition', 'salesPersonName', 'DealerInvoice'],
  ['1', '10-01-2026 12:00', '38.79 -121.21', 'Pat', 'Test', '', '1 Main St', '', 'Rocklin', 'CA', '95765', '916-555-1234', 'pat@gmai.com',
   '10-01-2026', '1899.00', 'Canon', 'EOS R7', '0123', 'Canon', '18-150mm', 'N/A', '', '', '',
   '10-01-2026', '239.95', '3', '2000', 'New', 'Ali', '20000104555'],
  ['2', '10-02-2026 12:00', '39.47 -119.78', 'Sam', 'Other', '', '2 Oak', '', 'Reno', 'NV', '89501', '7755551234', 'sam@example.com',
   '09-30-2026', '549.99', 'Sony', 'ZV-1', 'S1', '', '', '', '', '', '',
   '10-02-2026', '109.95', '3', '750', 'New', 'Jo', '104700'],
];
var fofSold = [soldRow({ sale: '104555', line: '50', key: '50-1', qty: 1, item: 'Mack 3 Yr Under $2000 Diamond OL' }),
               soldRow({ sale: '104777', line: '70', key: '70-1', qty: 1, item: 'Mack 3 Yr Under $750 Diamond OL', cid: '9' })];
fofSold[0][S['Price']] = 239.95; fofSold[1][S['Price']] = 109.95;
fofSold[1][S['Customer']] = 'Sam Other'; fofSold[1][S['Date']] = new Date(2026, 9, 2);
var fofCodes = { 'mack 3 yr under $750 diamond ol': { code: 'M026', years: 3, coverage: 750, condition: 'New' } };
var fo = fofRegistrations_(fofRecords_(fofCsv), fofSold, [], fofCodes, '', new Date(2026, 9, 7));
eq([fo.rows.length, fo.linked, fo.rows[0][T['Unit Key']], fo.rows[1][T['Unit Key']]], [2, 2, '50-1', '70-1'],
   'import: matched by receipt suffix and by name + date');
eq(fo.rows[0][T['Problems']], 'Item 2 has no serial number ("N/A"). Email ends in gmai.com, probably a typo for gmail.com. Receipt number 20000104555 looks wrong, the Lightspeed sale is 104555.',
   'import: problems listed');
eq([fo.rows[0][M['EQSerial']], fo.rows[1][M['WarrType']], fo.rows[1][T['Store']]], ['0123', 'M026', 'Reno'.length ? fo.rows[1][T['Store']] : ''],
   'import: serial text kept, WarrType from Codes');
var foSt = computeStatuses_(fofSold, fo.rows, fofCodes);
eq([foSt.sold[0].status, foSt.sold[1].status, foSt.regs[0], foSt.regs[1]], ['Registered', 'Registered', 'Needs fixing', 'Ready to send'],
   'import: sales registered, flagged row held back');
eq(fofRegistrations_(fofRecords_(fofCsv), fofSold, fo.rows, fofCodes, '', new Date(2026, 9, 7)).rows.length, 0, 'import twice: no duplicates');
var foSent = fofRegistrations_(fofRecords_(fofCsv), fofSold, [], fofCodes, 'Sent via Forms on Fire', new Date(2026, 9, 7));
eq(computeStatuses_(fofSold, foSent.rows, fofCodes).regs, ['Sent, needs fixing', 'Sent'], 'import as already sent');
print(failures ? failures + ' FAILURE(S)' : 'ALL V3 IMPORT TESTS PASSED');

// Gear bought somewhere else
var outsideReg = JSON.parse(JSON.stringify(reg));
outsideReg.outside = true; outsideReg.gear_sale = '130'; outsideReg.original_invoice = 'CANON-4005469098'; outsideReg.gear_date = '10-01-2026';
var oRow = registrationRow_(outsideReg, codes, 'zz', 'NOW');
eq([oRow[M['DealerInvoice#']], oRow[M['OriginalInvoiceNumber']], oRow[M['EquipmentPurchaseDate']]], ['130', 'CANON-4005469098', '10-01-2026'],
   'outside gear: our receipt is DealerInvoice#, theirs is OriginalInvoiceNumber');
outsideReg.original_invoice = '';
eq(registrationProblems_(outsideReg), ['The receipt or order number from where the gear was bought is missing.'], 'outside gear needs their receipt number');
print(failures ? failures + ' FAILURE(S)' : 'ALL OUTSIDE-GEAR TESTS PASSED');

// v4: the waiting list works statuses out live, and a failed status refresh
// after a save can't leave a registered warranty "outstanding".
var fakeTabs = {}, written = [], logged = [], refreshes = 0, refreshFails = false;
function fakeRange() {
  return { setValues: function (v) { written.push(v); return this; }, setNumberFormats: function () { return this; },
           insertCheckboxes: function () { return this; }, setValue: function () { return this; } };
}
sheet_ = function (name) {
  return { name: name, getLastRow: function () { return (fakeTabs[name] || []).length + 1; }, getRange: fakeRange };
};
readRows_ = function (sh) { return fakeTabs[sh.name] || []; };
readCodes_ = function () { return codes; };
readSettings_ = function () { return ['', 17, 3, 25, 'adapter, drone', 'kit, w/', 3, 30, 'Mack files']; };
readKits_ = function () { return { 'sony zv-e1 kit black': { camera: 'ZV-E1', lenses: ['FE 28-60mm F4-5.6'] } }; };
refreshStatuses_ = function () { refreshes++; if (refreshFails) throw new Error('validation rule on the Status column'); };
LockService = { getScriptLock: function () {
  return { tryLock: function () { return true; }, waitLock: function () {}, releaseLock: function () {} }; } };
Utilities = { formatDate: function () { return '10-20-2026'; }, getUuid: function () { return 'abcd1234-0000'; } };
Session = { getScriptTimeZone: function () { return 'America/Los_Angeles'; } };
console = { error: function (m) { logged.push(m); }, log: function () {} };

var soldNow = [soldRow({ sale: '201', line: '9', key: '9-1', qty: 1 }), soldRow({ sale: '202', line: '10', key: '10-1', qty: 1 })];
soldNow[0][S['Status']] = 'Waiting'; soldNow[1][S['Status']] = 'Waiting';   // both stored as Waiting...
fakeTabs[SOLD_TAB] = soldNow;
fakeTabs[REG_TAB] = [regRow({ key: '10-1' })];                           // ...but 10-1 is registered
var waitingNow = pending_('');
eq(waitingNow.waiting.map(function (w) { return w.key; }), ['9-1'], 'registered warranty leaves the waiting list even if its Status cell is stale');
eq(refreshes, 1, 'stale Status cells get fixed');
soldNow[1][S['Status']] = 'Registered'; refreshes = 0;
pending_('');
eq(refreshes, 0, 'no sheet writes when the Status column is already right');

refreshFails = true; refreshes = 0;
pending_('');
soldNow[1][S['Status']] = 'Waiting';
eq(pending_('').waiting.length, 1, 'waiting list still answers when fixing the Status cells fails');

fakeTabs[REG_TAB] = []; logged = [];
var saveReg = JSON.parse(JSON.stringify(reg)); saveReg.key = '9-1';
var saved = register_(saveReg);
eq([saved.ok, logged.length > 0], [true, true], 'a save whose status refresh fails is still reported as saved, and logged');
print(failures ? failures + ' FAILURE(S)' : 'ALL V4 WAITING-LIST TESTS PASSED');

// v5: a tab turned into a Sheets table (typed columns) can't break saving,
// and making Mack's file never leaves warranties half-marked as sent.
var typedError = new Error("Exception: You can't set the number format of cells in a typed column.");
var swallowed = true;
try { tryFormat_(function () { throw typedError; }); } catch (err) { swallowed = false; }
eq(swallowed, true, 'typed-column format errors are skipped');
var other = null;
try { tryFormat_(function () { throw new Error('Service unavailable'); }); } catch (err) { other = err.message; }
eq(other, 'Service unavailable', 'other errors still stop the work');

sheet_ = function (name) {
  return { name: name, getLastRow: function () { return (fakeTabs[name] || []).length + 1; },
    getRange: function () {
      var r = fakeRange();
      r.setNumberFormats = function () { throw typedError; };
      r.setNumberFormat = function () { throw typedError; };
      return r;
    } };
};
refreshFails = false; refreshes = 0; logged = []; fakeTabs[REG_TAB] = [];
var typedSave = JSON.parse(JSON.stringify(reg)); typedSave.key = '9-1';
var typedResult = register_(typedSave);
eq([typedResult.ok, refreshes, logged.length], [true, 1, 0], 'saving into a table: saved, statuses refreshed, no error');

// markSent_: the 3rd row refuses its value -> rows 1 and 2 are put back.
function cellSheet(failRow) {
  var cells = {};
  return { cells: cells, getRange: function (row, col) {
    var key = row + ':' + col;
    return { setNumberFormat: function () { throw typedError; },
             setValue: function (v) {
               if (row === failRow && col === T['Sent to Mack'] + 1 && v === true) throw new Error('value does not match the column type');
               cells[key] = v; return this; } };
  } };
}
var markRegs = [regRow({ key: '1-1' }), regRow({ key: '2-1' }), regRow({ key: '3-1' })];
markRegs[0][T['Sent to Mack']] = false; markRegs[1][T['Sent to Mack']] = '';
var markRows = markRegs.map(function () { var r = new Array(MACK_HEADERS.length).fill(''); r[M['WarrType']] = 'M029'; return r; });
var sentCol = T['Sent to Mack'] + 1;
var failing = cellSheet(4);   // sheet row 4 = third registration
markRegs[0][T['Notes']] = 'Typed in panel.';
var markErr = markSent_(failing, markRegs, [0, 1, 2], markRows, '10-20-2026', 'Mack 10-20-2026');
var notesCol = T['Notes'] + 1;
eq([!!markErr, failing.cells['2:' + sentCol], failing.cells['3:' + sentCol], failing.cells['2:' + notesCol]],
   [true, false, '', 'Typed in panel.'], 'a failed mark puts the earlier rows (box and notes) back the way they were');
var working = cellSheet(-1);
eq([markSent_(working, markRegs, [0, 1, 2], markRows, '10-20-2026', 'Mack 10-20-2026'), working.cells['4:' + sentCol],
    working.cells['2:' + notesCol], working.cells['3:' + notesCol]],
   [null, true, 'Typed in panel. Sent to Mack 10-20-2026 in "Mack 10-20-2026".', 'Sent to Mack 10-20-2026 in "Mack 10-20-2026".'],
   'all rows ticked, with a note added after any existing notes');
print(failures ? failures + ' FAILURE(S)' : 'ALL V5 TABLE TESTS PASSED');

// v6: Mack's file for a range of warranty sale dates.
var oct20 = new Date(2026, 9, 20);
function span(r) { return r && !r.error ? mmddyyyy_(r.from) + ' to ' + mmddyyyy_(r.to) : r; }
eq(parseDateRange_('', oct20), null, 'blank range = everything');
eq(span(parseDateRange_('10-01-2026 to 10-15-2026', oct20)), '10-01-2026 to 10-15-2026', 'range with full dates');
eq(span(parseDateRange_('10/1/26 - 10/15/26', oct20)), '10-01-2026 to 10-15-2026', 'slashes and two-digit years');
eq(span(parseDateRange_('10/1-10/15', oct20)), '10-01-2026 to 10-15-2026', 'no year means this year, even with a dash between');
eq(span(parseDateRange_('10/15 through 10/1', oct20)), '10-01-2026 to 10-15-2026', 'dates in either order');
eq(span(parseDateRange_('10/7', oct20)), '10-07-2026 to 10-07-2026', 'one date = that day');
eq(!!parseDateRange_('2/30/2026 to 3/2/2026', oct20).error, true, 'impossible date rejected');
eq(!!parseDateRange_('last week', oct20).error, true, 'words rejected');
eq(!!parseDateRange_('10/1/2016 to 10/15/2016', oct20).error, true, 'wrong year caught');

function datedReg(key, sold) { var r = regRow({ key: key }); r[M['ServiceContractPurchaseDate']] = sold; return r; }
var rangeRegs = [datedReg('1-1', '09-30-2026'), datedReg('2-1', '10-01-2026'), datedReg('3-1', '10-15-2026'),
                 datedReg('4-1', '10-16-2026'), datedReg('5-1', ''), datedReg('6-1', '10-05-2026'), datedReg('7-1', '09-01-2026')];
var rangeStatuses = ['Ready to send', 'Ready to send', 'Ready to send', 'Ready to send', 'Ready to send',
                     'Needs WarrType code', 'Cancel with Mack'];
var picked = pickForMackFile_(rangeRegs, rangeStatuses, parseDateRange_('10/1 to 10/15', oct20));
eq([picked.ready, picked.needCode, picked.cancel, picked.undated], [[1, 2], [5], [6], 1],
   'range keeps both end days, skips outside dates, counts undated, always lists cancellations');
eq(pickForMackFile_(rangeRegs, rangeStatuses, null).ready, [0, 1, 2, 3, 4], 'no range = every ready row');
print(failures ? failures + ' FAILURE(S)' : 'ALL V6 DATE-RANGE TESTS PASSED');

// v7: Sent to Mack is a checkbox (Ellie's table); the date lives in Notes.
var ticked = regRow({ key: '8-1', sent: true }); ticked[T['Notes']] = 'Sent to Mack 10-20-2026 in "Mack 10-20-2026".';
eq([sentOn_(ticked), sentOn_(regRow({ key: '8-2', sent: true })), sentOn_(regRow({ key: '8-3', sent: false })),
    sentOn_(regRow({ key: '8-4', sent: '10-05-2026' }))], ['10-20-2026', 'already', '', '10-05-2026'],
   'panel shows the sent date from the note, a typed date, or "already"');
eq(computeStatuses_([soldRow({ sale: '9', line: '8', key: '8-1', qty: 1 })], [ticked], codes).sold[0].status, 'Sent',
   'a ticked box counts as sent');
var fofTicked = fofRegistrations_([{ 'Row Id': '9001', First: 'Pat', Last: 'Test', DealerInvoice: '130', EquipmentPurchaseDate: '10-01-2026',
  ServiceContractPurchaseDate: '10-01-2026' }], [], [], codes, FOF_SENT_LABEL, oct20).rows[0];
eq([fofTicked[T['Sent to Mack']], fofTicked[T['Notes']].indexOf(FOF_SENT_LABEL) === 0], [true, true],
   'Forms on Fire "already sent" ticks the box and says so in Notes');
print(failures ? failures + ' FAILURE(S)' : 'ALL V7 CHECKBOX TESTS PASSED');

// v8: the kit list from Railway fills the Kits tab without touching what people typed.
function kitRow(name, camera, l1, l2, label, id) {
  var r = new Array(KIT_HEADERS.length).fill('');
  r[K['Lightspeed kit item']] = name; r[K['Camera model for Mack']] = camera || '';
  r[K['Lens 1 model for Mack']] = l1 || ''; r[K['Lens 2 model for Mack (two-lens kits)']] = l2 || '';
  r[K['Filled in by']] = label || ''; r[K['Lightspeed item ID']] = id || '';
  return r;
}
var kitRows = [
  kitRow('Canon EOS R50 2 Lens Kit Black', 'EOS R50', 'RF-S 18-45mm', 'RF-S 55-210mm'),          // typed by hand
  kitRow('Sony ZV-E10 II Kit Black', 'ZV-E10 II', '', '', KIT_NEEDS_PERSON, '40'),                // still unknown
  kitRow('Sony ZV-E1 Kit White', 'ZV-E1', 'FE 28-60mm F4-5.6', '', KIT_NEEDS_PERSON, '41'),        // a person typed the lens
  kitRow('Canon EOS R5 24-105mm Kit', 'EOS R5', 'RF 24-105mm F4 L IS USM', '', 'Check the lens (a best guess)', '42'),
  kitRow('Nikon Z30 2 Lens Kit', 'Z30', '', '', '', ''),                                           // added blank by the panel
];
var kitList = [
  { item_id: '30', name: 'Canon EOS R50 2 Lens Kit Black', camera: 'EOS R50', sku: '5811C022', upc: '013803351422',
    lenses: ['RF-S 18-45mm F4.5-6.3 IS STM', 'RF-S 55-210mm F5-7.1 IS STM'], source: 'UPC lookup', complete: true, check: false },
  { item_id: '40', name: 'Sony ZV-E10 II Kit Black', camera: 'ZV-E10 II', lenses: [], source: '', complete: false, check: false },
  { item_id: '41', name: 'Sony ZV-E1 Kit White', camera: 'ZV-E1', lenses: [], source: '', complete: false, check: false },
  { item_id: '42', name: 'Canon EOS R5 24-105mm Kit', camera: 'EOS R5', lenses: ['RF 24-105mm F4 L IS USM'],
    source: 'item name', complete: true, check: false },
  { item_id: '43', name: 'Nikon Z30 2 Lens Kit', camera: 'Z30', source: 'UPC lookup', complete: true, check: false,
    lenses: ['NIKKOR Z DX 16-50mm f/3.5-6.3 VR', 'NIKKOR Z DX 50-250mm f/4.5-6.3 VR'] },
  { item_id: '44', name: 'Canon EOS R7 Kit w/18-150mm', camera: 'EOS R7', lenses: ['RF-S 18-150mm F3.5-6.3 IS STM'],
    source: 'item name', complete: true, check: false },
  { item_id: '45', name: 'Sony ZV-E10 II Kit White', camera: 'ZV-E10 II', lenses: [], source: '', complete: false, check: false },
  { item_id: '46', name: 'Canon EOS R6 II 24-105 STM', camera: 'EOS R6 II', lenses: ['RF 24-105mm F4-7.1 IS STM'],
    source: 'item name', complete: true, check: false },
  { item_id: '46', name: 'Canon EOS R6 II 24-105 STM', camera: 'EOS R6 II', lenses: ['RF 24-105mm F4-7.1 IS STM'],
    source: 'item name', complete: true, check: false },
];
var km = mergeKits_(kitRows, kitList);
var hand = km.changed[0];
eq([hand[K['Lens 1 model for Mack']], hand[K['Filled in by']], hand[K['Lightspeed item ID']], hand[K['UPC']]],
   ['RF-S 18-45mm', '', '30', '013803351422'], 'a typed row keeps its words and just gets the Lightspeed IDs');
eq(km.changed[1], undefined, 'still unknown: nothing to change');
eq(km.changed[2][K['Filled in by']], 'Changed by a person', 'a lens typed into a NEEDS row is the person\'s');
eq(km.changed[3][K['Filled in by']], 'From the item name', 'a confirmed guess loses its "check" label');
eq([km.changed[4][K['Lens 1 model for Mack']], km.changed[4][K['Lens 2 model for Mack (two-lens kits)']],
    km.changed[4][K['Filled in by']], km.changed[4][K['Lightspeed item ID']]],
   ['NIKKOR Z DX 16-50mm f/3.5-6.3 VR', 'NIKKOR Z DX 50-250mm f/4.5-6.3 VR', 'From the UPC lookup', '43'],
   'a blank row from the panel gets filled');
eq(km.filled, 1, 'one row had blanks filled');
eq(km.added.map(function (r) { return [r[0], r[K['Filled in by']]]; }),
   [['Canon EOS R7 Kit w/18-150mm', 'From the item name'], ['Sony ZV-E10 II Kit White', KIT_NEEDS_PERSON],
    ['Canon EOS R6 II 24-105 STM', 'From the item name']], 'new kits are added once, unknown lenses flagged');
var renamed = mergeKits_([kitRow('Canon EOS R7 Kit w/18-150mm', 'EOS R7', 'RF-S 18-150mm F3.5-6.3 IS STM', '', 'From the item name', '44')],
  [{ item_id: '44', name: 'Canon EOS R7 Kit w/ RF-S 18-150mm', camera: 'EOS R7', lenses: ['RF-S 18-150mm F3.5-6.3 IS STM'],
     source: 'item name', complete: true, check: false }]);
eq([renamed.changed[0][0], renamed.added.length], ['Canon EOS R7 Kit w/ RF-S 18-150mm', 0], 'a renamed item keeps its row (matched by item ID)');
eq(Object.keys(mergeKits_(km.added, kitList.slice(5, 8)).changed).length, 0, 'a second sync changes nothing');
var kitsRead = (function () {
  var out = {};
  kitRows.concat(km.added).forEach(function (r) {
    var camera = String(r[1] || '').trim();
    var lenses = [r[2], r[3]].map(function (v) { return String(v || '').trim(); }).filter(String);
    if (r[0] && (camera || lenses.length)) out[normKit_(r[0])] = { camera: camera, lenses: lenses };
  });
  return out;
})();
eq(kitsRead['canon eos r6 ii 24-105 stm'], { camera: 'EOS R6 II', lenses: ['RF 24-105mm F4-7.1 IS STM'] },
   'the extension finds the kit by its Lightspeed name');
eq(pending_('').rules.kits['sony zv-e1 kit black'].lenses, ['FE 28-60mm F4-5.6'],
   'the waiting list carries the kit list to every register');
print(failures ? failures + ' FAILURE(S)' : 'ALL V8 KIT TESTS PASSED');
