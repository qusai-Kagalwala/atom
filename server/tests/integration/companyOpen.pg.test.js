// Super Admin opens / closes companies (31 Oct 2026) on real PostgreSQL: closed companies leave the
// login page, the picker and the switcher for everyone but the Super Admin; sessions inside one go back to
// the picker; at least one stays open. eJamaat mocked. Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
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

maybe('open / close companies on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { adminOf, companyId } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  const co = {};

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role, company) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role, companyId: company })).body;
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api${p}`)),
      post: (p, b = {}) => auth(request(app).post(`/Atom/api${p}`)).send(b),
      patch: (p, b = {}) => auth(request(app).patch(`/Atom/api${p}`)).send(b),
    };
  };
  const codes = (list) => list.map((c) => c.code);

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.query('UPDATE service_units SET is_open = TRUE');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE company_open_log, notifications, user_change_log, user_posts, user_status_log, user_roles,
                      password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query('UPDATE service_units SET is_open = TRUE');
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    co.avit = await companyId(pool, 'AVIT');
    co.siy = await companyId(pool, 'SIYANAAT');
    co.tan = await companyId(pool, 'TANZEEM');
    ids.sa = await addUser('30328701', 'Test Super Admin', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.siyAdmin = await addUser('40000020', 'Siyanaat Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.siyAdmin, 'SIYANAAT');
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
  });

  test('closing companies: login page, picker, switch and existing sessions follow; at least one stays open', async () => {
    const sa = as((await login('30328701', 'SUPER_ADMIN')).token);
    const inSiy = as((await login('40000001', 'EMPLOYEE', co.siy)).token); // a session already inside Siyanaat
    const admin = as((await login('40000020', 'ADMIN')).token);
    expect(codes((await request(app).get('/Atom/api/auth/open-companies')).body.companies)).toEqual(['AVIT', 'SIYANAAT', 'TANZEEM']);

    expect((await admin.patch('/settings/companies/SIYANAAT', { isOpen: false })).status).toBe(404); // Super Admin only
    await sa.patch('/settings/companies/SIYANAAT', { isOpen: false });
    const after = (await sa.patch('/settings/companies/TANZEEM', { isOpen: false })).body.companies;
    expect(after.map((c) => [c.code, c.isOpen])).toEqual([['AVIT', true], ['SIYANAAT', false], ['TANZEEM', false]]);
    expect(after[1].lastChange).toMatchObject({ by: 'Test Super Admin' });
    expect((await sa.patch('/settings/companies/AVIT', { isOpen: false })).body.code).toBe('last_open');
    expect((await sa.patch('/settings/companies/NOPE', { isOpen: false })).status).toBe(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM company_open_log')).rows[0].n).toBe(2);

    // Login page and pickers: AVIT only.
    expect((await request(app).get('/Atom/api/auth/open-companies')).body.companies).toEqual([{ code: 'AVIT', name: 'AVIT' }]);
    const alice = await login('40000001');
    expect(alice.user.company).toMatchObject({ code: 'AVIT', isOpen: true });
    expect(codes((await as(alice.token).get('/auth/companies')).body.companies)).toEqual(['AVIT']);
    expect((await login('40000001', 'EMPLOYEE', co.siy)).user.company.code).toBe('AVIT'); // asked for Siyanaat → AVIT
    expect((await as(alice.token).post('/auth/switch', { companyId: co.siy })).status).toBe(404);

    // Siyanaat's own Admin is out too (Super Admin only).
    const siyAdmin = await login('40000020', 'ADMIN');
    expect(siyAdmin.user.company?.code ?? null).not.toBe('SIYANAAT');
    expect((await as(siyAdmin.token).post('/auth/switch', { companyId: co.siy, role: 'ADMIN' })).status).toBe(404);
    expect((await admin.get('/staff')).body.code).toBe('choose_company'); // the session from before

    // A session already inside Siyanaat goes back to the picker (not signed out).
    expect((await inSiy.get('/requests/mine')).body.code).toBe('choose_company');
    expect((await inSiy.get('/auth/me')).body.user.company).toBeNull();

    // The Super Admin still sees and enters closed companies.
    const list = (await sa.get('/auth/companies')).body.companies;
    expect(list.map((c) => [c.code, c.isOpen])).toEqual([['AVIT', true], ['SIYANAAT', false], ['TANZEEM', false]]);
    const entered = (await sa.post('/auth/switch', { companyId: co.siy })).body;
    expect(entered.user.company).toMatchObject({ code: 'SIYANAAT', isOpen: false });
    expect((await as(entered.token).get('/requests/mine')).status).toBe(200);

    // Reopened: back for everyone.
    await sa.patch('/settings/companies/SIYANAAT', { isOpen: true });
    expect(codes((await as(alice.token).get('/auth/companies')).body.companies)).toEqual(['AVIT', 'SIYANAAT']);
    expect((await inSiy.get('/auth/me')).body.user.company).toMatchObject({ code: 'SIYANAAT' });
  });
});

if (!enabled) {
  test('company open / close integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
