// Phase 8.2: occupancy sheet → seats (pure).
const { buildOccupancyPlan, parseRoom, parseCubicle, personIds } = require('../modules/sync/occupancyPlan');

test('room and cubicle formats', () => {
  expect(parseRoom('1615')).toEqual({ roomNo: '1615', cubicle: '' });
  expect(parseRoom('1615-c')).toEqual({ roomNo: '1615', cubicle: 'C' });
  expect(parseRoom('1615 C')).toEqual({ roomNo: '1615', cubicle: 'C' });
  expect(parseRoom('1615/B')).toEqual({ roomNo: '1615', cubicle: 'B' });
  expect(parseRoom('Room 1615C')).toEqual({ roomNo: '1615', cubicle: 'C' });
  expect(parseRoom('Reception')).toBeNull();
  expect(parseRoom('16150')).toBeNull();
  expect(parseCubicle('Cubicle d')).toBe('D');
  expect(parseCubicle('E')).toBe('E');
  expect(parseCubicle('Reception')).toBe('');
  expect(personIds('1301 / 30328701')).toEqual(['1301', '30328701']);
  expect(personIds('-')).toEqual([]);
});

test('headers found by name (banner row above), several people per row, bad rows counted', () => {
  const rows = [
    ['MAROL INTERCOM DIRECTORY', '', '', '', '', '', '', '', '', ''],
    ['S.No', 'Building', 'Floor', 'Department', 'Room No', 'Place', 'ITS/Emp ID', 'Name', 'Intercom', 'DID No'],
    ['1', 'Admin Bldg', 'Sixth', 'Accounts', '1615', 'C', '30328701', 'A', '615', '022-1'],
    ['2', 'Admin Bldg', 'Sixth', 'Accounts', '1615-D', '', '1301, 1302', 'B / C', '616', ''],
    ['3', 'Admin Bldg', 'Sixth', 'Accounts', '1615', 'C', '30328701', 'A again', '', ''],
    ['4', 'Admin Bldg', 'Ground', 'Reception', 'Reception', '', '1400', 'D', '', ''],
    ['5', 'Admin Bldg', 'Ground', 'Vacant', '1001', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
  ];
  const plan = buildOccupancyPlan([{ tab: 'ADMIN BLDG', rows }]);
  expect(plan.occupants).toEqual([
    { personId: '30328701', roomNo: '1615', cubicle: 'C', building: 'Admin Bldg', floor: 'Sixth', department: 'Accounts', intercom: '615', didNo: '022-1', tab: 'ADMIN BLDG' },
    { personId: '1301', roomNo: '1615', cubicle: 'D', building: 'Admin Bldg', floor: 'Sixth', department: 'Accounts', intercom: '616', didNo: null, tab: 'ADMIN BLDG' },
    { personId: '1302', roomNo: '1615', cubicle: 'D', building: 'Admin Bldg', floor: 'Sixth', department: 'Accounts', intercom: '616', didNo: null, tab: 'ADMIN BLDG' },
  ]);
  expect(plan.counts).toMatchObject({ sourceRows: 5, validRows: 3, skippedRows: 2, skipped: { no_person_id: 1, no_room: 1 } });
  expect(plan.counts.tabs).toEqual([{ tab: 'ADMIN BLDG', rows: 3, header: true }]);
});

test('no recognisable header → fixed A–J columns, first row skipped', () => {
  const rows = [
    ['merged banner'],
    ['1', 'Maskan', '2nd', 'Hostel', '2021', 'A', '1500', 'E', '', ''],
  ];
  const plan = buildOccupancyPlan([{ tab: 'X', rows }]);
  expect(plan.occupants).toEqual([expect.objectContaining({ personId: '1500', roomNo: '2021', cubicle: 'A', building: 'Maskan' })]);
  expect(plan.counts.tabs[0].header).toBe(false);
});
