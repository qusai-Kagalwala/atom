// HR staff view → ATOM (Phase 3.1, ATOM_Decisions.md §5). Called by:
//   - sync/run-idarah-sync.js     (Windows Task Scheduler, right after the Idarah sync)
//   - POST /Atom/api/sync/hr      (Super Admin "Sync now")
//
// One run (same safety rules as the Idarah sync):
//   lock → read view → check columns → guard (0 rows / under 50%) →
//   ONE transaction: refresh mirror, departments (location), staff users, department links,
//   deactivations → log run → unlock.
// Staff users (short employee IDs):
//   - new      → EMPLOYEE_ID user, source 'hr', role Employee, first password = employee ID,
//                must change it at first sign-in
//   - source 'hr'     → name kept up to date; reactivated if the sync had deactivated them
//   - source 'legacy' (Login_Master import) → name filled only if empty; password and status untouched
//   - source 'manual' → untouched
//   - source 'hr' no longer in the view (HR Active = 0) → inactive (never deleted)
// ITS people (8-digit IDs) are left to the Idarah sync.
const defaultPool = require('../../db/pool');
const { readHrView } = require('./sqlServer');
const { buildHrPlan } = require('./hrPlan');
const { checkGuard } = require('./idarahPlan');
const { HR_MIRROR, readMirrorColumns, compareColumns, loadMirror } = require('./mirror');

const JOB = 'hr';
const LOCK_KEY = 727304; // ATOM HR sync (727302 = Idarah sync, 727303 = user admin)

// ---------- run log ----------
async function startRun(pool, { forced, triggeredBy }) {
  await pool.query(
    `UPDATE src.sync_runs SET status = 'failed', finished_at = now(), message = 'Interrupted (process stopped).'
      WHERE job = $1::text AND status = 'running'`,
    [JOB]
  );
  const { rows } = await pool.query(
    `INSERT INTO src.sync_runs (job, forced, triggered_by) VALUES ($1::text, $2::boolean, $3::bigint) RETURNING id`,
    [JOB, forced, triggeredBy]
  );
  return rows[0].id;
}

async function finishRun(pool, runId, { status, counts, summary, message }) {
  await pool.query(
    `UPDATE src.sync_runs
        SET status = $2::text, finished_at = now(),
            source_rows = $3::int, valid_rows = $4::int, skipped_rows = $5::int,
            summary = $6::jsonb, message = $7::text
      WHERE id = $1::bigint`,
    [runId, status, counts?.sourceRows ?? null, counts?.validRows ?? null, counts?.skippedRows ?? null,
      summary ? JSON.stringify(summary) : null, message ?? null]
  );
}

async function lastGoodValidRows(pool) {
  const { rows } = await pool.query(
    `SELECT valid_rows FROM src.sync_runs WHERE job = $1::text AND status = 'success' ORDER BY started_at DESC LIMIT 1`,
    [JOB]
  );
  return rows[0]?.valid_rows ?? null;
}

// ---------- apply (inside the transaction) ----------
async function applyDepartments(client, departments) {
  const { rows: before } = await client.query('SELECT idarah_id FROM departments');
  const known = new Set(before.map((d) => d.idarah_id));
  let created = 0;
  let located = 0;

  for (const d of departments) {
    // Existing values win for name / Arabic / category (the Idarah sync owns them); the HR view
    // fills gaps and owns the location. Empty values never wipe anything.
    await client.query(
      `INSERT INTO departments (idarah_id, name, name_arabic, category, category_arabic, email,
                                building, floor, room_no, in_idarah_view, in_hr_view)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, FALSE, TRUE)
       ON CONFLICT (idarah_id) DO UPDATE
          SET name            = COALESCE(departments.name, EXCLUDED.name),
              name_arabic     = COALESCE(departments.name_arabic, EXCLUDED.name_arabic),
              category        = COALESCE(departments.category, EXCLUDED.category),
              category_arabic = COALESCE(departments.category_arabic, EXCLUDED.category_arabic),
              email           = COALESCE(EXCLUDED.email, departments.email),
              building        = COALESCE(EXCLUDED.building, departments.building),
              floor           = COALESCE(EXCLUDED.floor, departments.floor),
              room_no         = COALESCE(EXCLUDED.room_no, departments.room_no),
              in_hr_view      = TRUE,
              is_active       = TRUE`,
      [d.idarahId, d.name ?? null, d.nameArabic ?? null, d.category ?? null, d.categoryArabic ?? null,
        d.email ?? null, d.building ?? null, d.floor ?? null, d.roomNo ?? null]
    );
    if (!known.has(d.idarahId)) created += 1;
    if (d.building || d.floor || d.roomNo) located += 1;
  }

  // No longer in the HR view → stays active only while the Idarah view still lists it.
  const { rowCount: deactivated } = await client.query(
    `UPDATE departments SET in_hr_view = FALSE, is_active = in_idarah_view
      WHERE in_hr_view AND NOT (idarah_id = ANY($1::text[]))`,
    [departments.map((d) => d.idarahId)]
  );

  const { rows } = await client.query('SELECT id, idarah_id FROM departments');
  return { ids: new Map(rows.map((r) => [r.idarah_id, r.id])), created, located, leftHrView: deactivated };
}

