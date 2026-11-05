// A person's saved Appearance choice (table user_theme, migration 025). Never part of the session user.
//
// Safe to deploy before the migration is applied: while the table does not exist, reads answer "no choice
// saved" and writes answer null (the route turns that into 503 theme_unavailable). Only "table does not
// exist" is tolerated; any other database error still surfaces.
const pool = require('../../db/pool');

const UNDEFINED_TABLE = '42P01';

// → { theme, mode } or null (nothing saved, or the table is not there yet).
async function getTheme(userId) {
  try {
    const { rows } = await pool.query(`SELECT theme, mode FROM user_theme WHERE user_id = $1::bigint`, [userId]);
    return rows[0] || null;
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

// → { theme, mode } as saved, or null when the table is not there yet. Values are validated by the route.
async function setTheme(userId, { theme, mode }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO user_theme (user_id, theme, mode)
       VALUES ($1::bigint, $2::text, $3::text)
       ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme, mode = EXCLUDED.mode, updated_at = now()
       RETURNING theme, mode`,
      [userId, theme, mode]
    );
    return rows[0];
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

module.exports = { getTheme, setTheme };
