const pool = require('../../db/pool');

const COLUMNS = 'id, code, name, is_active';

async function listServiceUnits({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM service_units ${activeOnly ? 'WHERE is_active' : ''} ORDER BY id`
  );
  return rows;
}

async function getServiceUnit(id) {
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM service_units WHERE id = $1::bigint`, [id]);
  return rows[0] || null;
}

async function getServiceUnitByCode(code) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM service_units WHERE code = $1::text`, [code]);
  return rows[0] || null;
}

// IDs (as strings) of the service units an engineer is tagged to.
async function userServiceUnitIds(userId) {
  const { rows } = await pool.query(
    'SELECT service_unit_id FROM user_service_units WHERE user_id = $1::bigint ORDER BY service_unit_id',
    [userId]
  );
  return rows.map((r) => String(r.service_unit_id));
}

module.exports = { listServiceUnits, getServiceUnit, getServiceUnitByCode, userServiceUnitIds };
