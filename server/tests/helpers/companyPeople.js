// Real-PostgreSQL tests: put people into a company (decided 28 Oct 2026).
//   staffOf(pool, userId, 'AVIT', 'Engineer')  — Staff of a company with an occupation (role ENGINEER separately)
//   adminOf(pool, userId, 'AVIT')              — grants ADMIN and the company
async function companyId(pool, code) {
  const { rows } = await pool.query('SELECT id FROM service_units WHERE code = $1', [code]);
  return String(rows[0].id);
}

async function staffOf(pool, userId, code = 'AVIT', occupation = 'Engineer') {
  await pool.query(
    `INSERT INTO user_company (user_id, service_unit_id, occupation_id)
     SELECT $1::bigint, s.id, o.id FROM service_units s JOIN occupations o ON o.service_unit_id = s.id AND o.name = $3::text
      WHERE s.code = $2::text
     ON CONFLICT (user_id) DO UPDATE SET service_unit_id = EXCLUDED.service_unit_id, occupation_id = EXCLUDED.occupation_id`,
    [userId, code, occupation]
  );
}

async function adminOf(pool, userId, code = 'AVIT') {
  await pool.query(
    `INSERT INTO user_company (user_id, service_unit_id) SELECT $1::bigint, s.id FROM service_units s WHERE s.code = $2::text
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, code]
  );
  await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'ADMIN') ON CONFLICT DO NOTHING`, [userId]);
}

module.exports = { companyId, staffOf, adminOf };
