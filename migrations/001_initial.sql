CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['jobs:read', 'jobs:write'],
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_account_idx ON api_keys(account_id);

CREATE TABLE pairing_codes (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE donors (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'online', 'paused', 'revoked')),
  capabilities jsonb,
  policy jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX donors_online_idx ON donors(last_seen_at) WHERE status = 'online';

CREATE TABLE jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  api_key_id text NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  idempotency_key text,
  original_api text NOT NULL CHECK (original_api IN ('chat.completions', 'responses')),
  virtual_model text NOT NULL,
  canonical_request jsonb NOT NULL,
  request_bytes integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'matching', 'leased', 'running', 'retrying', 'succeeded', 'failed', 'expired', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  state_version bigint NOT NULL DEFAULT 1,
  max_wait_at timestamptz NOT NULL,
  result_expires_at timestamptz,
  webhook_url text,
  result jsonb,
  error jsonb,
  deleted_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_result_state CHECK ((status = 'succeeded' AND result IS NOT NULL) OR status <> 'succeeded')
);
CREATE UNIQUE INDEX jobs_idempotency_idx ON jobs(api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX jobs_queue_idx ON jobs(created_at, id) WHERE status IN ('queued', 'retrying');
CREATE INDEX jobs_expiry_idx ON jobs(max_wait_at) WHERE status IN ('queued', 'retrying');
CREATE INDEX jobs_account_idx ON jobs(account_id, created_at DESC);

CREATE TABLE attempts (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  donor_id text NOT NULL REFERENCES donors(id) ON DELETE RESTRICT,
  number integer NOT NULL CHECK (number > 0),
  status text NOT NULL CHECK (status IN ('offered', 'accepted', 'running', 'succeeded', 'failed', 'expired', 'cancelled')),
  failure_code text,
  failure_message text,
  result_hash text,
  committed boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, number)
);
CREATE UNIQUE INDEX attempts_one_commit_idx ON attempts(job_id) WHERE committed;

CREATE TABLE leases (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_id text NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  donor_id text NOT NULL REFERENCES donors(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'expired', 'cancelled', 'failed')),
  expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX leases_one_active_job_idx ON leases(job_id) WHERE status = 'active';
CREATE INDEX leases_expiry_idx ON leases(expires_at) WHERE status = 'active';
CREATE INDEX leases_donor_idx ON leases(donor_id) WHERE status = 'active';

CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_replay_idx ON job_events(job_id, id);

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES job_events(id) ON DELETE CASCADE,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'abandoned')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_due_idx ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';

CREATE TABLE donor_usage (
  donor_id text NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  usage_date date NOT NULL DEFAULT current_date,
  jobs integer NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(donor_id, usage_date)
);
