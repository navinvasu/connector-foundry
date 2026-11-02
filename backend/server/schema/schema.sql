-- Connector Foundry — complete database schema (PostgreSQL 16).
--
-- This is the ONLY schema file. No database has ever been deployed, so the
-- incremental migration history (formerly migrations/001–019) was squashed
-- into this final-state DDL on 2026-10-26: every table below is written as
-- it exists after all of those changes, with no ALTER/backfill steps.
-- The server applies this file on boot (src/db.ts `applySchema`); it is
-- idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING) and safe to re-run.
-- Once any environment holds real data, schema changes must ship as
-- migrations again — do not edit deployed shapes in place.
--
-- Local:  docker compose up -d        (projects/connector-foundry/backend)
-- Hosted: same DDL against the lite stack's Postgres; only DATABASE_URL changes.

-- ─── Plans (packaging as data) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,                       -- 'trial' | 'starter' | 'growth' | 'scale'
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  name TEXT NOT NULL,
  seat_cap INT NOT NULL,                     -- max active+invited users
  project_cap INT NOT NULL,                  -- max projects; -1 = unlimited
  telemetry_retention_days INT NOT NULL,
  is_trial BOOLEAN NOT NULL DEFAULT FALSE,
  trial_duration_days INT,                   -- set only on trial plans
  status TEXT NOT NULL DEFAULT 'active',     -- active | retired
  stripe_price_id TEXT UNIQUE,               -- NULL until prices are created in Stripe
  price_display TEXT,                        -- human price for the console; NULL until pricing lands
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reference data: the four packages. DO NOTHING so a re-run never overwrites
-- an operator's edits to caps.
INSERT INTO plans (id, name, seat_cap, project_cap, telemetry_retention_days, is_trial, trial_duration_days) VALUES
  ('trial',   'Trial',   3,  2,  30, TRUE,  14),
  ('starter', 'Starter', 3,  5,  90, FALSE, NULL),
  ('growth',  'Growth', 10, 25, 180, FALSE, NULL),
  ('scale',   'Scale',  25, -1, 365, FALSE, NULL)
ON CONFLICT (id) DO NOTHING;

-- ─── Customers, users, memberships ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  plan_id TEXT NOT NULL REFERENCES plans(id) DEFAULT 'trial',
  status TEXT NOT NULL DEFAULT 'trialing',
  -- trialing | active | trial_expired | suspended | past_due | restricted
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  billing_email TEXT,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  past_due_since TIMESTAMPTZ,
  payment_failed_count INT NOT NULL DEFAULT 0,
  last_payment_failed_at TIMESTAMPTZ,
  seat_override INT CONSTRAINT customers_seat_override_check CHECK (seat_override IS NULL OR seat_override >= 1),
  seat_override_reason TEXT,
  seat_override_by TEXT,
  seat_override_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_plan ON customers(plan_id);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  cognito_sub TEXT UNIQUE,                   -- NULL until first Cognito login
  email TEXT NOT NULL,
  full_name TEXT,
  is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active',     -- active | suspended
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users(lower(email));

