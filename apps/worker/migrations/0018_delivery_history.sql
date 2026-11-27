ALTER TABLE notification_outbox ADD COLUMN manual_retry INTEGER NOT NULL DEFAULT 0 CHECK (manual_retry IN (0,1));

CREATE TABLE notification_attempts (
  delivery_id TEXT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('sent','delivery_failed','unavailable')),
  PRIMARY KEY (delivery_id, attempt_number)
);

CREATE TABLE notification_test_deliveries (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  channel_version INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('sent','delivery_failed','unavailable')),
  created_at INTEGER NOT NULL
);
CREATE INDEX notification_test_deliveries_created ON notification_test_deliveries(created_at);
