// Real-PostgreSQL test of the Idarah sync and the employee-ID import. SQL Server is faked.
// Runs ONLY when TEST_DATABASE_URL points at a database whose name ends in "_test":
//   TEST_DATABASE_URL=postgresql://postgres:root@localhost:5432/atom_test npx jest integration
// It wipes ATOM's tables in that database before every test. Skipped otherwise.
const { Pool } = require('pg');
const { runMigrations } = require('../../db/migrate');
const { runIdarahSync } = require('../../modules/sync/idarahSync');
const { runEmployeeImport } = require('../../modules/sync/employeeImport');

const URL_ENV = process.env.TEST_DATABASE_URL || '';
const dbName = (() => {
  try {
    return new URL(URL_ENV).pathname.slice(1);
  } catch {
    return '';
  }
})();
const enabled = /_test$/.test(dbName);
const maybe = enabled ? describe : describe.skip;

// The view's 21 columns, in order, with the types the mssql reader would report.
const COLUMNS = [
  ['Idarah_Id', 'text'], ['DPTNM', 'text'], ['Teacher_Id', 'text'], ['T_Name', 'text'], ['Yr', 'integer'],
  ['Post', 'text'], ['Post_TBQ', 'text'], ['DPTNM_ARABIC', 'text'], ['IDarahCat', 'text'],
  ['IDarahCat_Arabic', 'text'], ['Idarah_Intercom', 'text'], ['Expr1', 'text'], ['EJamaat_No', 'text'],
  ['Post_Id', 'integer'], ['Post_Category', 'text'], ['U_NAME', 'text'], ['T_Email', 'text'],
  ['Mobile', 'text'], ['DPT_Email', 'text'], ['Posr_Abbrv', 'text'], ['Office_No', 'text'],
].map(([name, pgType]) => ({ name, pgType }));

function row(over) {
  const base = Object.fromEntries(COLUMNS.map((c) => [c.name, null]));
  return { ...base, Yr: 1448, IDarahCat: 'TLM', ...over };
}

// Shaped like the real sample rows (24 Oct 2026).
const BASE_ROWS = [
  row({ Idarah_Id: '6053', DPTNM: 'Insha al-Nazm', Expr1: 'Insha al-Nazm', DPTNM_ARABIC: 'ادارة التمرين على انشاء النظم',
    Teacher_Id: '20305503', EJamaat_No: '20305503', T_Name: ' الشيخ ابراهيم بهائي ', U_NAME: 'Shaikh Ebrahim bhai Raja',
    T_Email: 'esharaja@example.edu', Mobile: '9820000001', Post: 'Masool (HOD)' }),
  row({ Idarah_Id: '6053', DPTNM: 'Insha al-Nazm', EJamaat_No: '20305503', Teacher_Id: '20305503',
    U_NAME: 'Shaikh Ebrahim bhai Raja', Post: 'Musaid' }), // same person, second post
  row({ Idarah_Id: '6002', DPTNM: 'Executive Council', Teacher_Id: '20304582', EJamaat_No: '',
    Post: 'Musaid' }), // no EJamaat_No → Teacher_Id fallback
  row({ Idarah_Id: '6026', DPTNM: 'Department of Arts and Vocational Training', Teacher_Id: '1301',
    Post: 'Musaid', DPT_Email: 'vocational@example.edu' }), // employee-ID post
  row({ Idarah_Id: '6010', DPTNM: 'Library', EJamaat_No: '30328701', U_NAME: 'From View Name', Post: 'Member' }), // manual dev account
  row({ Idarah_Id: '6010', DPTNM: 'Library', EJamaat_No: '40000001', U_NAME: 'Person One', T_Email: 'one@example.edu', Post: 'Member' }),
  row({ Idarah_Id: '6010', DPTNM: 'Library', EJamaat_No: '40000002', U_NAME: 'Person Two', Post: 'Member' }),
  row({ Idarah_Id: '6010', DPTNM: 'Library', EJamaat_No: '1234', U_NAME: 'Bad ITS', Post: 'Member' }), // invalid → skipped
  row({ Idarah_Id: null, Post: 'Unfilled designation' }), // FULL OUTER JOIN row → skipped
];

const source = (rows, columns = COLUMNS) => async () => ({ columns, rows: rows.map((r) => ({ ...r })) });
const quiet = () => {};

