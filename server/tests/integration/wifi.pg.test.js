// Guest Wi-Fi passes on real PostgreSQL (5 Nov 2026): upload (preview / save), buckets per department,
// HOD (Masool) page and access, giving passes (HOD, Admin direct, bulk), ITS lookup (ATOM, eJamaat),
// WhatsApp / email sharing, requests, Reset and expiry deleting the passes.
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

jest.mock('../../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn(), getMuminDetails: jest.fn() }));
jest.mock('../../services/mailer', () => ({ sendMail: jest.fn() }));

const maybe = enabled ? describe : describe.skip;

maybe('Guest Wi-Fi passes on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { adminOf, companyId } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const mailer = require('../../services/mailer');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const wifi = require('../../modules/wifi/wifi.service');

  let app;
  const ids = {};
  const co = {};
  const dept = {};
  const savedSmtp = { ...config.smtp };

  async function addUser(its, name, roles, extra = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (login_type, its_number, name, source, mobile, email) VALUES ('ITS', $1, $2, 'manual', $3, $4) RETURNING id`,
      [its, name, extra.mobile || null, extra.email || null]
    );
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const post = (userId, depId, p, cat = null) =>
    pool.query('INSERT INTO user_posts (user_id, department_id, post, post_category, is_active) VALUES ($1, $2, $3, $4, TRUE)', [userId, depId, p, cat]);
  const login = async (its, role, company) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role, companyId: company })).body.token;
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api/wifi${p}`)),
      post: (p, b = {}) => auth(request(app).post(`/Atom/api/wifi${p}`)).send(b),
      patch: (p, b = {}) => auth(request(app).patch(`/Atom/api/wifi${p}`)).send(b),
      upload: (fields, csv, name = 'passes.csv') => {
        let r = auth(request(app).post('/Atom/api/wifi/batches'));
        for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
        return r.attach('file', Buffer.from(csv), name);
      },
    };
  };
  const csv = (n, start = 1) => ['Username,Password', ...Array.from({ length: n }, (_, i) => `guest${start + i},pw-${start + i}`)].join('\r\n');
  const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    Object.assign(config.smtp, savedSmtp);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE wifi_log, wifi_requests, wifi_passes, wifi_batches, email_outbox, notifications, user_change_log, user_posts,
                      user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO wifi_settings (id, hod_posts) VALUES (1, ARRAY['Masool']) ON CONFLICT (id) DO UPDATE SET hod_posts = ARRAY['Masool']`);
    await pool.query('UPDATE service_units SET is_open = TRUE');
    await pool.query(`DELETE FROM departments WHERE idarah_id LIKE 'WIFI-%'`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    ejamaat.getMuminDetails.mockReset().mockResolvedValue(null);
    mailer.sendMail.mockReset().mockResolvedValue({});
    Object.assign(config.smtp, { host: 'smtp.test' });
    app = createApp();
    co.avit = await companyId(pool, 'AVIT');
    co.siy = await companyId(pool, 'SIYANAAT');
    const d = await pool.query(
      `INSERT INTO departments (idarah_id, name, is_active) VALUES ('WIFI-1', 'Wifi Library', TRUE), ('WIFI-2', 'Wifi Accounts', TRUE) RETURNING id, name`
    );
    dept.lib = String(d.rows[0].id);
    dept.acc = String(d.rows[1].id);
    ids.admin = await addUser('40000010', 'AVIT Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.admin, 'AVIT');
    ids.hod = await addUser('40000001', 'Library Masool', ['EMPLOYEE']);
    await post(ids.hod, dept.lib, 'Masool');
    ids.clerk = await addUser('40000002', 'Library Clerk', ['EMPLOYEE']);
    await post(ids.clerk, dept.lib, 'Clerk');
    ids.guest = await addUser('40000003', 'Known Guest', ['EMPLOYEE'], { mobile: '9820012345', email: 'guest@example.edu' });
    ids.accHod = await addUser('40000004', 'Accounts Head', ['EMPLOYEE']);
    await post(ids.accHod, dept.acc, 'Head', 'masool'); // matched on post category, any case
  });

  async function newBatch(admin, n = 20, extra = {}) {
    const r = await admin.upload({ name: 'Urs guests', ssid: 'AJSM-Guest', expiresAt: inDays(2), commit: true, ...extra }, csv(n));
    expect(r.status).toBe(200);
    return r.body.batchId;
  }

  test('upload: preview saves nothing, errors block unless skipped, Admin only, AVIT only', async () => {
    const admin = as(await login('40000010', 'ADMIN'));
    const bad = 'Username,Password\r\nguest1,a\r\nguest1,b\r\n,c\r\n"guest3","p,3"\r\n';
    const prev = await admin.upload({ name: 'B', ssid: 'S', expiresAt: inDays(1) }, bad);
    expect(prev.body).toMatchObject({ rows: 2, committed: false, sample: ['guest1', 'guest3'] });
    expect(prev.body.errors.map((e) => e.row)).toEqual([3, 4]);
    expect((await pool.query('SELECT count(*)::int AS n FROM wifi_passes')).rows[0].n).toBe(0);
    expect((await admin.upload({ name: 'B', ssid: 'S', expiresAt: inDays(1), commit: true }, bad)).body.code).toBe('row_errors');
    const saved = await admin.upload({ name: 'B', ssid: 'S', expiresAt: inDays(1), commit: true, skipErrors: true }, bad);
    expect(saved.body).toMatchObject({ committed: true, rows: 2 });
    expect((await pool.query(`SELECT password FROM wifi_passes WHERE username = 'guest3'`)).rows[0].password).toBe('p,3');

    expect((await admin.upload({ name: 'B', ssid: 'S', expiresAt: new Date(Date.now() - 1000).toISOString() }, csv(2))).body.code).toBe('bad_expiry');
    expect((await admin.upload({ name: 'B', ssid: 'S', expiresAt: inDays(1) }, 'Name,Code\r\na,b')).body.code).toBe('bad_columns');
    expect((await admin.upload({ name: 'B', ssid: 'S', expiresAt: inDays(1) }, 'x', 'p.xlsx')).body.code).toBe('bad_file_type');

    const hod = as(await login('40000001', 'EMPLOYEE', co.avit));
    expect((await hod.get('/batches')).status).toBe(404);
    expect((await hod.upload({ name: 'B', ssid: 'S', expiresAt: inDays(1) }, csv(2))).status).toBe(404);
    const elsewhere = as(await login('40000001', 'EMPLOYEE', co.siy));
    expect((await elsewhere.get('/me')).status).toBe(404);
  });

  test('buckets: allocate, take back, not enough, never below what was given; HOD told (no passwords)', async () => {
    const admin = as(await login('40000010', 'ADMIN'));
    const batchId = await newBatch(admin, 20);
    let r = await admin.post(`/batches/${batchId}/allocate`, { items: [{ departmentId: dept.lib, count: 12 }, { departmentId: dept.acc, count: 5 }] });
    expect(r.status).toBe(200);
    expect(r.body.batch.counts).toMatchObject({ free: 3, allocated: 17, given: 0 });
    const lib = r.body.departments.find((d) => d.id === dept.lib);
    expect(lib).toMatchObject({ allocated: 12, left: 12, hods: 'Library Masool' });
    expect(r.body.departments.find((d) => d.id === dept.acc).hods).toBe('Accounts Head');

    expect((await admin.post(`/batches/${batchId}/allocate`, { items: [{ departmentId: dept.acc, count: 9 }] })).body.code).toBe('not_enough');
    r = await admin.post(`/batches/${batchId}/allocate`, { items: [{ departmentId: dept.lib, count: 8 }] });
    expect(r.body.batch.counts).toMatchObject({ free: 7, allocated: 13 });

    const n = (await pool.query(`SELECT title, body FROM notifications WHERE user_id = $1`, [ids.hod])).rows;
    expect(n[0].title).toBe('12 guest Wi-Fi passes for Wifi Library');
    expect(JSON.stringify(n)).not.toMatch(/pw-/);

    // HOD gives 3, then Admin can't take the department below 3.
    const hod = as(await login('40000001', 'EMPLOYEE', co.avit));
    await hod.post(`/batches/${batchId}/assign`, { departmentId: dept.lib, people: [{ name: 'Guest A', count: 3 }] });
    expect((await admin.post(`/batches/${batchId}/allocate`, { items: [{ departmentId: dept.lib, count: 2 }] })).body.code).toBe('below_given');
  });

  test('HOD page: own department only; give by ITS / by hand / bulk; take back; share; request more', async () => {
    const admin = as(await login('40000010', 'ADMIN'));
    const batchId = await newBatch(admin, 10);
    await admin.post(`/batches/${batchId}/allocate`, { items: [{ departmentId: dept.lib, count: 6 }] });

    const hod = as(await login('40000001', 'EMPLOYEE', co.avit));
    expect((await hod.get('/me')).body).toEqual({ isAdmin: false, hodDepartments: [{ id: dept.lib, name: 'Wifi Library' }] });
    const clerk = as(await login('40000002', 'EMPLOYEE', co.avit));
    expect((await clerk.get('/me')).body.hodDepartments).toEqual([]);
    expect((await clerk.get(`/departments/${dept.lib}`)).status).toBe(404);
    expect((await hod.get(`/departments/${dept.acc}`)).status).toBe(404);
    expect((await clerk.get('/lookup?its=40000003')).status).toBe(404);

    // ITS lookup: ATOM user first, then eJamaat.
    expect((await hod.get('/lookup?its=40000003')).body).toMatchObject({ name: 'Known Guest', mobile: '9820012345', email: 'guest@example.edu', source: 'atom' });
    ejamaat.getMuminDetails.mockResolvedValue({ name: 'Outside Guest', mobile: '+919800000000', email: 'out@example.com' });
    expect((await hod.get('/lookup?its=50000001')).body).toMatchObject({ name: 'Outside Guest', source: 'ejamaat' });

    // Bulk: one person 2 passes + two people one each.
    let r = await hod.post(`/batches/${batchId}/assign`, {
      departmentId: dept.lib,
      people: [{ its: '50000001', name: 'Outside Guest', mobile: '+919800000000', email: 'out@example.com', count: 2 }, { name: 'Walk-in One' }, { name: 'Walk-in Two', mobile: '9876543210' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.passes).toHaveLength(4);
    expect(r.body.passes[0]).toMatchObject({ ssid: 'AJSM-Guest', recipient: { name: 'Outside Guest' }, assignedVia: 'department' });
    expect(r.body.passes[0].password).toMatch(/^pw-/);
    expect((await hod.post(`/batches/${batchId}/assign`, { departmentId: dept.lib, people: [{ name: 'Too many', count: 3 }] })).body.code).toBe('not_enough');
    expect((await hod.post(`/batches/${batchId}/assign`, { departmentId: dept.lib, people: [{ name: 'Xy', mobile: 'abc' }] })).body.code).toBe('bad_mobile');
    // HOD can't give from the unallocated pool (Admin direct).
    expect((await hod.post(`/batches/${batchId}/assign`, { people: [{ name: 'Sneaky' }] })).status).toBe(404);

    const view = await hod.get(`/departments/${dept.lib}`);
    expect(view.body.batches[0]).toMatchObject({ allocated: 6, given: 4, left: 2 });
    expect(view.body.passes).toHaveLength(4);

    // Share.
    const p = r.body.passes[0];
    expect((await hod.post(`/passes/${p.id}/whatsapp`)).body).toEqual({ ok: true });
    const mail = await hod.post('/passes/email', { passIds: [p.id, r.body.passes[2].id] });
    expect(mail.body.sent).toBe(1);
    expect(mail.body.results[1]).toMatchObject({ ok: false, error: 'No email address.' });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail.mock.calls[0][0].text).toContain(`Password: ${p.password}`);
    expect((await pool.query('SELECT count(*)::int AS n FROM email_outbox')).rows[0].n).toBe(0); // never queued
    // Another department's HOD can't touch it.
    const acc = as(await login('40000004', 'EMPLOYEE', co.avit));
    expect((await acc.post(`/passes/${p.id}/whatsapp`)).status).toBe(404);
    // Take back.
    expect((await hod.post(`/passes/${r.body.passes[3].id}/unassign`)).body).toEqual({ ok: true });
    expect((await hod.get(`/departments/${dept.lib}`)).body.batches[0].left).toBe(3);

    // Request more → Admin notified → done.
    r = await hod.post(`/departments/${dept.lib}/requests`, { count: 50, reason: 'Urs guests on Friday' });
    expect(r.status).toBe(201);
    expect((await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'wifi'`, [ids.admin])).rows[0].title).toBe('Wifi Library asks for 50 guest Wi-Fi passes');
    const reqs = (await admin.get('/requests')).body.requests;
    expect(reqs[0]).toMatchObject({ count: 50, status: 'open', department: { name: 'Wifi Library' }, by: 'Library Masool' });
    expect((await admin.post(`/requests/${reqs[0].id}`, { status: 'declined' })).body.code).toBe('note_required');
    expect((await admin.post(`/requests/${reqs[0].id}`, { status: 'done' })).body.requests[0].status).toBe('done');

    // Nothing with a password ever reached the log.
    expect(JSON.stringify((await pool.query('SELECT * FROM wifi_log')).rows)).not.toMatch(/pw-/);
  });

  test('Admin direct: from the unallocated pool, single and bulk; passes list', async () => {
    const admin = as(await login('40000010', 'ADMIN'));
    const batchId = await newBatch(admin, 5);
    await admin.post(`/batches/${batchId}/allocate`, { items: [{ departmentId: dept.lib, count: 2 }] });
    const r = await admin.post(`/batches/${batchId}/assign`, { people: [{ name: 'VIP One', email: 'vip@example.com' }, { name: 'VIP Two', count: 2 }] });
    expect(r.body.passes.map((p) => p.assignedVia)).toEqual(['admin', 'admin', 'admin']);
    expect((await admin.post(`/batches/${batchId}/assign`, { people: [{ name: 'One more' }] })).body.code).toBe('not_enough');
    const b = (await admin.get(`/batches/${batchId}`)).body.batch;
    expect(b.counts).toMatchObject({ free: 0, allocated: 2, adminGiven: 3, given: 3 });
    const list = await admin.get(`/batches/${batchId}/passes?view=admin&q=vip`);
    expect(list.body.total).toBe(3);
    expect(list.headers['cache-control']).toBe('no-store');
  });

  test('Reset and expiry delete the passes and keep only counts; ended batches refuse everything', async () => {
    const admin = as(await login('40000010', 'ADMIN'));
    const a = await newBatch(admin, 4);
    const b = await newBatch(admin, 3);
    await admin.post(`/batches/${a}/assign`, { people: [{ name: 'Guest' }] });

    const reset = await admin.post(`/batches/${a}/reset`);
    expect(reset.body.summary).toMatchObject({ total: 4, given: 1, adminGiven: 1 });
    expect((await pool.query('SELECT count(*)::int AS n FROM wifi_passes WHERE batch_id = $1', [a])).rows[0].n).toBe(0);
    expect((await admin.post(`/batches/${a}/assign`, { people: [{ name: 'Late' }] })).body.code).toBe('batch_ended');
    expect((await admin.post(`/batches/${a}/reset`)).status).toBe(409);

    await pool.query(`UPDATE wifi_batches SET expires_at = now() - interval '1 minute' WHERE id = $1`, [b]);
    expect(await wifi.expireDue()).toBe(1);
    expect(await wifi.expireDue()).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM wifi_passes')).rows[0].n).toBe(0);
    const list = (await admin.get('/batches')).body.batches;
    expect(list.map((x) => [x.ended, x.endedReason])).toEqual(expect.arrayContaining([[true, 'reset'], [true, 'expired']]));
    expect(list.find((x) => x.endedReason === 'expired').counts).toMatchObject({ total: 3, given: 0 });
  });

  test('Super Admin sets which posts count as HOD', async () => {
    const sa = await addUser('30328701', 'Test Super Admin', ['EMPLOYEE', 'SUPER_ADMIN']);
    void sa;
    const s = as(await login('30328701', 'SUPER_ADMIN', co.avit));
    const admin = as(await login('40000010', 'ADMIN'));
    expect((await admin.get('/settings')).status).toBe(404);
    const pr = await s.patch('/settings', { hodPosts: ['Head of Department'] });
    expect(pr.body.hodPosts).toEqual(['Head of Department']);
    const hod = as(await login('40000001', 'EMPLOYEE', co.avit));
    expect((await hod.get('/me')).body.hodDepartments).toEqual([]);
    expect((await s.patch('/settings', { hodPosts: [] })).body.code).toBe('invalid');
  });
});

if (!enabled) {
  test('Wi-Fi pass integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
