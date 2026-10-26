// Phase 3.2: staff contacts CSV import on real PostgreSQL.
// Runs ONLY when TEST_DATABASE_URL points at a database whose name ends in "_test".
const { Pool } = require('pg');
const { runMigrations } = require('../../db/migrate');
const { runContactsImport, cleanMobile } = require('../../modules/sync/contactsImport');

const URL_ENV = process.env.TEST_DATABASE_URL || '';
const dbName = (() => {
  try {
    return new URL(URL_ENV).pathname.slice(1);
  } catch {
    return '';
  }
})();
const enabled = /_test$/.test(dbName);
const maybe = enabled ? describe : describe.skip;

test('cleanMobile', () => {
  expect(cleanMobile('+91 98200-00001')).toEqual({ value: '919820000001' });
  expect(cleanMobile('9820000001')).toEqual({ value: '9820000001' });
  expect(cleanMobile('')).toEqual({ value: null });
  expect(cleanMobile('12345').error).toMatch(/10 digits/);
});

maybe('staff contacts import on real PostgreSQL', () => {
  let pool;
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const user = async (id) => (await q('SELECT email, mobile FROM users WHERE employee_id = $1', [id]))[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL_ENV, max: 2 });
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
  });
  afterAll(async () => pool && pool.end());

  beforeEach(async () => {
    await pool.query(`TRUNCATE user_departments, user_change_log, user_posts, user_status_log, user_roles,
                      password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO users (login_type, employee_id, legacy_password, source) VALUES
      ('EMPLOYEE_ID', '1001', '1001', 'hr'),
      ('EMPLOYEE_ID', '1002', '1002', 'hr'),
      ('EMPLOYEE_ID', '1003', 'x', 'legacy')`);
    await pool.query(`UPDATE users SET email = 'kept@example.edu' WHERE employee_id = '1003'`);
  });

  const CSV = [
    'employee_id,email,mobile',
    '1001,Tasneem@Example.com,9820000001',
    '1002,,+91 98200 00002',
    '1003,other@example.com,9820000003',
    '9999,ghost@example.com,',
  ].join('\r\n');

  test('dry run saves nothing; commit fills blanks only and keeps existing values', async () => {
    const dry = await runContactsImport({ csvText: CSV, pool });
    expect(dry).toMatchObject({ mode: 'dry-run', total: 4, toUpdate: 3, emails: 1, mobiles: 3, saved: false, notInAtom: ['9999'] });
    expect(dry.kept).toEqual([{ id: '1003', field: 'email' }]);
    expect(await user('1001')).toEqual({ email: null, mobile: null });

    const done = await runContactsImport({ csvText: CSV, pool, commit: true });
    expect(done.saved).toBe(true);
    expect(await user('1001')).toEqual({ email: 'tasneem@example.com', mobile: '9820000001' });
    expect(await user('1002')).toEqual({ email: null, mobile: '919820000002' });
    expect(await user('1003')).toEqual({ email: 'kept@example.edu', mobile: '9820000003' });

    const hist = await q(`SELECT detail FROM user_change_log ORDER BY id`);
    expect(hist.map((h) => h.detail)).toEqual([
      { fields: ['email', 'mobile'], source: 'contacts import' },
      { fields: ['mobile'], source: 'contacts import' },
      { fields: ['mobile'], source: 'contacts import' },
    ]);
    expect(JSON.stringify(hist)).not.toContain('@');

    // Re-running changes nothing.
    const again = await runContactsImport({ csvText: CSV, pool, commit: true });
    expect(again).toMatchObject({ toUpdate: 0, unchanged: 3, saved: false });
  });

  test('any bad row → nothing saved; errors never contain the email or number', async () => {
    const bad = `${CSV}\r\n1001,dup@example.com,\r\nabc,x@y.z,\r\n1002,not-an-email,\r\n1001x,,1`;
    const r = await runContactsImport({ csvText: bad, pool, commit: true });
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.reason)).toEqual([
      'Duplicate employee_id (also on row 2).',
      'employee_id must be 1–7 digits.',
      'Duplicate employee_id (also on row 3).',
      'employee_id must be 1–7 digits.',
    ]);
    expect(JSON.stringify(r)).not.toMatch(/dup@|not-an-email/);
    expect(await user('1001')).toEqual({ email: null, mobile: null });

    expect((await runContactsImport({ csvText: 'id,mail\n1,a', pool })).fatal).toMatch(/must have the columns/);
  });
});

if (!enabled) {
  test('contacts import integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
