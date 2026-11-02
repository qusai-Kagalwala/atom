// Phase 14 Web Push on real PostgreSQL: devices subscribe / unsubscribe (own only), the Super Admin switch,
// every notification pushed to the right person's devices, gone devices revoked. web-push and eJamaat
// mocked. Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
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

maybe('Web Push on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { adminOf, companyId } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const push = require('../../modules/push/push.service');

  let app;
  const ids = {};
  const co = {};
  const webpush = { setVapidDetails: jest.fn(), sendNotification: jest.fn() };
  const sub = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: `B${'p'.repeat(60)}${n}`, auth: `auth-secret-${n}` } });

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
      patch: (p, b = {}) => auth(request(app).patch(`/Atom/api${p}`)).send(b),
      del: (p, b = {}) => auth(request(app).delete(`/Atom/api${p}`)).send(b),
    };
  };
  const until = async (fn) => {
    for (let i = 0; i < 50; i += 1) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
    push.setDeps({ webpush });
  });
  afterAll(async () => {
    config.vapid = { publicKey: '', privateKey: '', subject: '' };
    await pool.query('UPDATE notify_settings SET push_enabled = FALSE');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE push_subscriptions, notifications, request_attachments, request_events, requests, user_change_log, user_posts,
                      user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query('UPDATE notify_settings SET push_enabled = FALSE, email_enabled = FALSE');
    await pool.query('UPDATE service_units SET is_open = TRUE');
    config.vapid = { publicKey: 'BPublicKeyForTests', privateKey: 'private', subject: 'mailto:it@example.edu' };
    webpush.setVapidDetails.mockReset();
    webpush.sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    co.avit = await companyId(pool, 'AVIT');
    ids.sa = await addUser('30328701', 'Test Super Admin', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.admin = await addUser('40000010', 'AVIT Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.admin, 'AVIT');
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    ids.bob = await addUser('40000002', 'Bob Saifee', ['EMPLOYEE']);
  });

  test('devices: own only; one device = one person; Super Admin switch; key only when configured', async () => {
    const sa = as(await login('30328701', 'SUPER_ADMIN'));
    const alice = as(await login('40000001', 'EMPLOYEE', co.avit));
    const bob = as(await login('40000002', 'EMPLOYEE', co.avit));
    expect((await alice.get('/push')).body).toEqual({ publicKey: 'BPublicKeyForTests', enabled: false, myDevices: 0 });

    expect((await alice.post('/push/subscriptions', { subscription: { endpoint: 'http://evil.example/x', keys: {} } })).body.code).toBe('bad_subscription');
    expect((await alice.post('/push/subscriptions', { subscription: sub(1) })).body.myDevices).toBe(1);
    expect((await alice.post('/push/subscriptions', { subscription: sub(1) })).body.myDevices).toBe(1); // again: same device
    // Bob signs in on Alice's phone: the device is his now.
    expect((await bob.post('/push/subscriptions', { subscription: sub(1) })).body.myDevices).toBe(1);
    expect((await alice.get('/push')).body.myDevices).toBe(0);
    // Alice can't turn off Bob's device.
    await alice.del('/push/subscriptions', { endpoint: sub(1).endpoint });
    expect((await bob.get('/push')).body.myDevices).toBe(1);
    expect((await bob.del('/push/subscriptions', { endpoint: sub(1).endpoint })).body.myDevices).toBe(0);

    expect((await as(await login('40000010', 'ADMIN')).patch('/settings/push', { enabled: true })).status).toBe(404);
    expect((await sa.patch('/settings/push', { enabled: true })).body).toMatchObject({ pushEnabled: true, keysConfigured: true });
    expect((await alice.get('/push')).body.enabled).toBe(true);
    config.vapid = { publicKey: '', privateKey: '', subject: '' };
    expect((await alice.get('/push')).body).toMatchObject({ publicKey: null, enabled: false });
    expect((await sa.get('/settings/push')).body.keysConfigured).toBe(false);
  });

  test('notifications are pushed to the right devices; gone devices are revoked; switch off = nothing sent', async () => {
    const alice = as(await login('40000001', 'EMPLOYEE', co.avit));
    const admin = as(await login('40000010', 'ADMIN'));
    await admin.post('/push/subscriptions', { subscription: sub(7) });
    await admin.post('/push/subscriptions', { subscription: sub(8) }); // second device
    await alice.post('/push/subscriptions', { subscription: sub(9) });
    const cat = (await pool.query(`SELECT id FROM categories WHERE service_unit_id = $1 LIMIT 1`, [co.avit])).rows[0].id;

    // Switch off: nothing.
    expect((await alice.post('/requests', { title: 'Printer jams', description: 'x', categoryId: String(cat) })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 200));
    expect(webpush.sendNotification).not.toHaveBeenCalled();

    await pool.query('UPDATE notify_settings SET push_enabled = TRUE');
    webpush.sendNotification.mockImplementation(async (s) => {
      if (s.endpoint.endsWith('device-8')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      return { statusCode: 201 };
    });
    const t = (await alice.post('/requests', { title: 'Projector off', description: 'x', categoryId: String(cat) })).body.request;
    await until(async () => webpush.sendNotification.mock.calls.length >= 2);
    const calls = webpush.sendNotification.mock.calls;
    expect(calls.map(([s]) => s.endpoint.split('/').pop()).sort()).toEqual(['device-7', 'device-8']); // the Admin's devices, not Alice's
    const [subArg, payload, opts] = calls[0];
    expect(subArg.keys.auth).toMatch(/^auth-secret-/);
    const data = JSON.parse(payload);
    const n = (await pool.query(`SELECT id FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [ids.admin])).rows[0];
    expect(data).toEqual({ title: `New ticket ${t.number}`, body: 'Projector off', tag: `atom-${n.id}`, url: `/Atom/notifications?open=${n.id}` });
    expect(opts).toMatchObject({ TTL: 86400 });
    expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:it@example.edu', 'BPublicKeyForTests', 'private');
    await until(async () => (await pool.query(`SELECT revoked_at FROM push_subscriptions WHERE endpoint LIKE '%device-8'`)).rows[0].revoked_at);
    expect((await admin.get('/push')).body.myDevices).toBe(1);

    // Tapping the push: the Admin is in the Employee role now, the notification is for ADMIN in AVIT.
    // /open returns it anyway (own row) so the app can switch there; nobody else can open it.
    const asEmployee = as(await login('40000010', 'EMPLOYEE', co.avit));
    const opened = await asEmployee.post(`/notifications/${n.id}/open`);
    expect(opened.status).toBe(200);
    expect(opened.body.notification).toMatchObject({ id: String(n.id), role: 'ADMIN', read: true, company: { id: String(co.avit) } });
    expect((await alice.post(`/notifications/${n.id}/open`)).status).toBe(404);
    expect((await alice.post('/notifications/abc/open')).status).toBe(404);
  });
});

if (!enabled) {
  test('Web Push integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
