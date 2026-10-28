// Login, /me and /switch-role. PostgreSQL and eJamaat are mocked.
jest.mock('../db/pool', () => require('./helpers/fakeUsers').createFakeUsers());
jest.mock('../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../db/pool');
const ejamaat = require('../services/ejamaatClient');
const { config } = require('../config/env');
const { createApp } = require('../app');

const LOGIN = '/Atom/api/auth/login';
const ME = '/Atom/api/auth/me';
const SWITCH = '/Atom/api/auth/switch-role';

const EMP_PASSWORD = 'legacy-Pass-1';
const ITS_PASSWORD = 'its-Secret-9';

let app;
let ids;
let logged;

beforeEach(() => {
  db.reset();
  ejamaat.authenticate.mockReset();
  config.authMode = 'live';
  app = createApp(); // fresh rate-limit counters per test

  ids = {
    employee: db.add({ login_type: 'EMPLOYEE_ID', employee_id: '1002', legacy_password: EMP_PASSWORD }),
    inactiveEmployee: db.add({
      login_type: 'EMPLOYEE_ID', employee_id: '1003', legacy_password: EMP_PASSWORD, is_active: false,
    }),
    qusai: db.add(
      { login_type: 'ITS', its_number: '30328701', name: 'Qusai Kagalwala' },
      ['EMPLOYEE', 'ENGINEER', 'SUPER_ADMIN']
    ),
    inactiveIts: db.add({ login_type: 'ITS', its_number: '40000001', is_active: false }),
    noRoles: db.add({ login_type: 'ITS', its_number: '40000002' }, []),
  };

  logged = [];
  for (const level of ['log', 'warn', 'error', 'info']) {
    jest.spyOn(console, level).mockImplementation((...args) => logged.push(args.map(String).join(' ')));
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  // Passwords must never reach any log line.
  const all = logged.join('\n');
  expect(all).not.toContain(EMP_PASSWORD);
  expect(all).not.toContain(ITS_PASSWORD);
});

const login = (identifier, password, extra = {}) =>
  request(app).post(LOGIN).send({ identifier, password, ...extra });

const noPasswordIn = (res) => {
  const text = JSON.stringify(res.body);
  // No password field of any kind (the boolean flag mustChangePassword is the only allowed mention).
  expect(text.replace(/"mustChangePassword":(true|false)/g, '')).not.toMatch(/password/i);
  expect(text).not.toContain(EMP_PASSWORD);
  expect(text).not.toContain(ITS_PASSWORD);
};

describe('POST /auth/login — validation', () => {
  it.each([
    [{}, 'empty body'],
    [{ identifier: '1002' }, 'no password'],
    [{ identifier: 'abc', password: 'x' }, 'non-digit ID'],
    [{ identifier: '1002', password: '' }, 'empty password'],
    [{ identifier: '1002', password: 'x', role: 'BOSS' }, 'unknown role'],
  ])('400 for %j (%s)', async (body) => {
    const res = await request(app).post(LOGIN).send(body);
    expect(res.status).toBe(400);
    expect(ejamaat.authenticate).not.toHaveBeenCalled();
  });
});

describe('POST /auth/login — employee ID', () => {
  it('logs in with the stored legacy password as Employee', async () => {
    const res = await login('1002', EMP_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: ids.employee, loginType: 'EMPLOYEE_ID', employeeId: '1002', roles: ['EMPLOYEE'], activeRole: 'EMPLOYEE',
    });
    expect(res.body.user.name).toBe('Employee 1002');
    expect(jwt.decode(res.body.token)).toMatchObject({ sub: ids.employee, role: 'EMPLOYEE' });
    expect(ejamaat.authenticate).not.toHaveBeenCalled();
    noPasswordIn(res);
  });

  it('wrong password → 401 and never falls through to eJamaat', async () => {
    const res = await login('1002', 'nope');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid ID or password.');
    expect(ejamaat.authenticate).not.toHaveBeenCalled();
  });

  it('inactive account with the right password → 403 inactive', async () => {
    const res = await login('1003', EMP_PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Your ATOM account is inactive.');
  });

  it('inactive account with a wrong password → 401 (does not reveal inactive)', async () => {
    const res = await login('1003', 'nope');
    expect(res.status).toBe(401);
  });

  it('works the same in mock mode (employee IDs are always checked for real)', async () => {
    config.authMode = 'mock';
    expect((await login('1002', 'anything')).status).toBe(401);
    expect((await login('1002', EMP_PASSWORD)).status).toBe(200);
  });
});

describe('POST /auth/login — ITS via eJamaat', () => {
  it('unknown non-8-digit number → 401 without calling eJamaat', async () => {
    const res = await login('5555', 'x');
    expect(res.status).toBe(401);
    expect(ejamaat.authenticate).not.toHaveBeenCalled();
  });

  it('valid eJamaat login lands in the highest role', async () => {
    ejamaat.authenticate.mockResolvedValue({ success: true });
    const res = await login('30328701', ITS_PASSWORD);
    expect(res.status).toBe(200);
    expect(ejamaat.authenticate).toHaveBeenCalledWith('30328701', ITS_PASSWORD);
    expect(res.body.user).toMatchObject({
      loginType: 'ITS', itsNumber: '30328701', name: 'Qusai Kagalwala',
      roles: ['EMPLOYEE', 'ENGINEER', 'SUPER_ADMIN'], activeRole: 'SUPER_ADMIN',
    });
    noPasswordIn(res);
  });

  it('honours the last-used role when it is still granted', async () => {
    ejamaat.authenticate.mockResolvedValue({ success: true });
    const res = await login('30328701', ITS_PASSWORD, { role: 'ENGINEER' });
    expect(res.body.user.activeRole).toBe('ENGINEER');
    expect(jwt.decode(res.body.token).role).toBe('ENGINEER');
  });

  it('ignores a last-used role that is no longer granted', async () => {
    db.removeRole(ids.qusai, 'ENGINEER');
    ejamaat.authenticate.mockResolvedValue({ success: true });
    const res = await login('30328701', ITS_PASSWORD, { role: 'ENGINEER' });
    expect(res.body.user.activeRole).toBe('SUPER_ADMIN');
  });

  it('wrong eJamaat password → 401', async () => {
    ejamaat.authenticate.mockResolvedValue({ success: false });
    const res = await login('30328701', 'nope');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid ID or password.');
  });

  it('eJamaat unreachable → 502', async () => {
    ejamaat.authenticate.mockRejectedValue(new Error('ETIMEDOUT'));
    const res = await login('30328701', ITS_PASSWORD);
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('Could not reach the authentication service.');
  });

  it('valid eJamaat login but no ATOM account → 403', async () => {
    ejamaat.authenticate.mockResolvedValue({ success: true });
    const res = await login('49999999', ITS_PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('No ATOM account for this ITS.');
  });

  it('inactive ITS account → 403', async () => {
    ejamaat.authenticate.mockResolvedValue({ success: true });
    const res = await login('40000001', ITS_PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Your ATOM account is inactive.');
  });

  it('account with no roles → 403', async () => {
    ejamaat.authenticate.mockResolvedValue({ success: true });
    const res = await login('40000002', ITS_PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('no_role');
  });
});

describe('POST /auth/login — AUTH_MODE=mock', () => {
  it('skips eJamaat and accepts any non-empty password for an existing ITS account', async () => {
    config.authMode = 'mock';
    const res = await login('30328701', 'whatever');
    expect(res.status).toBe(200);
    expect(ejamaat.authenticate).not.toHaveBeenCalled();
  });

  it('still requires an ATOM account', async () => {
    config.authMode = 'mock';
    expect((await login('49999999', 'whatever')).status).toBe(403);
  });
});

describe('POST /auth/login — rate limits', () => {
  it('blocks the 11th failed attempt for the same ID from the same IP', async () => {
    for (let i = 0; i < 10; i += 1) expect((await login('1002', 'wrong')).status).toBe(401);
    const res = await login('1002', EMP_PASSWORD);
    expect(res.status).toBe(429);
    expect(res.body.message).toBe('Too many login attempts. Please try again later.');
  });

  it('does not count successful logins against the per-ID limit', async () => {
    for (let i = 0; i < 12; i += 1) expect((await login('1002', EMP_PASSWORD)).status).toBe(200);
  });

  it('blocks spraying many IDs from one IP after 50 attempts', async () => {
    for (let i = 0; i < 50; i += 1) await login(String(2000 + i), 'x');
    expect((await login('1002', EMP_PASSWORD)).status).toBe(429);
  });
});

describe('GET /auth/me and requireAuth', () => {
  async function tokenFor(identifier = '1002', password = EMP_PASSWORD) {
    return (await login(identifier, password)).body.token;
  }

  it('returns the current user', async () => {
    const token = await tokenFor();
    const res = await request(app).get(ME).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: ids.employee, activeRole: 'EMPLOYEE' });
    noPasswordIn(res);
  });

  it('401 session_expired without a token', async () => {
    const res = await request(app).get(ME);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('session_expired');
  });

  it('401 session_expired for a tampered token', async () => {
    const token = await tokenFor();
    const res = await request(app).get(ME).set('Authorization', `Bearer ${token.slice(0, -2)}xx`);
    expect(res.body.code).toBe('session_expired');
  });

  it('401 session_expired for an expired token', async () => {
    const expired = jwt.sign({ role: 'EMPLOYEE' }, config.sessionSecret, {
      subject: ids.employee, expiresIn: -10,
    });
    const res = await request(app).get(ME).set('Authorization', `Bearer ${expired}`);
    expect(res.body.code).toBe('session_expired');
  });

  it('rejects tokens signed with another algorithm', async () => {
    const none = jwt.sign({ role: 'SUPER_ADMIN' }, null, { algorithm: 'none', subject: ids.employee });
    const res = await request(app).get(ME).set('Authorization', `Bearer ${none}`);
    expect(res.body.code).toBe('session_expired');
  });

  it('401 removed as soon as the user is deactivated', async () => {
    const token = await tokenFor();
    db.setActive(ids.employee, false);
    const res = await request(app).get(ME).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Your ATOM access has been removed.', code: 'removed' });
  });

  it('401 role_changed as soon as the active role is removed', async () => {
    ejamaat.authenticate.mockResolvedValue({ success: true });
    const token = await tokenFor('30328701', ITS_PASSWORD); // SUPER_ADMIN
    db.removeRole(ids.qusai, 'SUPER_ADMIN');
    const res = await request(app).get(ME).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('role_changed');
  });

  it('never trusts roles from the token: a forged role is refused', async () => {
    const forged = jwt.sign({ role: 'SUPER_ADMIN' }, config.sessionSecret, { subject: ids.employee });
    const res = await request(app).get(ME).set('Authorization', `Bearer ${forged}`);
    expect(res.body.code).toBe('role_changed');
  });
});

describe('POST /auth/switch-role', () => {
  async function qusaiToken() {
    ejamaat.authenticate.mockResolvedValue({ success: true });
    return (await login('30328701', ITS_PASSWORD)).body.token;
  }

  it('issues a new token for a granted role', async () => {
    const token = await qusaiToken();
    const res = await request(app).post(SWITCH).set('Authorization', `Bearer ${token}`).send({ role: 'ENGINEER' });
    expect(res.status).toBe(200);
    expect(res.body.user.activeRole).toBe('ENGINEER');
    expect(jwt.decode(res.body.token)).toMatchObject({ sub: ids.qusai, role: 'ENGINEER' });

    const me = await request(app).get(ME).set('Authorization', `Bearer ${res.body.token}`);
    expect(me.body.user.activeRole).toBe('ENGINEER');
  });

  it('403 for a role the user does not hold', async () => {
    const token = (await login('1002', EMP_PASSWORD)).body.token;
    const res = await request(app).post(SWITCH).set('Authorization', `Bearer ${token}`).send({ role: 'SUPER_ADMIN' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('role_not_granted');
  });

  it('400 for an unknown role', async () => {
    const token = await qusaiToken();
    const res = await request(app).post(SWITCH).set('Authorization', `Bearer ${token}`).send({ role: 'BOSS' });
    expect(res.status).toBe(400);
  });

  it('401 without a token', async () => {
    expect((await request(app).post(SWITCH).send({ role: 'ENGINEER' })).status).toBe(401);
  });
});

describe('companies: login, picker, switch (28 Oct 2026)', () => {
  const COMPANIES = '/Atom/api/auth/companies';
  const SWITCH_CO = '/Atom/api/auth/switch';
  const as = (token) => (r) => r.set('Authorization', `Bearer ${token}`);

  beforeEach(() => {
    ejamaat.authenticate.mockResolvedValue({ success: true });
    ids.siyAdmin = db.add({ login_type: 'ITS', its_number: '40000010', name: 'Siy Admin' }, ['EMPLOYEE', 'ADMIN'], { companyId: '2' });
    ids.carpenter = db.add({ login_type: 'ITS', its_number: '40000011', name: 'Carp' }, ['EMPLOYEE', 'ENGINEER'], {
      companyId: '2', occupationId: '7', occupationName: 'Carpenter',
    });
  });

  it('login opens their own company (Admin / Staff), else the first one; the token carries it', async () => {
    const emp = await login('1002', EMP_PASSWORD);
    expect(emp.body.user).toMatchObject({ company: { code: 'AVIT' }, companyId: '1', rolesHere: ['EMPLOYEE'] });
    expect(jwt.decode(emp.body.token).co).toBe('1');

    const admin = await login('40000010', ITS_PASSWORD);
    expect(admin.body.user).toMatchObject({ company: { code: 'SIYANAAT' }, activeRole: 'ADMIN', rolesHere: ['EMPLOYEE', 'ADMIN'] });

    const carp = await login('40000011', ITS_PASSWORD);
    expect(carp.body.user).toMatchObject({ activeRole: 'ENGINEER', occupation: 'Carpenter', staffCompany: { code: 'SIYANAAT' } });

    // Asking for a company where they can't use their roles: their own instead.
    const asked = await login('40000010', ITS_PASSWORD, { companyId: '3' });
    expect(asked.body.user).toMatchObject({ company: { code: 'TANZEEM' }, activeRole: 'EMPLOYEE' });
  });

  it('picker lists each company with the roles there; switching signs a token for it', async () => {
    const token = (await login('40000010', ITS_PASSWORD)).body.token;
    const list = (await as(token)(request(app).get(COMPANIES))).body.companies;
    expect(list.map((c) => [c.code, c.roles])).toEqual([
      ['AVIT', ['EMPLOYEE']],
      ['SIYANAAT', ['EMPLOYEE', 'ADMIN']],
      ['TANZEEM', ['EMPLOYEE']],
    ]);

    const toAvit = await as(token)(request(app).post(SWITCH_CO).send({ companyId: '1' }));
    expect(toAvit.body.user).toMatchObject({ company: { code: 'AVIT' }, activeRole: 'EMPLOYEE' });
    expect(jwt.decode(toAvit.body.token)).toMatchObject({ co: '1', role: 'EMPLOYEE' });

    // Admin only in their own company.
    const bad = await as(token)(request(app).post(SWITCH_CO).send({ companyId: '1', role: 'ADMIN' }));
    expect(bad.status).toBe(403);
    // Only the Super Admin may work without a company.
    expect((await as(token)(request(app).post(SWITCH_CO).send({ companyId: null }))).status).toBe(403);
    expect((await as(token)(request(app).post(SWITCH_CO).send({ companyId: '99' }))).status).toBe(404);

    const sa = (await login('30328701', ITS_PASSWORD)).body.token;
    const console = await as(sa)(request(app).post(SWITCH_CO).send({ companyId: null }));
    expect(console.body.user).toMatchObject({ company: null, activeRole: 'SUPER_ADMIN', rolesHere: ['SUPER_ADMIN'] });
    expect(jwt.decode(console.body.token).co).toBeNull();
  });

  it('a session whose company role went away, or a forged company, is refused (company_changed)', async () => {
    const forged = jwt.sign({ role: 'ADMIN', co: '1', sv: 0 }, config.sessionSecret, { subject: ids.siyAdmin });
    const res = await request(app).get(ME).set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('company_changed');
  });

  it('a token from before companies (no co) still signs in, but company routes ask to choose one', async () => {
    const old = jwt.sign({ role: 'EMPLOYEE', sv: 0 }, config.sessionSecret, { subject: ids.employee });
    expect((await request(app).get(ME).set('Authorization', `Bearer ${old}`)).body.user.company).toBeNull();
    const res = await request(app).get('/Atom/api/requests/mine').set('Authorization', `Bearer ${old}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('choose_company');
  });
});
