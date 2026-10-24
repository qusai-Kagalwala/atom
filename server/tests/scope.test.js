// Scope guards and /service-units. Repos and PostgreSQL mocked.
jest.mock('../db/pool', () => require('./helpers/fakeUsers').createFakeUsers());
jest.mock('../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));
jest.mock('../modules/serviceUnits/serviceUnits.repo', () => {
  const units = [
    { id: '1', code: 'AVIT', name: 'AVIT', is_active: true },
    { id: '2', code: 'SIYANAAT', name: 'Siyanaat', is_active: false },
  ];
  const tags = new Map();
  return {
    tags,
    listServiceUnits: jest.fn(async ({ activeOnly } = {}) => units.filter((u) => !activeOnly || u.is_active)),
    getServiceUnit: jest.fn(async (id) => units.find((u) => u.id === String(id)) || null),
    getServiceUnitByCode: jest.fn(async (code) => units.find((u) => u.code === code) || null),
    userServiceUnitIds: jest.fn(async (userId) => tags.get(String(userId)) || []),
  };
});

const express = require('express');
const request = require('supertest');
const db = require('../db/pool');
const repo = require('../modules/serviceUnits/serviceUnits.repo');
const ejamaat = require('../services/ejamaatClient');
const {
  assertServiceUnitInScope,
  assertRecordInScope,
  isRecordInScope,
  recordScopeSql,
  serviceUnitFrom,
} = require('../middleware/scope');
const { createApp } = require('../app');

const AVIT = '1';
const SIYANAAT = '2';
const as = (role, id = '10') => ({ user: { id, activeRole: role } });

beforeEach(() => {
  repo.tags.clear();
  repo.userServiceUnitIds.mockClear();
});

// ---------------------------------------------------------------------------------
describe('assertServiceUnitInScope', () => {
  const outcome = async (req, unit, purpose) => {
    try {
      const u = await assertServiceUnitInScope(req, unit, { purpose });
      return u.code;
    } catch (err) {
      return err.status;
    }
  };

  it.each([
    // role,         unit,     purpose, tagged?, expected
    ['SUPER_ADMIN', AVIT, 'raise', false, 'AVIT'],
    ['SUPER_ADMIN', SIYANAAT, 'raise', false, 'SIYANAAT'],
    ['SUPER_ADMIN', SIYANAAT, 'work', false, 'SIYANAAT'],
    ['ENGINEER', AVIT, 'raise', false, 'AVIT'],
    ['ENGINEER', SIYANAAT, 'raise', true, 404],
    ['ENGINEER', AVIT, 'work', true, 'AVIT'],
    ['ENGINEER', AVIT, 'work', false, 404],
    ['ENGINEER', SIYANAAT, 'work', true, 'SIYANAAT'],
    ['EMPLOYEE', AVIT, 'raise', false, 'AVIT'],
    ['EMPLOYEE', SIYANAAT, 'raise', false, 404],
    ['EMPLOYEE', AVIT, 'work', false, 404],
  ])('%s · unit %s · %s · tagged=%s → %s', async (role, unit, purpose, tagged, expected) => {
    if (tagged) repo.tags.set('10', [unit]);
    expect(await outcome(as(role), unit, purpose)).toBe(expected);
  });

  it.each([undefined, null, '', '999', 'abc', '1; DROP TABLE users'])('404 for unknown or bad unit id %j', async (id) => {
    expect(await outcome(as('SUPER_ADMIN'), id, 'raise')).toBe(404);
  });

  it('loads an engineer\'s tags once per request', async () => {
    repo.tags.set('10', [AVIT]);
    const req = as('ENGINEER');
    await assertServiceUnitInScope(req, AVIT, { purpose: 'work' });
    await assertServiceUnitInScope(req, AVIT, { purpose: 'work' });
    expect(repo.userServiceUnitIds).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------
describe('record scope', () => {
  const rec = { requester_id: '10', raised_by_id: '99', assigned_engineer_id: '20' };

  it.each([
    ['SUPER_ADMIN', '55', true],
    ['EMPLOYEE', '10', true], // requester
    ['EMPLOYEE', '99', true], // raised it
    ['EMPLOYEE', '20', false], // assigned engineer but acting as Employee
    ['EMPLOYEE', '55', false],
    ['ENGINEER', '20', true], // assigned
    ['ENGINEER', '10', true], // their own ticket
    ['ENGINEER', '55', false],
    [undefined, '10', false],
    ['ADMIN', '10', false], // unknown role
  ])('%s user %s → %s', (role, id, expected) => {
    expect(isRecordInScope({ id, activeRole: role }, rec)).toBe(expected);
  });

  it('compares ids as strings (pg returns bigint as string)', () => {
    expect(isRecordInScope({ id: '10', activeRole: 'EMPLOYEE' }, { requester_id: 10 })).toBe(true);
  });

  it('never matches on missing ids', () => {
    expect(isRecordInScope({ id: '10', activeRole: 'ENGINEER' }, { assigned_engineer_id: null, requester_id: null })).toBe(false);
    expect(isRecordInScope({ id: null, activeRole: 'EMPLOYEE' }, { requester_id: null })).toBe(false);
  });

  it('assertRecordInScope throws a 404 with the standard message', () => {
    expect(() => assertRecordInScope(as('EMPLOYEE', '55'), rec)).toThrow(expect.objectContaining({ status: 404, message: 'Not found.' }));
    expect(assertRecordInScope(as('EMPLOYEE', '10'), rec)).toBe(rec);
  });
});

describe('recordScopeSql', () => {
  it.each([
    ['SUPER_ADMIN', 'TRUE', []],
    ['ENGINEER', '(r.assigned_engineer_id = $3::bigint OR r.requester_id = $3::bigint)', ['10']],
    ['EMPLOYEE', '(r.requester_id = $3::bigint OR r.raised_by_id = $3::bigint)', ['10']],
    [undefined, 'FALSE', []],
    ['ADMIN', 'FALSE', []],
  ])('%s', (role, clause, params) => {
    expect(recordScopeSql({ id: '10', activeRole: role }, 'r', 3)).toEqual({ clause, params });
  });

  it('works without an alias', () => {
    expect(recordScopeSql({ id: '7', activeRole: 'EMPLOYEE' }).clause).toBe('(requester_id = $1::bigint OR raised_by_id = $1::bigint)');
  });
});

// ---------------------------------------------------------------------------------
describe('serviceUnitFrom middleware + error handler', () => {
  function appWith(role) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: '10', activeRole: role };
      next();
    });
    app.post('/raise', serviceUnitFrom('body', 'serviceUnitId', 'raise'), (req, res) => res.json({ unit: req.serviceUnit.code }));
    // Same error handling as the real app.
    const { HttpError } = require('../utils/httpError');
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      if (err instanceof HttpError) return res.status(err.status).json({ message: err.message, code: err.code });
      return res.status(500).end();
    });
    return app;
  }

  it('passes and exposes the unit', async () => {
    const res = await request(appWith('EMPLOYEE')).post('/raise').send({ serviceUnitId: AVIT });
    expect(res.body).toEqual({ unit: 'AVIT' });
  });

  it('404s an inactive unit for an Employee', async () => {
    const res = await request(appWith('EMPLOYEE')).post('/raise').send({ serviceUnitId: SIYANAAT });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Not found.', code: 'not_found' });
  });
});

