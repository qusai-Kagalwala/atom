// Room occupancy sheet → ATOM (Phase 8.2). Called by:
//   - sync/run-occupancy-sync.js   (Windows Task Scheduler; or --file=<csv> when the server has no internet)
//   - POST /Atom/api/sync/occupancy (Super Admin "Sync now")
// One run (same safety rules as the people syncs):
//   lock → read sheet tab(s) → plan → guard (0 rows / under 50%) →
//   ONE transaction: upsert seats of known active people, end seats no longer in the sheet → log → unlock.
// People are matched by ITS number (8 digits) or employee ID. Unknown IDs and rooms with no place
// in ATOM are reported, never guessed. Seats are history: ended, never deleted.
const fs = require('fs');
const defaultPool = require('../../db/pool');
const { config } = require('../../config/env');
const { parseRows } = require('../../utils/csv');
const { buildOccupancyPlan } = require('./occupancyPlan');
const { checkGuard } = require('./idarahPlan');

const JOB = 'occupancy';
const LOCK_KEY = 727306; // 727304 HR · 727305 Snipe-IT import · 727307 FAQ import
const SAMPLE = 30;

// Google Sheet tab(s) as CSV (sheet shared "anyone with the link can view"; no API key).
async function readSheets({ fetchImpl = fetch } = {}) {
  const { sheetId, tabs, timeoutMs } = config.occupancy;
  if (!sheetId) throw new Error('OCCUPANCY_SHEET_ID is not set in .env.');
  const out = [];
  for (const tab of tabs) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetchImpl(url, { signal: ctrl.signal });
    } catch (err) {
      throw new Error(`Could not reach Google Sheets for "${tab}" (${err.name === 'AbortError' ? 'timed out' : err.message}).`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Google Sheets answered HTTP ${res.status} for "${tab}". Is the sheet shared "anyone with the link"?`);
    // eslint-disable-next-line no-await-in-loop
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error(`Google Sheets returned a web page for "${tab}", not CSV. Check the sheet is shared "anyone with the link".`);
    out.push({ tab, rows: parseRows(text) });
  }
  return out;
}

const readFile = (file) => async () => [{ tab: 'file', rows: parseRows(fs.readFileSync(file, 'utf8')) }];

async function startRun(pool, { forced, triggeredBy }) {
  await pool.query(
    `UPDATE src.sync_runs SET status = 'failed', finished_at = now(), message = 'Interrupted (process stopped).'
      WHERE job = $1::text AND status = 'running'`,
    [JOB]
  );
  const { rows } = await pool.query(
    'INSERT INTO src.sync_runs (job, forced, triggered_by) VALUES ($1::text, $2::boolean, $3::bigint) RETURNING id',
    [JOB, forced, triggeredBy]
  );
  return rows[0].id;
}

async function finishRun(pool, runId, { status, counts, summary, message }) {
  await pool.query(
    `UPDATE src.sync_runs SET status = $2::text, finished_at = now(), source_rows = $3::int, valid_rows = $4::int,
            skipped_rows = $5::int, summary = $6::jsonb, message = $7::text
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

async function apply(client, occupants) {
  const { rows: users } = await client.query(
    `SELECT id, its_number, employee_id, is_active FROM users WHERE its_number IS NOT NULL OR employee_id IS NOT NULL`
  );
  const byIts = new Map(users.filter((u) => u.its_number).map((u) => [u.its_number, u]));
  const byEmp = new Map(users.filter((u) => u.employee_id).map((u) => [u.employee_id, u]));

  const unknown = new Set();
  const inactive = new Set();
  let created = 0;
  let kept = 0;
  const people = new Set();

  for (const o of occupants) {
    const u = o.personId.length === 8 ? byIts.get(o.personId) || byEmp.get(o.personId) : byEmp.get(o.personId);
    if (!u) {
      unknown.add(o.personId);
      continue;
    }
    if (!u.is_active) {
      inactive.add(o.personId);
      continue;
    }
    people.add(String(u.id));
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await client.query(
      `INSERT INTO place_occupants (user_id, room_no, cubicle, building, floor, department, intercom, did_no, sheet_tab)
       VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text)
       ON CONFLICT (user_id, room_no, cubicle) DO UPDATE
          SET building = EXCLUDED.building, floor = EXCLUDED.floor, department = EXCLUDED.department,
              intercom = EXCLUDED.intercom, did_no = EXCLUDED.did_no, sheet_tab = EXCLUDED.sheet_tab,
              first_seen_at = CASE WHEN place_occupants.is_active THEN place_occupants.first_seen_at ELSE now() END,
              is_active = TRUE, last_seen_at = now(), ended_at = NULL
       RETURNING (xmax = 0) AS inserted`,
      [u.id, o.roomNo, o.cubicle, o.building, o.floor, o.department, o.intercom, o.didNo, o.tab]
    );
    if (rows[0].inserted) created += 1;
    else kept += 1;
  }

  // Seats not in this sheet any more end (now() is the same for the whole transaction).
  const { rowCount: ended } = await client.query(
    `UPDATE place_occupants SET is_active = FALSE, ended_at = now() WHERE is_active AND last_seen_at < now()`
  );
  const { rows: noPlace } = await client.query(
    `SELECT DISTINCT o.room_no FROM place_occupants o
      WHERE o.is_active AND NOT EXISTS (SELECT 1 FROM places p WHERE p.is_active AND p.room_no = o.room_no)
      ORDER BY o.room_no`
  );
  return {
    seats: created + kept,
    people: people.size,
    created,
    kept,
    ended,
    unknownPeople: unknown.size,
    unknownSample: [...unknown].slice(0, SAMPLE),
    inactivePeople: inactive.size,
    roomsWithoutPlace: noPlace.length,
    roomSample: noPlace.slice(0, SAMPLE).map((r) => r.room_no),
  };
}

async function runOccupancySync({ force = false, triggeredBy = null, file = null, readSource = null, pool = defaultPool, log = console.log } = {}) {
  const read = readSource || (file ? readFile(file) : readSheets);
  const lockClient = await pool.connect();
  let runId = null;
  let counts = null;
  try {
    const { rows: lock } = await lockClient.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    if (!lock[0].ok) {
      log('Occupancy sync: another run is in progress — skipped.');
      return { status: 'busy', message: 'Another sync is already running.' };
    }
    try {
      runId = await startRun(pool, { forced: force, triggeredBy });
      const plan = buildOccupancyPlan(await read());
      counts = plan.counts;
      const guard = checkGuard(counts.validRows, await lastGoodValidRows(pool), force);
      if (!guard.ok) {
        const reason = guard.reason.replace('The view', 'The sheet').replace(' (Hijri year rollover?)', '');
        await finishRun(pool, runId, { status: 'blocked', counts, summary: { skipped: counts.skipped, tabs: counts.tabs }, message: reason });
        log(`Occupancy sync BLOCKED. ${reason}`);
        return { status: 'blocked', runId, message: reason, counts };
      }

      const client = await pool.connect();
      let seats;
      try {
        await client.query('BEGIN');
        seats = await apply(client, plan.occupants);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      const summary = { seats, skipped: counts.skipped, tabs: counts.tabs, source: file ? 'file' : 'sheet' };
      await finishRun(pool, runId, { status: 'success', counts, summary, message: force ? 'Forced run (50% guard overridden).' : null });
      log(
        `Occupancy sync OK: ${seats.seats} seats for ${seats.people} people · new ${seats.created} · ended ${seats.ended} · ` +
          `unknown IDs ${seats.unknownPeople} · rooms without a place ${seats.roomsWithoutPlace}`
      );
      return { status: 'success', runId, counts, summary };
    } catch (err) {
      const message = `Sync error: ${err.message}`;
      if (runId) await finishRun(pool, runId, { status: 'failed', counts, message }).catch(() => {});
      log(`Occupancy sync FAILED. ${message}`);
      return { status: 'failed', runId, message };
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

module.exports = { runOccupancySync, readSheets, JOB, LOCK_KEY };
