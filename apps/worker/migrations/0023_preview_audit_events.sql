-- Preview audit entries are isolated per lease; the baseline audit remains intact.
CREATE TABLE preview_audit_events (
  id TEXT PRIMARY KEY,
  preview_scope TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  details TEXT NOT NULL
);
CREATE INDEX preview_audit_events_scope_created ON preview_audit_events(preview_scope, created_at DESC);

-- Incidents and maintenance are shared resources. The original baseline
-- reader cannot show preview metadata, so expose an explicitly tagged copy
-- atomically without exposing subscriber-only audit records.
CREATE TRIGGER preview_shared_audit AFTER INSERT ON preview_audit_events
WHEN NEW.entity_type IN ('incident','maintenance')
BEGIN
  INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details,preview_scope)
  VALUES (NEW.id,NEW.actor_email,NEW.action,
    'preview_' || COALESCE((SELECT 'slot_' || slot FROM preview_subscriber_leases WHERE scope=NEW.preview_scope), 'unknown') || '_' || NEW.entity_type,
    NEW.entity_id,NEW.created_at,NEW.details,NEW.preview_scope);
END;
