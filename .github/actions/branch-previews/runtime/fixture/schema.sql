-- Applied only to a controller-owned preview database, never a shared database.
CREATE TABLE IF NOT EXISTS preview_fixture_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  monitor_status TEXT NOT NULL CHECK (monitor_status IN ('up', 'down'))
);
INSERT OR IGNORE INTO preview_fixture_control (id, monitor_status) VALUES (1, 'up');

CREATE TABLE IF NOT EXISTS preview_fixture_receipts (
  key_hash TEXT NOT NULL PRIMARY KEY,
  destination TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up', 'down', 'degraded')),
  scheduled_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
