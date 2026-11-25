-- Record acknowledged delivery per channel and check so recovery does not imply an outage was sent when it was not.
CREATE TABLE notification_delivery_state (
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL REFERENCES http_checks(id) ON DELETE CASCADE,
  check_version INTEGER NOT NULL,
  channel_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up','degraded','down')),
  PRIMARY KEY (channel_id, check_id)
);
