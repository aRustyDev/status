-- Monitor dependencies use component identities shared by both API profiles.
CREATE TABLE monitor_dependencies (
  dependent_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  PRIMARY KEY (dependent_id, depends_on_id),
  CHECK (dependent_id <> depends_on_id)
);
CREATE INDEX monitor_dependencies_target ON monitor_dependencies(depends_on_id);

-- Evaluate against the graph within the inserting transaction. Concurrent
-- edits therefore cannot both commit opposite edges.
CREATE TRIGGER monitor_dependencies_validate BEFORE INSERT ON monitor_dependencies
BEGIN
  SELECT CASE WHEN NEW.dependent_id = NEW.depends_on_id THEN RAISE(ABORT, 'monitor dependency cycle') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.dependent_id)
    OR NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.depends_on_id)
    OR EXISTS (SELECT 1 FROM gatus_sources WHERE component_id IN (NEW.dependent_id, NEW.depends_on_id))
    THEN RAISE(ABORT, 'invalid monitor dependency') END;
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE reachable(id) AS (
      SELECT NEW.depends_on_id
      UNION
      SELECT d.depends_on_id FROM monitor_dependencies d JOIN reachable r ON d.dependent_id=r.id
    ) SELECT 1 FROM reachable WHERE id=NEW.dependent_id
  ) THEN RAISE(ABORT, 'monitor dependency cycle') END;
END;

CREATE TRIGGER gatus_source_dependency_guard BEFORE INSERT ON gatus_sources
WHEN EXISTS (SELECT 1 FROM monitor_dependencies WHERE dependent_id=NEW.component_id OR depends_on_id=NEW.component_id)
BEGIN
  SELECT RAISE(ABORT, 'Gatus source cannot have monitor dependencies');
END;
CREATE TRIGGER gatus_source_dependency_update_guard BEFORE UPDATE OF component_id ON gatus_sources
WHEN EXISTS (SELECT 1 FROM monitor_dependencies WHERE dependent_id=NEW.component_id OR depends_on_id=NEW.component_id)
BEGIN
  SELECT RAISE(ABORT, 'Gatus source cannot have monitor dependencies');
END;
