// /users routes: access, validation and wiring. The service is mocked (its rules are covered
// end-to-end in tests/integration/users.pg.test.js against real PostgreSQL).
jest.mock('../db/pool', () => require('./helpers/fakeUsers').createFakeUsers());
jest.mock('../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));
jest.mock('../modules/users/users.service', () => ({
  listUsers: jest.fn(async () => ({ users: [], total: 0 })),
  getUserDetail: jest.fn(async (id) => ({ id })),
  createUser: jest.fn(async () => ({ id: '9' })),
  updateProfile: jest.fn(async (id) => ({ id })),
  grantRole: jest.fn(async (id) => ({ id })),
  removeRole: jest.fn(async (id) => ({ id })),
  tagUnit: jest.fn(async (id) => ({ id })),
  untagUnit: jest.fn(async (id) => ({ id })),
  setStatus: jest.fn(async (id) => ({ id })),
  resetPassword: jest.fn(async () => ({ message: 'ok' })),
}));

const request = require('supertest');
const db = require('../db/pool');
const ejamaat = require('../services/ejamaatClient');
const svc = require('../modules/users/users.service');
const { HttpError } = require('../utils/httpError');
const { createApp } = require('../app');

let app;
let token;
let logged;

beforeEach(async () => {
  db.reset();
  Object.values(svc).forEach((fn) => fn.mockClear && fn.mockClear());
  ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
  app = createApp();
  db.add({ login_type: 'ITS', its_number: '30328701', name: 'Qusai' }, ['EMPLOYEE', 'SUPER_ADMIN']);
  token = (await request(app).post('/Atom/api/auth/login').send({ identifier: '30328701', password: 'x' })).body.token;

  logged = [];
  for (const level of ['log', 'warn', 'error']) {
    jest.spyOn(console, level).mockImplementation((...a) => logged.push(a.join(' ')));
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  expect(logged.join('\n')).not.toMatch(/secret-pass/);
});

const api = (method, path, body) => {
  const r = request(app)[method](`/Atom/api/users${path}`).set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};

describe('access', () => {
  it('404 for the same person in the Employee role', async () => {
    const t = (await request(app).post('/Atom/api/auth/login').send({ identifier: '30328701', password: 'x', role: 'EMPLOYEE' })).body.token;
    const res = await request(app).get('/Atom/api/users').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(404);
    expect(svc.listUsers).not.toHaveBeenCalled();
  });

  it('401 without login', async () => {
    expect((await request(app).get('/Atom/api/users')).status).toBe(401);
  });
});

describe('GET /', () => {
  it('defaults: active users, page 1 of 25', async () => {
    const res = await api('get', '/');
    expect(res.body).toEqual({ users: [], total: 0, page: 1, pageSize: 25 });
    expect(svc.listUsers).toHaveBeenCalledWith({ q: null, role: null, active: true, source: null, limit: 25, offset: 0 });
  });

  it('passes filters and paging', async () => {
    await api('get', '/?q=%20raja%20&role=ENGINEER&status=all&source=legacy&page=3&pageSize=10');
    expect(svc.listUsers).toHaveBeenCalledWith({ q: 'raja', role: 'ENGINEER', active: null, source: 'legacy', limit: 10, offset: 20 });
  });

  it.each(['role=ADMIN', 'status=gone', 'source=x', 'page=0', 'pageSize=500'])('400 for %s', async (qs) => {
    expect((await api('get', `/?${qs}`)).status).toBe(400);
  });
});

describe('mutations', () => {
  it('passes the acting Super Admin to the service', async () => {
    await api('post', '/5/roles', { role: 'ENGINEER' });
    expect(svc.grantRole).toHaveBeenCalledWith('5', 'ENGINEER', expect.objectContaining({ id: '1', activeRole: 'SUPER_ADMIN' }));
  });

  it.each([
    ['post', '/5/roles', { role: 'ADMIN' }, 'Choose a valid role.'],
    ['post', '/5/service-units', { serviceUnitId: 'x' }, 'Choose a service unit.'],
    ['post', '/5/status', { active: 'yes', reason: 'x' }, 'Choose active or inactive.'],
    ['post', '/5/status', { active: false }, 'Enter a reason.'],
    ['post', '/', { loginType: 'X' }, 'Choose ITS or Employee ID.'],
    ['patch', '/5', { email: 'nope' }, 'Enter a valid email address.'],
    ['patch', '/5', { mobile: 'abc' }, 'Enter a valid mobile number.'],
  ])('%s %s → 400 "%s"', async (method, path, body, message) => {
    const res = await api(method, path, body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
  });

  it('profile: blanks become null, unknown fields are dropped', async () => {
    await api('patch', '/5', { name: '  ', email: '', mobile: '+91 98200 00000', role: 'SUPER_ADMIN' });
    expect(svc.updateProfile).toHaveBeenCalledWith('5', { name: null, email: null, mobile: '+91 98200 00000' }, expect.anything());
  });

  it('create returns 201', async () => {
    const res = await api('post', '/', { loginType: 'EMPLOYEE_ID', employeeId: '9001', password: 'secret-pass', name: 'Temp' });
    expect(res.status).toBe(201);
    expect(svc.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ loginType: 'EMPLOYEE_ID', employeeId: '9001', password: 'secret-pass', name: 'Temp' }),
      expect.anything()
    );
  });

  it('service HttpErrors reach the client with message and code', async () => {
    svc.removeRole.mockRejectedValueOnce(new HttpError(400, 'This is the last active Super Admin.', 'last_super_admin'));
    const res = await api('delete', '/5/roles/SUPER_ADMIN');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'This is the last active Super Admin.', code: 'last_super_admin' });
  });

  it('unexpected errors become a plain 500', async () => {
    svc.setStatus.mockRejectedValueOnce(new Error('db exploded: secret-pass'));
    const res = await api('post', '/5/status', { active: false, reason: 'Left' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Something went wrong. Please try again.' });
    logged = logged.map((l) => l.replace('secret-pass', '')); // the stack is logged server-side; not a request body
  });
});
