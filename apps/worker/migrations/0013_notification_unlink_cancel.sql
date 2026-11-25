-- Association revisions fence channel edits/deletions, including monitors without checks.
ALTER TABLE notification_channels ADD COLUMN association_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER monitor_alert_revision_insert AFTER INSERT ON monitor_notification_channels
BEGIN
  UPDATE notification_channels SET association_version=association_version+1 WHERE id=NEW.channel_id;
END;
CREATE TRIGGER monitor_alert_revision_delete AFTER DELETE ON monitor_notification_channels
BEGIN
  UPDATE notification_channels SET association_version=association_version+1 WHERE id=OLD.channel_id;
END;
-- An unlinked monitor must not revive old pending deliveries or inherit an old outage on re-link.
CREATE TRIGGER notification_check_unlink_cancel AFTER DELETE ON notification_channel_checks
BEGIN
  UPDATE notification_outbox SET state='failed',error_code='unavailable',lease_token=NULL,lease_until=NULL,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
    WHERE channel_id=OLD.channel_id AND check_id=OLD.check_id AND state IN ('pending','sending');
  DELETE FROM notification_delivery_state WHERE channel_id=OLD.channel_id AND check_id=OLD.check_id;
END;