maybe('Idarah sync + employee import on real PostgreSQL', () => {
  let pool;

  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const sync = (rows, opts = {}) => runIdarahSync({ pool, readSource: source(rows, opts.columns), log: quiet, force: opts.force });
  const user = async (its) => (await q('SELECT * FROM users WHERE its_number = $1', [its]))[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL_ENV, max: 4 });
    const client = await pool.connect();
    try {
      await runMigrations(client, { log: quiet });
    } finally {
      client.release();
    }
  });

  afterAll(async () => pool && pool.end());

  beforeEach(async () => {
    await pool.query(`TRUNCATE user_posts, user_status_log, user_roles, password_reset_tokens, users, departments,
                      src.sync_runs RESTART IDENTITY CASCADE`);
    await pool.query('DROP TABLE IF EXISTS src.idarah_tafveez_current_yr');
    // The developer's manual account (as seeded in dev).
    const { rows } = await pool.query(
      `INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', '30328701', 'Qusai Kagalwala', 'manual') RETURNING id`
    );
    await pool.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, 'EMPLOYEE'), ($1, 'ENGINEER'), ($1, 'SUPER_ADMIN')`,
      [rows[0].id]
    );
  });

  test('first run: mirror, departments, users, posts, roles, logs', async () => {
    const r = await sync(BASE_ROWS);
    expect(r.status).toBe('success');
    expect(r.counts).toMatchObject({ sourceRows: 9, validRows: 7, skippedRows: 2 });
    expect(r.summary.skipped).toMatchObject({ no_idarah_id: 1, invalid_ejamaat_no: 1, employee_id_not_in_atom: 1 });
    expect(r.summary.viaTeacherId).toBe(1);

    // Mirror = exact copy of all 9 rows, lower-cased columns.
    expect((await q('SELECT count(*)::int AS n FROM src.idarah_tafveez_current_yr'))[0].n).toBe(9);
    const cols = await q(`SELECT column_name FROM information_schema.columns
                           WHERE table_schema='src' AND table_name='idarah_tafveez_current_yr' ORDER BY ordinal_position`);
    expect(cols.map((c) => c.column_name)).toEqual(COLUMNS.map((c) => c.name.toLowerCase()));

    // Departments: 4 (incl. the one only an employee-ID row points at).
    expect((await q('SELECT idarah_id FROM departments ORDER BY idarah_id')).map((d) => d.idarah_id))
      .toEqual(['6002', '6010', '6026', '6053']);
    expect((await q(`SELECT email FROM departments WHERE idarah_id='6026'`))[0].email).toBe('vocational@example.edu');

    // New ITS users: names (English + trimmed Arabic), Employee role, source idarah, status log.
    const raja = await user('20305503');
    expect(raja).toMatchObject({ name: 'Shaikh Ebrahim bhai Raja', name_arabic: 'الشيخ ابراهيم بهائي', source: 'idarah', is_active: true, name_language: 'en' });
    expect((await q('SELECT role FROM user_roles WHERE user_id=$1', [raja.id])).map((x) => x.role)).toEqual(['EMPLOYEE']);
    expect(await q('SELECT source, is_active FROM user_status_log WHERE user_id=$1', [raja.id])).toEqual([{ source: 'sync', is_active: true }]);
    expect(await user('20304582')).toMatchObject({ source: 'idarah', name: null }); // via Teacher_Id
    expect(await user('1234')).toBeUndefined();

    // Two posts for Raja.
    expect((await q('SELECT post FROM user_posts WHERE user_id=$1 ORDER BY post', [raja.id])).map((p) => p.post))
      .toEqual(['Masool (HOD)', 'Musaid']);

    // Manual dev account: untouched (name, roles) but gets its post.
    const me = await user('30328701');
    expect(me).toMatchObject({ name: 'Qusai Kagalwala', source: 'manual', is_active: true });
    expect((await q('SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1', [me.id]))[0].n).toBe(3);
    expect((await q('SELECT count(*)::int AS n FROM user_posts WHERE user_id=$1', [me.id]))[0].n).toBe(1);

    const run = (await q('SELECT status, valid_rows FROM src.sync_runs'))[0];
    expect(run).toEqual({ status: 'success', valid_rows: 7 });
  });

  test('second identical run changes nothing', async () => {
    await sync(BASE_ROWS);
    const before = await q('SELECT id, updated_at FROM users ORDER BY id');
    const r = await sync(BASE_ROWS);
    expect(r.summary.users).toMatchObject({ created: 0, updated: 0, reactivated: 0, deactivated: 0 });
    expect(r.summary.posts).toMatchObject({ created: 0, deactivated: 0 });
    expect(r.summary.departments).toMatchObject({ created: 0, deactivated: 0 });
    expect(await q('SELECT id, updated_at FROM users ORDER BY id')).toEqual(before);
  });

  test('person leaves → inactive + post inactive; comes back → same record reactivated', async () => {
    await sync(BASE_ROWS);
    const id = (await user('40000002')).id;

    const without = BASE_ROWS.filter((r) => r.EJamaat_No !== '40000002');
    const r1 = await sync(without);
    expect(r1.summary.users.deactivated).toBe(1);
    expect((await user('40000002')).is_active).toBe(false);
    expect((await q('SELECT is_active FROM user_posts WHERE user_id=$1', [id]))[0].is_active).toBe(false);

    const r2 = await sync(BASE_ROWS);
    expect(r2.summary.users.reactivated).toBe(1);
    const back = await user('40000002');
    expect(back).toMatchObject({ id, is_active: true });
    expect((await q('SELECT is_active FROM user_posts WHERE user_id=$1', [id]))[0].is_active).toBe(true);
    expect((await q('SELECT is_active, reason FROM user_status_log WHERE user_id=$1 ORDER BY id', [id])).map((l) => l.is_active))
      .toEqual([true, false, true]);
  });

  test('a user deactivated by a Super Admin stays inactive even though they are in the view', async () => {
    await sync(BASE_ROWS);
    const u = await user('40000001');
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [u.id]);
    await pool.query(`INSERT INTO user_status_log (user_id, is_active, source, reason) VALUES ($1, FALSE, 'super_admin', 'Left')`, [u.id]);

    const r = await sync(BASE_ROWS);
    expect(r.summary.users.keptInactive).toBe(1);
    expect((await user('40000001')).is_active).toBe(false);
  });

  test('empty values in the view never wipe stored data; new values overwrite', async () => {
    await sync(BASE_ROWS);
    const rows = BASE_ROWS.map((r) =>
      r.EJamaat_No === '40000001' ? { ...r, T_Email: '', Mobile: '9999999999' } : r
    );
    await sync(rows);
    expect(await user('40000001')).toMatchObject({ email: 'one@example.edu', mobile: '9999999999' });
  });

  test('department missing from the view → inactive, kept', async () => {
    await sync(BASE_ROWS);
    await sync(BASE_ROWS.filter((r) => r.Idarah_Id !== '6002'));
    expect((await q(`SELECT is_active FROM departments WHERE idarah_id='6002'`))[0].is_active).toBe(false);
  });

  test('guard: under 50% of the last good run is blocked, data kept; --force accepts', async () => {
    await sync(BASE_ROWS); // 7 valid
    const few = BASE_ROWS.filter((r) => r.EJamaat_No === '20305503'); // 2 valid
    const blocked = await sync(few);
    expect(blocked.status).toBe('blocked');
    expect((await user('40000001')).is_active).toBe(true); // nothing changed
    expect((await q('SELECT count(*)::int AS n FROM src.idarah_tafveez_current_yr'))[0].n).toBe(9);

    const forced = await sync(few, { force: true });
    expect(forced.status).toBe('success');
    expect((await user('40000001')).is_active).toBe(false);
  });

  test('guard: 0 usable rows is blocked even when forced', async () => {
    await sync(BASE_ROWS);
    const r = await sync([], { force: true });
    expect(r.status).toBe('blocked');
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE is_active`))[0].n).toBe(5);
  });

  test('removed column stops the run and names it; new column is added', async () => {
    await sync(BASE_ROWS);

    const fewerCols = COLUMNS.filter((c) => c.name !== 'Office_No');
    const failed = await sync(BASE_ROWS, { columns: fewerCols });
    expect(failed.status).toBe('failed');
    expect(failed.message).toMatch(/"office_no" is missing/);

    const retyped = COLUMNS.map((c) => (c.name === 'Yr' ? { ...c, pgType: 'text' } : c));
    expect((await sync(BASE_ROWS, { columns: retyped })).message).toMatch(/"yr" changed type/);

    const moreCols = [...COLUMNS, { name: 'New_Col', pgType: 'text' }];
    const ok = await sync(BASE_ROWS.map((r) => ({ ...r, New_Col: 'x' })), { columns: moreCols });
    expect(ok.status).toBe('success');
    expect(ok.summary.columnsAdded).toEqual(['new_col']);
    expect((await q('SELECT count(*)::int AS n FROM src.idarah_tafveez_current_yr WHERE new_col = $1', ['x']))[0].n).toBe(9);
  });

  test('a database error rolls everything back and logs the run as failed', async () => {
    await sync(BASE_ROWS);
    const bad = BASE_ROWS.map((r) => (r.EJamaat_No === '40000001' ? { ...r, Post_Id: 'not-a-number' } : r));
    const r = await sync(bad.map((x) => ({ ...x, U_NAME: x.U_NAME ? `${x.U_NAME} CHANGED` : x.U_NAME })));
    expect(r.status).toBe('failed');
    expect((await user('40000002')).name).toBe('Person Two'); // rolled back
    const runs = await q('SELECT status FROM src.sync_runs ORDER BY id');
    expect(runs.map((x) => x.status)).toEqual(['success', 'failed']);
  });

  test('overlapping run is skipped (advisory lock)', async () => {
    const holder = await pool.connect();
    await holder.query('SELECT pg_advisory_lock(727302)');
    try {
      expect((await sync(BASE_ROWS)).status).toBe('busy');
    } finally {
      await holder.query('SELECT pg_advisory_unlock(727302)');
      holder.release();
    }
  });

  test('employee import: dry run saves nothing; commit imports; sync then attaches the 1301 post', async () => {
    const loginMaster = async () => [
      { User_Id: '1301', Password: 'pw-1301' },
      { User_Id: ' 1302 ', Password: 'pw 1302 ' }, // ID trimmed, password kept exactly
      { User_Id: '20305503', Password: 'its-pw' }, // 8-digit → skipped
    ];

    const dry = await runEmployeeImport({ pool, readSource: loginMaster });
    expect(dry).toMatchObject({ mode: 'dry-run', total: 3, itsSkipped: 1, toImport: 2, saved: false });
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE login_type='EMPLOYEE_ID'`))[0].n).toBe(0);

    const done = await runEmployeeImport({ pool, readSource: loginMaster, commit: true });
    expect(done).toMatchObject({ imported: 2, saved: true });
    const e = (await q(`SELECT * FROM users WHERE employee_id='1302'`))[0];
    expect(e).toMatchObject({ legacy_password: 'pw 1302 ', source: 'legacy', name: null, is_active: true });
    expect((await q('SELECT role FROM user_roles WHERE user_id=$1', [e.id]))[0].role).toBe('EMPLOYEE');
    expect((await q('SELECT source FROM user_status_log WHERE user_id=$1', [e.id]))[0].source).toBe('import');
    expect(JSON.stringify(done)).not.toMatch(/pw-1301|pw 1302|its-pw/);

    const again = await runEmployeeImport({ pool, readSource: loginMaster, commit: true });
    expect(again).toMatchObject({ alreadyInAtom: 2, toImport: 0, imported: 0 });
    expect(await user('20305503')).toBeUndefined(); // ITS row never becomes a user here

    const r = await sync(BASE_ROWS);
    expect(r.summary.skipped.employee_id_not_in_atom).toBe(0);
    const post = await q(`SELECT d.idarah_id FROM user_posts p JOIN users u ON u.id=p.user_id
                           JOIN departments d ON d.id=p.department_id WHERE u.employee_id='1301'`);
    expect(post).toEqual([{ idarah_id: '6026' }]);
  });

  test('employee import: one bad row → nothing saved, errors listed without passwords', async () => {
    const loginMaster = async () => [
      { User_Id: '1401', Password: 'secret-a' },
      { User_Id: '1401', Password: 'secret-b' },
      { User_Id: '1402', Password: '   ' },
      { User_Id: 'AB12', Password: 'secret-c' },
    ];
    const r = await runEmployeeImport({ pool, readSource: loginMaster, commit: true });
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.reason)).toEqual([
      'Duplicate User_Id (also on row 1).',
      'Empty password.',
      'User_Id is not a number of 1–7 digits.',
    ]);
    expect(JSON.stringify(r)).not.toMatch(/secret/);
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE login_type='EMPLOYEE_ID'`))[0].n).toBe(0);
  });
});

if (!enabled) {
  test('integration tests skipped (set TEST_DATABASE_URL to a *_test database to run them)', () => {
    expect(enabled).toBe(false);
  });
}
