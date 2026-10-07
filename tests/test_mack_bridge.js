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
   'Item 2 needs a serial number (or N/A).'], 'problems listed');
eq(parsePlan_('Mack 1 Yr Used Photo Under $1,000 OL'), { years: 1, coverage: 1000, condition: 'Used' }, 'parsePlan');
eq(shortName_('Pat Q Test'), 'Pat T.', 'shortName');

print(failures ? failures + ' FAILURE(S)' : 'ALL BRIDGE TESTS PASSED');
