-- Each endpoint's current deployment-approved target identity. Only the
-- deployment synchronization step changes these rows. Probe Workers never do.
CREATE TABLE endpoint_registry (
  endpoint_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
);

-- One registry mutation and its corresponding result invalidation are atomic.
CREATE TRIGGER endpoint_registry_insert AFTER INSERT ON endpoint_registry
BEGIN
  UPDATE http_checks SET config_version=config_version+1, last_scheduled_at=NULL,
    last_result_at=NULL, last_status=NULL, last_http_status=NULL, last_latency_ms=NULL
  WHERE endpoint_id=NEW.endpoint_id;
END;
CREATE TRIGGER endpoint_registry_update AFTER UPDATE OF fingerprint ON endpoint_registry
WHEN OLD.fingerprint <> NEW.fingerprint
BEGIN
  UPDATE http_checks SET config_version=config_version+1, last_scheduled_at=NULL,
    last_result_at=NULL, last_status=NULL, last_http_status=NULL, last_latency_ms=NULL
  WHERE endpoint_id=NEW.endpoint_id;
END;
CREATE TRIGGER endpoint_registry_delete AFTER DELETE ON endpoint_registry
BEGIN
  UPDATE http_checks SET config_version=config_version+1, last_scheduled_at=NULL,
    last_result_at=NULL, last_status=NULL, last_http_status=NULL, last_latency_ms=NULL
  WHERE endpoint_id=OLD.endpoint_id;
END;
