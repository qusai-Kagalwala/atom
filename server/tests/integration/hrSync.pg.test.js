// Phase 3.1: HR staff sync (dbo.Vw_User_Department_Details_New) + temporary-password sign-in,
// on real PostgreSQL. SQL Server is faked; eJamaat mocked.
// Runs ONLY when TEST_DATABASE_URL points at a database whose name ends in "_test".
const URL_ENV = process.env.TEST_DATABASE_URL || '';
let parsed = null;
try {
  parsed = new URL(URL_ENV);
} catch {
  /* not set */
}
const enabled = Boolean(parsed && /_test$/.test(parsed.pathname.slice(1)));
if (enabled) {
  process.env.PG_HOST = parsed.hostname;
  process.env.PG_PORT = parsed.port || '5432';
  process.env.PG_DATABASE = parsed.pathname.slice(1);
  process.env.PG_USER = decodeURIComponent(parsed.username);
  process.env.PG_PASSWORD = decodeURIComponent(parsed.password);
}

jest.mock('../../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));

const maybe = enabled ? describe : describe.skip;

// The view's 12 columns, in order (types as the mssql reader reports them).
const COLUMNS = [
  ['Dept_ID', 'integer'], ['user_id', 'text'], ['DPTNM', 'text'], ['DPTNM_ARABIC', 'text'], ['IDarahCat', 'text'],
  ['IDarahCat_Arabic', 'text'], ['DPT_Email', 'text'], ['ROOMNO', 'text'], ['FLOOR', 'text'], ['LOCATION', 'text'],
  ['U_name', 'text'], ['Office_No', 'text'],
].map(([name, pgType]) => ({ name, pgType }));

const DEPTS = {
  6005: { DPTNM: 'Office of Administrative Affairs', DPT_Email: 'admin.marol@example.edu', ROOMNO: '1017', FLOOR: 'Ground', LOCATION: 'ADMIN BLDG' },
  6013: { DPTNM: 'Culture Générale', DPTNM_ARABIC: 'مكتب مرحلة الثقافة العامة', ROOMNO: '1615', FLOOR: 'Sixth ', LOCATION: 'ADMIN BLDG' },
  6035: { DPTNM: 'Facilities Management', ROOMNO: '1001', FLOOR: 'Ground', LOCATION: 'ADMIN BLDG' },
  6043: { DPTNM: 'Department of Quranic Arts', ROOMNO: '4202', FLOOR: 'SECOND', LOCATION: 'MAHAD AL ZAHRA' },
};

function row(dept, userId, name) {
  return {
    Dept_ID: dept, user_id: userId, DPTNM_ARABIC: null, IDarahCat: 'TLM', IDarahCat_Arabic: null, DPT_Email: null,
    ROOMNO: '          ', FLOOR: null, LOCATION: null, Office_No: '', ...DEPTS[dept], U_name: name,
  };
}

// Shaped like the real export (26 Oct 2026).
const BASE = [
  row(6005, '1001', 'TASNEEM BAI MOHAMMED BHAI SUTERWALA'),
  row(6005, '1002', 'MOHD MUNEER SHAMEEM'),
  row(6035, '1002', 'MOHD MUNEER SHAMEEM'), // second department
  row(6035, '1104', 'SALIM MAULA SHAIKH'), // already in ATOM from Login_Master (legacy)
  row(6043, '1301', null), // duplicate pair: one row without a name…
  row(6043, '1301', 'TASNEEM AZIZ AHMEDABADWALA'), // …one with
  row(6013, '20309076', 'Shaikh Shabbir bhai Khomosi'), // ITS person → Idarah sync's job
];

const source = (rows, columns = COLUMNS) => async () => ({ columns, rows: rows.map((r) => ({ ...r })) });
const quiet = () => {};

maybe('HR staff sync on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const { runHrSync } = require('../../modules/sync/hrSync');
  const { runIdarahSync } = require('../../modules/sync/idarahSync');

  let app;
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const sync = (rows, opts = {}) => runHrSync({ pool, readSource: source(rows, opts.columns), log: quiet, force: opts.force });
  const staff = async (id) => (await q(`SELECT * FROM users WHERE employee_id = $1`, [id]))[0];
  const login = (identifier, password) => request(app).post('/Atom/api/auth/login').send({ identifier, password });
  const as = (token) => ({
    get: (p) => request(app).get(`/Atom/api${p}`).set('Authorization', `Bearer ${token}`),
    post: (p, b) => request(app).post(`/Atom/api${p}`).set('Authorization', `Bearer ${token}`).send(b),
  });
  let admin;

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: quiet });
    } finally {
      c.release();
    }
  });
  afterAll(async () => pool.end());

  beforeEach(async () => {
    await pool.query(`TRUNCATE invoice_links, invoices, notifications, request_attachments, request_events, requests,
                      user_departments, user_change_log, user_service_units, user_posts, user_status_log, user_roles,
                      password_reset_tokens, users, departments, src.sync_runs RESTART IDENTITY CASCADE`);
    await pool.query('DROP TABLE IF EXISTS src.user_department_details');
    await pool.query('DROP TABLE IF EXISTS src.idarah_tafveez_current_yr');
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();

    const { rows } = await pool.query(
      `INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', '30328701', 'Qusai', 'manual') RETURNING id`
    );
    await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'EMPLOYEE'), ($1, 'SUPER_ADMIN')`, [rows[0].id]);
    // Login_Master imports (source legacy): 1104 is in the HR list, 9998 is an old account.
    for (const [id, pw] of [['1104', 'old-legacy-pw'], ['9998', 'other-pw']]) {
      const u = await pool.query(
        `INSERT INTO users (login_type, employee_id, legacy_password, source) VALUES ('EMPLOYEE_ID', $1, $2, 'legacy') RETURNING id`,
        [id, pw]
      );
      await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'EMPLOYEE')`, [u.rows[0].id]);
    }
    admin = as((await login('30328701', 'x')).body.token);
  });

  test('first run: mirror, departments with clean locations, staff with temporary passwords, links', async () => {
    const r = await sync(BASE);
    expect(r.status).toBe('success');
    expect(r.counts).toMatchObject({ sourceRows: 7, validRows: 6, itsRows: 1, skippedRows: 0 });
    expect(r.summary.staff).toMatchObject({ inView: 4, created: 3, legacyMatched: 1, legacyNamed: 1, deactivated: 0 });

    expect((await q('SELECT count(*)::int AS n FROM src.user_department_details'))[0].n).toBe(7);

    const depts = await q('SELECT idarah_id, name, building, floor, room_no, in_hr_view, in_idarah_view, is_active FROM departments ORDER BY idarah_id');
    expect(depts.map((d) => [d.idarah_id, d.building, d.floor, d.room_no])).toEqual([
      ['6005', 'Admin Bldg', 'Ground', '1017'],
      ['6013', 'Admin Bldg', 'Sixth', '1615'],
      ['6035', 'Admin Bldg', 'Ground', '1001'],
      ['6043', 'Mahad Al Zahra', 'Second', '4202'],
    ]);
    expect(depts.every((d) => d.in_hr_view && !d.in_idarah_view && d.is_active)).toBe(true);

    const u1001 = await staff('1001');
    expect(u1001).toMatchObject({
      name: 'Tasneem Bai Mohammed Bhai Suterwala', source: 'hr', legacy_password: '1001',
      must_change_password: true, is_active: true, login_type: 'EMPLOYEE_ID',
    });
    expect((await q('SELECT role FROM user_roles WHERE user_id=$1', [u1001.id])).map((x) => x.role)).toEqual(['EMPLOYEE']);
    expect((await staff('1301')).name).toBe('Tasneem Aziz Ahmedabadwala');
    expect(await q(`SELECT * FROM users WHERE its_number='20309076'`)).toEqual([]); // ITS rows untouched

    // Legacy 1104: name filled, password and flags untouched.
    expect(await staff('1104')).toMatchObject({ name: 'Salim Maula Shaikh', legacy_password: 'old-legacy-pw', must_change_password: false, source: 'legacy' });

    const links = await q(`SELECT u.employee_id, d.idarah_id FROM user_departments x JOIN users u ON u.id=x.user_id
                            JOIN departments d ON d.id=x.department_id WHERE x.is_active ORDER BY 1, 2`);
    expect(links.map((l) => `${l.employee_id}:${l.idarah_id}`)).toEqual(['1001:6005', '1002:6005', '1002:6035', '1104:6035', '1301:6043']);
  });

  test('second identical run changes nothing', async () => {
    await sync(BASE);
    const r = await sync(BASE);
    expect(r.summary.staff).toMatchObject({ created: 0, updated: 0, reactivated: 0, deactivated: 0, legacyNamed: 0 });
    expect(r.summary.links.deactivated).toBe(0);
  });

  test('temporary password: sign in with the employee ID, everything else blocked until a new password is set', async () => {
    await sync(BASE);
    const res = await login('1001', '1001');
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);
    const temp = as(res.body.token);

    expect((await temp.get('/auth/me')).body.user.mustChangePassword).toBe(true);
    for (const p of ['/requests/mine', '/requests/categories', '/notifications']) {
      const blocked = await temp.get(p);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('must_change_password');
    }
    expect((await temp.post('/auth/switch-role', { role: 'EMPLOYEE' })).status).toBe(403);

    // The 4-digit employee ID is too short to be a real password anyway.
    expect((await temp.post('/auth/change-password', { currentPassword: '1001', newPassword: '1001' })).body.code).toBe('too_short');
    expect((await temp.post('/auth/change-password', { currentPassword: '1001', newPassword: 'short' })).body.code).toBe('too_short');

    const changed = await temp.post('/auth/change-password', { currentPassword: '1001', newPassword: 'My-own-pass-1' });
    expect(changed.status).toBe(200);
    const fresh = as(changed.body.token);
    expect((await fresh.get('/auth/me')).body.user.mustChangePassword).toBe(false);
    expect((await fresh.get('/requests/mine')).status).toBe(200);
    expect((await login('1001', '1001')).status).toBe(401);
    expect((await staff('1001')).must_change_password).toBe(false);

    // The sync never puts the temporary password back.
    await sync(BASE);
    expect((await staff('1001')).legacy_password).toBe('My-own-pass-1');
  });

  test('leavers (HR Active = 0) are deactivated; coming back reactivates the same record; Super Admin deactivation sticks', async () => {
    await sync(BASE);
    const without1002 = BASE.filter((r) => r.user_id !== '1002');
    const r = await sync(without1002);
    expect(r.summary.staff.deactivated).toBe(1);
    expect((await staff('1002')).is_active).toBe(false);
    expect((await login('1002', '1002')).status).toBe(403); // inactive
    expect((await q(`SELECT x.is_active FROM user_departments x JOIN users u ON u.id=x.user_id WHERE u.employee_id='1002'`)).every((x) => !x.is_active)).toBe(true);

    const back = await sync(BASE);
    expect(back.summary.staff.reactivated).toBe(1);
    const again = await staff('1002');
    expect(again.is_active).toBe(true);
    expect(again.id).toBe((await staff('1002')).id);

    // Super Admin deactivates 1001 → the sync leaves them inactive.
    const id1001 = (await staff('1001')).id;
    await admin.post(`/users/${id1001}/status`, { active: false, reason: 'On long leave' });
    const r2 = await sync(BASE);
    expect(r2.summary.staff.keptInactive).toBe(1);
    expect((await staff('1001')).is_active).toBe(false);

    // Legacy accounts are never deactivated by the sync.
    await sync(BASE.filter((x) => x.user_id !== '1104'));
    expect((await staff('1104')).is_active).toBe(true);
  });

  test('old Login_Master accounts not in the HR list are listed for the Super Admin', async () => {
    expect((await admin.get('/sync/old-accounts')).body).toEqual({ checkedAt: null, accounts: [] });
    await sync(BASE);
    const res = await admin.get('/sync/old-accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a) => a.employee_id)).toEqual(['9998']);
    expect(JSON.stringify(res.body)).not.toContain('other-pw');
    expect((await as((await login('1104', 'old-legacy-pw')).body.token).get('/sync/old-accounts')).status).toBe(404);
  });

  test('departments: the Idarah sync and the HR sync don\'t switch each other\'s departments off', async () => {
    const idarahRow = {
      Idarah_Id: '6013', DPTNM: 'Culture Générale', Teacher_Id: '20309076', EJamaat_No: '20309076', U_NAME: 'Shaikh Shabbir',
      Post: 'Masool', Yr: 1448, IDarahCat: 'TLM',
    };
    const idarahCols = ['Idarah_Id', 'DPTNM', 'Teacher_Id', 'EJamaat_No', 'U_NAME', 'Post', 'Yr', 'IDarahCat'].map((name) => ({
      name, pgType: name === 'Yr' ? 'integer' : 'text',
    }));
    const idarah = () => runIdarahSync({ pool, readSource: async () => ({ columns: idarahCols, rows: [{ ...idarahRow }] }), log: quiet });

    expect((await idarah()).status).toBe('success');
    expect((await sync(BASE)).status).toBe('success');
    expect((await idarah()).status).toBe('success'); // must NOT deactivate 6005 / 6035 / 6043
    const active = await q('SELECT idarah_id, is_active, in_idarah_view, in_hr_view FROM departments ORDER BY idarah_id');
    expect(active.map((d) => [d.idarah_id, d.is_active, d.in_idarah_view, d.in_hr_view])).toEqual([
      ['6005', true, false, true],
      ['6013', true, true, true],
      ['6035', true, false, true],
      ['6043', true, false, true],
    ]);
    // Idarah name wins; HR only adds location.
    expect((await q(`SELECT name, room_no FROM departments WHERE idarah_id='6013'`))[0]).toEqual({ name: 'Culture Générale', room_no: '1615' });

    // 6043 leaves the HR view and isn't in the Idarah view → inactive (kept).
    await sync(BASE.filter((x) => x.Dept_ID !== 6043));
    expect((await q(`SELECT is_active FROM departments WHERE idarah_id='6043'`))[0].is_active).toBe(false);
    expect((await q(`SELECT is_active FROM departments WHERE idarah_id='6013'`))[0].is_active).toBe(true);
  });

  test('guards: no staff rows / under 50% blocked (force overrides 50%), changed columns stop the run', async () => {
    await sync(BASE);
    const empty = await sync([row(6013, '20309076', 'x')]);
    expect(empty.status).toBe('blocked');
    expect((await q('SELECT count(*)::int AS n FROM users WHERE source = $1 AND is_active', ['hr']))[0].n).toBe(3);

    const half = BASE.filter((r) => ['1001', '20309076'].includes(r.user_id));
    expect((await sync(half)).status).toBe('blocked');
    expect((await sync(half, { force: true })).status).toBe('success');

    const fewer = COLUMNS.filter((c) => c.name !== 'LOCATION');
    const failed = await sync(BASE.map(({ LOCATION, ...rest }) => rest), { columns: fewer }); // eslint-disable-line no-unused-vars
    expect(failed.status).toBe('failed');
    expect(failed.message).toMatch(/"location" is missing/);
  });

  test('Super Admin password reset: temporary (must change) by default; employee ID only as temporary', async () => {
    await sync(BASE);
    const id = (await staff('1104')).id;
    expect((await admin.post(`/users/${id}/password`, { newPassword: '1104', requireChange: false })).body.code).toBe('employee_id_password');
    expect((await admin.post(`/users/${id}/password`, { newPassword: 'short', requireChange: false })).body.code).toBe('too_short');

    expect((await admin.post(`/users/${id}/password`, { newPassword: '1104' })).status).toBe(200);
    const r = await login('1104', '1104');
    expect(r.body.user.mustChangePassword).toBe(true);
    expect((await admin.get(`/users/${id}`)).body.user.mustChangePassword).toBe(true);

    expect((await admin.post(`/users/${id}/password`, { newPassword: 'Given-pass-9', requireChange: false })).status).toBe(200);
    expect((await login('1104', 'Given-pass-9')).body.user.mustChangePassword).toBe(false);
  });

  test('"Where?" prefill from the department; users list shows HR departments; detail shows location', async () => {
    await sync(BASE);
    const me = as((await as((await login('1002', '1002')).body.token).post('/auth/change-password', { currentPassword: '1002', newPassword: 'Pass-word-22' })).body.token);
    // Two departments (6005 room 1017, 6035 room 1001): the lower department ID wins, consistently.
    expect((await me.get('/requests/default-location')).body).toEqual({ location: 'Admin Bldg · Ground floor · Room 1017' });

    const id1301 = (await staff('1301')).id;
    expect((await admin.get(`/requests/default-location?for=${id1301}`)).body).toEqual({ location: 'Mahad Al Zahra · Second floor · Room 4202' });
    expect((await me.get(`/requests/default-location?for=${id1301}`)).status).toBe(404);
    expect((await admin.get('/requests/default-location')).body).toEqual({ location: null }); // no department

    const list = await admin.get('/users?source=hr');
    expect(list.body.users.map((u) => [u.employeeId, u.departments])).toEqual([
      ['1002', ['Facilities Management', 'Office of Administrative Affairs']], // Mohd Muneer…
      ['1301', ['Department of Quranic Arts']], // Tasneem Aziz…
      ['1001', ['Office of Administrative Affairs']], // Tasneem Bai…
    ]);
    const detail = (await admin.get(`/users/${id1301}`)).body.user;
    expect(detail).toMatchObject({ editable: false, mustChangePassword: true, source: 'hr' });
    expect(detail.hrDepartments).toEqual([
      { department: 'Department of Quranic Arts', departmentArabic: null, location: 'Mahad Al Zahra · Second floor · Room 4202', isActive: true },
    ]);
    expect((await admin.get('/sync/runs?job=hr')).body.runs[0]).toMatchObject({ job: 'hr', status: 'success' });
    expect((await admin.get('/sync/runs?job=nope')).status).toBe(400);
  });
});

if (!enabled) {
  test('HR sync integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
