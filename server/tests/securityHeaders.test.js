// Phase 16 security headers. Behind IIS, web.config owns CSP / HSTS / nosniff / X-Frame-Options /
// Referrer-Policy for every response and Express must not send them again; elsewhere helmet sends all.
// PostgreSQL mocked; web.config read from the repo.
jest.mock('../db/pool', () => ({ query: jest.fn() }));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../app');

const IIS_HEADERS = ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy'];

describe('Express headers', () => {
  afterEach(() => {
    delete process.env.IISNODE_VERSION;
  });

  test('without IIS (dev, tests): helmet sends all of them', async () => {
    const res = await request(createApp()).get('/Atom/api/health');
    for (const h of IIS_HEADERS) expect(res.headers[h]).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('under iisnode: the IIS-owned headers are left to web.config (never sent twice)', async () => {
    process.env.IISNODE_VERSION = '0.2.26';
    const res = await request(createApp()).get('/Atom/api/health');
    for (const h of IIS_HEADERS) expect(res.headers[h]).toBeUndefined();
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin'); // the rest of helmet stays
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('web.config', () => {
  const xml = fs.readFileSync(path.join(__dirname, '..', '..', 'web.config'), 'utf8');
  const header = (name) => (xml.match(new RegExp(`<add name="${name}" value="([^"]+)"`)) || [])[1];

  test('sets every IIS-owned header once, and removes X-Powered-By and the Server header', () => {
    for (const h of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
      expect(header(h)).toBeTruthy();
      expect(xml.split(`<add name="${h}"`).length - 1).toBe(1);
    }
    expect(xml).toContain('<remove name="X-Powered-By" />');
    expect(xml).toContain('removeServerHeader="true"');
  });

  test('CSP: own scripts only, no eval, no framing, PDF preview + photos allowed', () => {
    const csp = Object.fromEntries(
      header('Content-Security-Policy')
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .map(([k, ...v]) => [k, v])
    );
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['frame-src']).toContain('blob:');
    expect(csp['img-src']).toEqual(expect.arrayContaining(['blob:', 'data:']));
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(JSON.stringify(csp)).not.toMatch(/unsafe-eval|\*/);
  });

  test('logs and deployment scripts are never served', () => {
    expect(xml).toContain('<add segment="logs" />');
    expect(xml).toContain('<add segment="deployment" />');
    expect(xml).toContain('<add segment=".env" />');
  });
});
