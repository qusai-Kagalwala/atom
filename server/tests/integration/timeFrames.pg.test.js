// Time frames, priority changes with a message, overdue job and email notifications on real
// PostgreSQL. eJamaat and SMTP mocked. Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
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
const MIN = 60 * 1000;

maybe('time frames, overdue and email on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const timeFrames = require('../../modules/requests/timeFrames');
  const email = require('../../modules/notifications/email');

  let app;
  const ids = {};
  let admin;
  let alice;
  let eng1;
  let cat;

  async function addUser(its, name, roles, mail = null) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, email, source) VALUES ('ITS', $1, $2, $3, 'manual') RETURNING id`, [its, name, mail]);
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
      patch: (p, b = {}) => auth(request(app).patch(`/Atom/api${p}`)).send(b),
    };
  };
  const raise = (who, b = {}) => who.post('/requests', { title: 'Printer jams', description: 'x', categoryId: cat, ...b });
  const notes = async (id) => (await pool.query('SELECT title, body, role FROM notifications WHERE user_id = $1 ORDER BY id', [id])).rows;
  const window = (t) => [(new Date(t.dueFrom) - new Date(t.createdAt)) / MIN, (new Date(t.dueBy) - new Date(t.createdAt)) / MIN];

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    config.smtp.host = '';
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE email_outbox, notifications, request_items, request_attachments, request_events, requests, user_change_log,
                      user_service_units, user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    await pool.query(`UPDATE priority_targets SET min_minutes = d.mn, max_minutes = d.mx
                        FROM (VALUES ('HIGH', 30, 120), ('NORMAL', 120, 240), ('LOW', 240, 2880)) d(p, mn, mx)
                       WHERE priority::text = d.p`);
    await pool.query('INSERT INTO notify_settings (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET email_enabled = FALSE');
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    config.smtp.host = '';
    app = createApp();
    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN'], 'qusai@example.org');
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE'], 'alice@example.org');
    ids.eng1 = await addUser('40000003', 'Eng One', ['EMPLOYEE', 'ENGINEER']);
    const avit = (await pool.query(`SELECT id FROM service_units WHERE code='AVIT'`)).rows[0].id;
    await pool.query('INSERT INTO user_service_units (user_id, service_unit_id) VALUES ($1, $2)', [ids.eng1, avit]);
    cat = String((await pool.query(`SELECT id FROM categories WHERE name='Printer / Scanner'`)).rows[0].id);
    admin = as(await login('30328701', 'SUPER_ADMIN'));
    alice = as(await login('40000001'));
    eng1 = as(await login('40000003', 'ENGINEER'));
  });

  test('every ticket and request gets its window from when it was raised; Urgent is gone', async () => {
    expect(window((await raise(alice)).body.request)).toEqual([120, 240]);
    expect(window((await raise(alice, { priority: 'HIGH' })).body.request)).toEqual([30, 120]);
    expect(window((await raise(alice, { priority: 'LOW' })).body.request)).toEqual([240, 2880]);
    expect((await raise(alice, { priority: 'URGENT' })).status).toBe(400);
    const sr = (await alice.post('/requests/service', { items: [{ name: 'Wireless presenter', quantity: 1, reason: 'For the hall' }] })).body.request;
    expect(window(sr)).toEqual([120, 240]);
    expect((await alice.get('/requests/time-frames')).body.timeFrames).toEqual([
      expect.objectContaining({ priority: 'HIGH', minMinutes: 30, maxMinutes: 120 }),
      expect.objectContaining({ priority: 'NORMAL', minMinutes: 120, maxMinutes: 240 }),
      expect.objectContaining({ priority: 'LOW', minMinutes: 240, maxMinutes: 2880 }),
    ]);
    expect((await alice.get('/requests/mine')).body.requests[0]).toMatchObject({ dueBy: expect.any(String), doneAt: null });
  });

  test('Super Admin edits the time frames; employees cannot', async () => {
    expect((await alice.get('/settings')).status).toBe(404);
    expect((await admin.patch('/settings/time-frames', { targets: [{ priority: 'HIGH', minMinutes: 90, maxMinutes: 60 }] })).status).toBe(400);
    expect((await admin.patch('/settings/time-frames', { targets: [{ priority: 'URGENT', minMinutes: 1, maxMinutes: 2 }] })).status).toBe(400);
    const t = (await admin.patch('/settings/time-frames', { targets: [{ priority: 'HIGH', minMinutes: 15, maxMinutes: 60 }] })).body.timeFrames;
    expect(t[0]).toMatchObject({ priority: 'HIGH', minMinutes: 15, maxMinutes: 60 });
    expect(window((await raise(alice, { priority: 'HIGH' })).body.request)).toEqual([15, 60]);
  });

  test('priority change: new window from the raise time, message to requester + engineer, on the timeline', async () => {
    await raise(alice, { priority: 'LOW' });
    await admin.post('/requests/T-1001/actions/assign', { engineerId: ids.eng1 });
    const t = (await admin.patch('/requests/T-1001', { priority: 'HIGH', message: 'Exam papers are waiting — please do this first.' })).body.request;
    expect(t.priority).toBe('HIGH');
    expect(window(t)).toEqual([30, 120]);
    expect(t.events.at(-1)).toMatchObject({ type: 'priority', note: 'Exam papers are waiting — please do this first.', data: { from: 'LOW', to: 'HIGH' } });
    expect((await notes(ids.alice)).at(-1)).toMatchObject({ title: 'Priority of T-1001 changed to High', body: expect.stringMatching(/^Exam papers are waiting/) });
    expect((await notes(ids.eng1)).at(-1)).toMatchObject({ title: 'Priority of T-1001 changed to High', role: 'ENGINEER' });
    expect((await admin.patch('/requests/T-1001', { priority: 'HIGH', message: 'x'.repeat(1001) })).status).toBe(400);
    expect((await eng1.patch('/requests/T-1001', { priority: 'LOW' })).status).toBe(404);
  });

  test('overdue: told once (Super Admins + engineer); done ones are not', async () => {
    await raise(alice);
    await raise(alice);
    await admin.post('/requests/T-1001/actions/assign', { engineerId: ids.eng1 });
    await pool.query(`UPDATE requests SET due_by = now() - interval '1 minute'`);
    await admin.post('/requests/T-1002/actions/reject', { note: 'Duplicate' });
    const publish = jest.fn();
    expect(await timeFrames.checkOverdue({ publish })).toBe(1);
    expect(await timeFrames.checkOverdue({ publish })).toBe(0);
    expect((await notes(ids.admin)).filter((n) => /overdue/.test(n.title))).toEqual([{ title: 'T-1001 is overdue', body: 'Printer jams', role: 'SUPER_ADMIN' }]);
    expect((await notes(ids.eng1)).at(-1)).toMatchObject({ title: 'T-1001 is overdue', role: 'ENGINEER' });
    expect((await notes(ids.alice)).some((n) => /overdue/.test(n.title))).toBe(false);
    // Lowering the priority moves the window later → can be told again later.
    await admin.patch('/requests/T-1001', { priority: 'LOW' });
    expect((await pool.query(`SELECT overdue_notified_at FROM requests WHERE number = 1001`)).rows[0].overdue_notified_at).toBeNull();
  });

  test('email: off by default; when on, every notification to someone with an email is queued and sent', async () => {
    await raise(alice);
    expect((await pool.query('SELECT count(*)::int AS n FROM email_outbox')).rows[0].n).toBe(0);

    expect((await admin.patch('/settings/email', { enabled: 'yes' })).status).toBe(400);
    expect((await admin.patch('/settings/email', { enabled: true })).body.email).toMatchObject({ emailEnabled: true, smtpConfigured: false });
    await raise(alice, { priority: 'HIGH' }); // → Super Admin (has email)
    await admin.post('/requests/T-1002/actions/assign', { engineerId: ids.eng1 }); // → engineer (no email) + Alice
    const queued = (await pool.query('SELECT to_email, subject, body_text FROM email_outbox ORDER BY id')).rows;
    expect(queued.map((q) => [q.to_email, q.subject])).toEqual([
      ['qusai@example.org', 'ATOM: New ticket T-1002'],
      ['alice@example.org', 'ATOM: An engineer is on T-1002'],
    ]);
    expect(queued[1].body_text).toMatch(/Expected by: /);
    expect(queued[1].body_text).toContain(`${config.appUrl}/tickets/T-1002`);

    // No SMTP host → nothing is sent yet.
    expect(await email.sendQueued({ send: jest.fn() })).toEqual({ sent: 0, failed: 0 });
    config.smtp.host = 'smtp.test';
    const send = jest.fn().mockResolvedValueOnce({}).mockRejectedValue(new Error('550 mailbox unavailable'));
    expect(await email.sendQueued({ send })).toEqual({ sent: 1, failed: 0 });
    expect(send.mock.calls[0][0]).toMatchObject({ to: 'qusai@example.org', subject: 'ATOM: New ticket T-1002' });
    // The failing one: retried, then failed after 3 tries.
    for (let i = 0; i < 2; i += 1) {
      await pool.query(`UPDATE email_outbox SET next_try_at = now() WHERE status = 'queued'`);
      await email.sendQueued({ send });
    }
    const s = (await admin.get('/settings')).body.email;
    expect(s.emails.map((e) => [e.to, e.status, e.attempts])).toEqual([
      ['alice@example.org', 'failed', 3],
      ['qusai@example.org', 'sent', 1],
    ]);
    expect(s.emails[0].error).toBe('550 mailbox unavailable');
    expect(s.counts).toMatchObject({ queued: 0, sentToday: 1, failedThisWeek: 1 });
  });
});
