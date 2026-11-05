// /auth/theme (Appearance: colour theme + light/dark, saved per person). PostgreSQL mocked.
// The important property: nothing about signing in or the session depends on migration 025, so the
// server can run before the migration is applied.
jest.mock('../db/pool', () => require('./helpers/fakeUsers').createFakeUsers());
jest.mock('../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const db = require('../db/pool');
const ejamaat = require('../services/ejamaatClient');
const { createApp } = require('../app');
const sharedThemes = require('../../shared/themes.json');

let app;
let ids;

beforeEach(() => {
  db.reset();
  ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
  app = createApp();
  ids = {
    raja: db.add({ login_type: 'ITS', its_number: '20305503', name: 'Raja' }),
    other: db.add({ login_type: 'ITS', its_number: '30328701', name: 'Other' }),
  };
});

async function token(identifier) {
  const res = await request(app).post('/Atom/api/auth/login').send({ identifier, password: 'x' });
  return res.body.token;
}
const get = (t) => request(app).get('/Atom/api/auth/theme').set('Authorization', `Bearer ${t}`);
const put = (t, body) => request(app).put('/Atom/api/auth/theme').set('Authorization', `Bearer ${t}`).send(body);

describe('GET /auth/theme', () => {
  it('needs a login', async () => {
    expect((await request(app).get('/Atom/api/auth/theme')).status).toBe(401);
    expect((await request(app).put('/Atom/api/auth/theme').send({ theme: 'navy', mode: 'dark' })).status).toBe(401);
  });

  it('answers null until the person has chosen', async () => {
    const res = await get(await token('20305503'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ theme: null });
  });
});

describe('PUT /auth/theme', () => {
  it('saves the choice, returns it, and keeps it for next time', async () => {
    const t = await token('20305503');
    const saved = await put(t, { theme: 'navy', mode: 'dark' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ theme: { theme: 'navy', mode: 'dark' } });
    expect((await get(t)).body).toEqual({ theme: { theme: 'navy', mode: 'dark' } });
  });

  it('replaces an earlier choice instead of adding a second one', async () => {
    const t = await token('20305503');
    await put(t, { theme: 'navy', mode: 'dark' });
    await put(t, { theme: 'maroon', mode: 'system' });
    expect((await get(t)).body.theme).toEqual({ theme: 'maroon', mode: 'system' });
    expect(db.themes.size).toBe(1);
  });

  it("never shows or changes another person's choice", async () => {
    const a = await token('20305503');
    const b = await token('30328701');
    await put(a, { theme: 'maroon', mode: 'dark' });
    expect((await get(b)).body).toEqual({ theme: null });
    await put(b, { theme: 'teal', mode: 'light' });
    expect((await get(a)).body.theme).toEqual({ theme: 'maroon', mode: 'dark' });
    expect(db.themes.get(ids.raja)).toEqual({ theme: 'maroon', mode: 'dark' });
  });

  it.each([
    ['unknown colour', { theme: 'purple', mode: 'dark' }],
    ['unknown mode', { theme: 'navy', mode: 'sepia' }],
    ['missing mode', { theme: 'navy' }],
    ['missing theme', { mode: 'dark' }],
    ['empty body', {}],
    ['wrong types', { theme: ['navy'], mode: { a: 1 } }],
  ])('rejects %s', async (_label, body) => {
    const t = await token('20305503');
    const res = await put(t, body);
    expect(res.status).toBe(400);
    expect(db.themes.size).toBe(0);
  });

  it('accepts every colour and mode listed in shared/themes.json', async () => {
    const t = await token('20305503');
    for (const theme of sharedThemes.themes) {
      for (const mode of sharedThemes.modes) {
        expect((await put(t, { theme, mode })).status).toBe(200);
      }
    }
  });
});

describe('before migration 025 is applied (no user_theme table)', () => {
  beforeEach(() => db.setThemeTable(false));

  it('sign-in and the session still work', async () => {
    const login = await request(app).post('/Atom/api/auth/login').send({ identifier: '20305503', password: 'x' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ name: 'Raja' });
    expect(login.body.user).not.toHaveProperty('theme');
    const me = await request(app).get('/Atom/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user).not.toHaveProperty('theme');
  });

  it('reading answers "nothing saved" instead of failing', async () => {
    const res = await get(await token('20305503'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ theme: null });
  });

  it('saving answers 503 theme_unavailable, which the app ignores', async () => {
    const res = await put(await token('20305503'), { theme: 'navy', mode: 'dark' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('theme_unavailable');
  });

  it('a real database error is NOT swallowed', async () => {
    db.setThemeTable(true);
    const t = await token('20305503');
    const original = db.query;
    // Only the theme query fails (sign-in checks must still work), with an error that is not "table missing".
    const spy = jest.spyOn(db, 'query').mockImplementation(async (sql, params) => {
      if (String(sql).includes('FROM user_theme')) {
        const err = new Error('connection terminated');
        err.code = '57P01';
        throw err;
      }
      return original(sql, params);
    });
    const res = await get(t);
    spy.mockRestore();
    expect(res.status).toBe(500);
  });
});

describe('migration 025_user_theme.sql', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '025_user_theme.sql'), 'utf8');

  it('is idempotent and additive only', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_theme/);
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bALTER TABLE users\b|BEGIN|COMMIT/i);
  });

  it('has one row per person', () => {
    expect(sql).toMatch(/user_id\s+bigint\s+PRIMARY KEY REFERENCES users \(id\)/);
  });
});
