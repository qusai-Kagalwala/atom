// Users admin API end-to-end on real PostgreSQL (HTTP → service → SQL). eJamaat mocked.
// Runs ONLY when TEST_DATABASE_URL points at a database whose name ends in "_test".
const URL_ENV = process.env.TEST_DATABASE_URL || '';
let parsed = null;
try {
  parsed = new URL(URL_ENV);
} catch {
  /* not set */
}
const enabled = Boolean(parsed && /_test$/.test(parsed.pathname.slice(1)));

// Point the app's own pool at the test database (before anything loads config).
if (enabled) {
  process.env.PG_HOST = parsed.hostname;
  process.env.PG_PORT = parsed.port || '5432';
  process.env.PG_DATABASE = parsed.pathname.slice(1);
  process.env.PG_USER = decodeURIComponent(parsed.username);
  process.env.PG_PASSWORD = decodeURIComponent(parsed.password);
}

jest.mock('../../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));

const maybe = enabled ? describe : describe.skip;

maybe('users admin API on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  async function addUser({ its, emp, name, roles = ['EMPLOYEE'], source = 'idarah', password }) {
    const { rows } = await pool.query(
      `INSERT INTO users (login_type, its_number, employee_id, legacy_password, name, source)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [its ? 'ITS' : 'EMPLOYEE_ID', its || null, emp || null, emp ? password || 'legacy-pw' : null, name || null, source]
    );
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }

  const tokenFor = async (identifier, role) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier, password: 'x', role })).body.token;
  const as = (token) => ({
    get: (p) => request(app).get(`/Atom/api/users${p}`).set('Authorization', `Bearer ${token}`),
    post: (p, b) => request(app).post(`/Atom/api/users${p}`).set('Authorization', `Bearer ${token}`).send(b),
    patch: (p, b) => request(app).patch(`/Atom/api/users${p}`).set('Authorization', `Bearer ${token}`).send(b),
    del: (p) => request(app).delete(`/Atom/api/users${p}`).set('Authorization', `Bearer ${token}`),
  });

  let admin; // Super Admin client (Qusai)

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
  });
  afterAll(async () => pool.end());

  beforeEach(async () => {
    await pool.query(`TRUNCATE user_change_log, user_service_units, user_posts, user_status_log, user_roles,
                      password_reset_tokens, users, departments RESTART IDENTITY CASCADE`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();

    ids.qusai = await addUser({ its: '30328701', name: 'Qusai Kagalwala', roles: ['EMPLOYEE', 'ENGINEER', 'SUPER_ADMIN'], source: 'manual' });
    ids.raja = await addUser({ its: '20305503', name: 'Shaikh Ebrahim Raja' });
    ids.emp = await addUser({ emp: '1002', source: 'legacy' });
    ids.eng = await addUser({ its: '40000003', name: 'Engineer One', roles: ['EMPLOYEE', 'ENGINEER'] });

    const { rows } = await pool.query(`INSERT INTO departments (idarah_id, name) VALUES ('6053', 'Insha al-Nazm') RETURNING id`);
    await pool.query(`INSERT INTO user_posts (user_id, department_id, post) VALUES ($1, $2, 'Masool (HOD)')`, [ids.raja, rows[0].id]);

    admin = as(await tokenFor('30328701'));
  });

  test('list: search by name, ITS, employee ID ("Employee 1002"), department; filters; no passwords', async () => {
    const all = await admin.get('/');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 4, page: 1, pageSize: 25 });
    expect(JSON.stringify(all.body)).not.toMatch(/legacy-pw|password/i);

    const names = async (qs) => (await admin.get(qs)).body.users.map((u) => u.name);
    expect(await names('/?q=raja')).toEqual(['Shaikh Ebrahim Raja']);
    expect(await names('/?q=2030')).toEqual(['Shaikh Ebrahim Raja']);
    expect(await names('/?q=insha')).toEqual(['Shaikh Ebrahim Raja']);
    expect(await names('/?q=employee 1002')).toEqual(['Employee 1002']);
    expect(await names('/?q=100%25')).toEqual([]); // "%" is literal, not a wildcard
    expect(await names('/?role=ENGINEER')).toEqual(['Engineer One', 'Qusai Kagalwala']);
    expect(await names('/?source=legacy')).toEqual(['Employee 1002']);

    const page = await admin.get('/?pageSize=2&page=2');
    expect(page.body).toMatchObject({ total: 4, page: 2 });
    expect(page.body.users).toHaveLength(2);

    expect((await admin.get('/')).body.users.find((u) => u.id === ids.raja).departments).toEqual(['Insha al-Nazm']);
  });

  test('every /users route is 404 for non-Super-Admin roles, 401 without login', async () => {
    const asEngineer = as(await tokenFor('30328701', 'ENGINEER'));
    expect((await asEngineer.get('/')).status).toBe(404);
    expect((await asEngineer.get(`/${ids.raja}`)).status).toBe(404);
    expect((await asEngineer.post(`/${ids.raja}/roles`, { role: 'SUPER_ADMIN' })).status).toBe(404);
    expect((await request(app).get('/Atom/api/users')).status).toBe(401);
    expect(await q(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role='SUPER_ADMIN'`, [ids.raja])).toHaveLength(0);
  });

  test('detail: roles, posts, editable flag, unknown id → 404', async () => {
    const res = await admin.get(`/${ids.raja}`);
    expect(res.body.user).toMatchObject({
      name: 'Shaikh Ebrahim Raja', roles: ['EMPLOYEE'], editable: false, source: 'idarah',
      posts: [{ department: 'Insha al-Nazm', post: 'Masool (HOD)', isActive: true }],
    });
    expect((await admin.get('/999999')).status).toBe(404);
    expect((await admin.get('/abc')).status).toBe(404);
  });

  test('roles: grant/remove with history; protections', async () => {
    const g = await admin.post(`/${ids.raja}/roles`, { role: 'SUPER_ADMIN' });
    expect(g.body.user.roles).toEqual(['EMPLOYEE', 'SUPER_ADMIN']);
    expect(g.body.user.history[0]).toMatchObject({ text: 'Role granted: SUPER_ADMIN', by: 'Qusai Kagalwala' });

    // granting twice is a no-op (no second history line)
    const again = await admin.post(`/${ids.raja}/roles`, { role: 'SUPER_ADMIN' });
    expect(again.body.user.history.filter((h) => h.action === 'role_granted')).toHaveLength(1);

    expect((await admin.del(`/${ids.qusai}/roles/SUPER_ADMIN`)).body.code).toBe('own_super_admin');
    expect((await admin.del(`/${ids.emp}/roles/EMPLOYEE`)).body.code).toBe('only_role');

    const r = await admin.del(`/${ids.raja}/roles/SUPER_ADMIN`);
    expect(r.status).toBe(200);
    expect(r.body.user.roles).toEqual(['EMPLOYEE']);
  });

  test('last active Super Admin can be neither removed nor deactivated', async () => {
    // Make Raja a second SA, then let Raja try to remove Qusai's SA after Qusai is the only one left.
    await admin.post(`/${ids.raja}/roles`, { role: 'SUPER_ADMIN' });
    const raja = as(await tokenFor('20305503'));
    expect((await raja.del(`/${ids.qusai}/roles/SUPER_ADMIN`)).status).toBe(200); // 2 → 1 is fine

    const qusaiAgain = as(await tokenFor('30328701', 'EMPLOYEE'));
    expect((await qusaiAgain.get('/')).status).toBe(404); // Qusai no longer SA

    expect((await raja.del(`/${ids.raja}/roles/SUPER_ADMIN`)).body.code).toBe('own_super_admin');
    expect((await raja.post(`/${ids.raja}/status`, { active: false, reason: 'test' })).body.code).toBe('self_deactivate');

    // Even another SA can't deactivate the last one: make Qusai SA again, deactivate Raja → OK (2 → 1),
    // then Raja (inactive) can't act, and Qusai can't deactivate himself.
    await raja.post(`/${ids.qusai}/roles`, { role: 'SUPER_ADMIN' });
    const qusai = as(await tokenFor('30328701'));
    expect((await qusai.post(`/${ids.raja}/status`, { active: false, reason: 'Left' })).status).toBe(200);
    expect((await qusai.del(`/${ids.qusai}/roles/SUPER_ADMIN`)).body.code).toBe('own_super_admin');
  });

  test('concurrent removals cannot leave zero Super Admins', async () => {
    await admin.post(`/${ids.raja}/roles`, { role: 'SUPER_ADMIN' });
    const raja = as(await tokenFor('20305503'));
    const [a, b] = await Promise.all([
      admin.del(`/${ids.raja}/roles/SUPER_ADMIN`),
      raja.del(`/${ids.qusai}/roles/SUPER_ADMIN`),
    ]);
    const ok = [a, b].filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    const left = await q(`SELECT count(*)::int AS n FROM user_roles WHERE role='SUPER_ADMIN'`);
    expect(left[0].n).toBeGreaterThanOrEqual(1);
  });

  test('service-unit tags: engineers only; removing Engineer untags', async () => {
    const avit = (await q(`SELECT id FROM service_units WHERE code='AVIT'`))[0].id;
    const siy = (await q(`SELECT id FROM service_units WHERE code='SIYANAAT'`))[0].id;

    expect((await admin.post(`/${ids.raja}/service-units`, { serviceUnitId: avit })).body.code).toBe('not_engineer');

    await admin.post(`/${ids.eng}/service-units`, { serviceUnitId: avit });
    const t = await admin.post(`/${ids.eng}/service-units`, { serviceUnitId: siy }); // inactive unit is allowed
    expect(t.body.user.serviceUnits.map((s) => s.code)).toEqual(['AVIT', 'SIYANAAT']);

    const u = await admin.del(`/${ids.eng}/service-units/${siy}`);
    expect(u.body.user.serviceUnits.map((s) => s.code)).toEqual(['AVIT']);

    const r = await admin.del(`/${ids.eng}/roles/ENGINEER`);
    expect(r.body.user.serviceUnits).toEqual([]);
    expect(r.body.user.history[0].text).toBe('Role removed: ENGINEER (service units untagged: AVIT)');
    expect((await admin.post(`/${ids.eng}/service-units`, { serviceUnitId: 999 })).status).toBe(404);
  });

  test('status: reason required, logged with who; deactivated user is locked out at once', async () => {
    const empToken = (await request(app).post('/Atom/api/auth/login').send({ identifier: '1002', password: 'legacy-pw' })).body.token;
    expect(empToken).toBeTruthy();

    expect((await admin.post(`/${ids.emp}/status`, { active: false, reason: ' ' })).body.code).toBe('reason_required');
    const d = await admin.post(`/${ids.emp}/status`, { active: false, reason: 'Left Jamea' });
    expect(d.body.user).toMatchObject({ isActive: false });
    expect(d.body.user.history[0]).toMatchObject({ action: 'deactivated', reason: 'Left Jamea', by: 'Qusai Kagalwala' });

    const me = await request(app).get('/Atom/api/auth/me').set('Authorization', `Bearer ${empToken}`);
    expect(me.body.code).toBe('removed');

    expect((await admin.post(`/${ids.emp}/status`, { active: false, reason: 'again' })).body.code).toBe('no_change');
    expect((await admin.post(`/${ids.emp}/status`, { active: true, reason: 'Rejoined' })).body.user.isActive).toBe(true);
    expect((await admin.post(`/${ids.emp}/status`, { active: 'yes', reason: 'x' })).status).toBe(400);
  });

  test('profile edit: imported/manual only, validated, logged', async () => {
    const e = await admin.patch(`/${ids.emp}`, { name: '  Mulla Abc  ', email: 'abc@jameasaifiyah.edu', mobile: '' });
    expect(e.body.user).toMatchObject({ name: 'Mulla Abc', hasName: true, email: 'abc@jameasaifiyah.edu' });
    expect(e.body.user.history[0].text).toBe('Details edited: name, email');

    expect((await admin.patch(`/${ids.raja}`, { name: 'X' })).body.code).toBe('synced_read_only');
    expect((await admin.patch(`/${ids.emp}`, { email: 'not-an-email' })).body.message).toBe('Enter a valid email address.');

    // Clearing the name brings back "Employee 1002".
    expect((await admin.patch(`/${ids.emp}`, { name: '' })).body.user).toMatchObject({ name: 'Employee 1002', hasName: false });
  });

  test('create manual users (ITS and employee ID); duplicates refused', async () => {
    const its = await admin.post('/', { loginType: 'ITS', itsNumber: '50000001', name: 'New Joiner' });
    expect(its.status).toBe(201);
    expect(its.body.user).toMatchObject({ source: 'manual', roles: ['EMPLOYEE'], isActive: true, loginType: 'ITS' });

    const emp = await admin.post('/', { loginType: 'EMPLOYEE_ID', employeeId: '9001', password: 'welcome-123', name: 'Temp Staff' });
    expect(emp.status).toBe(201);
    expect(JSON.stringify(emp.body)).not.toContain('welcome-123');
    const login = await request(app).post('/Atom/api/auth/login').send({ identifier: '9001', password: 'welcome-123' });
    expect(login.status).toBe(200);

    expect((await admin.post('/', { loginType: 'ITS', itsNumber: '20305503' })).status).toBe(409);
    expect((await admin.post('/', { loginType: 'EMPLOYEE_ID', employeeId: '1002', password: 'welcome-123' })).status).toBe(409);
    expect((await admin.post('/', { loginType: 'ITS', itsNumber: '123' })).body.code).toBe('bad_its');
    expect((await admin.post('/', { loginType: 'EMPLOYEE_ID', employeeId: '12345678', password: 'welcome-123' })).body.code).toBe('bad_employee_id');
    expect((await admin.post('/', { loginType: 'EMPLOYEE_ID', employeeId: '9002', password: 'short' })).body.code).toBe('too_short');
  });

  test('password reset by Super Admin: employee-ID only, old password stops working, outstanding links die', async () => {
    const before = await request(app).post('/Atom/api/auth/login').send({ identifier: '1002', password: 'legacy-pw' });
    expect(before.status).toBe(200);
    const oldToken = before.body.token;
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, repeat('a', 64), now() + interval '30 min')`,
      [ids.emp]
    );
    const r = await admin.post(`/${ids.emp}/password`, { newPassword: 'brand-new-1' });
    expect(r.body.message).toBe('Password reset. The user is signed out everywhere — tell them their new password.');
    // Phase 7.1: a login from before the reset no longer works.
    const me = await request(app).get('/Atom/api/auth/me').set('Authorization', `Bearer ${oldToken}`);
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('password_changed');
    expect((await request(app).post('/Atom/api/auth/login').send({ identifier: '1002', password: 'legacy-pw' })).status).toBe(401);
    expect((await request(app).post('/Atom/api/auth/login').send({ identifier: '1002', password: 'brand-new-1' })).status).toBe(200);
    expect((await q('SELECT used_at FROM password_reset_tokens'))[0].used_at).not.toBeNull();

    const hist = (await admin.get(`/${ids.emp}`)).body.user.history;
    expect(hist[0].text).toBe('Password reset by a Super Admin');
    expect(JSON.stringify(hist)).not.toContain('brand-new-1');

    expect((await admin.post(`/${ids.raja}/password`, { newPassword: 'brand-new-1' })).body.code).toBe('its_user');
    expect((await admin.post(`/${ids.emp}/password`, { newPassword: 'short' })).body.code).toBe('too_short');
  });
});

if (!enabled) {
  test('users integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
