-- Baseline readers filter on the original entity type and display entity_id.
-- Label shared changes there while retaining the separate scoped audit record.
-- Existing tagged entries remain unchanged and visible in unfiltered logs.
DROP TRIGGER preview_shared_audit;
CREATE TRIGGER preview_shared_audit AFTER INSERT ON preview_audit_events
WHEN NEW.entity_type IN ('incident', 'maintenance')
BEGIN
  INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details,preview_scope)
  VALUES (NEW.id,NEW.actor_email,NEW.action,NEW.entity_type,
    'preview_' || COALESCE((SELECT 'slot_' || slot FROM preview_subscriber_leases WHERE scope=NEW.preview_scope), 'unknown') || ':' || NEW.entity_id,
    NEW.created_at,NEW.details,NEW.preview_scope);
END;
