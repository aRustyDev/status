-- Channel destinations are deployment-approved; credentials stay in the Vault.
CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  endpoint_id TEXT NOT NULL,
  endpoint_fingerprint TEXT NOT NULL,
  vault_id INTEGER NOT NULL,
  secret_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  mutation_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE notification_channel_checks (
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL REFERENCES http_checks(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, check_id)
);
-- An outbox row contains IDs and status only, never a credential or destination URL.
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  channel_version INTEGER NOT NULL,
  check_id TEXT NOT NULL REFERENCES http_checks(id) ON DELETE CASCADE,
  check_version INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up','degraded','down')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (channel_id, check_id, scheduled_at)
);
CREATE INDEX notification_outbox_pending ON notification_outbox(state, lease_until, created_at);
