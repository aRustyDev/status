-- Monitors may choose channels before a native HTTP check is configured.
-- Keep the existing check links in sync for channel management and delivery.
CREATE TABLE monitor_notification_channels (
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  PRIMARY KEY (component_id, channel_id)
);
-- A check move changes the physical delivery link, not either monitor's selection.
CREATE TABLE monitor_alert_check_moves (check_id TEXT PRIMARY KEY);
INSERT INTO monitor_notification_channels (component_id, channel_id)
  SELECT h.component_id, cc.channel_id FROM notification_channel_checks cc JOIN http_checks h ON h.id=cc.check_id;

CREATE TRIGGER monitor_alert_gatus_guard BEFORE INSERT ON monitor_notification_channels
WHEN EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=NEW.component_id)
BEGIN
  SELECT RAISE(ABORT, 'Gatus-managed component is read-only');
END;
CREATE TRIGGER gatus_source_alert_guard BEFORE INSERT ON gatus_sources
WHEN EXISTS (SELECT 1 FROM monitor_notification_channels WHERE component_id=NEW.component_id)
BEGIN
  SELECT RAISE(ABORT, 'Gatus source cannot own notification channels');
END;
CREATE TRIGGER monitor_alert_link_insert AFTER INSERT ON monitor_notification_channels
BEGIN
  INSERT OR IGNORE INTO notification_channel_checks (channel_id, check_id)
    SELECT NEW.channel_id, id FROM http_checks WHERE component_id=NEW.component_id;
END;
CREATE TRIGGER monitor_alert_link_delete AFTER DELETE ON monitor_notification_channels
BEGIN
  DELETE FROM notification_channel_checks WHERE channel_id=OLD.channel_id
    AND check_id IN (SELECT id FROM http_checks WHERE component_id=OLD.component_id);
END;
CREATE TRIGGER channel_check_monitor_insert AFTER INSERT ON notification_channel_checks
BEGIN
  INSERT OR IGNORE INTO monitor_notification_channels (component_id, channel_id)
    SELECT component_id, NEW.channel_id FROM http_checks WHERE id=NEW.check_id;
END;
CREATE TRIGGER channel_check_monitor_delete AFTER DELETE ON notification_channel_checks
WHEN NOT EXISTS (SELECT 1 FROM monitor_alert_check_moves WHERE check_id=OLD.check_id)
BEGIN
  DELETE FROM monitor_notification_channels WHERE channel_id=OLD.channel_id
    AND component_id=(SELECT component_id FROM http_checks WHERE id=OLD.check_id);
END;
CREATE TRIGGER monitor_alert_check_insert AFTER INSERT ON http_checks
BEGIN
  INSERT OR IGNORE INTO notification_channel_checks (channel_id, check_id)
    SELECT channel_id, NEW.id FROM monitor_notification_channels WHERE component_id=NEW.component_id;
END;
CREATE TRIGGER monitor_alert_check_move_before BEFORE UPDATE OF component_id ON http_checks
WHEN OLD.component_id <> NEW.component_id
BEGIN
  INSERT INTO monitor_alert_check_moves (check_id) VALUES (OLD.id);
  DELETE FROM notification_channel_checks WHERE check_id=OLD.id;
END;
CREATE TRIGGER monitor_alert_check_move_after AFTER UPDATE OF component_id ON http_checks
WHEN OLD.component_id <> NEW.component_id
BEGIN
  INSERT OR IGNORE INTO notification_channel_checks (channel_id,check_id)
    SELECT channel_id,NEW.id FROM monitor_notification_channels WHERE component_id=NEW.component_id;
  DELETE FROM monitor_alert_check_moves WHERE check_id=NEW.id;
END;