async function logStatus(client, userId, isActive, reason) {
  await client.query(
    `INSERT INTO user_status_log (user_id, is_active, source, reason) VALUES ($1::bigint, $2::boolean, 'sync', $3::text)`,
    [userId, isActive, reason]
  );
}

async function deactivatedBySync(client, userId) {
  const { rows } = await client.query(
    `SELECT source FROM user_status_log WHERE user_id = $1::bigint AND is_active = FALSE
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId]
  );
  return !rows[0] || rows[0].source === 'sync';
}

async function applyStaff(client, people) {
  const { rows: before } = await client.query(
    `SELECT id, employee_id, source, is_active, name FROM users WHERE login_type = 'EMPLOYEE_ID'`
  );
  const existing = new Map(before.map((u) => [u.employee_id, u]));
  const ids = new Map();
  const c = { created: 0, updated: 0, reactivated: 0, keptInactive: 0, legacyMatched: 0, legacyNamed: 0, manualKept: 0 };

  for (const p of people) {
    const u = existing.get(p.employeeId);

    if (!u) {
      // First password = the employee ID (client decision 26 Oct 2026); must be changed at first sign-in.
      const { rows } = await client.query(
        `INSERT INTO users (login_type, employee_id, name, legacy_password, must_change_password, source)
         VALUES ('EMPLOYEE_ID', $1::text, $2::text, $1::text, TRUE, 'hr')
         RETURNING id`,
        [p.employeeId, p.name ?? null]
      );
      const id = rows[0].id;
      await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1::bigint, 'EMPLOYEE')`, [id]);
      await logStatus(client, id, true, 'Added by HR sync');
      ids.set(p.employeeId, id);
      c.created += 1;
      continue;
    }

    ids.set(p.employeeId, u.id);

    if (u.source === 'legacy') {
      c.legacyMatched += 1;
      if (!u.name && p.name) {
        await client.query('UPDATE users SET name = $2::text WHERE id = $1::bigint AND name IS NULL', [u.id, p.name]);
        c.legacyNamed += 1;
      }
      continue; // password and status stay as they are
    }
    if (u.source !== 'hr') {
      c.manualKept += 1;
      continue;
    }

    if (p.name && p.name !== u.name) {
      await client.query('UPDATE users SET name = $2::text WHERE id = $1::bigint', [u.id, p.name]);
      c.updated += 1;
    }
    if (!u.is_active) {
      if (await deactivatedBySync(client, u.id)) {
        await client.query('UPDATE users SET is_active = TRUE WHERE id = $1::bigint', [u.id]);
        await logStatus(client, u.id, true, 'Back in HR employee list');
        c.reactivated += 1;
      } else {
        c.keptInactive += 1;
      }
    }
  }

  const { rows: gone } = await client.query(
    `UPDATE users SET is_active = FALSE
      WHERE login_type = 'EMPLOYEE_ID' AND source = 'hr' AND is_active
        AND NOT (employee_id = ANY($1::text[]))
      RETURNING id`,
    [people.map((p) => p.employeeId)]
  );
  for (const g of gone) await logStatus(client, g.id, false, 'No longer in HR employee list');
  // Phase 10 adds: flag their assigned assets "to recover".

  return { ids, ...c, deactivated: gone.length };
}

async function applyLinks(client, people, deptIds, userIds) {
  let upserted = 0;
  for (const p of people) {
    const userId = userIds.get(p.employeeId);
    for (const deptId of p.departmentIds) {
      await client.query(
        `INSERT INTO user_departments (user_id, department_id) VALUES ($1::bigint, $2::bigint)
         ON CONFLICT (user_id, department_id) DO UPDATE SET is_active = TRUE, last_seen_at = now()`,
        [userId, deptIds.get(deptId)]
      );
      upserted += 1;
    }
  }
  const { rowCount: deactivated } = await client.query(
    `UPDATE user_departments SET is_active = FALSE WHERE is_active AND last_seen_at < now()`
  );
  return { upserted, deactivated };
}

