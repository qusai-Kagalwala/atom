// /sync routes (Super Admin only) and /auth/preferences. PostgreSQL and eJamaat mocked.
jest.mock('../db/pool', () => require('./helpers/fakeUsers').createFakeUsers());
jest.mock('../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));
jest.mock('../modules/sync/idarahSync', () => ({ runIdarahSync: jest.fn(), JOB: 'idarah' }));

const request = require('supertest');
const db = require('../db/pool');
const ejamaat = require('../services/ejamaatClient');
const { runIdarahSync } = require('../modules/sync/idarahSync');
const { createApp } = require('../app');

let app;
let ids;

beforeEach(() => {
  db.reset();
  runIdarahSync.mockReset();
  ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
  app = createApp();
  ids = {
    admin: db.add({ login_type: 'ITS', its_number: '30328701', name: 'Qusai' }, ['EMPLOYEE', 'SUPER_ADMIN']),
    arabic: db.add({ login_type: 'ITS', its_number: '20305503', name: 'Raja', name_arabic: 'راجا' }),
    employee: db.add({ login_type: 'EMPLOYEE_ID', employee_id: '1002', legacy_password: 'pw-1002' }),
  };
});

async function token(identifier, password = 'x', role) {
  const res = await request(app).post('/Atom/api/auth/login').send({ identifier, password, role });
  return res.body.token;
}

describe('POST /sync/idarah', () => {
  it('runs the sync for a Super Admin and records who triggered it', async () => {
    runIdarahSync.mockResolvedValue({ status: 'success', runId: '5', summary: {} });
    const t = await token('30328701');
    const res = await request(app).post('/Atom/api/sync/idarah').set('Authorization', `Bearer ${t}`).send({ force: true });
    expect(res.status).toBe(200);
    expect(runIdarahSync).toHaveBeenCalledWith(expect.objectContaining({ force: true, triggeredBy: ids.admin }));
  });

  it.each([
    ['busy', 409],
    ['blocked', 409],
    ['failed', 502],
  ])('maps %s to HTTP %i', async (status, http) => {
    runIdarahSync.mockResolvedValue({ status, message: 'x' });
    const t = await token('30328701');
    expect((await request(app).post('/Atom/api/sync/idarah').set('Authorization', `Bearer ${t}`)).status).toBe(http);
  });

  it('is 404 for the same user in the Employee role', async () => {
    const t = await token('30328701', 'x', 'EMPLOYEE');
    const res = await request(app).post('/Atom/api/sync/idarah').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(404);
    expect(runIdarahSync).not.toHaveBeenCalled();
  });

  it('is 404 for an employee-ID user and 401 without login', async () => {
    const t = await token('1002', 'pw-1002');
    expect((await request(app).post('/Atom/api/sync/idarah').set('Authorization', `Bearer ${t}`)).status).toBe(404);
    expect((await request(app).post('/Atom/api/sync/idarah')).status).toBe(401);
  });
});

describe('PATCH /auth/preferences', () => {
  it('switches the shown name to Arabic and back', async () => {
    const t = await token('20305503');
    const ar = await request(app).patch('/Atom/api/auth/preferences').set('Authorization', `Bearer ${t}`).send({ nameLanguage: 'ar' });
    expect(ar.status).toBe(200);
    expect(ar.body.user).toMatchObject({ nameLanguage: 'ar', displayName: 'راجا', name: 'Raja', nameArabic: 'راجا' });

    const me = await request(app).get('/Atom/api/auth/me').set('Authorization', `Bearer ${t}`);
    expect(me.body.user.displayName).toBe('راجا');

    const en = await request(app).patch('/Atom/api/auth/preferences').set('Authorization', `Bearer ${t}`).send({ nameLanguage: 'en' });
    expect(en.body.user).toMatchObject({ nameLanguage: 'en', displayName: 'Raja' });
  });

  it('refuses Arabic when no Arabic name is on file', async () => {
    const t = await token('1002', 'pw-1002');
    const res = await request(app).patch('/Atom/api/auth/preferences').set('Authorization', `Bearer ${t}`).send({ nameLanguage: 'ar' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_arabic_name');
  });

  it('rejects other values', async () => {
    const t = await token('20305503');
    const res = await request(app).patch('/Atom/api/auth/preferences').set('Authorization', `Bearer ${t}`).send({ nameLanguage: 'fr' });
    expect(res.status).toBe(400);
  });

  it('shows "Employee 1002" as the display name when there is no name', async () => {
    const res = await request(app).post('/Atom/api/auth/login').send({ identifier: '1002', password: 'pw-1002' });
    expect(res.body.user).toMatchObject({ name: 'Employee 1002', displayName: 'Employee 1002', nameArabic: null, nameLanguage: 'en' });
  });
});
