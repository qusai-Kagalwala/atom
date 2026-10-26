// Idarah view → ATOM (ATOM_Decisions.md §4). Called by:
//   - sync/run-idarah-sync.js   (Windows Task Scheduler, every ~10 min)
//   - POST /Atom/api/sync/idarah (Super Admin "Sync now")
//
// One run:
//   lock → read view → check columns → guard (0 rows / under 50%) →
//   ONE transaction: refresh mirror, departments, users, posts, deactivations → log run → unlock.
// Never deletes. Never touches users whose source is not 'idarah' (manual, legacy) except to
// attach their posts. Never changes roles of existing users.
const defaultPool = require('../../db/pool');
const { readIdarahView } = require('./sqlServer');
const { buildPlan, checkGuard } = require('./idarahPlan');
const { readMirrorColumns, compareColumns, loadMirror } = require('./mirror');

const JOB = 'idarah';
const LOCK_KEY = 727302; // ATOM Idarah sync (migrations use 727301)

// ---------- run log (outside the main transaction, so failures are recorded too) ----------
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
    [
      runId,
      status,
      counts?.sourceRows ?? null,
      counts?.validRows ?? null,
      counts?.skippedRows ?? null,
      summary ? JSON.stringify(summary) : null,
      message ?? null,
    ]
  );
}

async function lastGoodValidRows(pool) {
  const { rows } = await pool.query(
    `SELECT valid_rows FROM src.sync_runs
      WHERE job = $1::text AND status = 'success'
      ORDER BY started_at DESC LIMIT 1`,
    [JOB]
  );
  return rows[0]?.valid_rows ?? null;
}

// ---------- apply (inside the transaction) ----------
async function applyDepartments(client, departments) {
  const { rows: before } = await client.query('SELECT idarah_id, is_active FROM departments');
  const prev = new Map(before.map((d) => [d.idarah_id, d.is_active]));
  let created = 0;
  let reactivated = 0;

  for (const d of departments) {
    await client.query(
      `INSERT INTO departments (idarah_id, name, name_arabic, category, category_arabic, email)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text)
       ON CONFLICT (idarah_id) DO UPDATE
          SET name            = COALESCE(EXCLUDED.name, departments.name),
              name_arabic     = COALESCE(EXCLUDED.name_arabic, departments.name_arabic),
              category        = COALESCE(EXCLUDED.category, departments.category),
              category_arabic = COALESCE(EXCLUDED.category_arabic, departments.category_arabic),
              email           = COALESCE(EXCLUDED.email, departments.email),
              in_idarah_view  = TRUE,
              is_active       = TRUE
        WHERE (departments.name, departments.name_arabic, departments.category,
               departments.category_arabic, departments.email, departments.in_idarah_view, departments.is_active)
              IS DISTINCT FROM
              (COALESCE(EXCLUDED.name, departments.name), COALESCE(EXCLUDED.name_arabic, departments.name_arabic),
               COALESCE(EXCLUDED.category, departments.category),
               COALESCE(EXCLUDED.category_arabic, departments.category_arabic),
               COALESCE(EXCLUDED.email, departments.email), TRUE, TRUE)`,
      [d.idarahId, d.name ?? null, d.nameArabic ?? null, d.category ?? null, d.categoryArabic ?? null, d.email ?? null]
    );
    if (!prev.has(d.idarahId)) created += 1;
    else if (prev.get(d.idarahId) === false) reactivated += 1;
  }

  // Not in this view any more. A department stays active while the HR view still lists it (Phase 3.1).
  await client.query(
    `UPDATE departments SET in_idarah_view = FALSE
      WHERE in_idarah_view AND NOT (idarah_id = ANY($1::text[]))`,
    [departments.map((d) => d.idarahId)]
  );
  const { rowCount: deactivated } = await client.query(
    `UPDATE departments SET is_active = FALSE
      WHERE is_active AND NOT in_idarah_view AND NOT in_hr_view`
  );

  const { rows } = await client.query('SELECT id, idarah_id FROM departments');
  return { ids: new Map(rows.map((r) => [r.idarah_id, r.id])), created, reactivated, deactivated };
}

async function logStatus(client, userId, isActive, reason) {
  await client.query(
    `INSERT INTO user_status_log (user_id, is_active, source, reason)
     VALUES ($1::bigint, $2::boolean, 'sync', $3::text)`,
    [userId, isActive, reason]
  );
}

