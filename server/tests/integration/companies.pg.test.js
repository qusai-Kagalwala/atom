// Real-PostgreSQL check of the companies migrations (017 + 018, decided 28 Oct 2026).
// Runs ONLY when TEST_DATABASE_URL points at a database whose name ends in "_test".
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { runMigrations } = require('../../db/migrate');

const URL_ENV = process.env.TEST_DATABASE_URL || '';
let dbName = '';
try {
  dbName = new URL(URL_ENV).pathname.slice(1);
} catch {
  /* not set */
}
const enabled = /_test$/.test(dbName);
const maybe = enabled ? describe : describe.skip;
const quiet = () => {};

maybe('companies migration on real PostgreSQL', () => {
  let pool;
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const user = async (emp) =>
    (
      await q(
        `INSERT INTO users (login_type, employee_id, legacy_password) VALUES ('EMPLOYEE_ID', $1, 'x')
         ON CONFLICT (employee_id) WHERE employee_id IS NOT NULL DO UPDATE SET is_active = TRUE RETURNING id`,
        [emp]
      )
    )[0].id;
  const occ = async (code, name) =>
    (await q(`SELECT o.id FROM occupations o JOIN service_units s ON s.id = o.service_unit_id WHERE s.code = $1 AND o.name = $2`, [code, name]))[0].id;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL_ENV, max: 2 });
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: quiet });
    } finally {
      c.release();
    }
  });
  afterAll(async () => pool && pool.end());

  test('AVIT, Siyanaat and Tanzeem — all active, in picker order', async () => {
    expect(await q('SELECT code, name, is_active FROM service_units ORDER BY sort_order, id')).toEqual([
      { code: 'AVIT', name: 'AVIT', is_active: true },
      { code: 'SIYANAAT', name: 'Siyanaat', is_active: true },
      { code: 'TANZEEM', name: 'Tanzeem', is_active: true },
    ]);
  });

  test('each company has its own starting occupations', async () => {
    const rows = await q(`SELECT s.code, array_agg(o.name ORDER BY o.sort_order) AS names
                            FROM occupations o JOIN service_units s ON s.id = o.service_unit_id GROUP BY s.code ORDER BY s.code`);
    const by = Object.fromEntries(rows.map((r) => [r.code, r.names]));
    expect(by.AVIT).toEqual(expect.arrayContaining(['Engineer']));
    expect(by.TANZEEM).toEqual(expect.arrayContaining(['Peon']));
    expect(by.SIYANAAT).toEqual(expect.arrayContaining(['Electrician', 'Carpenter', 'Plumber', 'Painter', 'Mason', 'Gardener']));
  });

  test('re-running 018 adds no duplicates and keeps changes made since', async () => {
    await pool.query(`UPDATE service_units SET tagline = 'Our own words' WHERE code = 'TANZEEM'`);
    const before = (await q('SELECT count(*)::int AS n FROM occupations'))[0].n;
    await pool.query(fs.readFileSync(path.join(__dirname, '../../db/migrations/018_companies.sql'), 'utf8'));
    expect((await q('SELECT count(*)::int AS n FROM occupations'))[0].n).toBe(before);
    expect((await q(`SELECT tagline FROM service_units WHERE code = 'TANZEEM'`))[0].tagline).toBe('Our own words');
    expect((await q(`SELECT count(*)::int AS n FROM service_units`))[0].n).toBe(3);
  });

  test('one company per person; the occupation must be one of that company\'s', async () => {
    const a = await user('7101');
    const b = await user('7102');
    await pool.query('DELETE FROM user_company WHERE user_id IN ($1, $2)', [a, b]);
    const avit = (await q(`SELECT id FROM service_units WHERE code = 'AVIT'`))[0].id;
    await pool.query('INSERT INTO user_company (user_id, service_unit_id, occupation_id) VALUES ($1, $2, $3)', [a, avit, await occ('AVIT', 'Engineer')]);
    await expect(pool.query('INSERT INTO user_company (user_id, service_unit_id) VALUES ($1, $2)', [a, avit])).rejects.toThrow(/duplicate key/);
    // A Siyanaat occupation in AVIT is refused.
    await expect(
      pool.query('INSERT INTO user_company (user_id, service_unit_id, occupation_id) VALUES ($1, $2, $3)', [b, avit, await occ('SIYANAAT', 'Carpenter')])
    ).rejects.toThrow(/foreign key/);
    await expect(pool.query(`INSERT INTO occupations (service_unit_id, name) VALUES ($1, 'engineer')`, [avit])).rejects.toThrow(/duplicate key/);
    await expect(pool.query(`INSERT INTO service_units (code, name) VALUES ('bad code', 'x')`)).rejects.toThrow(/check constraint/);
    await pool.query('DELETE FROM user_company WHERE user_id IN ($1, $2)', [a, b]);
  });
});

if (!enabled) {
  test('companies integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
