-- Keep channel edits representable even when monitors have no check yet.
-- Existing oversized channels remain intact and can be reduced by an admin.
CREATE TRIGGER monitor_alert_channel_limit BEFORE INSERT ON monitor_notification_channels
WHEN NOT EXISTS (SELECT 1 FROM monitor_notification_channels WHERE component_id=NEW.component_id AND channel_id=NEW.channel_id)
  AND (SELECT COUNT(*) FROM monitor_notification_channels WHERE channel_id=NEW.channel_id) >= 20
BEGIN
  SELECT RAISE(ABORT, 'notification channel monitor limit reached');
END;
