// Contact details (7 Nov 2026, migration 032): people set their own email / mobile in Profile; the Super
// Admin sets anyone's (synced users too). Saved straight away, logged (field names only), kept by the sync.
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

maybe('contact details on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  async function addUser({ its, emp, name, roles = ['EMPLOYEE'], source = 'idarah', email = null, mobile = null }) {
    const { rows } = await pool.query(
      `INSERT INTO users (login_type, its_number, employee_id, legacy_password, name, source, email, mobile)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [its ? 'ITS' : 'EMPLOYEE_ID', its || null, emp || null, emp ? 'legacy-pw' : null, name, source, email, mobile]
    );
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }

  const login = async (identifier, password = 'x') => (await request(app).post('/Atom/api/auth/login').send({ identifier, password })).body.token;
  const api = (token) => ({
    me: () => request(app).get('/Atom/api/auth/me').set('Authorization', `Bearer ${token}`),
    contact: (b) => request(app).patch('/Atom/api/auth/contact').set('Authorization', `Bearer ${token}`).send(b),
    user: (id) => request(app).get(`/Atom/api/users/${id}`).set('Authorization', `Bearer ${token}`),
    edit: (id, b) => request(app).patch(`/Atom/api/users/${id}`).set('Authorization', `Bearer ${token}`).send(b),
  });

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
    await pool.query(`TRUNCATE notifications, user_change_log, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.admin = await addUser({ its: '90009801', name: 'Super Admin', roles: ['EMPLOYEE', 'SUPER_ADMIN'], source: 'manual' });
    ids.its = await addUser({ its: '90009802', name: 'Synced Person', mobile: '9820000002' });
    ids.emp = await addUser({ emp: '4321', name: 'Staff Member', source: 'hr' });
  });

  test('own details: saved straight away, cleaned, marked "self", logged without values', async () => {
    const me = api(await login('90009802'));
    const r = await me.contact({ email: '  Person@Example.COM ', mobile: '+91 98200-11111' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: 'person@example.com', mobile: '919820011111', contactSetBy: { email: 'self', mobile: 'self' } });
    expect((await me.me()).body.user).toMatchObject({ email: 'person@example.com', mobile: '919820011111' });

    const log = await q(`SELECT action, detail, changed_by::text FROM user_change_log WHERE user_id = $1`, [ids.its]);
    expect(log).toEqual([{ action: 'profile_updated', detail: { fields: ['email', 'mobile'], source: 'themselves' }, changed_by: ids.its }]);
    expect(JSON.stringify(log)).not.toMatch(/example|98200/);

    // Only one field sent → the other is untouched. Clearing removes the mark.
    const cleared = await me.contact({ email: '' });
    expect(cleared.body.user).toMatchObject({ email: null, mobile: '919820011111', contactSetBy: { email: null, mobile: 'self' } });
  });

  test('own details: checks; employee-ID login too; nothing sent = 400; needs login', async () => {
    const me = api(await login('4321', 'legacy-pw'));
    expect((await me.contact({ email: 'not-an-email' })).body.code).toBe('bad_email');
    expect((await me.contact({ mobile: '12345' })).body.code).toBe('bad_mobile');
    expect((await me.contact({ mobile: '809820000000' })).body.code).toBe('bad_mobile'); // 12 digits must start with 91
    expect((await me.contact({})).body.code).toBe('nothing');
    const ok = await me.contact({ mobile: '9820033333' });
    expect(ok.body.user).toMatchObject({ employeeId: '4321', mobile: '9820033333' });
    expect((await request(app).patch('/Atom/api/auth/contact').send({ email: 'a@b.co' })).status).toBe(401);
  });

  test("Super Admin sets a synced user's email / mobile; name stays read-only; person told", async () => {
    const admin = api(await login('90009801'));
    const r = await admin.edit(ids.its, { email: 'office@example.edu', mobile: '9820044444' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: 'office@example.edu', mobile: '9820044444', emailSetBy: 'admin', mobileSetBy: 'admin' });
    expect(r.body.user.history[0].text).toBe('Details edited: email, mobile');

    const notes = await q(`SELECT user_id::text, type, title, link FROM notifications`);
    expect(notes).toEqual([{ user_id: ids.its, type: 'profile', title: 'Your email and mobile number were updated', link: '/profile' }]);

    expect((await admin.edit(ids.its, { name: 'Other Name' })).body.code).toBe('synced_read_only');
    expect((await admin.edit(ids.its, { mobile: '123' })).status).toBe(400);
    expect((await admin.edit(ids.its, { mobile: '98200 444' })).body.code).toBe('bad_mobile'); // passes the form check, not the 10-digit rule

    // Same values again: no change, no history line, no new notification.
    await admin.edit(ids.its, { email: 'office@example.edu', mobile: '9820044444' });
    expect((await q(`SELECT count(*)::int AS n FROM notifications`))[0].n).toBe(1);
  });

  test("someone else's details: only through the Super Admin API (404 for others)", async () => {
    const me = api(await login('90009802'));
    expect((await me.edit(ids.emp, { email: 'x@example.com' })).status).toBe(404);
    expect((await q(`SELECT email FROM users WHERE id = $1`, [ids.emp]))[0].email).toBeNull();
  });
});

if (!enabled) {
  test('contact integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {});
}
