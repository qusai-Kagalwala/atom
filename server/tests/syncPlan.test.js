// Pure parts of the Idarah sync and employee import. No database, no SQL Server.
jest.mock('../db/pool', () => ({}));

const { buildPlan, checkGuard, resolvePerson } = require('../modules/sync/idarahPlan');
const { compareColumns, canonicalType } = require('../modules/sync/mirror');
const { toPgType } = require('../modules/sync/sqlServer');
const { planImport } = require('../modules/sync/employeeImport');

describe('resolvePerson', () => {
  it.each([
    [{ EJamaat_No: '20305503' }, { kind: 'ITS', id: '20305503', viaTeacherId: false }],
    [{ ejamaat_no: ' 20305503 ' }, { kind: 'ITS', id: '20305503', viaTeacherId: false }],
    [{ ejamaat_no: 20305503 }, { kind: 'ITS', id: '20305503', viaTeacherId: false }],
    [{ ejamaat_no: '', teacher_id: '20304582' }, { kind: 'ITS', id: '20304582', viaTeacherId: true }],
    [{ ejamaat_no: null, teacher_id: '1301' }, { kind: 'EMPLOYEE', id: '1301' }],
    [{ ejamaat_no: '1234' }, { skip: 'invalid_ejamaat_no' }],
    [{ ejamaat_no: '' , teacher_id: '' }, { skip: 'no_person_id' }],
    [{ ejamaat_no: null, teacher_id: '123456789' }, { skip: 'no_person_id' }],
  ])('%j', (raw, expected) => {
    const lower = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
    expect(resolvePerson(lower)).toEqual(expected);
  });
});

describe('buildPlan', () => {
  const rows = [
    { Idarah_Id: '6053', DPTNM: 'Insha', EJamaat_No: '20305503', U_NAME: 'Raja', T_Name: 'راجا', T_Email: 'b@x', Post: 'Musaid' },
    { Idarah_Id: '6053', DPTNM: 'Insha', EJamaat_No: '20305503', U_NAME: '', T_Email: 'a@x', Post: 'Masool' },
    { Idarah_Id: '6053', DPTNM: 'Insha', EJamaat_No: '20305503', Post: 'Masool' }, // duplicate post
    { Idarah_Id: '6002', DPTNM: 'Exec', Teacher_Id: '20304582', EJamaat_No: '', Post: 'Musaid' },
    { Idarah_Id: '6026', DPTNM: 'Arts', Teacher_Id: '1301', DPT_Email: 'arts@x', Post: 'Musaid' },
    { Idarah_Id: '6026', EJamaat_No: 'abc' },
    { Idarah_Id: null, Post: 'Orphan designation' },
  ];

  const plan = buildPlan(rows);

  it('counts rows, valid rows and skip reasons', () => {
    expect(plan.counts).toEqual({
      sourceRows: 7,
      validRows: 5,
      skippedRows: 2,
      skipped: { no_idarah_id: 1, invalid_ejamaat_no: 1, no_person_id: 0 },
      viaTeacherId: 1,
      employeeRows: 1,
    });
  });

  it('builds one department per Idarah, including ones with only skipped people', () => {
    expect(plan.departments.map((d) => d.idarahId).sort()).toEqual(['6002', '6026', '6053']);
    expect(plan.departments.find((d) => d.idarahId === '6026')).toMatchObject({ name: 'Arts', email: 'arts@x' });
  });

  it('builds one person per ITS number, first non-empty value in a stable order', () => {
    expect(plan.people).toHaveLength(2);
    const raja = plan.people.find((p) => p.its === '20305503');
    // Rows sort by post: "Masool" (email a@x) comes before "Musaid" (email b@x).
    expect(raja).toEqual({ its: '20305503', name: 'Raja', nameArabic: 'راجا', email: 'a@x' });
  });

  it('gives the same result whatever order the view returns rows in', () => {
    expect(buildPlan([...rows].reverse())).toEqual(plan);
  });

  it('dedupes posts and keeps employee-ID posts', () => {
    expect(plan.posts.map((p) => `${p.ownerKind}:${p.ownerId}:${p.idarahId}:${p.post}`).sort()).toEqual([
      'EMPLOYEE:1301:6026:Musaid',
      'ITS:20304582:6002:Musaid',
      'ITS:20305503:6053:Masool',
      'ITS:20305503:6053:Musaid',
    ]);
  });
});

