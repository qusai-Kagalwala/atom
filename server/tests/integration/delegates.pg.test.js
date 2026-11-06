// Delegate access (6 Nov 2026) and the Super Admin status change, on real PostgreSQL. eJamaat mocked.
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

maybe('Delegate access and status change on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { staffOf, adminOf } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  let cat;

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
  const grant = (who, features) => who.put(`/delegates/${ids.dee}`, { features });

  let admin;
  let alice;
  let dee; // a staff member who gets features, in the Staff (ENGINEER) role
  let deeEmp; // the same person in the Employee role
  let eng;
  let sa;

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
    await pool.query(`TRUNCATE user_features, notifications, email_outbox, request_attachments, request_events, requests, user_change_log,
                      user_service_units, user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.sa = await addUser('90000701', 'Super Sample', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.admin = await addUser('90000702', 'Admin Sample', ['EMPLOYEE']);
    await adminOf(pool, ids.admin);
    ids.alice = await addUser('90000703', 'Alice Sample', ['EMPLOYEE']);
    ids.dee = await addUser('90000704', 'Dee Delegate', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.dee);
    ids.eng = await addUser('90000705', 'Eng Sample', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.eng);
    ids.siy = await addUser('90000706', 'Siyanaat Staff', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.siy, 'SIYANAAT', 'Electrician');
    cat = String((await pool.query(`SELECT id FROM categories WHERE name='Printer / Scanner'`)).rows[0].id);
    admin = as(await login('90000702', 'ADMIN'));
    alice = as(await login('90000703'));
    dee = as(await login('90000704', 'ENGINEER'));
    deeEmp = as(await login('90000704', 'EMPLOYEE'));
    eng = as(await login('90000705', 'ENGINEER'));
    sa = as(await login('90000701', 'SUPER_ADMIN'));
    await alice.post('/requests', { title: 'Printer jams', description: 'x', categoryId: cat });
  });

  test('the Admin gives and removes features for staff only; never delegable itself; logged and notified', async () => {
    let r = await admin.get('/delegates');
    expect(r.status).toBe(200);
    expect(r.body.features.map((f) => f.key)).toContain('wifi'); // AVIT
    expect(r.body.features.map((f) => f.key)).not.toContain('staff');
    expect(r.body.people.map((p) => p.name)).toEqual(['Dee Delegate', 'Eng Sample']); // AVIT staff, not Admins / others

    expect((await grant(admin, ['staff'])).status).toBe(400);
    expect((await grant(admin, ['delegate'])).status).toBe(400);
    expect((await admin.put(`/delegates/${ids.alice}`, { features: ['assign'] })).status).toBe(404); // not staff
    expect((await admin.put(`/delegates/${ids.siy}`, { features: ['assign'] })).status).toBe(404); // other company
    for (const who of [dee, eng, alice]) expect((await who.get('/delegates')).status).toBe(404);

    r = await grant(admin, ['assign', 'inventory']);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: ['assign', 'inventory'], removed: [], person: { features: ['assign', 'inventory'] } });
    expect((await dee.get('/auth/me')).body.user.features).toEqual(['assign', 'inventory']);
    expect((await deeEmp.get('/auth/me')).body.user.features).toEqual(['assign', 'inventory']); // any role
    expect((await sa.get('/auth/me')).body.user.features).toEqual([]);

    r = await grant(admin, ['inventory']);
    expect(r.body).toMatchObject({ added: [], removed: ['assign'] });
    const rows = (await pool.query('SELECT feature, revoked_at IS NOT NULL AS revoked FROM user_features ORDER BY id')).rows;
    expect(rows).toEqual([{ feature: 'assign', revoked: true }, { feature: 'inventory', revoked: false }]); // history kept
    const titles = (await pool.query('SELECT title FROM notifications WHERE user_id = $1 ORDER BY id', [ids.dee])).rows.map((x) => x.title);
    expect(titles).toEqual(['You can now use: Assign queue, Inventory', 'Access removed: Assign queue']);
    // The Super Admin inside the company can give features too.
    expect((await sa.put(`/delegates/${ids.dee}`, { features: ['faqs'] })).status).toBe(200);
  });

  test('Assign queue: a delegate assigns and closes, in any role; nothing else opens up; revoked = 404 at once', async () => {
    expect((await dee.get('/requests/queue/assign')).status).toBe(404);
    await grant(admin, ['assign']);
    for (const who of [dee, deeEmp]) expect((await who.get('/requests/queue/assign')).body.requests.map((x) => x.number)).toEqual(['T-1001']);
    expect((await dee.get('/requests/counts')).body.counts).toMatchObject({ assignQueue: 1, workQueue: 0 });
    expect((await deeEmp.get('/requests/all')).status).toBe(404); // not given All tickets
    expect((await deeEmp.get('/inventory/assets')).status).toBe(404);
    expect((await deeEmp.get('/staff')).status).toBe(404);
    expect((await deeEmp.get('/requests/T-1001')).body.request.permissions.actions).toEqual(['assign', 'reject']);

    expect((await deeEmp.post('/requests/T-1001/actions/assign', { engineerId: ids.eng })).status).toBe(200);
    expect((await eng.post('/requests/T-1001/actions/start')).status).toBe(200);
    expect((await deeEmp.post('/requests/T-1001/actions/start')).status).toBe(404); // worker actions stay with the engineer
    await eng.post('/requests/T-1001/actions/resolve', { note: 'Cleared the paper path' });
    expect((await dee.post('/requests/T-1001/actions/close')).status).toBe(200);
    const ev = (await pool.query(`SELECT actor_id FROM request_events WHERE data->>'action' = 'close'`)).rows[0];
    expect(String(ev.actor_id)).toBe(ids.dee);

    await alice.post('/requests', { title: 'Second', description: 'x', categoryId: cat });
    await grant(admin, []);
    expect((await dee.get('/requests/queue/assign')).status).toBe(404);
    expect((await dee.get('/requests/T-1002')).status).toBe(404);
  });

  test('Approvals only: the approvals list, not all tickets, and no closing', async () => {
    await grant(admin, ['approvals']);
    expect((await deeEmp.get('/requests/all?status=approval&type=SERVICE_REQUEST')).status).toBe(200);
    expect((await deeEmp.get('/requests/all')).status).toBe(404);
    expect((await deeEmp.get('/requests/all?status=approval')).status).toBe(404);
    await admin.post('/requests/T-1001/actions/assign', { engineerId: ids.eng });
    await eng.post('/requests/T-1001/actions/start');
    await eng.post('/requests/T-1001/actions/resolve', { note: 'Done' });
    expect((await deeEmp.post('/requests/T-1001/actions/close')).status).toBe(404);
  });

  test('delegates hear about new work for their feature', async () => {
    await grant(admin, ['assign']);
    await alice.post('/requests', { title: 'Scanner offline', description: 'x', categoryId: cat });
    const n = (await pool.query('SELECT title, role FROM notifications WHERE user_id = $1 ORDER BY id', [ids.dee])).rows;
    expect(n.at(-1)).toEqual({ title: 'New ticket T-1002', role: null });
    expect((await deeEmp.get('/notifications')).body.notifications.map((x) => x.title)).toContain('New ticket T-1002');
    await grant(admin, ['inventory']);
    await alice.post('/requests', { title: 'Third', description: 'x', categoryId: cat });
    expect((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title = 'New ticket T-1003'`, [ids.dee])).rows[0].n).toBe(0);
  });

  test('other features: Inventory, Analytics, FAQs, Problem list — as the Admin, only what was given', async () => {
    await grant(admin, ['inventory', 'analytics']);
    expect((await deeEmp.get('/inventory/assets')).status).toBe(200);
    expect((await deeEmp.post('/inventory/places', { name: 'Delegate shelf', roomNo: '2001' })).status).toBe(201);
    expect((await deeEmp.get('/analytics')).status).toBe(200);
    expect((await deeEmp.get('/reports')).status).toBe(404);
    expect((await deeEmp.get('/assistant/faqs')).status).toBe(404);
    expect((await deeEmp.post('/problems/categories', { name: 'X' })).status).toBe(404);
    expect((await deeEmp.get('/inventory/people/1')).status).toBe(404); // onboarding not given
  });

  test('Super Admin moves any ticket to any status with a reason; nobody else can', async () => {
    await admin.post('/requests/T-1001/actions/assign', { engineerId: ids.eng });
    await eng.post('/requests/T-1001/actions/start');
    await eng.post('/requests/T-1001/actions/resolve', { note: 'Done' });
    await admin.post('/requests/T-1001/actions/close');
    let t = (await pool.query(`SELECT status, closed_at FROM requests WHERE number = 1001`)).rows[0];
    expect(t.status).toBe('CLOSED');

    for (const who of [admin, eng, alice, dee]) expect((await who.post('/requests/T-1001/status', { status: 'IN_PROGRESS', note: 'Reopen' })).status).toBe(404);
    expect((await sa.post('/requests/T-1001/status', { status: 'IN_PROGRESS' })).body.code).toBe('note_required');
    expect((await sa.post('/requests/T-1001/status', { status: 'NOPE', note: 'xxx' })).body.code).toBe('bad_status');
    expect((await sa.post('/requests/T-1001/status', { status: 'CLOSED', note: 'xxx' })).body.code).toBe('no_change');
    expect((await sa.post('/requests/T-1001/status', { status: 'PENDING_APPROVAL', note: 'xxx' })).body.code).toBe('bad_status');

    const r = await sa.post('/requests/T-1001/status', { status: 'IN_PROGRESS', note: 'Printer jammed again' });
    expect(r.status).toBe(200);
    expect(r.body.request).toMatchObject({ status: 'IN_PROGRESS', permissions: { canChangeStatus: true } });
    t = (await pool.query(`SELECT status, closed_at, resolved_at, assigned_engineer_id FROM requests WHERE number = 1001`)).rows[0];
    expect(t).toMatchObject({ status: 'IN_PROGRESS', closed_at: null, resolved_at: null });
    expect(String(t.assigned_engineer_id)).toBe(ids.eng);
    const ev = r.body.request.events.at(-1);
    expect(ev).toMatchObject({ type: 'status', fromStatus: 'CLOSED', toStatus: 'IN_PROGRESS', note: 'Printer jammed again', data: { action: 'override' } });
    const told = (await pool.query(`SELECT user_id FROM notifications WHERE title = 'T-1001 moved to In progress' ORDER BY user_id`)).rows.map((x) => String(x.user_id));
    expect(told).toEqual([ids.alice, ids.eng].sort((a, b) => a - b));
    // Back to Open clears the engineer; an engineer-needing status then needs one chosen.
    await sa.post('/requests/T-1001/status', { status: 'OPEN', note: 'Re-triage' });
    expect((await sa.post('/requests/T-1001/status', { status: 'ASSIGNED', note: 'xxx' })).body.code).toBe('engineer_required');
    const a = await sa.post('/requests/T-1001/status', { status: 'ASSIGNED', note: 'Give it to Dee', engineerId: ids.dee });
    expect(a.body.request.status).toBe('ASSIGNED');
    expect((await alice.get('/requests/T-1001')).body.request.permissions.canChangeStatus).toBe(false);
  });
});