// ---------------------------------------------------------------------------------
describe('GET /service-units', () => {
  let app;
  beforeEach(() => {
    db.reset();
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    db.add({ login_type: 'ITS', its_number: '30328701', name: 'Qusai' }, ['EMPLOYEE', 'ENGINEER', 'SUPER_ADMIN']);
  });

  const tokenAs = async (role) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: '30328701', password: 'x', role })).body.token;

  it('Super Admin sees every unit, including inactive Siyanaat', async () => {
    const res = await request(app).get('/Atom/api/service-units').set('Authorization', `Bearer ${await tokenAs('SUPER_ADMIN')}`);
    expect(res.body.serviceUnits).toEqual([
      { id: '1', code: 'AVIT', name: 'AVIT', isActive: true },
      { id: '2', code: 'SIYANAAT', name: 'Siyanaat', isActive: false },
    ]);
  });

  it('other roles see active units only', async () => {
    const res = await request(app).get('/Atom/api/service-units').set('Authorization', `Bearer ${await tokenAs('EMPLOYEE')}`);
    expect(res.body.serviceUnits.map((u) => u.code)).toEqual(['AVIT']);
  });

  it('/mine lists an engineer\'s tagged units; 404 for other roles', async () => {
    repo.tags.set('1', [SIYANAAT]);
    const eng = await request(app).get('/Atom/api/service-units/mine').set('Authorization', `Bearer ${await tokenAs('ENGINEER')}`);
    expect(eng.body.serviceUnits.map((u) => u.code)).toEqual(['SIYANAAT']);

    const emp = await request(app).get('/Atom/api/service-units/mine').set('Authorization', `Bearer ${await tokenAs('EMPLOYEE')}`);
    expect(emp.status).toBe(404);
  });

  it('requires login', async () => {
    expect((await request(app).get('/Atom/api/service-units')).status).toBe(401);
  });
});