// ---------- the run ----------
async function runHrSync({ force = false, triggeredBy = null, readSource = readHrView, pool = defaultPool, log = console.log } = {}) {
  const lockClient = await pool.connect();
  let runId = null;
  let counts = null;

  try {
    const { rows: lock } = await lockClient.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    if (!lock[0].ok) {
      log('HR sync: another run is in progress — skipped.');
      return { status: 'busy', message: 'Another sync is already running.' };
    }

    try {
      runId = await startRun(pool, { forced: force, triggeredBy });
      const source = await readSource();

      const cmp = compareColumns(source.columns, await readMirrorColumns(pool, HR_MIRROR));
      if (cmp.problems.length) {
        const message = `Column check failed: ${cmp.problems.join(' ')}`;
        await finishRun(pool, runId, { status: 'failed', message });
        log(`HR sync FAILED. ${message}`);
        return { status: 'failed', runId, message };
      }

      const plan = buildHrPlan(source.rows);
      counts = plan.counts;
      const guard = checkGuard(counts.validRows, await lastGoodValidRows(pool), force);
      if (!guard.ok) {
        await finishRun(pool, runId, { status: 'blocked', counts, summary: { skipped: counts.skipped }, message: guard.reason });
        log(`HR sync BLOCKED. ${guard.reason}`);
        return { status: 'blocked', runId, message: guard.reason, counts };
      }

      const client = await pool.connect();
      let summary;
      try {
        await client.query('BEGIN');
        const mirrored = await loadMirror(client, cmp, source.rows, HR_MIRROR);
        const dept = await applyDepartments(client, plan.departments);
        const staff = await applyStaff(client, plan.people);
        const links = await applyLinks(client, plan.people, dept.ids, staff.ids);
        await client.query('COMMIT');

        summary = {
          mirroredRows: mirrored,
          columnsAdded: cmp.creating ? [] : cmp.toAdd.map((c) => c.name),
          skipped: counts.skipped,
          itsRows: counts.itsRows,
          departments: { total: plan.departments.length, created: dept.created, withLocation: dept.located, leftHrView: dept.leftHrView },
          staff: {
            inView: plan.people.length,
            created: staff.created,
            updated: staff.updated,
            reactivated: staff.reactivated,
            deactivated: staff.deactivated,
            keptInactive: staff.keptInactive,
            legacyMatched: staff.legacyMatched,
            legacyNamed: staff.legacyNamed,
            manualKept: staff.manualKept,
          },
          links: { upserted: links.upserted, deactivated: links.deactivated },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      await finishRun(pool, runId, { status: 'success', counts, summary, message: force ? 'Forced run (50% guard overridden).' : null });
      log(
        `HR sync OK: ${counts.validRows} staff rows / ${counts.sourceRows} · ` +
          `staff +${summary.staff.created} ~${summary.staff.updated} ↑${summary.staff.reactivated} ↓${summary.staff.deactivated} · ` +
          `departments ${summary.departments.total} (${summary.departments.withLocation} with location)`
      );
      return { status: 'success', runId, counts, summary };
    } catch (err) {
      const message = `Sync error: ${err.message}`;
      if (runId) await finishRun(pool, runId, { status: 'failed', counts, message }).catch(() => {});
      log(`HR sync FAILED. ${message}`);
      return { status: 'failed', runId, message };
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

// Imported Login_Master accounts that are active in ATOM but not in the HR list
// (Super Admin decides). null when no HR sync has succeeded yet (the list would be meaningless).
async function oldAccountsNotInHr(pool = defaultPool) {
  const { rows: ok } = await pool.query(
    `SELECT finished_at FROM src.sync_runs WHERE job = $1::text AND status = 'success' ORDER BY started_at DESC LIMIT 1`,
    [JOB]
  );
  if (!ok[0]) return null;
  const { rows } = await pool.query(
    `SELECT u.id::text AS id, u.employee_id, u.name, u.email, u.created_at,
            (SELECT max(r.created_at) FROM requests r WHERE r.requester_id = u.id) AS last_ticket_at
       FROM users u
      WHERE u.login_type = 'EMPLOYEE_ID' AND u.source = 'legacy' AND u.is_active
        AND NOT EXISTS (SELECT 1 FROM user_departments d WHERE d.user_id = u.id AND d.is_active)
      ORDER BY length(u.employee_id), u.employee_id`
  );
  return { checkedAt: ok[0].finished_at, accounts: rows };
}

module.exports = { runHrSync, oldAccountsNotInHr, JOB, LOCK_KEY };
