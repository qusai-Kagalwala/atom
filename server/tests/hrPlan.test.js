// Phase 3.1: HR view → plan (pure, no DB).
const { buildHrPlan, titleCase, normaliseFloor, locationLabel } = require('../modules/sync/hrPlan');

test('titleCase: only ALL-CAPS names are converted; mixed case is kept', () => {
  expect(titleCase('TASNEEM BAI MOHAMMED BHAI SUTERWALA')).toBe('Tasneem Bai Mohammed Bhai Suterwala');
  expect(titleCase('  MOHD   ISMAIL C SHAIKH ')).toBe('Mohd Ismail C Shaikh');
  expect(titleCase("D'SOUZA-KHAN")).toBe("D'Souza-Khan");
  expect(titleCase('Shaikh Shabbir bhai Khomosi')).toBe('Shaikh Shabbir bhai Khomosi');
  expect(titleCase('   ')).toBeNull();
  expect(titleCase(null)).toBeNull();
});

test('normaliseFloor and locationLabel', () => {
  expect(normaliseFloor('SECOND')).toBe('Second');
  expect(normaliseFloor('Sixth ')).toBe('Sixth');
  expect(normaliseFloor('b1')).toBe('B1');
  expect(normaliseFloor('Mezzanine')).toBe('Mezzanine');
  expect(normaliseFloor('  ')).toBeNull();
  expect(locationLabel({ building: 'Admin Bldg', floor: 'Sixth', roomNo: '1615' })).toBe('Admin Bldg · Sixth floor · Room 1615');
  expect(locationLabel({ building: 'Admin Bldg', floor: 'B1', roomNo: null })).toBe('Admin Bldg · B1');
  expect(locationLabel({ building: null, floor: null, roomNo: null })).toBeNull();
});

test('buildHrPlan: short IDs become staff, 8-digit rows only count for departments, duplicates merge', () => {
  const plan = buildHrPlan([
    { Dept_ID: 6043, user_id: '1301', U_name: null, DPTNM: 'Quranic Arts', ROOMNO: '4202', FLOOR: 'SECOND', LOCATION: 'MAHAD AL ZAHRA' },
    { Dept_ID: 6043, user_id: '1301', U_name: 'TASNEEM AZIZ', DPTNM: 'Quranic Arts', ROOMNO: '4202', FLOOR: 'SECOND', LOCATION: 'MAHAD AL ZAHRA' },
    { Dept_ID: 6013, user_id: '20309076', U_name: 'Shaikh Shabbir', DPTNM: 'Culture', ROOMNO: '          ', FLOOR: null, LOCATION: 'ADMIN BLDG' },
    { Dept_ID: 6013, user_id: 'abc', U_name: 'Bad' },
    { Dept_ID: null, user_id: '1500', U_name: 'No dept' },
  ]);
  expect(plan.counts).toEqual({ sourceRows: 5, validRows: 2, itsRows: 1, skippedRows: 2, skipped: { invalid_user_id: 1, no_department: 1 } });
  expect(plan.people).toEqual([{ employeeId: '1301', name: 'Tasneem Aziz', departmentIds: ['6043'] }]);
  expect(plan.departments.find((d) => d.idarahId === '6043')).toMatchObject({ building: 'Mahad Al Zahra', floor: 'Second', roomNo: '4202' });
  const culture = plan.departments.find((d) => d.idarahId === '6013');
  expect(culture.building).toBe('Admin Bldg');
  expect(culture.roomNo ?? null).toBeNull(); // a blank ROOMNO ("          ") is no room
});
