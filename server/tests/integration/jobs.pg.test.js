// Phase 16: sync/run-jobs.js (Task Scheduler, every 5 min) on real PostgreSQL. Overdue found once even when
// the web server's timer runs at the same moment; its push goes out before the script exits; queued
// emails sent once; old email log cleaned. eJamaat, SMTP and web-push mocked.
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

maybe('background jobs script on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { adminOf, companyId } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const mailer = require('../../services/mailer');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const push = require('../../modules/push/push.service');
  const jobs = require('../../jobs');
  const { main } = require('../../../sync/run-jobs');

  let app;
  const ids = {};
  let avit;
  const webpush = { setVapidDetails: jest.fn(), sendNotification: jest.fn() };
  const savedSmtp = { ...config.smtp };

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role, company) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role, companyId: company })).body.token;
  const post = (token, p, b) => request(app).post(`/Atom/api${p}`).set('Authorization', `Bearer ${token}`).send(b);

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
    Object.assign(config.smtp, savedSmtp);
    await pool.query('UPDATE notify_settings SET push_enabled = FALSE');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE email_outbox, push_subscriptions, notifications, request_items, request_attachments, request_events, requests,
                      user_change_log, user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query('UPDATE notify_settings SET push_enabled = TRUE, email_enabled = FALSE');
    await pool.query('UPDATE service_units SET is_open = TRUE');
    config.vapid = { publicKey: 'BPublicKeyForTests', privateKey: 'private', subject: 'mailto:it@example.edu' };
    Object.assign(config.smtp, { host: 'smtp.test' });
    webpush.sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
    mailer.sendMail.mockReset().mockResolvedValue({});
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    avit = await companyId(pool, 'AVIT');
    ids.admin = await addUser('40000010', 'AVIT Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.admin, 'AVIT');
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
  });

  test('overdue: claimed once with the web timer running too; push sent before exit; emails sent once; old log cleaned', async () => {
    const alice = await login('40000001', 'EMPLOYEE', avit);
    const admin = await login('40000010', 'ADMIN');
    await post(admin, '/push/subscriptions', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/admin-phone', keys: { p256dh: `B${'p'.repeat(60)}`, auth: 'auth-secret-1' } } });
    const cat = (await pool.query('SELECT id FROM categories WHERE service_unit_id = $1 LIMIT 1', [avit])).rows[0].id;
    await (post(alice, '/requests', { title: 'Projector off', description: 'x', categoryId: String(cat) }));
    await new Promise((r) => setTimeout(r, 200)); // the "new ticket" push from the web request
    webpush.sendNotification.mockClear();
    await pool.query(`UPDATE requests SET due_by = now() - interval '1 minute' WHERE id = (SELECT max(id) FROM requests)`);

    // Queued emails: one to send, one sent long ago (cleaned), one failed long ago (cleaned).
    await pool.query(`INSERT INTO email_outbox (to_email, subject, body_text) VALUES ('a@example.edu', 'Queued', 'x')`);
    await pool.query(`INSERT INTO email_outbox (to_email, subject, body_text, status, created_at) VALUES
                       ('b@example.edu', 'Old sent', 'x', 'sent', now() - interval '91 days'),
                       ('c@example.edu', 'Old failed', 'x', 'failed', now() - interval '120 days')`);

    // Task Scheduler script and the web server's minute timer at the same moment.
    const [script] = await Promise.all([main(), jobs.runOnce()]);
    const overdueRows = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE '% is overdue'`);
    const perPerson = await pool.query(`SELECT user_id, count(*)::int AS n FROM notifications WHERE title LIKE '% is overdue' GROUP BY user_id`);
    expect(overdueRows.rows[0].n).toBeGreaterThan(0);
    expect(perPerson.rows.every((r) => r.n === 1)).toBe(true); // nobody told twice
    expect(mailer.sendMail).toHaveBeenCalledTimes(1); // the queued email, once
    expect((await pool.query(`SELECT status FROM email_outbox WHERE subject = 'Queued'`)).rows[0].status).toBe('sent');
    expect((await pool.query('SELECT count(*)::int AS n FROM email_outbox')).rows[0].n).toBe(1); // old ones cleaned

    // If the script found it, its push was sent before main() returned.
    if (script.overdue === 1) {
      expect(webpush.sendNotification).toHaveBeenCalled();
      expect(JSON.parse(webpush.sendNotification.mock.calls[0][1]).title).toMatch(/overdue/i);
    }

    // Next round: nothing new.
    webpush.sendNotification.mockClear();
    expect(await main()).toEqual({ overdue: 0, poolsAssigned: 0, emailsSent: 0, emailsFailed: 0, emailsCleaned: 0, wifiExpired: 0, notificationsCleared: 0 });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  test('script alone: finds the overdue request and pushes it before returning', async () => {
    const alice = await login('40000001', 'EMPLOYEE', avit);
    const admin = await login('40000010', 'ADMIN');
    await post(admin, '/push/subscriptions', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/admin-phone', keys: { p256dh: `B${'p'.repeat(60)}`, auth: 'auth-secret-1' } } });
    const cat = (await pool.query('SELECT id FROM categories WHERE service_unit_id = $1 LIMIT 1', [avit])).rows[0].id;
    await (post(alice, '/requests', { title: 'Mic dead', description: 'x', categoryId: String(cat) }));
    await new Promise((r) => setTimeout(r, 200));
    webpush.sendNotification.mockClear();
    await pool.query(`UPDATE requests SET due_by = now() - interval '1 minute' WHERE id = (SELECT max(id) FROM requests)`);

    const r = await main();
    expect(r.overdue).toBe(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1); // already sent — no waiting needed
    expect(JSON.parse(webpush.sendNotification.mock.calls[0][1]).url).toMatch(/^\/Atom\/notifications\?open=\d+$/);
  });
});

if (!enabled) {
  test('jobs integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
