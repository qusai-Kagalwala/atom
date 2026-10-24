// Phase 13 notifications on real PostgreSQL. eJamaat mocked; Socket.IO is a recording fake io.
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

maybe('notifications on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const realtime = require('../../realtime');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  let cat;
  let pushed; // [room, event, payload]
  let dropped; // rooms disconnected

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
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      token,
      raise: (b) => auth(request(app).post('/Atom/api/requests')).send(b),
      act: (n, a, b = {}) => auth(request(app).post(`/Atom/api/requests/${n}/actions/${a}`)).send(b),
      comment: (n, b) => auth(request(app).post(`/Atom/api/requests/${n}/comments`)).send(b),
      triage: (n, b) => auth(request(app).patch(`/Atom/api/requests/${n}`)).send(b),
      list: (qs = '') => auth(request(app).get(`/Atom/api/notifications${qs}`)),
      unread: () => auth(request(app).get('/Atom/api/notifications/unread-count')),
      read: (id) => auth(request(app).post(`/Atom/api/notifications/${id}/read`)),
      readAll: () => auth(request(app).post('/Atom/api/notifications/read-all')),
    };
  };
  const titles = async (who) => (await who.list()).body.notifications.map((n) => n.title);
  const rowsFor = async (userId) =>
    (await pool.query('SELECT role, title FROM notifications WHERE user_id = $1 ORDER BY id', [userId])).rows;

  let admin;
  let admin2;
  let adminAsEmployee;
  let alice;
  let eng1;
  let eng1AsEmployee;

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    realtime._setIo(null);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE notifications, request_attachments, request_events, requests, user_change_log,
                      user_service_units, user_posts, user_status_log, user_roles, password_reset_tokens, users
                      RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();

    pushed = [];
    dropped = [];
    const target = (room) => ({
      emit: (event, payload) => pushed.push([room, event, payload]),
      except: () => target(room),
      disconnectSockets: () => dropped.push(room),
    });
    realtime._setIo({ to: target, in: target });

    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.admin2 = await addUser('30328702', 'Second Admin', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    ids.eng1 = await addUser('40000003', 'Eng One', ['EMPLOYEE', 'ENGINEER']);
    const avit = (await pool.query(`SELECT id FROM service_units WHERE code='AVIT'`)).rows[0].id;
    await pool.query('INSERT INTO user_service_units (user_id, service_unit_id) VALUES ($1, $2)', [ids.eng1, avit]);
    cat = String((await pool.query(`SELECT id FROM categories WHERE name='Printer / Scanner'`)).rows[0].id);

    admin = as(await login('30328701', 'SUPER_ADMIN'));
    admin2 = as(await login('30328702', 'SUPER_ADMIN'));
    adminAsEmployee = as(await login('30328701', 'EMPLOYEE'));
    alice = as(await login('40000001'));
    eng1 = as(await login('40000003', 'ENGINEER'));
    eng1AsEmployee = as(await login('40000003', 'EMPLOYEE'));
  });

  test('raise → every Super Admin is told, in the Super Admin role only; pushed live', async () => {
    expect((await alice.raise({ title: 'Printer jams', description: 'x', categoryId: cat })).status).toBe(201);

    expect(await titles(admin)).toEqual(['New ticket T-1001']);
    expect(await titles(admin2)).toEqual(['New ticket T-1001']);
    expect(await titles(adminAsEmployee)).toEqual([]); // access follows the active role
    expect(await titles(alice)).toEqual([]); // the actor is never told

    const n = (await admin.list()).body.notifications[0];
    expect(n).toMatchObject({ type: 'ticket.created', body: 'Printer jams', link: '/tickets/T-1001', role: 'SUPER_ADMIN', read: false });

    expect(pushed.map(([room, event]) => `${room} ${event}`)).toEqual([
      `user:${ids.admin}:SUPER_ADMIN notification:new`,
      `user:${ids.admin2}:SUPER_ADMIN notification:new`,
      'role:SUPER_ADMIN requests:changed',
      `user:${ids.alice} requests:changed`,
    ]);
  });

  test('a full ticket: assign, wait for you, reply, resolve, close — each person told the right things', async () => {
    await alice.raise({ title: 'Printer jams', description: 'x', categoryId: cat });
    await admin.act('T-1001', 'assign', { engineerId: ids.eng1 });
    await eng1.act('T-1001', 'start');
    await eng1.act('T-1001', 'wait_user', { note: 'Which floor?' });
    await alice.comment('T-1001', { note: 'Second floor' });
    await eng1.comment('T-1001', { note: 'Check the fuser', internal: true });
    await eng1.act('T-1001', 'resolve', { note: 'Cleared the jam' });
    await admin.act('T-1001', 'close');

    expect(await rowsFor(ids.alice)).toEqual([
      { role: null, title: 'An engineer is on T-1001' },
      { role: null, title: 'Work started on T-1001' },
      { role: null, title: 'T-1001 needs your reply' },
      { role: null, title: 'T-1001 is resolved' },
      { role: null, title: 'T-1001 is closed' },
    ]);
    expect(await rowsFor(ids.eng1)).toEqual([
      { role: 'ENGINEER', title: 'T-1001 is assigned to you' },
      { role: 'ENGINEER', title: 'Requester replied on T-1001' },
      { role: 'ENGINEER', title: 'T-1001 was closed' },
    ]);
    expect(await rowsFor(ids.admin2)).toEqual([
      { role: 'SUPER_ADMIN', title: 'New ticket T-1001' },
      { role: 'SUPER_ADMIN', title: 'T-1001 resolved, ready to close' },
    ]);
    // The internal note never reached the requester.
    expect(JSON.stringify(await rowsFor(ids.alice))).not.toContain('fuser');

    // Engineer rows show only in the Engineer role; own-ticket rows show in every role.
    expect(await titles(eng1AsEmployee)).toEqual([]);
    expect((await eng1.list()).body.total).toBe(3);
  });

  test('a refused action notifies no one and pushes nothing', async () => {
    await alice.raise({ title: 'Printer jams', description: 'x', categoryId: cat });
    pushed = [];
    const before = (await pool.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n;

    expect((await eng1.act('T-1001', 'start')).status).toBe(404); // not assigned to them
    expect((await admin.act('T-1001', 'reject', { note: 'x' })).status).toBe(400); // note too short
    expect((await admin.act('T-1001', 'assign', { engineerId: ids.alice })).status).toBe(400); // not an engineer

    expect((await pool.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n).toBe(before);
    expect(pushed).toEqual([]);
  });

  test('reject tells the requester with the reason; triage notifies no one but refreshes lists', async () => {
    await alice.raise({ title: 'Printer jams', description: 'x', categoryId: cat });
    pushed = [];
    await admin.triage('T-1001', { priority: 'HIGH' });
    expect(pushed.map(([, e]) => e)).toEqual(['requests:changed', 'requests:changed']);
    expect(await rowsFor(ids.alice)).toEqual([]);

    await admin.act('T-1001', 'reject', { note: 'Duplicate of T-1000' });
    const n = (await alice.list()).body.notifications[0];
    expect(n).toMatchObject({ title: 'T-1001 was rejected', body: 'Duplicate of T-1000', role: null });
  });

  test('inactive users and users who lost the role get nothing', async () => {
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [ids.admin2]);
    await alice.raise({ title: 'Printer jams', description: 'x', categoryId: cat });
    expect(await rowsFor(ids.admin2)).toEqual([]);

    await pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role = 'ENGINEER'`, [ids.eng1]);
    await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'ENGINEER')`, [ids.eng1]);
    await admin.act('T-1001', 'assign', { engineerId: ids.eng1 });
    expect(await rowsFor(ids.eng1)).toEqual([{ role: 'ENGINEER', title: 'T-1001 is assigned to you' }]);
  });

  test('API: unread count, unread filter, mark one / all read; someone else\'s id → 404', async () => {
    await alice.raise({ title: 'One', description: 'x', categoryId: cat });
    await alice.raise({ title: 'Two', description: 'x', categoryId: cat });

    expect((await admin.unread()).body).toEqual({ unread: 2 });
    const list = (await admin.list('?unread=1')).body;
    expect(list).toMatchObject({ total: 2, unread: 2, page: 1, pageSize: 20 });
    expect(list.notifications.map((n) => n.title)).toEqual(['New ticket T-1002', 'New ticket T-1001']);

    const [newest] = list.notifications;
    expect((await admin.read(newest.id)).body).toEqual({ unread: 1 });
    expect((await admin.read(newest.id)).body).toEqual({ unread: 1 }); // already read: fine
    expect((await admin.list('?unread=1')).body.total).toBe(1);
    expect((await admin.list()).body).toMatchObject({ total: 2, unread: 1 });

    // Another user's notification, or own notification from another role → 404.
    expect((await admin2.read(newest.id)).status).toBe(404);
    expect((await adminAsEmployee.read(newest.id)).status).toBe(404);
    expect((await admin.read('abc')).status).toBe(404);

    expect((await admin.readAll()).body).toEqual({ unread: 0 });
    expect((await admin2.unread()).body).toEqual({ unread: 2 }); // untouched

    expect((await admin.list('?pageSize=500')).status).toBe(400);
    expect((await request(app).get('/Atom/api/notifications')).status).toBe(401);
  });

  test('deactivating a user or removing a role drops their live connections', async () => {
    const users = (p) => request(app)[p.m](`/Atom/api/users${p.path}`).set('Authorization', `Bearer ${admin.token}`).send(p.body);
    await users({ m: 'delete', path: `/${ids.eng1}/roles/ENGINEER` });
    await users({ m: 'post', path: `/${ids.alice}/status`, body: { active: false, reason: 'Left AJSM' } });
    expect(dropped).toEqual([`user:${ids.eng1}`, `user:${ids.alice}`]);
  });
});

if (!enabled) {
  test('notifications integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
