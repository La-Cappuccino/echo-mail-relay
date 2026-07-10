-- echo-mail-relay schema v0 (SPEC-echo-mail-relay.md D3/D4)

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,               -- e.g. 'rnb-vault'
  display_name  TEXT NOT NULL,
  from_email    TEXT NOT NULL,                  -- e.g. 'noreply@rnbvault.no'
  from_name     TEXT NOT NULL,                  -- e.g. 'RnB Vault'
  domain        TEXT NOT NULL,                  -- sending domain, must be Brevo-verified
  api_key_hash  TEXT NOT NULL UNIQUE,           -- sha256 hex of the project's bearer key
  -- Tiered kill-switch (D4): marketing is toggleable; transactional only stops on hard_off
  marketing_enabled BOOLEAN NOT NULL DEFAULT true,
  hard_off      BOOLEAN NOT NULL DEFAULT false, -- decommission switch; blocks EVERYTHING
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sends (
  id             BIGSERIAL PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  tier           TEXT NOT NULL CHECK (tier IN ('transactional','marketing')),
  template       TEXT,                          -- reserved for slice-2 relay-side templates
  recipient      TEXT NOT NULL,
  subject        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('sent','suppressed','failed')),
  suppress_reason TEXT,                         -- 'marketing_disabled' | 'hard_off'
  brevo_message_id TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sends_project_created_idx ON sends (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sends_status_idx ON sends (status, created_at DESC);
