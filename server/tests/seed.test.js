// Dev seed with a fake pg client. No real DB needed.
jest.mock('../db/pool', () => ({}));

const { seedDevUsers, DEV_USERS } = require('../db/seeds/001_dev_users');

function fakeClient({ failOn = null } = {}) {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    query: jest.fn(async (sql, params = []) => {
      calls.push({ sql: String(sql).trim(), params });
      if (failOn && String(sql).includes(failOn)) throw new Error('boom');
      if (String(sql).includes('RETURNING id')) return { rows: [{ id: nextId++ }] };
      return { rows: [] };
    }),
  };
}

const quiet = () => {};

describe('seedDevUsers', () => {
  it('refuses to run in production', async () => {
    const client = fakeClient();
    await expect(seedDevUsers(client, { nodeEnv: 'production', log: quiet })).rejects.toThrow(/production/);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('seeds Qusai with every role (Admin and Staff of AVIT) and employee 1000 with Employee, in one transaction', async () => {
    const client = fakeClient();
    await seedDevUsers(client, { nodeEnv: 'development', log: quiet });

    expect(client.calls[0].sql).toBe('BEGIN');
    expect(client.calls.at(-1).sql).toBe('COMMIT');

    const roleInserts = client.calls.filter((c) => c.sql.startsWith('INSERT INTO user_roles'));
    expect(roleInserts.map((c) => c.params[1])).toEqual([
      ['EMPLOYEE', 'ENGINEER', 'ADMIN', 'SUPER_ADMIN'],
      ['EMPLOYEE'],
    ]);
    const company = client.calls.filter((c) => c.sql.startsWith('INSERT INTO user_company'));
    expect(company.map((c) => c.params.slice(1))).toEqual([['AVIT', 'Engineer']]);

    const its = client.calls.find((c) => c.params[0] === '30328701');
    expect(its.sql).toMatch(/ON CONFLICT \(its_number\)/);
    const emp = client.calls.find((c) => c.params[0] === '1000');
    expect(emp.sql).toMatch(/ON CONFLICT \(employee_id\)/);
  });

  it('never overwrites an existing password or name on re-run', () => {
    const src = require('fs').readFileSync(require.resolve('../db/seeds/001_dev_users'), 'utf8');
    const updates = src.match(/DO UPDATE SET[^\n]*/g);
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u).toBe('DO UPDATE SET is_active = TRUE');
  });

  it('rolls back on failure', async () => {
    const client = fakeClient({ failOn: 'user_roles' });
    await expect(seedDevUsers(client, { nodeEnv: 'development', log: quiet })).rejects.toThrow('boom');
    expect(client.calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(client.calls.map((c) => c.sql)).not.toContain('COMMIT');
  });

  it('logs only IDs and roles, never passwords', async () => {
    const lines = [];
    await seedDevUsers(fakeClient(), { nodeEnv: 'development', log: (l) => lines.push(l) });
    expect(lines).toEqual(DEV_USERS.map((u) =>
      `Seed: ${u.itsNumber ? `ITS ${u.itsNumber}` : `Employee ID ${u.employeeId}`} → ${u.roles.join(', ')}`
    ));
  });
});
