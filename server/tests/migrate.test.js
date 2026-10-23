// Migration runner with a fake pg client. No real DB needed.
jest.mock('../db/pool', () => ({}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMigrations, listMigrationFiles } = require('../db/migrate');

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atom-mig-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

function fakeClient({ applied = [], failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push(String(sql).trim().split('\n')[0]);
      if (failOn && String(sql).includes(failOn)) throw new Error('syntax error');
      if (String(sql).startsWith('SELECT filename')) {
        return { rows: applied.map((filename) => ({ filename })) };
      }
      return { rows: [], params };
    }),
  };
}

const quiet = () => {};

describe('listMigrationFiles', () => {
  it('returns only NNN_name.sql files in order', () => {
    const dir = makeDir({ '002_b.sql': '', '001_a.sql': '', 'notes.md': '', '1_bad.sql': '' });
    expect(listMigrationFiles(dir)).toEqual(['001_a.sql', '002_b.sql']);
  });
});

describe('runMigrations', () => {
  it('applies only pending files, each in a transaction, and unlocks', async () => {
    const dir = makeDir({ '001_a.sql': 'CREATE SCHEMA a;', '002_b.sql': 'CREATE SCHEMA b;' });
    const client = fakeClient({ applied: ['001_a.sql'] });

    const result = await runMigrations(client, { dir, log: quiet });

    expect(result).toEqual(['002_b.sql']);
    expect(client.calls).not.toContain('CREATE SCHEMA a;');
    const i = client.calls.indexOf('CREATE SCHEMA b;');
    expect(client.calls[i - 1]).toBe('BEGIN');
    expect(client.calls[i + 2]).toBe('COMMIT');
    expect(client.calls[0]).toMatch(/pg_advisory_lock/);
    expect(client.calls.at(-1)).toMatch(/pg_advisory_unlock/);
  });

  it('does nothing when everything is applied', async () => {
    const dir = makeDir({ '001_a.sql': 'CREATE SCHEMA a;' });
    const client = fakeClient({ applied: ['001_a.sql'] });
    await expect(runMigrations(client, { dir, log: quiet })).resolves.toEqual([]);
  });

  it('rolls back, names the file and still unlocks on failure', async () => {
    const dir = makeDir({ '001_bad.sql': 'BROKEN SQL;' });
    const client = fakeClient({ failOn: 'BROKEN' });

    await expect(runMigrations(client, { dir, log: quiet })).rejects.toThrow(/001_bad\.sql failed/);
    expect(client.calls).toContain('ROLLBACK');
    expect(client.calls).not.toContain('COMMIT');
    expect(client.calls.at(-1)).toMatch(/pg_advisory_unlock/);
  });

  it('ships a valid 001 migration', () => {
    expect(listMigrationFiles()).toContain('001_init.sql');
  });
});
