-- 020_company_assistant.sql — companies step C (decided 30 Oct 2026). Idempotent.
--   Each company has its own AI assistant and FAQs; GPT settings, limits and prices stay global.
--   - FAQs, chat sessions, saved GPT answers and GPT calls belong to a company (existing rows: AVIT).
--   - The Super Admin switches each company's assistant on or off (on for all three).
--   - An FAQ can point at a problem of the company's problem list (Category > Item > Problem); the chat's
--     browse buttons use the problem list, and a problem without an FAQ goes straight to a ticket.
--   - Tanzeem: the chat can also suggest catalogue items and send the person to the Request page.

-- ---------- per-company switch ----------
ALTER TABLE service_units ADD COLUMN IF NOT EXISTS assistant_enabled boolean NOT NULL DEFAULT TRUE;

-- ---------- FAQs ----------
ALTER TABLE faqs ADD COLUMN IF NOT EXISTS service_unit_id bigint REFERENCES service_units (id);
UPDATE faqs SET service_unit_id = (SELECT id FROM service_units WHERE code = 'AVIT') WHERE service_unit_id IS NULL;
ALTER TABLE faqs ALTER COLUMN service_unit_id SET NOT NULL;
ALTER TABLE faqs DROP CONSTRAINT IF EXISTS faqs_item_id_uq;                 -- item ids are per company now
CREATE UNIQUE INDEX IF NOT EXISTS faqs_company_item_uq ON faqs (service_unit_id, item_id);
CREATE INDEX IF NOT EXISTS faqs_company_idx ON faqs (service_unit_id) WHERE is_active;
ALTER TABLE faqs ADD COLUMN IF NOT EXISTS ticket_problem_id bigint REFERENCES ticket_problems (id);

-- Link existing FAQs to their problem by name (Item_Id numbers in the FAQ file and Item_Master differ).
UPDATE faqs f SET ticket_problem_id = m.problem_id
  FROM (
    SELECT DISTINCT ON (f2.id) f2.id AS faq_id, p.id AS problem_id
      FROM faqs f2
      JOIN ticket_items i ON i.service_unit_id = f2.service_unit_id AND lower(trim(i.name)) = lower(trim(f2.item))
      JOIN ticket_problems p ON p.item_id = i.id
       AND lower(trim(regexp_replace(p.name, '\s*\(specify in description\)\s*', '', 'i')))
         = lower(trim(regexp_replace(f2.sub_item, '\s*\(specify in description\)\s*', '', 'i')))
     WHERE f2.ticket_problem_id IS NULL
     ORDER BY f2.id, p.is_active DESC, i.is_active DESC, p.id
  ) m
 WHERE f.id = m.faq_id;

-- ---------- sessions, GPT calls, saved answers ----------
ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS service_unit_id bigint REFERENCES service_units (id);
UPDATE assistant_sessions SET service_unit_id = (SELECT id FROM service_units WHERE code = 'AVIT') WHERE service_unit_id IS NULL;
ALTER TABLE assistant_sessions ALTER COLUMN service_unit_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS assistant_sessions_company_idx ON assistant_sessions (service_unit_id, created_at DESC);
-- A problem picked from the problem list (with or without an FAQ).
ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS ticket_problem_id bigint REFERENCES ticket_problems (id);

ALTER TABLE assistant_gpt_calls ADD COLUMN IF NOT EXISTS service_unit_id bigint REFERENCES service_units (id);
UPDATE assistant_gpt_calls g SET service_unit_id = COALESCE(
    (SELECT s.service_unit_id FROM assistant_sessions s WHERE s.id = g.session_id),
    (SELECT id FROM service_units WHERE code = 'AVIT'))
 WHERE service_unit_id IS NULL;
CREATE INDEX IF NOT EXISTS assistant_gpt_calls_company_idx ON assistant_gpt_calls (service_unit_id, created_at);

ALTER TABLE assistant_learned ADD COLUMN IF NOT EXISTS service_unit_id bigint REFERENCES service_units (id);
UPDATE assistant_learned SET service_unit_id = (SELECT id FROM service_units WHERE code = 'AVIT') WHERE service_unit_id IS NULL;
ALTER TABLE assistant_learned ALTER COLUMN service_unit_id SET NOT NULL;
ALTER TABLE assistant_learned DROP CONSTRAINT IF EXISTS assistant_learned_key_uq;
CREATE UNIQUE INDEX IF NOT EXISTS assistant_learned_company_key_uq ON assistant_learned (service_unit_id, match_key);
-- What GPT picked: FAQs and/or problems of the list.
ALTER TABLE assistant_learned ADD COLUMN IF NOT EXISTS problem_ids bigint[] NOT NULL DEFAULT '{}';

-- ---------- event / match kinds ----------
--   picked: a problem with no FAQ was chosen (→ ticket) · request: sent to the Request page (Tanzeem)
--   catalogue: catalogue items were suggested (Tanzeem)
ALTER TABLE assistant_events DROP CONSTRAINT IF EXISTS assistant_events_kind_chk;
ALTER TABLE assistant_events ADD CONSTRAINT assistant_events_kind_chk
  CHECK (kind IN ('typed', 'shown', 'choices', 'no_match', 'gpt', 'gpt_skipped', 'learned', 'solved', 'not_solved', 'ticket',
                  'picked', 'catalogue', 'request'));
ALTER TABLE assistant_events ADD COLUMN IF NOT EXISTS ticket_problem_id bigint REFERENCES ticket_problems (id);
