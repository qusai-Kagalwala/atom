// Open / close companies (Super Admin, decided 31 Oct 2026). A closed company is hidden from the
// picker, the login page and every company list for everyone except the Super Admin; its data stays.
// At least one company stays open. Every change is logged (company_open_log).
const pool = require('../../db/pool');
const { HttpError, notFound } = require('../../utils/httpError');

const bad = (message, code) => new HttpError(400, message, code);

async function list() {
  const { rows } = await pool.query(
    `SELECT s.id::text AS id, s.code, s.name, s.tagline, s.is_open,
            (SELECT json_build_object('at', l.created_at, 'by', COALESCE(u.name, 'Employee ' || u.employee_id))
               FROM company_open_log l JOIN users u ON u.id = l.changed_by
              WHERE l.service_unit_id = s.id ORDER BY l.id DESC LIMIT 1) AS last_change
       FROM service_units s WHERE s.is_active ORDER BY s.sort_order, s.id`
  );
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, tagline: r.tagline, isOpen: r.is_open, lastChange: r.last_change }));
}

async function setOpen(user, code, body = {}) {
  if (typeof body.isOpen !== 'boolean') throw bad('Bad value.', 'invalid');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, is_open FROM service_units WHERE code = $1::text AND is_active FOR UPDATE',
      [String(code || '').toUpperCase()]
    );
    const unit = rows[0];
    if (!unit) throw notFound();
    if (unit.is_open !== body.isOpen) {
      if (!body.isOpen) {
        const { rows: open } = await client.query('SELECT count(*)::int AS n FROM service_units WHERE is_active AND is_open AND id <> $1::bigint', [unit.id]);
        if (!open[0].n) throw bad('At least one company has to stay open.', 'last_open');
      }
      await client.query('UPDATE service_units SET is_open = $2::boolean WHERE id = $1::bigint', [unit.id, body.isOpen]);
      await client.query('INSERT INTO company_open_log (service_unit_id, is_open, changed_by) VALUES ($1::bigint, $2::boolean, $3::bigint)', [unit.id, body.isOpen, user.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return list();
}

module.exports = { list, setOpen };
