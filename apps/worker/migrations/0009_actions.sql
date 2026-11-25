-- Actions target deployment-approved destinations and reference Vault values only.
CREATE TABLE worker_actions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  endpoint_id TEXT NOT NULL, endpoint_fingerprint TEXT NOT NULL,
  vault_id INTEGER NOT NULL, secret_id INTEGER NOT NULL,
  trigger_status TEXT NOT NULL CHECK (trigger_status IN ('up','degraded','down','all')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1, mutation_key TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE worker_action_checks (
  action_id TEXT NOT NULL REFERENCES worker_actions(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL REFERENCES http_checks(id) ON DELETE CASCADE,
  PRIMARY KEY (action_id,check_id)
);
-- Never store destination URLs, request headers or resolved credentials in jobs.
CREATE TABLE worker_action_outbox (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES worker_actions(id) ON DELETE CASCADE,
  action_version INTEGER NOT NULL, check_id TEXT NOT NULL REFERENCES http_checks(id) ON DELETE CASCADE,
  check_version INTEGER NOT NULL, scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up','degraded','down')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','executing','completed','unavailable','uncertain')),
  claimed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(action_id,check_id,scheduled_at)
);
CREATE INDEX worker_action_outbox_pending ON worker_action_outbox(state,created_at);
