-- Preserve each raw probe result separately from its dependency-derived status.
ALTER TABLE http_checks ADD COLUMN dependency_affected INTEGER NOT NULL DEFAULT 0 CHECK (dependency_affected IN (0, 1));
ALTER TABLE http_checks ADD COLUMN dependency_causes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dependency_causes));
ALTER TABLE http_checks ADD COLUMN dependency_scheduled_at INTEGER;
ALTER TABLE http_check_results ADD COLUMN dependency_affected INTEGER NOT NULL DEFAULT 0 CHECK (dependency_affected IN (0, 1));
ALTER TABLE http_check_results ADD COLUMN dependency_causes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dependency_causes));

-- Notifications and actions have different status semantics. Preserve the
-- previous generation so already queued events remain valid after migration.
CREATE TABLE notification_transition_state (
  check_id TEXT PRIMARY KEY REFERENCES http_checks(id) ON DELETE CASCADE,
  check_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up','degraded','down','affected')),
  generation INTEGER NOT NULL DEFAULT 0
);
INSERT INTO notification_transition_state (check_id, check_version, status, generation)
  SELECT check_id, check_version, status, generation FROM automation_transition_state;