// Was this user's latest deactivation done by the sync? (Then the sync may reactivate them.
// If a Super Admin deactivated them, they stay inactive.)
async function deactivatedBySync(client, userId) {
  const { rows } = await client.query(
    `SELECT source FROM user_status_log
      WHERE user_id = $1::bigint AND is_active = FALSE
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId]
  );
  return !rows[0] || rows[0].source === 'sync';
}

async function applyPeople(client, people) {
  const { rows: before } = await client.query(
    `SELECT id, its_number, source, is_active FROM users WHERE login_type = 'ITS'`
  );
  const existing = new Map(before.map((u) => [u.its_number, u]));
  const ids = new Map();
  const c = { created: 0, updated: 0, reactivated: 0, keptInactive: 0, manualKept: 0 };

  for (const p of people) {
    const u = existing.get(p.its);

    if (!u) {
      const { rows } = await client.query(
        `INSERT INTO users (login_type, its_number, name, name_arabic, email, mobile, source)
         VALUES ('ITS', $1::text, $2::text, $3::text, $4::text, $5::text, 'idarah')
         RETURNING id`,
        [p.its, p.name ?? null, p.nameArabic ?? null, p.email ?? null, p.mobile ?? null]
      );
      const id = rows[0].id;
      await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1::bigint, 'EMPLOYEE')`, [id]);
      await logStatus(client, id, true, 'Added by Idarah sync');
      ids.set(p.its, id);
      c.created += 1;
      continue;
    }

    ids.set(p.its, u.id);

    if (u.source !== 'idarah') {
      c.manualKept += 1; // e.g. the developer test account — name, roles and status untouched
      continue;
    }

    // Empty values in the view never wipe what ATOM already has.
    const { rowCount } = await client.query(
      `UPDATE users
          SET name        = COALESCE($2::text, name),
              name_arabic = COALESCE($3::text, name_arabic),
              email       = COALESCE($4::text, email),
              mobile      = COALESCE($5::text, mobile)
        WHERE id = $1::bigint
          AND (name, name_arabic, email, mobile) IS DISTINCT FROM
              (COALESCE($2::text, name), COALESCE($3::text, name_arabic),
               COALESCE($4::text, email), COALESCE($5::text, mobile))`,
      [u.id, p.name ?? null, p.nameArabic ?? null, p.email ?? null, p.mobile ?? null]
    );
    if (rowCount) c.updated += 1;

    if (!u.is_active) {
      if (await deactivatedBySync(client, u.id)) {
        await client.query('UPDATE users SET is_active = TRUE WHERE id = $1::bigint', [u.id]);
        await logStatus(client, u.id, true, 'Back in Idarah view');
        c.reactivated += 1;
      } else {
        c.keptInactive += 1;
      }
    }
  }

  // Idarah users no longer in the view → inactive (never deleted).
  const { rows: gone } = await client.query(
    `UPDATE users SET is_active = FALSE
      WHERE login_type = 'ITS' AND source = 'idarah' AND is_active
        AND NOT (its_number = ANY($1::text[]))
      RETURNING id`,
    [people.map((p) => p.its)]
  );
  for (const g of gone) await logStatus(client, g.id, false, 'No longer in Idarah view');
  // Phase 5 (assets) adds: flag their assigned assets "to recover".

  return { ids, ...c, deactivated: gone.length };
}

