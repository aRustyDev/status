CREATE TABLE subscription_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  allow_email INTEGER NOT NULL DEFAULT 0,
  allowed_events TEXT NOT NULL DEFAULT '["incident.created","incident.updated","incident.resolved","maintenance.scheduled"]',
  allow_component_scope INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO subscription_settings (id) VALUES (1);

CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
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
  confirmation_sent_at INTEGER
);
CREATE INDEX subscribers_status_idx ON subscribers(status, id);
