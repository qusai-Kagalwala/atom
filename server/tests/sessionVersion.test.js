// Phase 7.1: a password change / reset signs the user out on every other device.
// PostgreSQL, eJamaat and SMTP are mocked; Socket.IO is a fake io.
jest.mock('../db/pool', () => require('./helpers/fakeUsers').createFakeUsers());
jest.mock('../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));
jest.mock('../services/mailer', () => ({ sendMail: jest.fn() }));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const db = require('../db/pool');
const ejamaat = require('../services/ejamaatClient');
const { sendMail } = require('../services/mailer');
const { config } = require('../config/env');
const { createApp } = require('../app');
const { signSession, verifySession } = require('../modules/auth/tokens');
const realtime = require('../realtime');

const API = '/Atom/api/auth';
const OLD = 'old-Password-1';
const NEW = 'new-Password-2';

let app;
let ids;
let dropped;

function fakeIo() {
  dropped = [];
  const target = (room, except) => ({
    except: (id) => target(room, id),
    disconnectSockets: () => dropped.push({ room, except }),
    emit: () => {},
  });
  return { in: (room) => target(room), to: (room) => target(room) };
}

beforeEach(() => {
  db.reset();
  sendMail.mockReset().mockResolvedValue({ messageId: 'x' });
  ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
  config.authMode = 'live';
  app = createApp();
  realtime._setIo(fakeIo());
  ids = {
    emp: db.add({ login_type: 'EMPLOYEE_ID', employee_id: '1002', legacy_password: OLD, email: 'a.b@jameasaifiyah.edu' }, ['EMPLOYEE', 'ENGINEER']),
    admin: db.add({ login_type: 'ITS', its_number: '30328701' }, ['EMPLOYEE', 'SUPER_ADMIN']),
  };
});

afterEach(() => realtime._setIo(null));

const login = async (identifier, password = OLD) =>
  (await request(app).post(`${API}/login`).send({ identifier, password })).body.token;
const me = (token) => request(app).get(`${API}/me`).set('Authorization', `Bearer ${token}`);

describe('session version in the token', () => {
  test('signed tokens carry sv; tokens from before 7.1 (no sv) count as version 0', () => {
    expect(verifySession(signSession('5', 'EMPLOYEE', 3))).toEqual({ userId: '5', role: 'EMPLOYEE', version: 3, companyId: null });
    expect(verifySession(signSession('5', 'ADMIN', 3, 2))).toEqual({ userId: '5', role: 'ADMIN', version: 3, companyId: '2' });
    const legacy = jwt.sign({ role: 'EMPLOYEE' }, config.sessionSecret, { algorithm: 'HS256', subject: '5', expiresIn: '1h' });
    expect(verifySession(legacy).version).toBe(0);
  });

  test('a token with a malformed sv is refused', () => {
    for (const sv of [-1, 1.5, 'x', null]) {
      const bad = jwt.sign({ role: 'EMPLOYEE', sv }, config.sessionSecret, { algorithm: 'HS256', subject: '5' });
      expect(() => verifySession(bad)).toThrow();
    }
  });

  test('an existing pre-7.1 login keeps working until the password changes', async () => {
    const legacy = jwt.sign({ role: 'EMPLOYEE' }, config.sessionSecret, { algorithm: 'HS256', subject: ids.emp, expiresIn: '1h' });
    expect((await me(legacy)).status).toBe(200);
  });
});

describe('change password (logged in)', () => {
  test('this device gets a fresh token and stays in; every other login is signed out', async () => {
    const thisDevice = await login('1002');
    const otherDevice = await login('1002');

    const res = await request(app)
      .post(`${API}/change-password`)
      .set('Authorization', `Bearer ${thisDevice}`)
      .set('X-Socket-Id', 'sock_ABC-123')
      .send({ currentPassword: OLD, newPassword: NEW });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Your password has been changed.');
    expect(typeof res.body.token).toBe('string');

    expect((await me(res.body.token)).status).toBe(200);
    for (const old of [thisDevice, otherDevice]) {
      const r = await me(old);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ code: 'password_changed', message: 'Your password was changed. Please sign in again.' });
    }
    // Live connections of other devices drop; this device's socket is kept.
    expect(dropped).toEqual([{ room: `user:${ids.emp}`, except: 'sock_ABC-123' }]);
  });

  test('the fresh token keeps the active role, and switching role afterwards still works', async () => {
    let token = await login('1002');
    token = (await request(app).post(`${API}/switch-role`).set('Authorization', `Bearer ${token}`).send({ role: 'ENGINEER' })).body.token;
    const res = await request(app)
      .post(`${API}/change-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: OLD, newPassword: NEW });
    expect((await me(res.body.token)).body.user.activeRole).toBe('ENGINEER');

    const back = await request(app).post(`${API}/switch-role`).set('Authorization', `Bearer ${res.body.token}`).send({ role: 'EMPLOYEE' });
    expect(back.status).toBe(200);
    expect((await me(back.body.token)).status).toBe(200);
  });

  test('a junk X-Socket-Id is ignored (all sockets drop)', async () => {
    const token = await login('1002');
    await request(app)
      .post(`${API}/change-password`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Socket-Id', '../../etc')
      .send({ currentPassword: OLD, newPassword: NEW });
    expect(dropped).toEqual([{ room: `user:${ids.emp}`, except: undefined }]);
  });

  test('a failed change (wrong current password) signs no one out', async () => {
    const token = await login('1002');
    const res = await request(app)
      .post(`${API}/change-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'wrong-one', newPassword: NEW });
    expect(res.status).toBe(400);
    expect(res.body.token).toBeUndefined();
    expect((await me(token)).status).toBe(200);
    expect(dropped).toEqual([]);
  });
});

describe('reset by email link', () => {
  test('existing logins stop working after the reset', async () => {
    const token = await login('1002');
    await request(app).post(`${API}/forgot-password`).send({ employeeId: '1002' });
    const link = sendMail.mock.calls[0][0].text.match(/token=([A-Za-z0-9_-]+)/)[1];

    const res = await request(app).post(`${API}/reset-password`).send({ token: link, newPassword: NEW });
    expect(res.status).toBe(200);
    expect((await me(token)).body.code).toBe('password_changed');
    expect(dropped).toEqual([{ room: `user:${ids.emp}`, except: undefined }]);
    expect((await me(await login('1002', NEW))).status).toBe(200);
  });
});

describe('ITS users', () => {
  test('ITS logins are unaffected (their password lives on eJamaat)', async () => {
    const token = await login('30328701', 'anything');
    expect((await me(token)).status).toBe(200);
    const res = await request(app)
      .post(`${API}/change-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'x', newPassword: NEW });
    expect(res.body.code).toBe('its_user');
    expect((await me(token)).status).toBe(200);
  });
});
