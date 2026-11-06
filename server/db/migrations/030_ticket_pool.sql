-- 030_ticket_pool.sql — Pool assignment (Phase 2 of leave + pool, decided 6 Nov 2026). Idempotent.
--   Instead of one person, the Admin (or someone given Assign queue / All tickets / Approvals) sends an
--   unassigned ticket or request to a pool: several chosen staff, or all available staff. Everyone in the
--   pool is told; the first to "Take it" gets it. Nobody can decline. If nobody takes it within 12 hours,
--   it is assigned automatically to the pool member with the fewest ongoing tickets (staff on leave skipped).
--   request_pool holds the live pool only; who was in it, who took it and when stay in request_events.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS pool_started_at timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS pool_started_by bigint REFERENCES users (id);
CREATE INDEX IF NOT EXISTS requests_pool_idx ON requests (pool_started_at) WHERE pool_started_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS request_pool (
  request_id  bigint      NOT NULL REFERENCES requests (id),
  user_id     bigint      NOT NULL REFERENCES users (id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX IF NOT EXISTS request_pool_user_idx ON request_pool (user_id);
