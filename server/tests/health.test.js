// Health routes + app-level behaviour. PostgreSQL is mocked; no real DB needed.
jest.mock('../db/pool', () => ({ query: jest.fn() }));

const request = require('supertest');
const pool = require('../db/pool');
const { createApp } = require('../app');

const app = createApp();

describe('GET /Atom/api/health', () => {
  it('returns ok with the app version', async () => {
    const res = await request(app).get('/Atom/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', app: 'ATOM' });
    expect(typeof res.body.version).toBe('string');
  });

  it('sets helmet headers and hides x-powered-by', async () => {
    const res = await request(app).get('/Atom/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('GET /Atom/api/health/db', () => {
  afterEach(() => pool.query.mockReset());

  it('returns ok when PostgreSQL answers', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const res = await request(app).get('/Atom/api/health/db');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ database: 'ok' });
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns 503 without leaking the error when PostgreSQL is down', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    pool.query.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432 password=secret'));
    const res = await request(app).get('/Atom/api/health/db');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ database: 'unreachable' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|ECONNREFUSED/);
    console.error.mockRestore();
  });
});

describe('routing and errors', () => {
  it('returns JSON 404 for unknown API routes', async () => {
    const res = await request(app).get('/Atom/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Not found.' });
  });

  it('returns JSON 404 outside the /Atom base path', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(404);
  });

  it('rejects malformed JSON without echoing or logging the body', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post('/Atom/api/health')
      .set('Content-Type', 'application/json')
      .send('{"password":"hunter2"');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Invalid JSON in request body.' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
