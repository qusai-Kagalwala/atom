-- 012_assistant.sql — AI assistant (Phase 12) + room occupancy (Phase 8.2).
-- Idempotent: safe to run again.
--   - FAQ bank (4 languages) the chatbot answers from. GPT is the last resort and only picks an FAQ.
--   - One settings row (GPT switch, model, token limits), with a change log.
--   - Every chat session and every GPT call is recorded (tokens + estimated cost).
--   - Who sits in which room / cubicle, from the occupancy sheet (synced by Task Scheduler).

-- ---------- ticket category for phone problems (FAQ category "Telecommunication") ----------
INSERT INTO categories (service_unit_id, name, sort_order)
SELECT s.id, 'Telephone / Intercom', 85 FROM service_units s WHERE s.code = 'AVIT'
ON CONFLICT (service_unit_id, name) DO NOTHING;

-- ---------- FAQ bank ----------
-- item_id: the id in the FAQ JSON (re-import matches on it). FAQs added in ATOM get 100000+.
-- answers: { en|ar|hi|gu: { question, steps[], raise_ticket } }
CREATE TABLE IF NOT EXISTS faqs (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id             integer     NOT NULL,
  category            text        NOT NULL,
  item                text        NOT NULL,
  sub_item            text        NOT NULL,
  keywords            text[]      NOT NULL DEFAULT '{}',
  direct_ticket       boolean     NOT NULL DEFAULT FALSE,
  answers             jsonb       NOT NULL,
  details_en          jsonb       NOT NULL DEFAULT '[]',   -- longer DIY steps (English)
  ticket_info         jsonb       NOT NULL DEFAULT '[]',   -- "info to include in the ticket"
  ticket_category_id  bigint      REFERENCES categories (id),
  source              text        NOT NULL DEFAULT 'json',
  content_hash        text,                                -- of the JSON entry, to spot unchanged re-imports
  edited_in_atom_at   timestamptz,
  is_active           boolean     NOT NULL DEFAULT TRUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faqs_item_id_uq UNIQUE (item_id),
  CONSTRAINT faqs_source_chk CHECK (source IN ('json', 'atom'))
);
DROP TRIGGER IF EXISTS faqs_set_updated_at ON faqs;
CREATE TRIGGER faqs_set_updated_at BEFORE UPDATE ON faqs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- settings (one row) ----------
CREATE TABLE IF NOT EXISTS assistant_settings (
  id                   smallint    PRIMARY KEY DEFAULT 1,
  gpt_enabled          boolean     NOT NULL DEFAULT FALSE,
  model                text        NOT NULL DEFAULT 'gpt-4o-mini',
  temperature          numeric(3,2) NOT NULL DEFAULT 0.40,
  daily_token_limit    integer     NOT NULL DEFAULT 200000,
  monthly_token_limit  integer     NOT NULL DEFAULT 3000000,
  user_daily_calls     integer     NOT NULL DEFAULT 20,
  price_in_per_m       numeric(8,4) NOT NULL DEFAULT 0.15,  -- USD per 1M input tokens (gpt-4o-mini)
  price_out_per_m      numeric(8,4) NOT NULL DEFAULT 0.60,  -- USD per 1M output tokens
  content              jsonb       NOT NULL DEFAULT '{}',   -- languages, ui_text, general_guidelines (from the JSON)
  updated_by           bigint      REFERENCES users (id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_settings_one_row CHECK (id = 1),
  CONSTRAINT assistant_settings_temp_chk CHECK (temperature BETWEEN 0 AND 1),
  CONSTRAINT assistant_settings_limits_chk CHECK (daily_token_limit >= 0 AND monthly_token_limit >= 0 AND user_daily_calls >= 0)
);
INSERT INTO assistant_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS assistant_settings_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_by  bigint      NOT NULL REFERENCES users (id),
  changes     jsonb       NOT NULL,          -- { field: { from, to } }
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- chat sessions ----------
--   status: OPEN → SOLVED (user said yes) · TICKET (ticket raised) · CLOSED (left without either)
--   matched_by: how the FAQ shown last was found
DO $$ BEGIN
  CREATE TYPE assistant_status AS ENUM ('OPEN', 'SOLVED', 'TICKET', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint           NOT NULL REFERENCES users (id),
  language    text             NOT NULL DEFAULT 'en',
  status      assistant_status NOT NULL DEFAULT 'OPEN',
  first_text  text,
  faq_id      bigint           REFERENCES faqs (id),
  matched_by  text,
  used_gpt    boolean          NOT NULL DEFAULT FALSE,
  request_id  bigint           REFERENCES requests (id),
  created_at  timestamptz      NOT NULL DEFAULT now(),
  updated_at  timestamptz      NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  CONSTRAINT assistant_sessions_lang_chk CHECK (language IN ('en', 'ar', 'hi', 'gu')),
  CONSTRAINT assistant_sessions_match_chk CHECK (matched_by IS NULL OR matched_by IN ('browse', 'choice', 'search', 'gpt'))
);
CREATE INDEX IF NOT EXISTS assistant_sessions_user_idx ON assistant_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assistant_sessions_created_idx ON assistant_sessions (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_sessions_request_uq ON assistant_sessions (request_id) WHERE request_id IS NOT NULL;
DROP TRIGGER IF EXISTS assistant_sessions_set_updated_at ON assistant_sessions;
CREATE TRIGGER assistant_sessions_set_updated_at BEFORE UPDATE ON assistant_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What happened in a session, in order.
--   typed (text) · shown (faq_id, data.via) · choices (data.faqIds) · no_match · gpt (data.callId)
--   gpt_skipped (data.reason) · solved · not_solved · ticket (data.requestId)
CREATE TABLE IF NOT EXISTS assistant_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint      NOT NULL REFERENCES assistant_sessions (id),
  kind        text        NOT NULL,
  text        text,
  faq_id      bigint      REFERENCES faqs (id),
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_events_kind_chk CHECK (kind IN ('typed', 'shown', 'choices', 'no_match', 'gpt', 'gpt_skipped', 'solved', 'not_solved', 'ticket'))
);
CREATE INDEX IF NOT EXISTS assistant_events_session_idx ON assistant_events (session_id, id);
CREATE INDEX IF NOT EXISTS assistant_events_nomatch_idx ON assistant_events (created_at DESC) WHERE kind = 'no_match';

-- ---------- GPT calls (token spend) ----------
CREATE TABLE IF NOT EXISTS assistant_gpt_calls (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id         bigint      REFERENCES assistant_sessions (id),
  user_id            bigint      NOT NULL REFERENCES users (id),
  model              text        NOT NULL,
  status             text        NOT NULL,          -- ok · error
  prompt_tokens      integer     NOT NULL DEFAULT 0,
  completion_tokens  integer     NOT NULL DEFAULT 0,
  total_tokens       integer     NOT NULL DEFAULT 0,
  cost_usd           numeric(12,6) NOT NULL DEFAULT 0,
  latency_ms         integer,
  result             jsonb,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_gpt_calls_status_chk CHECK (status IN ('ok', 'error'))
);
CREATE INDEX IF NOT EXISTS assistant_gpt_calls_created_idx ON assistant_gpt_calls (created_at);
CREATE INDEX IF NOT EXISTS assistant_gpt_calls_user_idx ON assistant_gpt_calls (user_id, created_at);

-- ---------- room occupancy (Phase 8.2) ----------
-- One row per person per seat (room + optional cubicle) in the occupancy sheet. Rows that leave
-- the sheet become inactive (ended_at) — kept as history, never deleted.
-- Assets reach the person through the place: same room_no (and same cubicle, or a whole-room place).
CREATE TABLE IF NOT EXISTS place_occupants (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint      NOT NULL REFERENCES users (id),
  room_no        text        NOT NULL,
  cubicle        text        NOT NULL DEFAULT '',     -- '' = the whole room
  building       text,
  floor          text,
  department     text,
  intercom       text,
  did_no         text,
  sheet_tab      text,
  is_active      boolean     NOT NULL DEFAULT TRUE,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  CONSTRAINT place_occupants_uq UNIQUE (user_id, room_no, cubicle)
);
CREATE INDEX IF NOT EXISTS place_occupants_room_idx ON place_occupants (room_no, cubicle) WHERE is_active;
CREATE INDEX IF NOT EXISTS place_occupants_user_idx ON place_occupants (user_id) WHERE is_active;
