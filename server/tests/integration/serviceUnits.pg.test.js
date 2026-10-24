// Real-PostgreSQL check of migration 004 (service units + engineer tags).
// Runs ONLY when TEST_DATABASE_URL points at a database whose name ends in "_test".
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

maybe('migration 004 on real PostgreSQL', () => {
  let pool;
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

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

  beforeEach(async () => {
    await pool.query('TRUNCATE user_service_units');
  });

  test('seeds AVIT (active) and Siyanaat (inactive)', async () => {
    expect(await q('SELECT code, name, is_active FROM service_units ORDER BY id')).toEqual([
      { code: 'AVIT', name: 'AVIT', is_active: true },
      { code: 'SIYANAAT', name: 'Siyanaat', is_active: false },
    ]);
  });

  test('re-running the migration keeps manual changes and adds no duplicates', async () => {
    await pool.query(`UPDATE service_units SET is_active = TRUE WHERE code = 'SIYANAAT'`);
    const fs = require('fs');
    const path = require('path');
    await pool.query(fs.readFileSync(path.join(__dirname, '../../db/migrations/004_service_units.sql'), 'utf8'));
    expect(await q('SELECT code, is_active FROM service_units ORDER BY id')).toEqual([
      { code: 'AVIT', is_active: true },
      { code: 'SIYANAAT', is_active: true },
    ]);
    await pool.query(`UPDATE service_units SET is_active = FALSE WHERE code = 'SIYANAAT'`);
  });

  test('tags: one per user per unit; must reference real users and units', async () => {
    const { rows } = await pool.query(
      `INSERT INTO users (login_type, employee_id, legacy_password) VALUES ('EMPLOYEE_ID', '7001', 'x')
       ON CONFLICT (employee_id) WHERE employee_id IS NOT NULL DO UPDATE SET is_active = TRUE RETURNING id`
    );
    const userId = rows[0].id;
    const avit = (await q(`SELECT id FROM service_units WHERE code='AVIT'`))[0].id;

    await pool.query('INSERT INTO user_service_units (user_id, service_unit_id) VALUES ($1, $2)', [userId, avit]);
    await expect(pool.query('INSERT INTO user_service_units (user_id, service_unit_id) VALUES ($1, $2)', [userId, avit]))
      .rejects.toThrow(/duplicate key/);
    await expect(pool.query('INSERT INTO user_service_units (user_id, service_unit_id) VALUES ($1, 999999)', [userId]))
      .rejects.toThrow(/foreign key/);
    await expect(pool.query(`INSERT INTO service_units (code, name) VALUES ('bad code', 'x')`)).rejects.toThrow(/check constraint/);
  });
});

if (!enabled) {
  test('service-unit integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
