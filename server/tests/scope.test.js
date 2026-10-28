// Scope guards (companies, 28 Oct 2026) and /service-units. Repos and PostgreSQL mocked.
jest.mock('../db/pool', () => require('./helpers/fakeUsers').createFakeUsers());
jest.mock('../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));
jest.mock('../modules/serviceUnits/serviceUnits.repo', () => {
  const units = [
    { id: '1', code: 'AVIT', name: 'AVIT', is_active: true, tagline: 'IT' },
    { id: '2', code: 'SIYANAAT', name: 'Siyanaat', is_active: true, tagline: null },
    { id: '3', code: 'OLD', name: 'Old unit', is_active: false, tagline: null },
  ];
  return {
    listServiceUnits: jest.fn(async ({ activeOnly } = {}) => units.filter((u) => !activeOnly || u.is_active)),
    getServiceUnit: jest.fn(async (id) => units.find((u) => u.id === String(id)) || null),
    getServiceUnitByCode: jest.fn(async (code) => units.find((u) => u.code === code) || null),
  };
});

const request = require('supertest');
const db = require('../db/pool');
const ejamaat = require('../services/ejamaatClient');
const { assertServiceUnitInScope, assertRecordInScope, isRecordInScope, recordScopeSql } = require('../middleware/scope');
const { createApp } = require('../app');

const AVIT = '1';
const SIYANAAT = '2';
const user = (role, id = '10', companyId = AVIT) => ({ id, activeRole: role, companyId });

// ---------------------------------------------------------------------------------
describe('assertServiceUnitInScope', () => {
  const outcome = async (u, unit) => {
    try {
      return (await assertServiceUnitInScope({ user: u }, unit)).code;
    } catch (err) {
      return err.status;
    }
  };

  it.each([
    ['the active company', user('EMPLOYEE'), AVIT, 'AVIT'],
    ['another company', user('SUPER_ADMIN'), SIYANAAT, 404],
    ['an inactive one', user('SUPER_ADMIN', '10', '3'), '3', 404],
    ['no company chosen', user('SUPER_ADMIN', '10', null), AVIT, 404],
  ])('%s', async (_, u, unit, expected) => {
    expect(await outcome(u, unit)).toBe(expected);
  });

  it.each([undefined, null, '', '999', 'abc', '1; DROP TABLE users'])('404 for unknown or bad unit id %j', async (id) => {
    expect(await outcome(user('ADMIN'), id)).toBe(404);
  });
});

// ---------------------------------------------------------------------------------
describe('record scope', () => {
  const rec = { service_unit_id: AVIT, requester_id: '10', raised_by_id: '99', assigned_engineer_id: '20' };

  it.each([
    ['ADMIN', '55', true],
    ['SUPER_ADMIN', '55', true],
    ['EMPLOYEE', '10', true], // requester
    ['EMPLOYEE', '99', true], // raised it
    ['EMPLOYEE', '20', false], // assigned staff but acting as Employee
    ['EMPLOYEE', '55', false],
    ['ENGINEER', '20', true], // assigned
    ['ENGINEER', '10', true], // their own ticket
    ['ENGINEER', '55', false],
    [undefined, '10', false],
    ['BOSS', '10', false], // unknown role
  ])('%s user %s → %s', (role, id, expected) => {
    expect(isRecordInScope(user(role, id), rec)).toBe(expected);
  });

  it('another company\'s record is out of scope for everyone, Admins and the Super Admin included', () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'EMPLOYEE', 'ENGINEER']) {
      expect(isRecordInScope(user(role, '10', SIYANAAT), rec)).toBe(false);
      expect(isRecordInScope(user(role, '20', SIYANAAT), rec)).toBe(false);
    }
    expect(isRecordInScope(user('SUPER_ADMIN', '10', null), rec)).toBe(false);
  });

  it('compares ids as strings (pg returns bigint as string)', () => {
    expect(isRecordInScope({ id: '10', activeRole: 'EMPLOYEE', companyId: '1' }, { service_unit_id: 1, requester_id: 10 })).toBe(true);
  });

  it('never matches on missing ids', () => {
    expect(isRecordInScope(user('ENGINEER'), { service_unit_id: AVIT, assigned_engineer_id: null, requester_id: null })).toBe(false);
    expect(isRecordInScope(user('EMPLOYEE', null), { service_unit_id: AVIT, requester_id: null })).toBe(false);
  });

  it('assertRecordInScope throws a 404 with the standard message', () => {
    expect(() => assertRecordInScope({ user: user('EMPLOYEE', '55') }, rec)).toThrow(expect.objectContaining({ status: 404, message: 'Not found.' }));
    expect(assertRecordInScope({ user: user('EMPLOYEE', '10') }, rec)).toBe(rec);
  });
});

describe('recordScopeSql', () => {
  it.each([
    ['ADMIN', 'r.service_unit_id = $3::bigint', [AVIT]],
    ['SUPER_ADMIN', 'r.service_unit_id = $3::bigint', [AVIT]],
    ['ENGINEER', '(r.service_unit_id = $3::bigint AND (r.assigned_engineer_id = $4::bigint OR r.requester_id = $4::bigint))', [AVIT, '10']],
    ['EMPLOYEE', '(r.service_unit_id = $3::bigint AND (r.requester_id = $4::bigint OR r.raised_by_id = $4::bigint))', [AVIT, '10']],
    [undefined, 'FALSE', []],
    ['BOSS', 'FALSE', []],
  ])('%s', (role, clause, params) => {
    expect(recordScopeSql(user(role), 'r', 3)).toEqual({ clause, params });
  });

  it('nothing without a company', () => {
    expect(recordScopeSql(user('SUPER_ADMIN', '10', null), 'r')).toEqual({ clause: 'FALSE', params: [] });
  });

  it('works without an alias', () => {
    expect(recordScopeSql(user('EMPLOYEE', '7')).clause).toBe('(service_unit_id = $1::bigint AND (requester_id = $2::bigint OR raised_by_id = $2::bigint))');
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

  it('Super Admin sees every company, including inactive ones', async () => {
    const res = await request(app).get('/Atom/api/service-units').set('Authorization', `Bearer ${await tokenAs('SUPER_ADMIN')}`);
    expect(res.body.serviceUnits.map((u) => [u.code, u.isActive])).toEqual([
      ['AVIT', true],
      ['SIYANAAT', true],
      ['OLD', false],
    ]);
  });

  it('other roles see active companies only', async () => {
    const res = await request(app).get('/Atom/api/service-units').set('Authorization', `Bearer ${await tokenAs('EMPLOYEE')}`);
    expect(res.body.serviceUnits.map((u) => u.code)).toEqual(['AVIT', 'SIYANAAT']);
  });

  it('requires login', async () => {
    expect((await request(app).get('/Atom/api/service-units')).status).toBe(401);
  });
});
