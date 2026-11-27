-- Preview subscriptions are isolated by the hash of the current slot lease.
-- Baseline subscription tables and their existing constraints are unchanged.
CREATE TABLE preview_subscriber_leases (
  scope TEXT PRIMARY KEY,
  slot INTEGER NOT NULL UNIQUE CHECK (slot BETWEEN 1 AND 6),
  target TEXT NOT NULL CHECK (target IN ('a','b')),
  release TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE preview_subscription_settings (
  scope TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  allow_email INTEGER NOT NULL DEFAULT 0,
  allowed_events TEXT NOT NULL DEFAULT '["incident.created","incident.updated","incident.resolved","maintenance.scheduled"]',
  allow_component_scope INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE preview_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'unsubscribed')),
  events TEXT NOT NULL,
  monitor_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  last_notified_at INTEGER,
  last_error TEXT,
  confirmation_hash TEXT,
  confirmation_expires_at INTEGER,
  confirmation_sent_at INTEGER,
  UNIQUE (scope, user_id)
);
CREATE INDEX preview_subscribers_scope_status ON preview_subscribers(scope, status, id);

CREATE TABLE preview_subscriber_deliveries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  subscriber_id INTEGER NOT NULL REFERENCES preview_subscribers(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  component_ids TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','delivered','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE (scope, subscriber_id, event_id)
);
CREATE INDEX preview_subscriber_deliveries_pending ON preview_subscriber_deliveries(scope, state, created_at);
