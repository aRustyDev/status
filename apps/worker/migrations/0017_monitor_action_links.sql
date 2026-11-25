-- Per-monitor action policies override the legacy action-level trigger for that pair.
CREATE TABLE monitor_action_revisions (
  component_id TEXT PRIMARY KEY REFERENCES components(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0, mutation_key TEXT
);
CREATE TABLE monitor_action_links (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL REFERENCES worker_actions(id) ON DELETE CASCADE,
  on_status TEXT NOT NULL CHECK (on_status IN ('up','down','degraded')),
  delay_minutes INTEGER NOT NULL CHECK (delay_minutes BETWEEN 0 AND 10080),
  cooldown_minutes INTEGER NOT NULL CHECK (cooldown_minutes BETWEEN 0 AND 10080),
  UNIQUE(component_id,action_id,on_status)
);
CREATE TABLE monitor_action_cooldowns (
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL REFERENCES worker_actions(id) ON DELETE CASCADE,
  on_status TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  reservation_id TEXT NOT NULL,
  PRIMARY KEY (component_id,action_id,on_status)
);
ALTER TABLE worker_action_outbox ADD COLUMN due_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worker_action_outbox ADD COLUMN link_id TEXT;
ALTER TABLE worker_action_outbox ADD COLUMN cooldown_minutes INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER monitor_action_gatus_guard BEFORE INSERT ON monitor_action_links
WHEN EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=NEW.component_id)
BEGIN SELECT RAISE(ABORT,'Gatus-managed component is read-only'); END;
CREATE TRIGGER gatus_source_action_guard BEFORE INSERT ON gatus_sources
WHEN EXISTS (SELECT 1 FROM monitor_action_links WHERE component_id=NEW.component_id) OR EXISTS (SELECT 1 FROM worker_action_checks ac JOIN http_checks h ON h.id=ac.check_id WHERE h.component_id=NEW.component_id)
BEGIN SELECT RAISE(ABORT,'Gatus source cannot own actions'); END;
