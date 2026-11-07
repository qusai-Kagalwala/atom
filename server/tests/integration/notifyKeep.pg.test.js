// Auto-clear old notifications (7 Nov 2026, migration 034): each person picks 1 week / 15 days / 1 month / never.
// Runs ONLY when TEST_DATABASE_URL points at a database whose name ends in "_test". eJamaat mocked.
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

maybe('notification auto-clear on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const jobs = require('../../jobs');

  let app;
  const ids = {};
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  async function addUser(its, name) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'EMPLOYEE')`, [rows[0].id]);
    return String(rows[0].id);
  }
  const note = (userId, daysAgo, read = false) =>
    pool.query(
      `INSERT INTO notifications (user_id, type, title, created_at, read_at)
       VALUES ($1, 'test', $2, now() - make_interval(days => $3::int), CASE WHEN $4::boolean THEN now() END)`,
      [userId, `${daysAgo} days old`, daysAgo, read]
    );
  const login = async (identifier) => (await request(app).post('/Atom/api/auth/login').send({ identifier, password: 'x' })).body.token;
  const keep = (token, keepDays) => request(app).patch('/Atom/api/auth/notify-keep').set('Authorization', `Bearer ${token}`).send({ keepDays });

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
    await pool.query('TRUNCATE notifications, user_roles, users RESTART IDENTITY CASCADE');
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.a = await addUser('90009701', 'Week Person');
    ids.b = await addUser('90009702', 'Never Person');
  });

  test('default never; choice saved and shown in the session; bad values refused', async () => {
    const t = await login('90009701');
    const me = () => request(app).get('/Atom/api/auth/me').set('Authorization', `Bearer ${t}`);
    expect((await me()).body.user.notify).toEqual({ inApp: true, email: true, keepDays: null });
    expect((await keep(t, 7)).body).toEqual({ keepDays: 7 });
    expect((await me()).body.user.notify.keepDays).toBe(7);
    expect((await keep(t, 10)).body.code).toBe('bad_keep');
    expect((await keep(t, '7')).body.code).toBe('bad_keep');
    expect((await keep(t, null)).body).toEqual({ keepDays: null });
    expect((await request(app).patch('/Atom/api/auth/notify-keep').send({ keepDays: 7 })).status).toBe(401);
  });

  test('the job deletes only that person\'s notifications older than their choice, read or unread', async () => {
    await keep(await login('90009701'), 7);
    for (const days of [1, 6, 8, 40]) await note(ids.a, days, days === 40);
    for (const days of [1, 8, 40]) await note(ids.b, days);

    expect(await jobs.clearOldNotifications()).toBe(2);
    expect((await q('SELECT title FROM notifications WHERE user_id = $1 ORDER BY created_at DESC', [ids.a])).map((r) => r.title)).toEqual(['1 days old', '6 days old']);
    expect((await q('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [ids.b]))[0].n).toBe(3); // never → kept
    expect((await jobs.runOnce()).notificationsCleared).toBe(0);
  });
});

if (!enabled) {
  test('notification auto-clear tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {});
}