describe('checkGuard', () => {
  it('blocks 0 usable rows, even forced', () => {
    expect(checkGuard(0, null, false).ok).toBe(false);
    expect(checkGuard(0, 100, true).ok).toBe(false);
  });
  it('blocks under 50% of the last good run unless forced', () => {
    expect(checkGuard(49, 100, false).ok).toBe(false);
    expect(checkGuard(49, 100, true).ok).toBe(true);
    expect(checkGuard(50, 100, false).ok).toBe(true);
  });
  it('passes on the very first run', () => {
    expect(checkGuard(5, null, false).ok).toBe(true);
  });
});

describe('toPgType', () => {
  const col = (declaration, extra = {}) => ({ type: { declaration }, ...extra });
  it.each([
    ['nvarchar', 'text'], ['varchar', 'text'], ['int', 'integer'], ['smallint', 'integer'],
    ['bigint', 'bigint'], ['bit', 'boolean'], ['datetime', 'timestamp'], ['datetime2', 'timestamp'],
    ['date', 'date'], ['float', 'double precision'], ['uniqueidentifier', 'text'],
  ])('%s → %s', (decl, pg) => expect(toPgType(col(decl))).toBe(pg));
  it('keeps decimal precision/scale', () => {
    expect(toPgType(col('decimal', { precision: 10, scale: 2 }))).toBe('numeric(10,2)');
  });
});

describe('compareColumns', () => {
  const src = [{ name: 'Idarah_Id', pgType: 'text' }, { name: 'Yr', pgType: 'integer' }];

  it('creates everything when the mirror does not exist', () => {
    const r = compareColumns(src, null);
    expect(r).toMatchObject({ problems: [], creating: true });
    expect(r.columns.map((c) => c.name)).toEqual(['idarah_id', 'yr']);
  });

  it('adds new columns', () => {
    const r = compareColumns([...src, { name: 'New', pgType: 'text' }], new Map([['idarah_id', 'text'], ['yr', 'integer']]));
    expect(r.problems).toEqual([]);
    expect(r.toAdd).toEqual([{ name: 'new', pgType: 'text' }]);
  });

  it('reports removed/renamed and retyped columns by name', () => {
    const r = compareColumns([{ name: 'Yr', pgType: 'text' }], new Map([['idarah_id', 'text'], ['yr', 'integer']]));
    expect(r.problems).toEqual([
      'Column "yr" changed type: was integer, now text.',
      'Column "idarah_id" is missing from the view (removed or renamed).',
    ]);
  });

  it('treats timestamp spellings as equal', () => {
    expect(canonicalType('timestamp')).toBe('timestamp without time zone');
    const r = compareColumns([{ name: 'At', pgType: 'timestamp' }], new Map([['at', 'timestamp without time zone']]));
    expect(r.problems).toEqual([]);
  });

  it('rejects two columns whose names differ only by case', () => {
    expect(compareColumns([{ name: 'A', pgType: 'text' }, { name: 'a', pgType: 'text' }], null).problems).toHaveLength(1);
  });
});

describe('planImport', () => {
  it('skips ITS IDs and existing users; keeps passwords exactly; reports errors without passwords', () => {
    const plan = planImport(
      [
        { User_Id: '1002', Password: ' keep spaces ' },
        { User_Id: '20305503', Password: 'x' },
        { User_Id: '1003', Password: 'p' },
        { User_Id: '1002', Password: 'dup' },
        { User_Id: '1004', Password: '' },
        { User_Id: null, Password: 'p' },
      ],
      new Set(['1003'])
    );
    expect(plan.toImport).toEqual([{ id: '1002', password: ' keep spaces ' }]);
    expect(plan.itsSkipped).toBe(1);
    expect(plan.alreadyInAtom).toEqual(['1003']);
    expect(plan.errors).toEqual([
      { row: 4, id: '1002', reason: 'Duplicate User_Id (also on row 1).' },
      { row: 5, id: '1004', reason: 'Empty password.' },
      { row: 6, id: '(blank)', reason: 'User_Id is not a number of 1–7 digits.' },
    ]);
  });
});
