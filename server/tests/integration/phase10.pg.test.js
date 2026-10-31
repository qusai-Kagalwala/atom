// Phase 10 on real PostgreSQL: onboarding (assign one by one), offboarding (receive all at once) and
// "to recover" when someone is deactivated — each company sees and changes only its own assets.
// eJamaat mocked. Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
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

maybe('Phase 10 onboarding / offboarding on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { adminOf, companyId } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  const co = {};
  let sa;
  let siyAdmin;
  let avitAdmin;
  let aliceSiy;

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role, company) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role, companyId: company })).body.token;
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api${p}`)),
      post: (p, b = {}) => auth(request(app).post(`/Atom/api${p}`)).send(b),
    };
  };
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  async function category(code, name) {
    await q(`INSERT INTO asset_categories (name, service_unit_id) SELECT $2::text, s.id FROM service_units s WHERE s.code = $1::text
              AND NOT EXISTS (SELECT 1 FROM asset_categories c WHERE c.name = $2::text AND c.service_unit_id = s.id)`, [code, name]);
    return (await q(`SELECT c.id FROM asset_categories c JOIN service_units s ON s.id = c.service_unit_id WHERE s.code = $1 AND c.name = $2`, [code, name]))[0].id;
  }
  const asset = async (tag, cat, coId) =>
    (await q(`INSERT INTO assets (asset_tag, category_id, service_unit_id) VALUES ($1, $2, $3) RETURNING id`, [tag, cat, coId]))[0].id;

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
    await pool.query(`TRUNCATE asset_events, assets, notifications, user_change_log, user_posts, user_status_log, user_roles,
                      password_reset_tokens, users RESTART IDENTITY CASCADE`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    co.avit = await companyId(pool, 'AVIT');
    co.siy = await companyId(pool, 'SIYANAAT');
    ids.sa = await addUser('30328701', 'Test Super Admin', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.siyAdmin = await addUser('40000020', 'Siyanaat Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.siyAdmin, 'SIYANAAT');
    ids.avitAdmin = await addUser('40000010', 'AVIT Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.avitAdmin, 'AVIT');
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    sa = as(await login('30328701', 'SUPER_ADMIN'));
    siyAdmin = as(await login('40000020', 'ADMIN'));
    avitAdmin = as(await login('40000010', 'ADMIN'));
    aliceSiy = as(await login('40000001', 'EMPLOYEE', co.siy));

    const cooler = await category('SIYANAAT', 'Water coolers');
    const laptop = await category('AVIT', 'Laptops');
    await asset('WC-1', cooler, co.siy);
    await asset('WC-2', cooler, co.siy);
    await asset('WC-3', cooler, co.siy);
    await asset('LT-1', laptop, co.avit);
  });

  test('onboarding: assign one at a time; the person page shows only this company\'s assets', async () => {
    const found = (await siyAdmin.get('/inventory/people?q=alice')).body.people;
    expect(found).toEqual([expect.objectContaining({ id: ids.alice, name: 'Alice Hamid', isActive: true, held: 0, toRecover: 0 })]);
    for (const tag of ['WC-1', 'WC-2']) {
      expect((await siyAdmin.post(`/inventory/assets/${tag}/assign`, { userId: ids.alice })).body.asset).toMatchObject({ status: 'IN_USE' });
    }
    await avitAdmin.post('/inventory/assets/LT-1/assign', { userId: ids.alice });

    const page = (await siyAdmin.get(`/inventory/people/${ids.alice}`)).body;
    expect(page.person).toMatchObject({ name: 'Alice Hamid', isActive: true });
    expect(page.assets.map((a) => a.tag)).toEqual(['WC-1', 'WC-2']);
    expect((await avitAdmin.get(`/inventory/people/${ids.alice}`)).body.assets.map((a) => a.tag)).toEqual(['LT-1']);
    expect((await siyAdmin.get('/inventory/people?q=alice')).body.people[0]).toMatchObject({ held: 2 });
    expect((await aliceSiy.get('/inventory/mine')).body.assets.map((a) => a.tag)).toEqual(['WC-1', 'WC-2']);

    // Admin only; another company's tag is "not found".
    expect((await aliceSiy.get(`/inventory/people/${ids.alice}`)).status).toBe(404);
    expect((await aliceSiy.get('/inventory/to-recover')).status).toBe(404);
    expect((await avitAdmin.post(`/inventory/people/${ids.alice}/receive`, { tags: ['WC-1'] })).body.code).toBe('bad_asset');
    expect((await siyAdmin.get('/inventory/people/999999')).status).toBe(404);
  });

  test('offboarding: tick all and receive in one go; back in store with history', async () => {
    for (const tag of ['WC-1', 'WC-2']) await siyAdmin.post(`/inventory/assets/${tag}/assign`, { userId: ids.alice });
    expect((await siyAdmin.post(`/inventory/people/${ids.alice}/receive`, {})).body.code).toBe('no_assets');
    expect((await siyAdmin.post(`/inventory/people/${ids.alice}/receive`, { tags: ['WC-1', 'WC-3'] })).body.code).toBe('not_holder');
    expect((await q(`SELECT holder_user_id::text AS h FROM assets WHERE asset_tag = 'WC-1'`))[0].h).toBe(ids.alice); // nothing changed

    const r = (await siyAdmin.post(`/inventory/people/${ids.alice}/receive`, { tags: ['wc-1', 'WC-2'], note: 'Left the department' })).body;
    expect(r).toMatchObject({ received: ['WC-1', 'WC-2'], assets: [] });
    expect(await q(`SELECT asset_tag, status, holder_user_id FROM assets WHERE asset_tag LIKE 'WC-%' ORDER BY asset_tag`)).toEqual([
      { asset_tag: 'WC-1', status: 'IN_STORE', holder_user_id: null },
      { asset_tag: 'WC-2', status: 'IN_STORE', holder_user_id: null },
      { asset_tag: 'WC-3', status: 'IN_STORE', holder_user_id: null },
    ]);
    const ev = (await siyAdmin.get('/inventory/assets/WC-1')).body.asset.history[0];
    expect(ev).toMatchObject({ type: 'returned', note: 'Left the department', data: { offboarding: true, from: { name: 'Alice Hamid' } } });
  });

  test('to recover: deactivated with assets → flagged, each company told; receiving clears; active again clears the rest', async () => {
    for (const tag of ['WC-1', 'WC-2']) await siyAdmin.post(`/inventory/assets/${tag}/assign`, { userId: ids.alice });
    await avitAdmin.post('/inventory/assets/LT-1/assign', { userId: ids.alice });

    expect((await sa.post(`/users/${ids.alice}/status`, { active: false, reason: 'Left Jamea' })).status).toBe(200);
    const list = (await siyAdmin.get('/inventory/to-recover')).body;
    expect(list.total).toBe(2);
    expect(list.people).toEqual([expect.objectContaining({ person: expect.objectContaining({ name: 'Alice Hamid' }) })]);
    expect(list.people[0].assets.map((a) => a.tag)).toEqual(['WC-1', 'WC-2']);
    expect(list.people[0].assets[0].toRecoverSince).toBeTruthy();
    expect((await avitAdmin.get('/inventory/to-recover')).body.total).toBe(1);

    const notes = async (id) => q('SELECT title, body, link FROM notifications WHERE user_id = $1 ORDER BY id', [id]);
    expect(await notes(ids.siyAdmin)).toEqual([{ title: 'Recover 2 assets from Alice Hamid', body: 'Alice Hamid is no longer active. WC-1, WC-2', link: `/onboarding?person=${ids.alice}` }]);
    expect((await notes(ids.avitAdmin))[0]).toMatchObject({ title: 'Recover 1 asset from Alice Hamid' });
    expect((await siyAdmin.get('/inventory/people?q=alice')).body.people[0]).toMatchObject({ isActive: false, held: 2, toRecover: 2 });

    // Siyanaat gets one back; the flag goes with it.
    await siyAdmin.post(`/inventory/people/${ids.alice}/receive`, { tags: ['WC-1'] });
    expect((await siyAdmin.get('/inventory/to-recover')).body.total).toBe(1);
    expect((await siyAdmin.get('/inventory/assets/WC-1')).body.asset.history.map((e) => e.type)).toEqual(['returned', 'to_recover', 'assigned']);
    // Active again: what is left is no longer "to recover" (still theirs).
    expect((await sa.post(`/users/${ids.alice}/status`, { active: true, reason: 'Rejoined' })).status).toBe(200);
    expect((await siyAdmin.get('/inventory/to-recover')).body.total).toBe(0);
    expect((await avitAdmin.get('/inventory/to-recover')).body.total).toBe(0);
    expect((await q(`SELECT holder_user_id::text AS h FROM assets WHERE asset_tag = 'WC-2'`))[0].h).toBe(ids.alice); // still hers
  });
});

if (!enabled) {
  test('Phase 10 integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
