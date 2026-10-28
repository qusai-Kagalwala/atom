// Companies (rows of service_units: AVIT, Siyanaat, Tanzeem — decided 28 Oct 2026).
const pool = require('../../db/pool');

const COLUMNS = 'id, code, name, is_active, tagline, sort_order';

async function listServiceUnits({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM service_units ${activeOnly ? 'WHERE is_active' : ''} ORDER BY sort_order, id`
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

module.exports = { listServiceUnits, getServiceUnit, getServiceUnitByCode };
