-- 013_assistant_learned.sql — saved GPT answers + dismissed questions (Phase 12 update, 27 Oct 2026).
-- Idempotent: safe to run again.
--   Order in the chat: FAQ match → saved GPT answer → GPT.
--   match_key = the question's important words (stemmed, no filler words), sorted, so
--   "hall printer not working" and "printer not working in hall" share one saved answer.

CREATE TABLE IF NOT EXISTS assistant_learned (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_key        text        NOT NULL,
  sample_text      text        NOT NULL,                -- the question as first asked
  language         text        NOT NULL DEFAULT 'en',
  faq_ids          bigint[]    NOT NULL DEFAULT '{}',   -- empty = GPT found no FAQ
  suggestion       jsonb,                               -- { category, categoryId, priority, title }
  source_call_id   bigint      REFERENCES assistant_gpt_calls (id),
  hits             integer     NOT NULL DEFAULT 0,      -- times reused instead of calling GPT
  last_used_at     timestamptz,
  is_active        boolean     NOT NULL DEFAULT TRUE,   -- switched off = ask GPT again next time
  changed_by       bigint      REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_learned_key_uq UNIQUE (match_key)
);
DROP TRIGGER IF EXISTS assistant_learned_set_updated_at ON assistant_learned;
CREATE TRIGGER assistant_learned_set_updated_at BEFORE UPDATE ON assistant_learned FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- "Questions with no FAQ" the Super Admin dismissed (junk such as "hi", "test").
CREATE TABLE IF NOT EXISTS assistant_dismissed (
  match_key     text        PRIMARY KEY,
  dismissed_by  bigint      REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE assistant_events DROP CONSTRAINT IF EXISTS assistant_events_kind_chk;
ALTER TABLE assistant_events ADD CONSTRAINT assistant_events_kind_chk
  CHECK (kind IN ('typed', 'shown', 'choices', 'no_match', 'gpt', 'gpt_skipped', 'learned', 'solved', 'not_solved', 'ticket'));

ALTER TABLE assistant_sessions DROP CONSTRAINT IF EXISTS assistant_sessions_match_chk;
ALTER TABLE assistant_sessions ADD CONSTRAINT assistant_sessions_match_chk
  CHECK (matched_by IS NULL OR matched_by IN ('browse', 'choice', 'search', 'learned', 'gpt'));
