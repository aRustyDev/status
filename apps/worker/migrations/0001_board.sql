PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'operator', 'admin')),
  version INTEGER NOT NULL DEFAULT 1, mutation_key TEXT, UNIQUE (issuer, subject)
);
CREATE TABLE components (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  manual_status TEXT NOT NULL DEFAULT 'operational' CHECK (manual_status IN ('operational', 'degraded', 'down')),
  version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, mutation_key TEXT
);
CREATE TABLE incidents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('investigating','identified','monitoring','resolved')),
  impact TEXT NOT NULL CHECK (impact IN ('minor','major','critical')), draft INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1, mutation_key TEXT
);
CREATE TABLE incident_updates (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  body TEXT NOT NULL, status TEXT NOT NULL, posted_at INTEGER NOT NULL
);
CREATE TABLE incident_components (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  component_id TEXT NOT NULL REFERENCES components(id), PRIMARY KEY (incident_id, component_id)
);
CREATE TABLE maintenance (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, mutation_key TEXT, CHECK (ends_at > starts_at)
);
CREATE TABLE maintenance_components (
  maintenance_id TEXT NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
  component_id TEXT NOT NULL REFERENCES components(id), PRIMARY KEY (maintenance_id, component_id)
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, action TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL, details TEXT NOT NULL
);
CREATE INDEX incident_updates_incident ON incident_updates(incident_id, posted_at);
CREATE INDEX audit_events_created ON audit_events(created_at DESC);
