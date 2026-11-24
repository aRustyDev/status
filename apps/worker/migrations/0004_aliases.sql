CREATE TABLE entity_aliases (
  alias INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  UNIQUE (entity_type, entity_id)
);

INSERT INTO entity_aliases (entity_type, entity_id) SELECT 'component', id FROM components ORDER BY rowid;
INSERT INTO entity_aliases (entity_type, entity_id) SELECT 'incident', id FROM incidents ORDER BY rowid;
INSERT INTO entity_aliases (entity_type, entity_id) SELECT 'update', id FROM incident_updates ORDER BY rowid;
INSERT INTO entity_aliases (entity_type, entity_id) SELECT 'maintenance', id FROM maintenance ORDER BY rowid;
INSERT INTO entity_aliases (entity_type, entity_id) SELECT 'user', id FROM users ORDER BY rowid;

CREATE TRIGGER alias_component AFTER INSERT ON components BEGIN
  INSERT INTO entity_aliases (entity_type, entity_id) VALUES ('component', NEW.id);
END;
CREATE TRIGGER alias_incident AFTER INSERT ON incidents BEGIN
  INSERT INTO entity_aliases (entity_type, entity_id) VALUES ('incident', NEW.id);
END;
CREATE TRIGGER alias_update AFTER INSERT ON incident_updates BEGIN
  INSERT INTO entity_aliases (entity_type, entity_id) VALUES ('update', NEW.id);
END;
CREATE TRIGGER alias_maintenance AFTER INSERT ON maintenance BEGIN
  INSERT INTO entity_aliases (entity_type, entity_id) VALUES ('maintenance', NEW.id);
END;
CREATE TRIGGER alias_user AFTER INSERT ON users BEGIN
  INSERT INTO entity_aliases (entity_type, entity_id) VALUES ('user', NEW.id);
END;
