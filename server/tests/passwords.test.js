// Change / forgot / reset password. PostgreSQL, eJamaat and SMTP are mocked.
jest.mock('../db/pool', () => require('./helpers/fakeUsers').createFakeUsers());
jest.mock('../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));
jest.mock('../services/mailer', () => ({ sendMail: jest.fn() }));

const request = require('supertest');
const db = require('../db/pool');
const ejamaat = require('../services/ejamaatClient');
const { sendMail } = require('../services/mailer');
const { config } = require('../config/env');
const { createApp } = require('../app');
const { maskEmail, hashToken } = require('../modules/auth/passwords.service');

const API = '/Atom/api/auth';
const OLD = 'old-Password-1';
const NEW = 'new-Password-2';

let app;
let ids;
let logged;

beforeEach(() => {
  db.reset();
  sendMail.mockReset().mockResolvedValue({ messageId: 'x' });
  ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
  config.authMode = 'live';
  app = createApp();

  ids = {
    withEmail: db.add({
      login_type: 'EMPLOYEE_ID', employee_id: '1002', legacy_password: OLD, email: 'ali.husain@jameasaifiyah.edu',
    }),
    noEmail: db.add({ login_type: 'EMPLOYEE_ID', employee_id: '1004', legacy_password: OLD }),
    inactive: db.add({
      login_type: 'EMPLOYEE_ID', employee_id: '1005', legacy_password: OLD, email: 'x@jameasaifiyah.edu', is_active: false,
    }),
    its: db.add({ login_type: 'ITS', its_number: '30328701' }, ['EMPLOYEE', 'SUPER_ADMIN']),
  };

  logged = [];
  for (const level of ['log', 'warn', 'error', 'info']) {
    jest.spyOn(console, level).mockImplementation((...args) => logged.push(args.map(String).join(' ')));
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  const all = logged.join('\n');
  expect(all).not.toContain(OLD);
  expect(all).not.toContain(NEW);
  expect(all).not.toMatch(/reset-password\?token=/);
});

async function tokenFor(identifier, password = OLD) {
  const res = await request(app).post(`${API}/login`).send({ identifier, password });
  return res.body.token;
}

const post = (path, body, token) => {
  const r = request(app).post(`${API}${path}`).send(body);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

// Pull the raw token out of the email the mock "sent".
function tokenFromLastEmail() {
  const { text } = sendMail.mock.calls.at(-1)[0];
  return new URL(text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
}

// ---------------------------------------------------------------------------------
describe('POST /change-password', () => {
  it('changes the password; old one stops working, new one works', async () => {
    const token = await tokenFor('1002');
    const res = await post('/change-password', { currentPassword: OLD, newPassword: NEW }, token);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Your password has been changed.');

    expect((await request(app).post(`${API}/login`).send({ identifier: '1002', password: OLD })).status).toBe(401);
    expect((await request(app).post(`${API}/login`).send({ identifier: '1002', password: NEW })).status).toBe(200);
  });

  it('rejects a wrong current password', async () => {
    const token = await tokenFor('1002');
    const res = await post('/change-password', { currentPassword: 'nope', newPassword: NEW }, token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('wrong_current');
    expect(db.users.get(ids.withEmail).legacy_password).toBe(OLD);
  });

  it.each([
    ['short', 'too_short'],
    [OLD, 'same_as_current'],
    ['x'.repeat(257), 'too_long'],
  ])('rejects new password %s… (%s)', async (newPassword, code) => {
    const token = await tokenFor('1002');
    const res = await post('/change-password', { currentPassword: OLD, newPassword }, token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
  });

  it('refuses ITS users (their password lives on eJamaat)', async () => {
    const token = await tokenFor('30328701', 'eJamaat-pass');
    const res = await post('/change-password', { currentPassword: 'x', newPassword: NEW }, token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('its_user');
  });

  it('requires login', async () => {
    expect((await post('/change-password', { currentPassword: OLD, newPassword: NEW })).status).toBe(401);
  });

  it('invalidates an outstanding reset link', async () => {
    await post('/forgot-password', { employeeId: '1002' });
    const resetToken = tokenFromLastEmail();
    const token = await tokenFor('1002');
    await post('/change-password', { currentPassword: OLD, newPassword: NEW }, token);

    const res = await post('/reset-password', { token: resetToken, newPassword: 'another-Pass-3' });
    expect(res.body.code).toBe('bad_link');
  });

  it('limits wrong current-password attempts per user', async () => {
    const token = await tokenFor('1002');
    for (let i = 0; i < 10; i += 1) {
      expect((await post('/change-password', { currentPassword: 'nope', newPassword: NEW }, token)).status).toBe(400);
    }
    expect((await post('/change-password', { currentPassword: OLD, newPassword: NEW }, token)).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------------
describe('POST /forgot-password', () => {
  it('emails a single reset link and shows a masked address', async () => {
    const res = await post('/forgot-password', { employeeId: '1002' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sent: true,
      message: 'A reset link has been sent to a***@jameasaifiyah.edu. It expires in 30 minutes.',
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('ali.husain@jameasaifiyah.edu');
    expect(mail.subject).toBe('Reset your ATOM password');
    expect(mail.text).toContain(`${config.appUrl}/reset-password?token=`);
    expect(mail.html).toContain('/reset-password?token=');
    expect(mail.text).not.toContain(OLD);
  });

  it('stores only the SHA-256 of the token, with a 30-minute expiry', async () => {
    await post('/forgot-password', { employeeId: '1002' });
    const raw = tokenFromLastEmail();
    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0].token_hash).toBe(hashToken(raw));
    expect(db.tokens[0].token_hash).not.toBe(raw);
    const minutes = (db.tokens[0].expires_at - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it('a new request makes the previous link useless', async () => {
    await post('/forgot-password', { employeeId: '1002' });
    const first = tokenFromLastEmail();
    await post('/forgot-password', { employeeId: '1002' });
    expect((await post('/reset-password', { token: first, newPassword: NEW })).body.code).toBe('bad_link');
    expect((await post('/reset-password', { token: tokenFromLastEmail(), newPassword: NEW })).status).toBe(200);
  });

  it.each([
    ['1004', 'no email on file'],
    ['1005', 'inactive'],
    ['7777', 'unknown ID'],
  ])('%s (%s) → same "contact a Super Admin" answer, no email sent', async (employeeId) => {
    const res = await post('/forgot-password', { employeeId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sent: false,
      message: 'No email is on file for this Employee ID. Please contact a Super Admin to reset your password.',
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('points ITS numbers to eJamaat', async () => {
    const res = await post('/forgot-password', { employeeId: '30328701' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Using your ITS number? Reset your password on eJamaat.');
  });

  it('502 when SMTP fails, and the stored link is cancelled', async () => {
    sendMail.mockRejectedValue(new Error('ECONNREFUSED smtp'));
    const res = await post('/forgot-password', { employeeId: '1002' });
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('Could not send the reset email. Please try again later.');
    expect(db.tokens.every((t) => t.used_at)).toBe(true);
  });

  it('400 for a missing or non-numeric ID', async () => {
    expect((await post('/forgot-password', {})).status).toBe(400);
    expect((await post('/forgot-password', { employeeId: 'abc' })).status).toBe(400);
  });

  it('limits requests: 3 per ID and 10 per IP per 15 minutes', async () => {
    for (let i = 0; i < 3; i += 1) await post('/forgot-password', { employeeId: '1002' });
    expect((await post('/forgot-password', { employeeId: '1002' })).status).toBe(429);

    app = createApp();
    for (let i = 0; i < 10; i += 1) await post('/forgot-password', { employeeId: String(3000 + i) });
    expect((await post('/forgot-password', { employeeId: '1004' })).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------------
describe('POST /reset-password', () => {
  async function freshLink() {
    await post('/forgot-password', { employeeId: '1002' });
    return tokenFromLastEmail();
  }

  it('sets the new password and the user can sign in with it', async () => {
    const token = await freshLink();
    const res = await post('/reset-password', { token, newPassword: NEW });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Your password has been reset. You can now sign in.');
    expect(db.txLog).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));

    expect((await request(app).post(`${API}/login`).send({ identifier: '1002', password: NEW })).status).toBe(200);
    expect((await request(app).post(`${API}/login`).send({ identifier: '1002', password: OLD })).status).toBe(401);
  });

  it('is single use', async () => {
    const token = await freshLink();
    expect((await post('/reset-password', { token, newPassword: NEW })).status).toBe(200);
    const again = await post('/reset-password', { token, newPassword: 'third-Pass-33' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('bad_link');
  });

  it('rejects an expired link', async () => {
    const token = await freshLink();
    db.tokens[0].expires_at = new Date(Date.now() - 1000);
    expect((await post('/reset-password', { token, newPassword: NEW })).body.code).toBe('bad_link');
  });

  it('rejects a link once the account is deactivated', async () => {
    const token = await freshLink();
    db.setActive(ids.withEmail, false);
    expect((await post('/reset-password', { token, newPassword: NEW })).body.code).toBe('bad_link');
  });

  it.each(['', 'short', 'not a token!', 'x'.repeat(30)])('rejects a bad token %j', async (token) => {
    const res = await post('/reset-password', { token, newPassword: NEW });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_link');
  });

  it('a too-short new password keeps the link valid for another try', async () => {
    const token = await freshLink();
    const weak = await post('/reset-password', { token, newPassword: 'short' });
    expect(weak.body.code).toBe('too_short');
    expect(db.txLog).toContain('ROLLBACK');
    expect((await post('/reset-password', { token, newPassword: NEW })).status).toBe(200);
  });

  it('refuses the same password as the current one', async () => {
    const token = await freshLink();
    expect((await post('/reset-password', { token, newPassword: OLD })).body.code).toBe('same_as_current');
  });
});

describe('maskEmail', () => {
  it.each([
    ['ali.husain@jameasaifiyah.edu', 'a***@jameasaifiyah.edu'],
    ['q@x.edu', 'q***@x.edu'],
    ['broken', 'your email'],
  ])('%s → %s', (input, out) => expect(maskEmail(input)).toBe(out));
});
