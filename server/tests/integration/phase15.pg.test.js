// Phase 15 on real PostgreSQL: analytics numbers (checked against hand-counted tickets), company isolation,
// the Super Admin overview and every PDF report. eJamaat mocked. Runs ONLY when TEST_DATABASE_URL names a
// "*_test" database.
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

maybe('Phase 15 analytics + reports on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { adminOf, staffOf, companyId } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  const co = {};
  let sa;
  let siyAdmin;
  let avitAdmin;
  let alice;
  const P = '?from=2026-10-01&to=2026-10-31';

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role, company) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role, companyId: company })).body.token;
  const as = (token) => ({
    get: (p) => request(app).get(`/Atom/api${p}`).set('Authorization', `Bearer ${token}`),
    pdf: (p) =>
      request(app)
        .get(`/Atom/api${p}`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        }),
  });
  // One ticket raised at `at` (India time), with its own outcome.
  async function ticket(coId, cat, { at, status = 'OPEN', engineer = null, startAfter = null, resolveAfter = null, dueAfter = 240, priority = 'NORMAL' }) {
    const { rows } = await pool.query(
      `INSERT INTO requests (type, status, priority, title, description, category_id, service_unit_id, requester_id, raised_by_id,
                             assigned_engineer_id, created_at, due_from, due_by, resolved_at, rejected_at, rejection_note)
       VALUES ('TICKET', $1::request_status, $2::request_priority, 'Test ticket', 'x', $3, $4, $5, $5, $6, ($7::timestamp AT TIME ZONE 'Asia/Kolkata'),
               ($7::timestamp AT TIME ZONE 'Asia/Kolkata'), ($7::timestamp AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => $8::int),
               CASE WHEN $9::int IS NULL THEN NULL ELSE ($7::timestamp AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => $9::int) END,
               CASE WHEN $1::text = 'REJECTED' THEN now() END, CASE WHEN $1::text = 'REJECTED' THEN 'Not ours' END)
       RETURNING id`,
      [status, priority, cat, coId, ids.alice, engineer, at, dueAfter, resolveAfter]
    );
    if (startAfter != null) {
      await pool.query(
        `INSERT INTO request_events (request_id, type, actor_id, data, created_at)
         VALUES ($1, 'status', $2, '{"action":"start"}', ($3::timestamp AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => $4::int))`,
        [rows[0].id, engineer, at, startAfter]
      );
    }
    return rows[0].id;
  }

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
    await pool.query(`TRUNCATE assistant_events, assistant_sessions, invoice_links, invoices, stock_movements, notifications, request_items,
                      request_attachments, request_events, requests, asset_events, assets, user_change_log, user_posts, user_status_log,
                      user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query('UPDATE service_units SET is_open = TRUE');
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    co.avit = await companyId(pool, 'AVIT');
    co.siy = await companyId(pool, 'SIYANAAT');
    ids.sa = await addUser('30328701', 'Test Super Admin', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.siyAdmin = await addUser('40000020', 'Siyanaat Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.siyAdmin, 'SIYANAAT');
    ids.avitAdmin = await addUser('40000010', 'AVIT Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.avitAdmin, 'AVIT');
    ids.carp = await addUser('40000021', 'Abbas Test Carpenter', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.carp, 'SIYANAAT', 'Carpenter');
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    sa = as(await login('30328701', 'SUPER_ADMIN', co.siy));
    siyAdmin = as(await login('40000020', 'ADMIN'));
    avitAdmin = as(await login('40000010', 'ADMIN'));
    alice = as(await login('40000001', 'EMPLOYEE', co.siy));

    const cat = (await pool.query(`SELECT id FROM categories WHERE service_unit_id = $1 AND name = 'Other'`, [co.siy])).rows[0].id;
    const avitCat = (await pool.query(`SELECT id FROM categories WHERE service_unit_id = $1 LIMIT 1`, [co.avit])).rows[0].id;
    ids.cat = String(cat);
    ids.avitCat = String(avitCat);
    // October in Siyanaat: on time (start +30 min, resolved +2 h of 4 h), late (start +90, resolved +5 h), rejected, open and overdue.
    await ticket(co.siy, cat, { at: '2026-10-10 10:00', status: 'RESOLVED', engineer: ids.carp, startAfter: 30, resolveAfter: 120, priority: 'HIGH' });
    await ticket(co.siy, cat, { at: '2026-10-12 09:00', status: 'CLOSED', engineer: ids.carp, startAfter: 90, resolveAfter: 300 });
    await ticket(co.siy, cat, { at: '2026-10-15 11:00', status: 'REJECTED' });
    await ticket(co.siy, cat, { at: '2026-10-20 08:00', status: 'ASSIGNED', engineer: ids.carp });
    await ticket(co.siy, cat, { at: '2026-09-01 10:00', status: 'OPEN', dueAfter: 999999 }); // outside the period, not overdue
    await ticket(co.avit, avitCat, { at: '2026-10-11 10:00', status: 'OPEN', dueAfter: 999999 });
  });

  test('analytics: the numbers match the tickets; per company; staff workload', async () => {
    const a = (await siyAdmin.get(`/analytics${P}`)).body;
    expect(a.period).toEqual({ from: '2026-10-01', to: '2026-10-31', days: 31 });
    expect(a.headline).toEqual({
      raised: 4, stillOpen: 1, done: 2, rejected: 1, successRate: 66.7,
      avgResponseMinutes: 60, avgResolutionMinutes: 210, withinTimeFrame: 50, overdueNow: 1,
    });
    expect(a.perDay).toHaveLength(31);
    expect(a.perDay.find((d) => d.day === '2026-10-10').count).toBe(1);
    expect(a.byCategory).toEqual([{ key: ids.cat, label: 'Other', count: 4 }]);
    expect(a.byPriority.find((p) => p.key === 'HIGH').count).toBe(1);
    expect(a.byDepartment).toEqual([{ key: 'No department', label: 'No department', count: 4 }]);
    expect(a.staff).toEqual([expect.objectContaining({ name: 'Abbas Test Carpenter', occupation: 'Carpenter', openNow: 1, assigned: 3, done: 2, avgResolutionMinutes: 210, withinTimeFrame: 50 })]);
    expect(a.assets).toMatchObject({ total: 0, toRecover: 0 });

    // AVIT sees only its own ticket; employees don't see analytics.
    expect((await avitAdmin.get(`/analytics${P}`)).body.headline).toMatchObject({ raised: 1, stillOpen: 1 });
    expect((await alice.get(`/analytics${P}`)).status).toBe(404);
    expect((await siyAdmin.get('/analytics?from=2026-10-31&to=2026-10-01')).body.code).toBe('bad_period');
    expect((await siyAdmin.get('/analytics?from=oct')).body.code).toBe('bad_period');
    expect((await siyAdmin.get('/analytics')).body.period.days).toBe(30); // default: last 30 days

    // Super Admin overview: every company side by side; Admins can't.
    const o = (await sa.get(`/analytics/overview${P}`)).body;
    expect(o.companies.map((c) => [c.code, c.raised])).toEqual([['AVIT', 1], ['SIYANAAT', 4], ['TANZEEM', 0]]);
    expect((await siyAdmin.get(`/analytics/overview${P}`)).status).toBe(404);
  });

  test('reports: every PDF builds for the active company; filters checked; Admin only', async () => {
    const list = (await siyAdmin.get('/reports')).body.reports.map((r) => r.key);
    expect(list).toEqual(['tickets', 'performance', 'workload', 'assets', 'person', 'invoices', 'monthly']);
    const urls = [
      `/reports/tickets${P}&status=closed&categoryId=${ids.cat}&engineerId=${ids.carp}`,
      `/reports/performance${P}`,
      `/reports/workload${P}`,
      '/reports/assets?assetStatus=all',
      `/reports/person?personId=${ids.alice}`,
      `/reports/invoices${P}`,
      '/reports/monthly?month=2026-10',
    ];
    for (const u of urls) {
      const r = await siyAdmin.pdf(u);
      expect([u, r.status]).toEqual([u, 200]);
      expect(r.headers['content-type']).toBe('application/pdf');
      expect(r.headers['content-disposition']).toMatch(/^inline; filename="ATOM-siyanaat-[a-z]+-\d{4}-\d{2}-\d{2}\.pdf"$/);
      expect(r.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(r.body.length).toBeGreaterThan(2000);
    }
    expect((await siyAdmin.get(`/reports/tickets${P}&categoryId=${ids.avitCat}`)).body.code).toBe('bad_filter'); // AVIT's category
    expect((await siyAdmin.get('/reports/person')).body.code).toBe('bad_filter');
    expect((await siyAdmin.get('/reports/monthly?month=2026-13')).body.code).toBe('bad_period');
    expect((await siyAdmin.get('/reports/nope')).status).toBe(404);
    expect((await alice.get(`/reports/tickets${P}`)).status).toBe(404);
  });
});

if (!enabled) {
  test('Phase 15 integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