async function applyPosts(client, posts, deptIds, itsIds) {
  const employeeIds = [...new Set(posts.filter((p) => p.ownerKind === 'EMPLOYEE').map((p) => p.ownerId))];
  const { rows: emp } = employeeIds.length
    ? await client.query(
        `SELECT id, employee_id FROM users WHERE login_type = 'EMPLOYEE_ID' AND employee_id = ANY($1::text[])`,
        [employeeIds]
      )
    : { rows: [] };
  const empIds = new Map(emp.map((e) => [e.employee_id, e.id]));

  let upserted = 0;
  let created = 0;
  let employeeNotFound = 0;

  for (const p of posts) {
    const userId = p.ownerKind === 'ITS' ? itsIds.get(p.ownerId) : empIds.get(p.ownerId);
    if (!userId) {
      employeeNotFound += 1; // employee-ID row whose user isn't in ATOM (yet)
      continue;
    }
    const { rows } = await client.query(
      `INSERT INTO user_posts
              (user_id, department_id, post, post_tbq, post_id, post_category, post_abbrev, intercom, office_no)
       VALUES ($1::bigint, $2::bigint, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text)
       ON CONFLICT (user_id, department_id, post, post_tbq) DO UPDATE
          SET post_id = EXCLUDED.post_id, post_category = EXCLUDED.post_category,
              post_abbrev = EXCLUDED.post_abbrev, intercom = EXCLUDED.intercom,
              office_no = EXCLUDED.office_no, is_active = TRUE, last_seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [userId, deptIds.get(p.idarahId), p.post, p.postTbq, p.postId, p.postCategory, p.postAbbrev, p.intercom, p.officeNo]
    );
    upserted += 1;
    if (rows[0].inserted) created += 1;
  }

  // Everything touched above has last_seen_at = now() (the transaction time); the rest is gone.
  const { rowCount: deactivated } = await client.query(
    `UPDATE user_posts SET is_active = FALSE WHERE is_active AND last_seen_at < now()`
  );

  return { upserted, created, deactivated, employeeNotFound };
}

// ---------- the run ----------
async function runIdarahSync({
  force = false,
  triggeredBy = null,
  readSource = readIdarahView,
  pool = defaultPool,
  log = console.log,
} = {}) {
  const lockClient = await pool.connect();
  let runId = null;
  let counts = null;

  try {
    const { rows: lock } = await lockClient.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    if (!lock[0].ok) {
      log('Idarah sync: another run is in progress — skipped.');
      return { status: 'busy', message: 'Another sync is already running.' };
    }

    try {
      runId = await startRun(pool, { forced: force, triggeredBy });

      // 1. Read the view.
      const source = await readSource();

      // 2. Column check (§4 rule 1).
      const cmp = compareColumns(source.columns, await readMirrorColumns(pool));
      if (cmp.problems.length) {
        const message = `Column check failed: ${cmp.problems.join(' ')}`;
        await finishRun(pool, runId, { status: 'failed', message });
        log(`Idarah sync FAILED. ${message}`);
        return { status: 'failed', runId, message };
      }

      // 3. Plan + guard (§4 rule 2).
      const plan = buildPlan(source.rows);
      counts = plan.counts;
      const guard = checkGuard(counts.validRows, await lastGoodValidRows(pool), force);
      if (!guard.ok) {
        await finishRun(pool, runId, { status: 'blocked', counts, summary: { skipped: counts.skipped }, message: guard.reason });
        log(`Idarah sync BLOCKED. ${guard.reason}`);
        return { status: 'blocked', runId, message: guard.reason, counts };
      }

      // 4. One transaction for everything.
      const client = await pool.connect();
      let summary;
      try {
        await client.query('BEGIN');
        const mirrored = await loadMirror(client, cmp, source.rows);
        const dept = await applyDepartments(client, plan.departments);
        const people = await applyPeople(client, plan.people);
        const posts = await applyPosts(client, plan.posts, dept.ids, people.ids);
        await client.query('COMMIT');

        summary = {
          mirroredRows: mirrored,
          columnsAdded: cmp.creating ? [] : cmp.toAdd.map((c) => c.name),
          skipped: { ...counts.skipped, employee_id_not_in_atom: posts.employeeNotFound },
          viaTeacherId: counts.viaTeacherId,
          departments: { total: plan.departments.length, created: dept.created, reactivated: dept.reactivated, deactivated: dept.deactivated },
          users: {
            inView: plan.people.length,
            created: people.created,
            updated: people.updated,
            reactivated: people.reactivated,
            deactivated: people.deactivated,
            keptInactive: people.keptInactive,
            manualKept: people.manualKept,
          },
          posts: { upserted: posts.upserted, created: posts.created, deactivated: posts.deactivated },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      await finishRun(pool, runId, { status: 'success', counts, summary, message: forced(force) });
      log(
        `Idarah sync OK: ${counts.validRows}/${counts.sourceRows} rows · ` +
          `users +${summary.users.created} ~${summary.users.updated} ↑${summary.users.reactivated} ↓${summary.users.deactivated} · ` +
          `departments ${summary.departments.total} · posts ${summary.posts.upserted}`
      );
      return { status: 'success', runId, counts, summary };
    } catch (err) {
      const message = `Sync error: ${err.message}`;
      if (runId) await finishRun(pool, runId, { status: 'failed', counts, message }).catch(() => {});
      log(`Idarah sync FAILED. ${message}`);
      return { status: 'failed', runId, message };
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

const forced = (force) => (force ? 'Forced run (50% guard overridden).' : null);

module.exports = { runIdarahSync, JOB, LOCK_KEY };
