-- Rows are provisioned from a reviewed Gatus catalog. Shadow components keep
-- stable aliases and support incident and maintenance associations.
CREATE TABLE gatus_sources (
  source_id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL UNIQUE REFERENCES components(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('endpoint','suite')),
  source_key TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_group TEXT NOT NULL DEFAULT '',
  stale_after_seconds INTEGER NOT NULL CHECK (stale_after_seconds BETWEEN 1 AND 604800),
  advisory INTEGER NOT NULL DEFAULT 0 CHECK (advisory IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (kind, source_key),
  UNIQUE (kind, source_group, source_name)
);

-- Guard write races as well as direct calls through either API contract.
CREATE TRIGGER gatus_component_update_guard BEFORE UPDATE ON components
WHEN EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Gatus-managed component is read-only');
END;
CREATE TRIGGER gatus_component_delete_guard BEFORE DELETE ON components
WHEN EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Gatus-managed component is read-only');
END;
CREATE TRIGGER gatus_check_insert_guard BEFORE INSERT ON http_checks
WHEN EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=NEW.component_id)
BEGIN
  SELECT RAISE(ABORT, 'Gatus-managed component is read-only');
END;
CREATE TRIGGER gatus_check_update_guard BEFORE UPDATE ON http_checks
WHEN EXISTS (SELECT 1 FROM gatus_sources WHERE component_id IN (OLD.component_id, NEW.component_id))
BEGIN
  SELECT RAISE(ABORT, 'Gatus-managed component is read-only');
END;
CREATE TRIGGER gatus_source_check_guard BEFORE INSERT ON gatus_sources
WHEN EXISTS (SELECT 1 FROM http_checks WHERE component_id=NEW.component_id)
BEGIN
  SELECT RAISE(ABORT, 'Gatus source cannot own a native check');
END;
CREATE TRIGGER gatus_source_component_guard BEFORE UPDATE OF component_id ON gatus_sources
WHEN NEW.component_id<>OLD.component_id
BEGIN
  SELECT RAISE(ABORT, 'Gatus source component cannot be reassigned');
END;
-- Retain existing historical links, but never add a newly inactive source.
CREATE TRIGGER gatus_inactive_incident_guard BEFORE INSERT ON incident_components
WHEN EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=NEW.component_id AND active=0)
BEGIN
  SELECT RAISE(ABORT, 'Inactive Gatus source cannot be associated');
END;
CREATE TRIGGER gatus_inactive_maintenance_guard BEFORE INSERT ON maintenance_components
WHEN EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=NEW.component_id AND active=0)
BEGIN
  SELECT RAISE(ABORT, 'Inactive Gatus source cannot be associated');
END;
