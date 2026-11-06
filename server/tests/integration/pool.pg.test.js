// Pool assignment (Phase 2, 6 Nov 2026) on real PostgreSQL: send to occupations / people / everyone,
// first to take it gets it, leave respected, 12-hour automatic assignment. eJamaat mocked.
// Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
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
jest.mock('../../services/mailer', () => ({ sendMail: jest.fn() }));

const maybe = enabled ? describe : describe.skip;

maybe('Pool assignment on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { staffOf, adminOf } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const svc = require('../../modules/requests/requests.service');

  let app;
  const ids = {};
  const occ = {};
  let cat;
  let admin;
  let alice;
  let e1;
  let e2;
  let help;

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role) => (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role })).body.token;
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api${p}`)),
      post: (p, b = {}) => auth(request(app).post(`/Atom/api${p}`)).send(b),
      put: (p, b = {}) => auth(request(app).put(`/Atom/api${p}`)).send(b),
    };
  };
  const titlesFor = async (id) => (await pool.query('SELECT title FROM notifications WHERE user_id = $1 ORDER BY id', [id])).rows.map((x) => x.title);

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
    await pool.query(`INSERT INTO occupations (service_unit_id, name, sort_order) SELECT id, 'Help desk', 200 FROM service_units WHERE code = 'AVIT'
                      ON CONFLICT DO NOTHING`);
    for (const r of (await pool.query(`SELECT o.id::text AS id, o.name FROM occupations o JOIN service_units s ON s.id = o.service_unit_id WHERE s.code = 'AVIT'`)).rows) occ[r.name] = r.id;
  });
  afterAll(async () => pool.end());

  beforeEach(async () => {
    await pool.query(`TRUNCATE request_pool, staff_leave, user_features, notifications, email_outbox, request_attachments, request_events, requests, user_change_log,
                      user_service_units, user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.admin = await addUser('90000902', 'Admin Sample', ['EMPLOYEE']);
    await adminOf(pool, ids.admin);
    ids.alice = await addUser('90000903', 'Alice Sample', ['EMPLOYEE']);
    ids.e1 = await addUser('90000904', 'Eng One', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.e1);
    ids.e2 = await addUser('90000905', 'Eng Two', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.e2);
    ids.help = await addUser('90000906', 'Help One', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.help, 'AVIT', 'Help desk');
    cat = String((await pool.query(`SELECT id FROM categories WHERE name='Printer / Scanner'`)).rows[0].id);
    admin = as(await login('90000902', 'ADMIN'));
    alice = as(await login('90000903'));
    e1 = as(await login('90000904', 'ENGINEER'));
    e2 = as(await login('90000905', 'ENGINEER'));
    help = as(await login('90000906', 'ENGINEER'));
    await alice.post('/requests', { title: 'Printer jams', description: 'x', categoryId: cat });
  });

  test('send to an occupation: members told, can open it, first to take it gets it; others lose it', async () => {
    expect((await e1.get('/requests/T-1001')).status).toBe(404); // not offered yet
    expect((await admin.post('/requests/T-1001/pool', { engineerIds: [ids.e1] })).body.code).toBe('pool_too_small');
    expect((await alice.post('/requests/T-1001/pool', { all: true })).status).toBe(404);
    expect((await e1.post('/requests/T-1001/pool', { all: true })).status).toBe(404);

    const r = await admin.post('/requests/T-1001/pool', { occupationIds: [occ.Engineer], note: 'Whoever is near Room 12' });
    expect(r.status).toBe(200);
    expect(r.body.request).toMatchObject({ status: 'OPEN', assignedEngineer: null, permissions: { canPool: true, canTake: false } });
    expect(r.body.request.pool.members.map((m) => m.name)).toEqual(['Eng One', 'Eng Two']);
    expect(r.body.request.events.at(-1).data).toMatchObject({ action: 'pool', occupations: ['Engineer'], memberNames: ['Eng One', 'Eng Two'], hours: 12 });
    expect(await titlesFor(ids.e1)).toEqual(['T-1001 is available — take it if you can']);
    expect(await titlesFor(ids.help)).toEqual([]);

    expect((await e1.get('/requests/queue/pool')).body.requests.map((x) => x.number)).toEqual(['T-1001']);
    expect((await e1.get('/requests/counts')).body.counts.workQueue).toBe(1);
    const seen = (await e2.get('/requests/T-1001')).body.request;
    expect(seen).toMatchObject({ permissions: { canTake: true }, pool: { mine: true } });
    expect(seen.pool.members).toBeUndefined(); // the list is for assigners
    expect((await help.get('/requests/T-1001')).status).toBe(404);
    expect((await help.post('/requests/T-1001/take')).status).toBe(404);

    const t = await e2.post('/requests/T-1001/take');
    expect(t.status).toBe(200);
    expect(t.body.request).toMatchObject({ status: 'ASSIGNED', assignedEngineer: { name: 'Eng Two' }, pool: null });
    expect(t.body.request.events.at(-1)).toMatchObject({ type: 'assigned', data: { via: 'pool', engineerName: 'Eng Two' } });
    const late = await e1.post('/requests/T-1001/take');
    expect(late.status).toBe(409);
    expect(late.body.message).toBe('Eng Two has already taken it.');
    expect((await e1.get('/requests/queue/pool')).body.requests).toEqual([]);
    expect((await e1.get('/requests/T-1001')).status).toBe(404); // not theirs any more
    expect((await titlesFor(ids.alice)).at(-1)).toBe('An engineer is on T-1001');
    expect((await pool.query('SELECT count(*)::int AS n FROM request_pool')).rows[0].n).toBe(0);
  });

  test('everyone available skips people on leave; choosing someone on leave is refused; cancel and direct assign end the pool', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    await pool.query(`INSERT INTO staff_leave (user_id, service_unit_id, type, start_date, end_date, status)
                      SELECT $1, service_unit_id, 'LEAVE', $2::date, $2::date, 'APPROVED' FROM user_company WHERE user_id = $1`, [ids.e1, today]);
    expect((await admin.post('/requests/T-1001/pool', { engineerIds: [ids.e1, ids.e2] })).body.code).toBe('on_leave');
    let r = await admin.post('/requests/T-1001/pool', { all: true });
    expect(r.body.request.pool.members.map((m) => m.name)).toEqual(['Eng Two', 'Help One']);
    // Mixed: an occupation plus a person.
    r = await admin.post('/requests/T-1001/pool', { occupationIds: [occ['Help desk']], engineerIds: [ids.e2] });
    expect(r.body.request.pool.members.map((m) => m.name)).toEqual(['Eng Two', 'Help One']);

    r = await admin.post('/requests/T-1001/pool/cancel');
    expect(r.body.request.pool).toBeNull();
    expect((await help.get('/requests/queue/pool')).body.requests).toEqual([]);
    expect((await admin.post('/requests/T-1001/pool/cancel')).body.code).toBe('no_pool');

    await admin.post('/requests/T-1001/pool', { all: true });
    await admin.post('/requests/T-1001/actions/assign', { engineerId: ids.help });
    expect((await pool.query('SELECT count(*)::int AS n FROM request_pool')).rows[0].n).toBe(0);
    expect((await admin.post('/requests/T-1001/pool', { all: true })).body.code).toBe('already_assigned');
  });

  test('nobody takes it in 12 hours: the member with the fewest ongoing tickets gets it automatically', async () => {
    // Eng One already has a job; Eng Two has none.
    await alice.post('/requests', { title: 'Other', description: 'x', categoryId: cat });
    await admin.post('/requests/T-1002/actions/assign', { engineerId: ids.e1 });
    await admin.post('/requests/T-1001/pool', { occupationIds: [occ.Engineer] });
    expect(await svc.expirePools()).toBe(0); // not yet
    await pool.query(`UPDATE requests SET pool_started_at = now() - interval '12 hours 1 minute' WHERE number = 1001`);
    expect(await svc.expirePools()).toBe(1);
    const t = (await admin.get('/requests/T-1001')).body.request;
    expect(t).toMatchObject({ status: 'ASSIGNED', assignedEngineer: { name: 'Eng Two' }, pool: null });
    expect(t.events.at(-1)).toMatchObject({ type: 'assigned', actor: null, data: { via: 'pool_auto' } });
    expect((await titlesFor(ids.e2)).at(-1)).toBe('T-1001 is assigned to you — nobody took it from the pool');
    expect(await svc.expirePools()).toBe(0);
  });

  test('12 hours later but everyone in the pool is now on leave: back to the Admin', async () => {
    await admin.post('/requests/T-1001/pool', { occupationIds: [occ['Help desk']] });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    await pool.query(`INSERT INTO staff_leave (user_id, service_unit_id, type, start_date, end_date, status)
                      SELECT $1, service_unit_id, 'SICK', $2::date, $2::date, 'APPROVED' FROM user_company WHERE user_id = $1`, [ids.help, today]);
    await pool.query(`UPDATE requests SET pool_started_at = now() - interval '13 hours' WHERE number = 1001`);
    expect(await svc.expirePools()).toBe(1);
    const t = (await admin.get('/requests/T-1001')).body.request;
    expect(t).toMatchObject({ status: 'OPEN', assignedEngineer: null, pool: null });
    expect((await titlesFor(ids.admin)).at(-1)).toBe('Nobody in the pool could take T-1001');
  });

  test('a delegate with Assign queue can send to a pool', async () => {
    await admin.put(`/delegates/${ids.help}`, { features: ['assign'] });
    expect((await help.post('/requests/T-1001/pool', { occupationIds: [occ.Engineer] })).status).toBe(200);
  });
});
