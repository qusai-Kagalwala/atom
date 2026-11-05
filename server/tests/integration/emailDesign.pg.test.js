// Email design (Super Admin) on real PostgreSQL: save / reset / preview / test email, RBAC, and the saved
// design + the sending company's name in queued emails. eJamaat and SMTP mocked.
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

maybe('email design on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { adminOf } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const mailer = require('../../services/mailer');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const emailDesign = require('../../services/emailDesign');

  let app;
  let sa;
  let admin;
  let alice;
  let cat;
  const ids = {};

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
      put: (p, b = {}) => auth(request(app).put(`/Atom/api${p}`)).send(b),
    };
  };
  const navy = { ...emailDesign.DEFAULTS, palette: 'navy', style: 'banner', signOff: 'Regards, {company} Team', footerText: '{company} help desk' };

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
    await pool.query(`TRUNCATE email_design_log, email_design, email_outbox, notifications, request_items, request_attachments, request_events, requests,
                      user_change_log, user_service_units, user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query('INSERT INTO notify_settings (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET email_enabled = TRUE');
    emailDesign.clearCache();
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    mailer.sendMail.mockReset().mockResolvedValue({});
    config.smtp.host = '';
    app = createApp();
    ids.sa = await addUser('90000901', 'Super Sample', ['EMPLOYEE', 'SUPER_ADMIN'], 'super@example.org');
    ids.admin = await addUser('90000902', 'Admin Sample', ['EMPLOYEE'], 'admin@example.org');
    await adminOf(pool, ids.admin);
    ids.alice = await addUser('90000903', 'Alice Sample', ['EMPLOYEE'], 'alice@example.org');
    cat = String((await pool.query(`SELECT id FROM categories WHERE name='Printer / Scanner'`)).rows[0].id);
    sa = as(await login('90000901', 'SUPER_ADMIN'));
    admin = as(await login('90000902', 'ADMIN'));
    alice = as(await login('90000903'));
  });

  test('only the Super Admin reaches it (others 404)', async () => {
    for (const who of [admin, alice]) {
      expect((await who.get('/settings/email-design')).status).toBe(404);
      expect((await who.put('/settings/email-design', { design: navy })).status).toBe(404);
      expect((await who.post('/settings/email-design/preview', { design: navy })).status).toBe(404);
    }
    const r = await sa.get('/settings/email-design');
    expect(r.status).toBe(200);
    expect(r.body.design).toEqual(emailDesign.DEFAULTS);
    expect(Object.keys(r.body.palettes)).toEqual(['teal', 'navy', 'maroon']);
    expect(r.body.history).toEqual([]);
  });

  test('save checks every value, is logged, and reset brings the default back', async () => {
    expect((await sa.put('/settings/email-design', { design: { ...navy, palette: 'custom', colors: { ...navy.colors, primary: 'red' } } })).status).toBe(400);
    const light = await sa.put('/settings/email-design', { design: { ...navy, palette: 'custom', colors: { primary: '#F5E6A8', accent: '#C9A84C', background: '#FFFFFF', text: '#111111' } } });
    expect(light.status).toBe(400);
    expect(light.body.message).toMatch(/too light/);
    expect((await sa.put('/settings/email-design', { design: { ...navy, title: '' } })).status).toBe(400);
    expect((await sa.put('/settings/email-design', { design: { ...navy, style: 'neon' } })).status).toBe(400);

    const saved = await sa.put('/settings/email-design', { design: { ...navy, colors: { primary: '#000000' }, extra: 'dropped' } });
    expect(saved.status).toBe(200);
    expect(saved.body.design.colors).toEqual({ primary: '#1E3A6E', accent: '#C9A84C', background: '#F6F8FC', text: '#141A28' }); // palette wins
    expect(saved.body.design.extra).toBeUndefined();
    expect((await sa.get('/settings/email-design')).body.design.style).toBe('banner');

    expect((await sa.post('/settings/email-design/reset')).body.design).toEqual(emailDesign.DEFAULTS);
    const h = (await sa.get('/settings/email-design')).body.history;
    expect(h.map((x) => [x.kind, x.by])).toEqual([['reset', 'Super Sample'], ['save', 'Super Sample']]);
  });

  test('preview renders the draft without saving; HTML is escaped', async () => {
    const r = await sa.post('/settings/email-design/preview', { design: { ...navy, title: '<b>X</b>' }, sample: 'wifi', company: 'Tanzeem' });
    expect(r.status).toBe(200);
    expect(r.body.html).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(r.body.html).toContain('Regards, Tanzeem Team');
    expect(r.body.html).toContain('#1E3A6E');
    expect(r.body.html).toContain('Sample#123');
    expect((await sa.post('/settings/email-design/preview', { design: navy, sample: 'nope' })).status).toBe(400);
    expect((await pool.query('SELECT count(*)::int AS n FROM email_design')).rows[0].n).toBe(0);
  });

  test('test email: needs SMTP, goes only to the Super Admin', async () => {
    expect((await sa.post('/settings/email-design/test', { design: navy, sample: 'ticket', company: 'AVIT' })).status).toBe(503);
    config.smtp.host = 'smtp.test';
    const r = await sa.post('/settings/email-design/test', { design: navy, sample: 'ticket', company: 'AVIT' });
    expect(r.body).toEqual({ sent: true, to: 'super@example.org' });
    const m = mailer.sendMail.mock.calls[0][0];
    expect(m.to).toBe('super@example.org');
    expect(m.subject).toMatch(/^\[Test\] /);
    expect(m.html).toContain('Regards, AVIT Team');
    expect(m.text).toContain('Regards, AVIT Team');
  });

  test('queued emails use the saved design and the ticket company name', async () => {
    await sa.put('/settings/email-design', { design: navy });
    expect((await alice.post('/requests', { title: 'Printer jams', description: 'x', categoryId: cat })).status).toBe(201);
    const q = (await pool.query('SELECT to_email, body_text, body_html FROM email_outbox ORDER BY id')).rows;
    expect(q.map((x) => x.to_email)).toEqual(['admin@example.org']);
    expect(q[0].body_html).toContain('#1E3A6E');
    expect(q[0].body_html).toContain('AVIT help desk');
    expect(q[0].body_text).toContain('Regards, AVIT Team');

    config.smtp.host = 'smtp.test';
    const email = require('../../modules/notifications/email');
    expect(await email.sendQueued()).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sendMail.mock.calls[0][0].html).toContain('AVIT help desk');
  });
});
