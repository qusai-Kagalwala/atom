// Staff leave (6 Nov 2026) on real PostgreSQL: apply, approve / reject, cancel, "On leave" in assignment and
// auto-assign, the availability board, and Delegate access. eJamaat mocked.
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

maybe('Staff leave on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { staffOf, adminOf } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const { today } = require('../../modules/leave/leave.service');

  let app;
  const ids = {};
  let cat;
  let admin;
  let alice;
  let eng;
  let eng2;
  let engEmp;

  const day = (n) => {
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
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
    await pool.query(`TRUNCATE staff_leave, user_features, notifications, email_outbox, request_attachments, request_events, requests, user_change_log,
                      user_service_units, user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.admin = await addUser('90000802', 'Admin Sample', ['EMPLOYEE']);
    await adminOf(pool, ids.admin);
    ids.alice = await addUser('90000803', 'Alice Sample', ['EMPLOYEE']);
    ids.eng = await addUser('90000804', 'Eng One', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.eng);
    ids.eng2 = await addUser('90000805', 'Eng Two', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.eng2);
    cat = String((await pool.query(`SELECT id FROM categories WHERE name='Printer / Scanner'`)).rows[0].id);
    admin = as(await login('90000802', 'ADMIN'));
    alice = as(await login('90000803'));
    eng = as(await login('90000804', 'ENGINEER'));
    engEmp = as(await login('90000804', 'EMPLOYEE'));
    eng2 = as(await login('90000805', 'ENGINEER'));
  });

  test('staff apply; dates checked; overlaps refused; non-staff 404; Admins told', async () => {
    expect((await alice.post('/leave', { type: 'LEAVE', startDate: day(1) })).status).toBe(404);
    expect((await alice.get('/leave/mine')).status).toBe(404);
    expect((await eng.post('/leave', { type: 'NAP', startDate: day(1) })).body.code).toBe('bad_type');
    expect((await eng.post('/leave', { type: 'LEAVE', startDate: day(-1) })).body.code).toBe('past');
    expect((await eng.post('/leave', { type: 'LEAVE', startDate: day(3), endDate: day(2) })).body.code).toBe('bad_range');
    expect((await eng.post('/leave', { type: 'LEAVE', startDate: day(1), endDate: day(100) })).body.code).toBe('too_long');
    expect((await eng.post('/leave', { type: 'LEAVE', startDate: '2026-02-30' })).body.code).toBe('bad_date');

    const r = await engEmp.post('/leave', { type: 'SICK', startDate: day(1), endDate: day(3), note: 'Fever' }); // any role
    expect(r.status).toBe(201);
    expect(r.body.leave).toMatchObject({ status: 'PENDING', type: 'SICK', days: 3, current: false });
    expect((await eng.post('/leave', { type: 'LEAVE', startDate: day(3), endDate: day(5) })).body.code).toBe('overlap');
    expect((await eng.get('/leave/mine')).body.leaves).toHaveLength(1);
    const n = (await pool.query(`SELECT user_id, title FROM notifications WHERE type = 'leave'`)).rows;
    expect(n.map((x) => String(x.user_id))).toEqual([ids.admin]);
    expect(n[0].title).toMatch(/^Eng One asks for sick leave: /);
    for (const who of [eng, alice]) expect((await who.get('/leave')).status).toBe(404);
  });

  test('approve / reject; on approved leave the person can\'t be assigned and auto-assign skips them', async () => {
    const l1 = (await eng.post('/leave', { type: 'LEAVE', startDate: day(0), endDate: day(2) })).body.leave;
    expect((await admin.get('/leave')).body.leaves.map((x) => x.id)).toEqual([l1.id]);
    expect((await admin.post(`/leave/${l1.id}/decide`, { decision: 'reject' })).body.code).toBe('note_required');

    // Pending leave doesn't count yet.
    await alice.post('/requests', { title: 'Printer jams', description: 'x', categoryId: cat });
    let staff = (await admin.get('/requests/engineers')).body.engineers;
    expect(staff.find((s) => s.id === ids.eng).onLeaveUntil).toBeNull();

    const ok = await admin.post(`/leave/${l1.id}/decide`, { decision: 'approve' });
    expect(ok.body.leave).toMatchObject({ status: 'APPROVED', current: true, decidedBy: 'Admin Sample' });
    expect((await admin.post(`/leave/${l1.id}/decide`, { decision: 'approve' })).body.code).toBe('not_pending');
    const told = (await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'leave'`, [ids.eng])).rows;
    expect(told[0].title).toMatch(/^Your leave .* was approved$/);

    staff = (await admin.get('/requests/engineers')).body.engineers;
    expect(staff.find((s) => s.id === ids.eng).onLeaveUntil).toBe(day(2));
    expect((await admin.get('/requests/T-1001/engineers')).body.engineers.find((s) => s.id === ids.eng).onLeaveUntil).toBe(day(2));
    const refused = await admin.post('/requests/T-1001/actions/assign', { engineerId: ids.eng });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'on_leave' });
    expect(refused.body.message).toMatch(/^Eng One is on leave till /);
    expect((await admin.post('/requests/T-1001/actions/assign', { engineerId: ids.eng2 })).status).toBe(200);

    // Auto-assign: with both in the occupation, the one on leave is skipped even with less work.
    const problems = require('../../modules/problems/problems.service');
    const co = (await pool.query(`SELECT id, (SELECT occupation_id FROM user_company WHERE user_id = $1) AS occ FROM service_units WHERE code = 'AVIT'`, [ids.eng])).rows[0];
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); // all rolled back: the company's settings stay as they were
      await c.query('UPDATE service_units SET auto_assign = TRUE WHERE id = $1', [co.id]);
      await c.query('UPDATE categories SET occupation_id = $1 WHERE id = $2', [co.occ, cat]);
      expect((await problems.pickAutoAssignee(c, String(co.id), cat)).id).toBe(ids.eng2);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }

    // Board: Eng One on leave (first), Eng Two available with 1 open job.
    const b = (await admin.get('/leave/staff')).body.staff;
    expect(b.map((s) => [s.name, s.onLeaveUntil, s.openWork])).toEqual([['Eng One', day(2), 0], ['Eng Two', null, 1]]);

    // Reject another with a reason.
    const l2 = (await eng2.post('/leave', { type: 'TRAINING', startDate: day(5) })).body.leave;
    const no = await admin.post(`/leave/${l2.id}/decide`, { decision: 'reject', note: 'Exams week' });
    expect(no.body.leave).toMatchObject({ status: 'REJECTED', decisionNote: 'Exams week' });
  });

  test('cancel: the person (pending, or approved not started); the manager with a reason', async () => {
    const a = (await eng.post('/leave', { type: 'LEAVE', startDate: day(4) })).body.leave;
    expect((await eng2.post(`/leave/${a.id}/cancel`)).status).toBe(404);
    expect((await eng.post(`/leave/${a.id}/cancel`)).body.leave.status).toBe('CANCELLED');
    expect((await eng.post(`/leave/${a.id}/cancel`)).body.code).toBe('not_cancellable');

    const b = (await eng.post('/leave', { type: 'LEAVE', startDate: day(0), endDate: day(1) })).body.leave;
    await admin.post(`/leave/${b.id}/decide`, { decision: 'approve' });
    expect((await eng.post(`/leave/${b.id}/cancel`)).body.code).toBe('started');
    expect((await admin.post(`/leave/${b.id}/cancel`)).body.code).toBe('note_required');
    expect((await admin.post(`/leave/${b.id}/cancel`, { note: 'Needed for the event' })).body.leave.status).toBe('CANCELLED');
    expect((await admin.get('/requests/engineers')).body.engineers.find((s) => s.id === ids.eng).onLeaveUntil).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM staff_leave')).rows[0].n).toBe(2); // history kept
  });

  test('Delegate access: someone given "Staff leave" decides others\' leave, not their own', async () => {
    expect((await admin.put(`/delegates/${ids.eng2}`, { features: ['leave'] })).status).toBe(200);
    const mine = (await eng2.post('/leave', { type: 'LEAVE', startDate: day(2) })).body.leave;
    const other = (await eng.post('/leave', { type: 'LEAVE', startDate: day(2) })).body.leave;
    expect((await eng2.get('/leave')).body.leaves).toHaveLength(2);
    expect((await eng2.post(`/leave/${mine.id}/decide`, { decision: 'approve' })).body.code).toBe('own_leave');
    expect((await eng2.post(`/leave/${other.id}/decide`, { decision: 'approve' })).body.leave.status).toBe('APPROVED');
    expect((await eng2.get('/leave/staff')).status).toBe(200);
    const n = (await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND title LIKE 'Eng One asks%'`, [ids.eng2])).rows;
    expect(n).toHaveLength(1); // delegates hear about new leave requests
  });
});
