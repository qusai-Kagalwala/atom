// Phase 7 queues + "All tickets" on real PostgreSQL. eJamaat mocked.
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

maybe('queues and All tickets on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  let cat;
  let cat2;

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(
      `INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`,
      [its, name]
    );
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }

  const login = async (its, role) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role })).body.token;
  const as = (token) => ({
    get: (p) => request(app).get(`/Atom/api/requests${p}`).set('Authorization', `Bearer ${token}`),
    raise: (b) => request(app).post('/Atom/api/requests').set('Authorization', `Bearer ${token}`).send(b),
    act: (n, a, b = {}) => request(app).post(`/Atom/api/requests/${n}/actions/${a}`).set('Authorization', `Bearer ${token}`).send(b),
  });
  const numbers = (res) => res.body.requests.map((r) => r.number);

  let admin;
  let alice;
  let eng1;
  let eng2;
  let eng1AsEmployee;

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
    await pool.query(`TRUNCATE request_attachments, request_events, requests, user_change_log, user_service_units,
                      user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();

    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    ids.eng1 = await addUser('40000003', 'Eng One', ['EMPLOYEE', 'ENGINEER']);
    ids.eng2 = await addUser('40000004', 'Eng Two', ['EMPLOYEE', 'ENGINEER']);
    const avit = (await pool.query(`SELECT id FROM service_units WHERE code='AVIT'`)).rows[0].id;
    for (const e of [ids.eng1, ids.eng2]) {
      await pool.query('INSERT INTO user_service_units (user_id, service_unit_id) VALUES ($1, $2)', [e, avit]);
    }
    cat = String((await pool.query(`SELECT id FROM categories WHERE name='Printer / Scanner'`)).rows[0].id);
    cat2 = String((await pool.query(`SELECT id FROM categories WHERE name='Network / Internet'`)).rows[0].id);

    admin = as(await login('30328701'));
    alice = as(await login('40000001'));
    eng1 = as(await login('40000003', 'ENGINEER'));
    eng2 = as(await login('40000004', 'ENGINEER'));
    eng1AsEmployee = as(await login('40000003', 'EMPLOYEE'));

    // T-1001 normal printer, T-1002 urgent network, T-1003 low printer, T-1004 normal (rejected later)
    await alice.raise({ title: 'Printer jams', description: 'x', categoryId: cat, location: 'Library' });
    await alice.raise({ title: 'No internet in 1102', description: 'x', categoryId: cat2, priority: 'HIGH' });
    await alice.raise({ title: 'Toner low', description: 'x', categoryId: cat, priority: 'LOW' });
    await alice.raise({ title: 'Duplicate', description: 'x', categoryId: cat });
  });

  test('assign queue: unassigned, urgent first then oldest; Super Admin only', async () => {
    const q = await admin.get('/queue/assign');
    expect(q.status).toBe(200);
    expect(numbers(q)).toEqual(['T-1002', 'T-1001', 'T-1004', 'T-1003']);
    expect(q.body.requests[0]).toMatchObject({ priority: 'HIGH', requester: { name: 'Alice Hamid' } });
    expect(q.body.requests[0].statusSince).toBeTruthy();

    for (const c of [alice, eng1]) expect((await c.get('/queue/assign')).status).toBe(404);
    expect((await admin.get('/queue/assign?view=nope')).status).toBe(400);
  });

  test('work queue: only my assigned work, by group; active role decides', async () => {
    await admin.act('T-1001', 'assign', { engineerId: ids.eng1 });
    await admin.act('T-1002', 'assign', { engineerId: ids.eng1 });
    await admin.act('T-1003', 'assign', { engineerId: ids.eng2 });
    await eng1.act('T-1002', 'start');

    expect(numbers(await eng1.get('/queue/work'))).toEqual(['T-1002', 'T-1001']);
    expect(numbers(await eng1.get('/queue/work?group=to_start'))).toEqual(['T-1001']);
    expect(numbers(await eng1.get('/queue/work?group=in_progress'))).toEqual(['T-1002']);
    expect(numbers(await eng2.get('/queue/work'))).toEqual(['T-1003']);

    expect((await eng1AsEmployee.get('/queue/work')).status).toBe(404);
    expect((await alice.get('/queue/work')).status).toBe(404);
    expect((await eng1.get('/queue/work?group=all')).status).toBe(400);

    await eng1.act('T-1002', 'resolve', { note: 'Fixed the switch port' });
    expect(numbers(await eng1.get('/queue/work?group=resolved'))).toEqual(['T-1002']);
    expect(numbers(await admin.get('/queue/assign?view=to_close'))).toEqual(['T-1002']);
  });

  test('counts for sidebar badges follow the active role', async () => {
    await admin.act('T-1001', 'assign', { engineerId: ids.eng1 });
    expect((await admin.get('/counts')).body.counts).toEqual({ workQueue: 0, assignQueue: 3, toClose: 0, approvals: 0 });
    expect((await eng1.get('/counts')).body.counts).toEqual({ workQueue: 1 });
    expect((await alice.get('/counts')).body.counts).toEqual({});
  });

  test('All tickets: filters, search, sorting; Super Admin only', async () => {
    await admin.act('T-1001', 'assign', { engineerId: ids.eng1 });
    await admin.act('T-1004', 'reject', { note: 'Duplicate of T-1001' });

    expect(numbers(await admin.get('/all?sort=oldest'))).toEqual(['T-1001', 'T-1002', 'T-1003']); // open by default
    expect(numbers(await admin.get('/all?status=all&sort=oldest'))).toEqual(['T-1001', 'T-1002', 'T-1003', 'T-1004']);
    expect(numbers(await admin.get('/all?status=rejected'))).toEqual(['T-1004']);
    expect(numbers(await admin.get('/all?status=unassigned&sort=priority'))).toEqual(['T-1002', 'T-1003']);
    expect(numbers(await admin.get('/all?priority=HIGH'))).toEqual(['T-1002']);
    expect(numbers(await admin.get(`/all?categoryId=${cat}&sort=oldest`))).toEqual(['T-1001', 'T-1003']);
    expect(numbers(await admin.get(`/all?engineerId=${ids.eng1}`))).toEqual(['T-1001']);
    expect(numbers(await admin.get('/all?engineerId=none&sort=oldest'))).toEqual(['T-1002', 'T-1003']);

    expect(numbers(await admin.get('/all?q=T-1003'))).toEqual(['T-1003']);
    expect(numbers(await admin.get('/all?q=1002'))).toEqual(['T-1002']);
    expect(numbers(await admin.get('/all?q=internet'))).toEqual(['T-1002']);
    expect(numbers(await admin.get('/all?q=hamid&sort=oldest'))).toEqual(['T-1001', 'T-1002', 'T-1003']);
    expect(numbers(await admin.get('/all?q=library'))).toEqual(['T-1001']);
    expect(numbers(await admin.get('/all?q=100%25'))).toEqual([]);

    const page = await admin.get('/all?status=all&pageSize=2&page=2&sort=oldest');
    expect(page.body).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(numbers(page)).toEqual(['T-1003', 'T-1004']);

    for (const c of [alice, eng1]) expect((await c.get('/all')).status).toBe(404);
    for (const bad of ['status=x', 'priority=x', 'categoryId=x', 'engineerId=x', 'sort=x', 'pageSize=500']) {
      expect((await admin.get(`/all?${bad}`)).status).toBe(400);
    }
  });

  test('engineers list for quick assign: tagged, active, least open work first', async () => {
    await admin.act('T-1001', 'assign', { engineerId: ids.eng1 });
    const res = await admin.get('/engineers');
    expect(res.body.engineers.map((e) => [e.name, e.open_work])).toEqual([['Eng Two', 0], ['Eng One', 1]]);
    expect((await eng1.get('/engineers')).status).toBe(404);
  });
});

if (!enabled) {
  test('queue integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
