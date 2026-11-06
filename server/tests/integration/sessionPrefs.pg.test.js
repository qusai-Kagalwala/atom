// "Keep me signed in", "Sign out of all devices" and "How I get notified" (6 Nov 2026), on real PostgreSQL.
// eJamaat and SMTP mocked. Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
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

maybe('Session length and notification choices on real PostgreSQL', () => {
  const request = require('supertest');
  const jwt = require('jsonwebtoken');
  const pool = require('../../db/pool');
  const { adminOf } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  let cat;

  async function addUser(its, name, roles, email = null) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, email, source) VALUES ('ITS', $1, $2, $3, 'manual') RETURNING id`, [its, name, email]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const loginRes = (its, extra = {}) => request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', ...extra });
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api${p}`)),
      post: (p, b = {}) => auth(request(app).post(`/Atom/api${p}`)).send(b),
      patch: (p, b = {}) => auth(request(app).patch(`/Atom/api${p}`)).send(b),
    };
  };

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
    await pool.query(`TRUNCATE notifications, email_outbox, request_attachments, request_events, requests, user_change_log,
                      user_service_units, user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query('INSERT INTO notify_settings (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET email_enabled = TRUE');
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.admin = await addUser('90000952', 'Admin Sample', ['EMPLOYEE'], 'admin@example.org');
    await adminOf(pool, ids.admin);
    ids.alice = await addUser('90000953', 'Alice Sample', ['EMPLOYEE'], 'alice@example.org');
    cat = String((await pool.query(`SELECT id FROM categories WHERE name='Printer / Scanner'`)).rows[0].id);
  });

  test('default 8 hours; "Keep me signed in" lasts 90 days, survives role switches and renews itself', async () => {
    const short = (await loginRes('90000953')).body.token;
    let p = jwt.decode(short);
    expect(p.exp - p.iat).toBe(8 * 3600);
    expect(p.k).toBeUndefined();
    expect((await as(short).get('/auth/me')).body.keepSignedIn).toBe(false);

    const r = await loginRes('90000952', { keep: true, role: 'ADMIN' });
    p = jwt.decode(r.body.token);
    expect(p.k).toBe(1);
    expect(p.exp - p.iat).toBe(90 * 86400);
    expect((await as(r.body.token).get('/auth/me')).body.keepSignedIn).toBe(true);
    const switched = (await as(r.body.token).post('/auth/switch-role', { role: 'EMPLOYEE' })).body.token;
    expect(jwt.decode(switched).k).toBe(1);

    // A day-old keep token is renewed on use (X-Atom-Token); a fresh one and a short one are not.
    const old = jwt.sign({ role: 'EMPLOYEE', co: null, sv: 0, k: 1, iat: Math.floor(Date.now() / 1000) - 2 * 86400 }, config.sessionSecret, {
      algorithm: 'HS256', subject: ids.admin, expiresIn: '88d',
    });
    const renewed = await as(old).get('/auth/me');
    expect(renewed.status).toBe(200);
    expect(jwt.decode(renewed.headers['x-atom-token'])).toMatchObject({ k: 1, sub: ids.admin });
    expect((await as(switched).get('/auth/me')).headers['x-atom-token']).toBeUndefined();
    expect((await as(short).get('/auth/me')).headers['x-atom-token']).toBeUndefined();
    expect((await loginRes('90000953', { keep: 'yes' })).status).toBe(400);
  });

  test('sign out of all devices: others get 401, this device continues', async () => {
    const a = (await loginRes('90000953', { keep: true })).body.token;
    const b = (await loginRes('90000953')).body.token;
    const r = await as(a).post('/auth/sign-out-everywhere');
    expect(r.status).toBe(200);
    expect(jwt.decode(r.body.token).k).toBe(1);
    expect((await as(r.body.token).get('/auth/me')).status).toBe(200);
    for (const t of [a, b]) expect((await as(t).get('/auth/me')).body.code).toBe('password_changed');
  });

  test('How I get notified: email off = no email; in-app off = kept as history, already read, no count', async () => {
    const admin = as((await loginRes('90000952', { role: 'ADMIN' })).body.token);
    const alice = as((await loginRes('90000953')).body.token);
    expect((await admin.get('/auth/me')).body.user.notify).toEqual({ inApp: true, email: true });
    expect((await admin.patch('/auth/notify', { inApp: false, email: false })).body.code).toBe('need_one');
    expect((await admin.patch('/auth/notify', { inApp: 'no', email: true })).status).toBe(400);

    expect((await admin.patch('/auth/notify', { inApp: true, email: false })).body.notify).toEqual({ inApp: true, email: false });
    await alice.post('/requests', { title: 'Printer jams', description: 'x', categoryId: cat });
    expect((await pool.query('SELECT count(*)::int AS n FROM email_outbox')).rows[0].n).toBe(0);
    expect((await admin.get('/notifications/unread-count')).body.unread).toBe(1);

    await admin.patch('/auth/notify', { inApp: false, email: true });
    expect((await admin.get('/auth/me')).body.user.notify).toEqual({ inApp: false, email: true });
    await alice.post('/requests', { title: 'Scanner', description: 'x', categoryId: cat });
    expect((await pool.query('SELECT to_email FROM email_outbox')).rows.map((x) => x.to_email)).toEqual(['admin@example.org']);
    expect((await admin.get('/notifications/unread-count')).body.unread).toBe(1); // the new one arrived read
    const list = (await admin.get('/notifications')).body.notifications;
    expect(list.map((n) => [n.title, n.read])).toEqual([['New ticket T-1002', true], ['New ticket T-1001', false]]);
  });
});
