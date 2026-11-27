CREATE TABLE subscriber_deliveries (
  id TEXT PRIMARY KEY,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
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
  UNIQUE (subscriber_id, event_id)
);
CREATE INDEX subscriber_deliveries_pending ON subscriber_deliveries(state, created_at);
