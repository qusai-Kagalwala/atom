// Companies are kept apart (decided 28 Oct 2026): AVIT and Siyanaat on real PostgreSQL.
// Tickets, catalogue, inventory, staff, occupations and notifications of one company are never
// reachable from another — not by its Admin, its Staff or its Employees. eJamaat mocked.
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

maybe('company isolation on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { staffOf, adminOf, companyId } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  const co = {};
  const cat = {};

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const session = async (its, role, company) => {
    const res = await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role, companyId: company });
    return res.body;
  };
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api${p}`)),
      post: (p, b = {}) => auth(request(app).post(`/Atom/api${p}`)).send(b),
      patch: (p, b = {}) => auth(request(app).patch(`/Atom/api${p}`)).send(b),
      del: (p) => auth(request(app).delete(`/Atom/api${p}`)),
    };
  };
  const numbers = (res) => res.body.requests.map((r) => r.number);

  let avitAdmin;
  let siyAdmin;
  let carpenter;
  let avitEng;
  let aliceAvit;
  let aliceSiy;

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
    await pool.query(`TRUNCATE notifications, request_items, request_attachments, request_events, requests, asset_events, assets,
                      asset_categories, user_change_log, user_posts, user_status_log, user_roles, password_reset_tokens,
                      users RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    await pool.query(`DELETE FROM catalogue_items WHERE name LIKE 'Iso %'`);
    await pool.query(`DELETE FROM occupations WHERE name = 'Welder'`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();

    co.avit = await companyId(pool, 'AVIT');
    co.siy = await companyId(pool, 'SIYANAAT');
    // A Siyanaat ticket category (the problem list arrives in step B).
    await pool.query(`INSERT INTO categories (service_unit_id, name, sort_order) VALUES ($1, 'Carpentry', 10) ON CONFLICT DO NOTHING`, [co.siy]);
    cat.siy = String((await pool.query(`SELECT id FROM categories WHERE service_unit_id = $1 AND name = 'Carpentry'`, [co.siy])).rows[0].id);
    cat.avit = String((await pool.query(`SELECT id FROM categories WHERE name = 'Printer / Scanner'`)).rows[0].id);

    ids.avitAdmin = await addUser('40000010', 'AVIT Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.avitAdmin, 'AVIT');
    ids.siyAdmin = await addUser('40000020', 'Siyanaat Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.siyAdmin, 'SIYANAAT');
    ids.carpenter = await addUser('40000021', 'Abbas Carpenter', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.carpenter, 'SIYANAAT', 'Carpenter');
    ids.avitEng = await addUser('40000011', 'Eng AVIT', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.avitEng, 'AVIT', 'Engineer');
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    ids.sa = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN']);

    avitAdmin = as((await session('40000010', 'ADMIN')).token);
    siyAdmin = as((await session('40000020', 'ADMIN')).token);
    carpenter = as((await session('40000021', 'ENGINEER')).token);
    avitEng = as((await session('40000011', 'ENGINEER')).token);
    aliceAvit = as((await session('40000001', 'EMPLOYEE', co.avit)).token);
    aliceSiy = as((await session('40000001', 'EMPLOYEE', co.siy)).token);

    expect((await aliceAvit.post('/requests', { title: 'Printer jams', description: 'x', categoryId: cat.avit })).status).toBe(201); // T-1001
    expect((await aliceSiy.post('/requests', { title: 'Door hinge broken', description: 'x', categoryId: cat.siy })).status).toBe(201); // T-1002
  });

  test('tickets: each company sees only its own, for every role', async () => {
    expect(numbers(await aliceAvit.get('/requests/mine'))).toEqual(['T-1001']);
    expect(numbers(await aliceSiy.get('/requests/mine'))).toEqual(['T-1002']);
    expect(numbers(await avitAdmin.get('/requests/all'))).toEqual(['T-1001']);
    expect(numbers(await siyAdmin.get('/requests/all'))).toEqual(['T-1002']);
    expect((await siyAdmin.get('/requests/counts')).body.counts).toMatchObject({ assignQueue: 1 });

    // Another company's ticket looks missing — even to its own requester while in the other company.
    expect((await siyAdmin.get('/requests/T-1001')).status).toBe(404);
    expect((await avitAdmin.get('/requests/T-1002')).status).toBe(404);
    expect((await aliceAvit.get('/requests/T-1002')).status).toBe(404);
    expect((await siyAdmin.post('/requests/T-1001/actions/reject', { note: 'Not ours' })).status).toBe(404);
    expect((await siyAdmin.patch('/requests/T-1001', { priority: 'LOW' })).status).toBe(404);

    // A category of another company can't be used.
    expect((await aliceAvit.post('/requests', { title: 'Door', description: 'x', categoryId: cat.siy })).body.code).toBe('bad_category');
  });

  test('assign: only this company\'s staff, grouped by occupation; staff see only their company\'s work', async () => {
    const staff = (await siyAdmin.get('/requests/T-1002/engineers')).body.engineers;
    expect(staff).toEqual([expect.objectContaining({ id: ids.carpenter, name: 'Abbas Carpenter', occupation: 'Carpenter' })]);
    expect((await siyAdmin.get('/requests/engineers')).body.engineers.map((e) => e.id)).toEqual([ids.carpenter]);

    const wrong = await siyAdmin.post('/requests/T-1002/actions/assign', { engineerId: ids.avitEng });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('bad_engineer');

    const ok = await siyAdmin.post('/requests/T-1002/actions/assign', { engineerId: ids.carpenter });
    expect(ok.body.request.assignedEngineer).toMatchObject({ name: 'Abbas Carpenter', occupation: 'Carpenter' });
    expect(numbers(await carpenter.get('/requests/queue/work'))).toEqual(['T-1002']);
    expect(numbers(await avitEng.get('/requests/queue/work'))).toEqual([]);
    expect((await avitEng.get('/requests/T-1002')).status).toBe(404);

    // The carpenter can't work in AVIT: there they are only an Employee.
    const token = (await session('40000021', 'ENGINEER')).token;
    const sw = await as(token).post('/auth/switch', { companyId: co.avit, role: 'ENGINEER' });
    expect(sw.status).toBe(403);
    const asEmp = await as(token).post('/auth/switch', { companyId: co.avit });
    expect(asEmp.body.user).toMatchObject({ activeRole: 'EMPLOYEE', rolesHere: ['EMPLOYEE'] });
  });

  test('notifications: each company\'s Admins hear only about their own company', async () => {
    const titles = async (who) => (await who.get('/notifications')).body.notifications.map((n) => n.title);
    expect(await titles(avitAdmin)).toEqual(['New ticket T-1001']);
    expect(await titles(siyAdmin)).toEqual(['New ticket T-1002']);
  });

  test('catalogue, inventory and occupations are per company', async () => {
    expect((await siyAdmin.post('/requests/catalogue', { name: 'Iso Plywood sheet', kind: 'physical' })).status).toBe(201);
    expect((await avitAdmin.post('/requests/catalogue', { name: 'Iso Plywood sheet', kind: 'physical' })).status).toBe(201); // same name, other company
    const names = async (who) => (await who.get('/requests/catalogue')).body.items.map((i) => i.name);
    expect((await names(aliceSiy)).filter((n) => n.startsWith('Iso'))).toEqual(['Iso Plywood sheet']);
    const siyItem = (await siyAdmin.get('/requests/catalogue')).body.items.find((i) => i.name === 'Iso Plywood sheet');
    expect((await avitAdmin.patch(`/requests/catalogue/${siyItem.id}`, { name: 'Taken over' })).status).toBe(404);
    // A request can't use another company's catalogue item.
    expect((await aliceAvit.post('/requests/service', { items: [{ catalogueItemId: siyItem.id, quantity: 1, reason: 'Need it' }] })).body.code).toBe('bad_item');

    const siyCat = (await siyAdmin.post('/inventory/categories', { name: 'Ladders' })).body.category;
    const avitCat = (await avitAdmin.post('/inventory/categories', { name: 'Ladders' })).body.category; // same name allowed
    expect((await siyAdmin.post('/inventory/assets', { tag: 'L-1', categoryId: siyCat.id })).status).toBe(201);
    expect((await avitAdmin.post('/inventory/assets', { tag: 'L-1', categoryId: siyCat.id })).body.code).toBe('bad_category');
    expect((await avitAdmin.post('/inventory/assets', { tag: 'L-1', categoryId: avitCat.id })).status).toBe(201); // same tag, other company
    expect((await avitAdmin.get('/inventory/assets')).body.assets.map((a) => [a.tag, a.category.id])).toEqual([['L-1', avitCat.id]]);
    expect((await carpenter.get('/inventory/assets')).body.assets.map((a) => a.category.id)).toEqual([siyCat.id]);
    expect((await avitAdmin.post('/inventory/assets/L-1/status', { status: 'RETIRED', note: 'Broken' })).status).toBe(200);
    expect((await carpenter.get('/inventory/assets/L-1')).body.asset.status).toBe('IN_STORE'); // Siyanaat's L-1 untouched
    // Snipe-IT import is AVIT's only.
    expect((await siyAdmin.post('/inventory/import')).status).toBe(404);

    expect((await siyAdmin.post('/staff/occupations', { name: 'Welder' })).status).toBe(201);
    const occ = async (who) => (await who.get('/staff/occupations')).body.occupations.map((o) => o.name);
    expect(await occ(siyAdmin)).toContain('Welder');
    expect(await occ(avitAdmin)).not.toContain('Welder');
  });

  test('staff: an Admin manages only their own company\'s staff; people working elsewhere can\'t be added', async () => {
    const staff = (await siyAdmin.get('/staff')).body.staff;
    expect(staff.map((m) => [m.name, m.isAdmin, m.occupation?.name ?? null])).toEqual([
      ['Siyanaat Admin', true, null],
      ['Abbas Carpenter', false, 'Carpenter'],
    ]);
    const occs = (await siyAdmin.get('/staff/occupations')).body.occupations;
    const electrician = occs.find((o) => o.name === 'Electrician').id;

    const people = (await siyAdmin.get('/staff/people?q=eng')).body.people;
    expect(people.find((p) => p.id === ids.avitEng)).toMatchObject({ otherCompany: 'AVIT' });
    const taken = await siyAdmin.post('/staff', { userId: ids.avitEng, occupationId: electrician });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('other_company');

    // An AVIT occupation can't be used in Siyanaat.
    const avitOcc = (await avitAdmin.get('/staff/occupations')).body.occupations[0].id;
    expect((await siyAdmin.post('/staff', { userId: ids.alice, occupationId: avitOcc })).body.code).toBe('bad_occupation');
    const added = await siyAdmin.post('/staff', { userId: ids.alice, occupationId: electrician });
    expect(added.status).toBe(201);
    expect(added.body.member).toMatchObject({ name: 'Alice Hamid', occupation: { name: 'Electrician' } });

    // AVIT's Admin can't touch Siyanaat staff.
    expect((await avitAdmin.patch(`/staff/${ids.carpenter}`, { occupationId: electrician })).status).toBe(404);
    expect((await avitAdmin.del(`/staff/${ids.carpenter}`)).status).toBe(404);
    // Staff and employees can't use /staff at all.
    expect((await carpenter.get('/staff')).status).toBe(404);
    expect((await aliceAvit.get('/staff')).status).toBe(404);

    expect((await siyAdmin.del(`/staff/${ids.carpenter}`)).body).toEqual({ removed: true });
    expect((await siyAdmin.get('/staff')).body.staff.map((m) => m.name)).toEqual(['Siyanaat Admin', 'Alice Hamid']);
  });

  test('Super Admin: enters any company as its Admin; without a company only the console works', async () => {
    const t = (await session('30328701', 'SUPER_ADMIN', co.siy)).token;
    const sa = as(t);
    expect(numbers(await sa.get('/requests/all'))).toEqual(['T-1002']);
    expect((await sa.get('/requests/T-1001')).status).toBe(404);

    const console = as((await sa.post('/auth/switch', { companyId: null })).body.token);
    const res = await console.get('/requests/all');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('choose_company');
    expect((await console.get('/users')).status).toBe(200);
    expect((await console.get('/settings')).status).toBe(200);
    expect((await console.get('/assistant/usage')).status).toBe(200);

    // Company Admins never reach the global pages.
    for (const p of ['/users', '/settings', '/sync/runs', '/assistant/usage', '/assistant/settings']) {
      expect((await siyAdmin.get(p)).status).toBe(404);
    }
  });

  test('the AI assistant and FAQs are AVIT\'s for now', async () => {
    expect((await aliceSiy.get('/assistant/config')).status).toBe(404);
    expect((await siyAdmin.get('/assistant/faqs')).status).toBe(404);
    expect((await aliceAvit.get('/assistant/config')).status).toBe(200);
    expect((await avitAdmin.get('/assistant/faqs')).status).toBe(200);
  });
});

if (!enabled) {
  test('isolation integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