-- Memberships + invites. Only the SHA-256 hash of an invite token is stored;
-- the plaintext exists solely in the invite email / create response.
CREATE TABLE IF NOT EXISTS customer_users (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer',       -- owner | editor | viewer
  status TEXT NOT NULL DEFAULT 'invited',    -- invited | active | suspended
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  invite_token_hash TEXT,
  invite_expires_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_users_customer ON customer_users(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_users_user ON customer_users(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_users_invite_token_hash
  ON customer_users(invite_token_hash) WHERE invite_token_hash IS NOT NULL;

-- ─── Projects and imported sources ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'starter',
  status TEXT NOT NULL DEFAULT 'active',
  owner_user_id TEXT,
  targets JSONB NOT NULL DEFAULT '["mcp", "openai"]',
  capture_prompts BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects(customer_id);

CREATE TABLE IF NOT EXISTS api_sources (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  location TEXT NOT NULL,
  spec_hash TEXT,
  spec_body JSONB,                 -- immutable imported spec snapshot; compile reads this
  fetch_status TEXT NOT NULL DEFAULT 'pending',
  fetch_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_sources_project ON api_sources(project_id);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES api_sources(id) ON DELETE CASCADE,
  http_method TEXT NOT NULL,
  path TEXT NOT NULL,
  operation_id TEXT,
  summary TEXT,
  base_url TEXT,
  spec_hash TEXT,
  status TEXT NOT NULL DEFAULT 'imported',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_operations_project ON operations(project_id);
-- Dedupe: one operation per method+path per project. Imports and compiles
-- are append-only by design (audit trail of sources), so re-importing the
-- same spec must be a no-op — the write sites use ON CONFLICT DO NOTHING
-- against this index. (Same path on two different upstream APIs in one
-- project would collide; split those into two projects.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_operations_project_method_path
  ON operations(project_id, http_method, path);

-- ─── Canonical tools and review ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS canonical_tools (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  purpose TEXT,
  eligible_use TEXT,
  ineligible_use TEXT,
  input_schema JSONB NOT NULL,
  output_schema JSONB,
  pagination JSONB,
  upstream JSONB NOT NULL,         -- method, path_template, param mapping, base_url
  effect_classes JSONB NOT NULL DEFAULT '["read_only"]',
  confirmation_required BOOLEAN NOT NULL DEFAULT false,
  idempotent BOOLEAN NOT NULL DEFAULT false,
  idempotency_key_source TEXT,
  retry_policy JSONB,
  credential_mode TEXT,            -- none | api_key | oauth2 | basic
  required_scopes JSONB,
  token_lifecycle JSONB,
  provenance JSONB NOT NULL DEFAULT '[]',
  confidence INTEGER,              -- 0-100
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_canonical_tools_project ON canonical_tools(project_id);
-- Dedupe: one tool per name per project. Tool names derive deterministically
-- from the operation, so every re-compile of the same spec collides here and
-- the compile write site skips it (ON CONFLICT DO NOTHING) instead of
-- appending a 2nd..Nth draft row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_canonical_tools_project_name
  ON canonical_tools(project_id, name);

CREATE TABLE IF NOT EXISTS tool_recovery_rules (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES canonical_tools(id) ON DELETE CASCADE,
  tool_version INTEGER NOT NULL,
  condition TEXT NOT NULL,
  detection_rule JSONB NOT NULL,
  behavior TEXT NOT NULL,          -- auto_recover | retry_changed | escalate_user | terminal
  recovery_action TEXT,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  backoff_ms INTEGER NOT NULL DEFAULT 0,
  user_message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tool_id, tool_version, condition)
);
CREATE INDEX IF NOT EXISTS idx_recovery_rules_tool ON tool_recovery_rules(tool_id);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_id TEXT REFERENCES canonical_tools(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence JSONB NOT NULL,
  recommendation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_review_items_project ON review_items(project_id);
-- Dedupe: the same warning must appear once. Re-imports and re-evals that
-- raise an already-open item collide here; the write sites use ON CONFLICT
-- DO NOTHING. Answered items leave the open set, so a genuinely recurring
-- issue can be raised again after the previous one is resolved/acknowledged.
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_items_open
  ON review_items(project_id, kind, title) WHERE status = 'open';

-- ─── Evaluation ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_id TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  summary JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_project ON eval_runs(project_id);

CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  eval_run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  tool_id TEXT,
  suite TEXT NOT NULL,             -- contract | behavior | auth | resilience | custom | safety
  scenario TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  latency_ms INTEGER,
  detail JSONB,                    -- redacted
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(eval_run_id);

CREATE TABLE IF NOT EXISTS eval_custom_scenarios (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL REFERENCES canonical_tools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  given_args JSONB NOT NULL DEFAULT '{}'::jsonb,
  expect_status INTEGER CHECK (expect_status IS NULL OR (expect_status >= 100 AND expect_status <= 599)),
  expect_body_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS eval_custom_scenarios_tool_name_idx
  ON eval_custom_scenarios (tool_id, name);
CREATE INDEX IF NOT EXISTS eval_custom_scenarios_tool_idx
  ON eval_custom_scenarios (tool_id, enabled, created_at);
CREATE INDEX IF NOT EXISTS eval_custom_scenarios_project_idx
  ON eval_custom_scenarios (project_id);

-- Agent task suite (EV-08): natural-language tasks scored per eval run.
CREATE TABLE IF NOT EXISTS eval_agent_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  expected_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  answer_rubric TEXT,
  source TEXT NOT NULL DEFAULT 'owner',                -- owner | llm
  status TEXT NOT NULL DEFAULT 'proposed',             -- proposed | approved | rejected
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_project ON eval_agent_tasks(project_id, status);

CREATE TABLE IF NOT EXISTS eval_agent_results (
  id TEXT PRIMARY KEY,
  eval_run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  checks JSONB NOT NULL,
  steps INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  wrong_tool_calls INTEGER NOT NULL,
  failed_calls INTEGER NOT NULL,
  invalid_arg_calls INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  transcript JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_results_run ON eval_agent_results(eval_run_id);

-- Fix suggestions (HK-09): model-proposed tool-text edits, human-decided.
CREATE TABLE IF NOT EXISTS fix_suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_id TEXT REFERENCES canonical_tools(id) ON DELETE CASCADE,
  field TEXT NOT NULL,          -- description | eligible_use | ineligible_use | param_description
  param TEXT,
  before_text TEXT,
  after_text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'proposed',   -- proposed | accepted | rejected | superseded
  model TEXT,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fix_suggestions_project ON fix_suggestions(project_id, status);

-- ─── Releases ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  bundle_s3_key TEXT,
  bundle_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT 'mcp+openai',
  status TEXT NOT NULL DEFAULT 'draft',
  channel TEXT NOT NULL DEFAULT 'staging' CONSTRAINT releases_channel_check CHECK (channel IN ('staging', 'prod')),
  promoted_at TIMESTAMPTZ,
  promoted_by TEXT,
  deprecated_at TIMESTAMPTZ,
  deprecated_by TEXT,
  deprecate_reason TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  manifest JSONB NOT NULL,         -- the rendered release manifest (MCP + OpenAI artifacts)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_releases_project ON releases(project_id);
CREATE INDEX IF NOT EXISTS idx_releases_project_channel ON releases(project_id, channel, created_at DESC);

CREATE TABLE IF NOT EXISTS release_tools (
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  tool_version INTEGER NOT NULL,
  tool_snapshot JSONB NOT NULL,    -- frozen tool definition
  PRIMARY KEY (release_id, tool_id)
);

-- ─── Jobs, billing events, audit ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- compile | eval | drift
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | succeeded | failed | cancelled
  payload JSONB NOT NULL DEFAULT '{}',
  progress JSONB,
  result JSONB,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  locked_by TEXT,
  locked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,                       -- Stripe evt_... id
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  type TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_project ON audit_events(project_id);

-- ─── Credentials vault handles and gateway keys (never secret material) ────
-- vault_handle is an opaque KMS-envelope locator; key material lives only in
-- the vault and in request-scoped memory. One active credential per kind.
CREATE TABLE IF NOT EXISTS project_credentials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'api_key' CHECK (kind IN ('api_key')),
  vault_handle TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS project_credentials_one_active_per_kind
  ON project_credentials (project_id, kind) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS project_credentials_project_idx
  ON project_credentials (project_id);

-- Gateway keys: only the display prefix + SHA-256 hash of the secret are
-- stored; the secret is shown once at create. Soft revoke keeps the audit row.
CREATE TABLE IF NOT EXISTS project_api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS project_api_keys_hash_idx
  ON project_api_keys (key_hash);
CREATE INDEX IF NOT EXISTS project_api_keys_project_idx
  ON project_api_keys (project_id);

-- ─── Telemetry, MCP sessions, drift ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  release_id TEXT,
  tool_id TEXT,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,            -- ok | upstream_error | policy_blocked
  latency_ms INTEGER NOT NULL,
  prompt_ref TEXT,                 -- opaque caller reference (no PII)
  actor TEXT,                      -- api-key:<prefix> for gateway-key invokes; NULL for humans
  channel TEXT,                    -- mcp | openai_actions | rest | playground
  client TEXT,
  trigger TEXT,                    -- user_prompt | agent_followup | automated | unknown
  trigger_source TEXT,             -- declared | inferred
  session_id TEXT,
  turn_id TEXT,
  prompt_text TEXT,                -- redacted; only when the project opts in (capture_prompts)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_project_time ON telemetry_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_session_time ON telemetry_events(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_name TEXT,
  client_version TEXT,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_project ON mcp_sessions(project_id);

CREATE TABLE IF NOT EXISTS drift_checks (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_id TEXT REFERENCES releases(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'schedule', -- schedule | manual
  status TEXT NOT NULL DEFAULT 'running',   -- running | succeeded | failed
  summary JSONB,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_drift_checks_project ON drift_checks (project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS drift_alerts (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'connector-foundry',
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_id TEXT REFERENCES releases(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | resolved
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  evidence JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_project ON drift_alerts (project_id, status, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_drift_alerts_open
  ON drift_alerts (project_id, tool_id) WHERE status = 'open';
