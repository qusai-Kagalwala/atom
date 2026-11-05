-- 026_wifi_passes.sql — Jamea Internet Access / Wi-Fi passes (AVIT, decided 5 Nov 2026). Idempotent.
--   The AVIT Admin uploads batches of Wi-Fi accounts made in Cisco ISE (CSV: Username, Password) with an
--   SSID and an expiry, allocates them to departments, and can give them out directly. A department's
--   HOD (Masool, from the Idarah view's post) gives them to people and shares them by WhatsApp / email.
--   At expiry, or on Reset, the batch's usernames, passwords and recipients are DELETED (temporary
--   credentials — the one exception to "never delete"); the batch row keeps only counts.
--   Passwords are never written to logs, notifications or the email queue.

-- Which Idarah posts make someone a department's HOD. Matched case-insensitively against the post and
-- the post category. Editable by the Super Admin.
CREATE TABLE IF NOT EXISTS wifi_settings (
  id          integer     PRIMARY KEY DEFAULT 1,
  hod_posts   text[]      NOT NULL DEFAULT ARRAY['Masool'],
  updated_by  bigint      REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wifi_settings_one_row CHECK (id = 1)
);
INSERT INTO wifi_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS wifi_batches (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  name             text        NOT NULL,
  ssid             text        NOT NULL,
  expires_at       timestamptz NOT NULL,
  total            integer     NOT NULL,
  file_name        text,
  created_by       bigint      NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  ended_reason     text,
  ended_by         bigint      REFERENCES users (id),
  summary          jsonb,      -- counts kept after the passes are deleted
  CONSTRAINT wifi_batches_name_chk CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT wifi_batches_ssid_chk CHECK (char_length(ssid) BETWEEN 1 AND 64),
  CONSTRAINT wifi_batches_end_chk CHECK (ended_reason IS NULL OR ended_reason IN ('expired', 'reset'))
);
CREATE INDEX IF NOT EXISTS wifi_batches_live_idx ON wifi_batches (expires_at) WHERE ended_at IS NULL;

-- One row per Wi-Fi account. department_id = allocated to that department; recipient_* = given to a person.
CREATE TABLE IF NOT EXISTS wifi_passes (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id            bigint      NOT NULL REFERENCES wifi_batches (id),
  username            text        NOT NULL,
  password            text        NOT NULL,
  department_id       bigint      REFERENCES departments (id),
  allocated_at        timestamptz,
  assigned_at         timestamptz,
  assigned_by         bigint      REFERENCES users (id),
  assigned_via        text,       -- 'department' (HOD) or 'admin' (AVIT Admin directly)
  recipient_its       text,
  recipient_name      text,
  recipient_mobile    text,
  recipient_email     text,
  shared_whatsapp_at  timestamptz,
  shared_email_at     timestamptz,
  CONSTRAINT wifi_passes_via_chk CHECK (assigned_via IS NULL OR assigned_via IN ('department', 'admin'))
);
CREATE UNIQUE INDEX IF NOT EXISTS wifi_passes_batch_user_uq ON wifi_passes (batch_id, lower(username));
CREATE INDEX IF NOT EXISTS wifi_passes_dept_idx ON wifi_passes (batch_id, department_id);

-- HOD asks the AVIT Admin for more passes.
CREATE TABLE IF NOT EXISTS wifi_requests (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  department_id    bigint      NOT NULL REFERENCES departments (id),
  requested_by     bigint      NOT NULL REFERENCES users (id),
  count            integer     NOT NULL,
  reason           text        NOT NULL,
  status           text        NOT NULL DEFAULT 'open',
  decided_by       bigint      REFERENCES users (id),
  decided_at       timestamptz,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wifi_requests_count_chk CHECK (count BETWEEN 1 AND 10000),
  CONSTRAINT wifi_requests_status_chk CHECK (status IN ('open', 'done', 'declined'))
);
CREATE INDEX IF NOT EXISTS wifi_requests_open_idx ON wifi_requests (service_unit_id, status, created_at);

-- Who did what. Never holds a username or password.
CREATE TABLE IF NOT EXISTS wifi_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id       bigint      REFERENCES wifi_batches (id),
  kind           text        NOT NULL,
  actor_id       bigint      REFERENCES users (id),
  department_id  bigint      REFERENCES departments (id),
  count          integer,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wifi_log_kind_chk CHECK (kind IN ('upload', 'allocate', 'take_back', 'assign', 'unassign', 'share_whatsapp',
                                               'share_email', 'expired', 'reset', 'request', 'request_done', 'request_declined', 'settings'))
);
CREATE INDEX IF NOT EXISTS wifi_log_batch_idx ON wifi_log (batch_id, created_at DESC);
