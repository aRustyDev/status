-- Advanced settings are optional, deployment-managed, and must not contain
-- credentials, request headers or bodies. Response comparison values must
-- not contain secrets. A null config retains the original HTTP probe behavior.
ALTER TABLE http_checks ADD COLUMN advanced_config TEXT
  CHECK (advanced_config IS NULL OR (json_valid(advanced_config) AND length(advanced_config) <= 32000));
ALTER TABLE http_checks ADD COLUMN last_effective_status TEXT
  CHECK (last_effective_status IS NULL OR last_effective_status IN ('up', 'degraded', 'down'));
-- A legacy probe cannot write this watermark. Readers trust the effective
-- status only when it belongs to the latest scheduled observation.
ALTER TABLE http_checks ADD COLUMN last_effective_scheduled_at INTEGER;
ALTER TABLE http_check_results ADD COLUMN effective_status TEXT
  CHECK (effective_status IS NULL OR effective_status IN ('up', 'degraded', 'down'));

-- Block unrecognized top-level keys at the database boundary: in particular,
-- request bodies, authentication and headers must never be stored here.
CREATE TRIGGER http_checks_advanced_config_validate_insert BEFORE INSERT ON http_checks
WHEN NEW.advanced_config IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.advanced_config) OR json_type(NEW.advanced_config) <> 'object'
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.advanced_config)
    WHERE key NOT IN ('method', 'acceptedStatusRanges', 'keyword', 'assertions', 'timeoutMs', 'attempts', 'degradedAboveMs'))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.assertions') IS NOT NULL AND json_type(NEW.advanced_config, '$.assertions') <> 'array'
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.assertions') AS a
    WHERE a.type <> 'object' OR EXISTS (SELECT 1 FROM json_each(a.value) WHERE key NOT IN ('type', 'name', 'path', 'op', 'value', 'onFail')))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.acceptedStatusRanges') IS NOT NULL AND json_type(NEW.advanced_config, '$.acceptedStatusRanges') <> 'array'
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.acceptedStatusRanges') AS r
    WHERE r.type <> 'object' OR EXISTS (SELECT 1 FROM json_each(r.value) WHERE key NOT IN ('min', 'max')))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.method') IS NOT NULL AND
    (json_type(NEW.advanced_config, '$.method') <> 'text' OR upper(json_extract(NEW.advanced_config, '$.method')) NOT IN ('GET', 'HEAD'))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
END;
CREATE TRIGGER http_checks_advanced_config_validate_update BEFORE UPDATE OF advanced_config ON http_checks
WHEN NEW.advanced_config IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.advanced_config) OR json_type(NEW.advanced_config) <> 'object'
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.advanced_config)
    WHERE key NOT IN ('method', 'acceptedStatusRanges', 'keyword', 'assertions', 'timeoutMs', 'attempts', 'degradedAboveMs'))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.assertions') IS NOT NULL AND json_type(NEW.advanced_config, '$.assertions') <> 'array'
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.assertions') AS a
    WHERE a.type <> 'object' OR EXISTS (SELECT 1 FROM json_each(a.value) WHERE key NOT IN ('type', 'name', 'path', 'op', 'value', 'onFail')))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.acceptedStatusRanges') IS NOT NULL AND json_type(NEW.advanced_config, '$.acceptedStatusRanges') <> 'array'
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.acceptedStatusRanges') AS r
    WHERE r.type <> 'object' OR EXISTS (SELECT 1 FROM json_each(r.value) WHERE key NOT IN ('min', 'max')))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.method') IS NOT NULL AND
    (json_type(NEW.advanced_config, '$.method') <> 'text' OR upper(json_extract(NEW.advanced_config, '$.method')) NOT IN ('GET', 'HEAD'))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
END;

-- A changed check must never reuse observations from its prior configuration.
CREATE TRIGGER http_checks_advanced_config_update AFTER UPDATE OF advanced_config ON http_checks
WHEN OLD.advanced_config IS NOT NEW.advanced_config
BEGIN
  UPDATE http_checks SET config_version=config_version+1, last_scheduled_at=NULL,
    last_result_at=NULL, last_status=NULL, last_effective_status=NULL, last_effective_scheduled_at=NULL,
    last_http_status=NULL, last_latency_ms=NULL
  WHERE id=NEW.id;
END;

-- Any config-version change fences the previous effective state, including
-- updates from legacy APIs that do not know about the new status column.
CREATE TRIGGER http_checks_version_invalidate AFTER UPDATE OF config_version ON http_checks
WHEN OLD.config_version <> NEW.config_version
BEGIN
  UPDATE http_checks SET last_scheduled_at=NULL, last_result_at=NULL, last_status=NULL,
    last_effective_status=NULL, last_effective_scheduled_at=NULL, last_http_status=NULL, last_latency_ms=NULL
  WHERE id=NEW.id;
END;

-- Registry changes also invalidate the additive effective status column.
DROP TRIGGER endpoint_registry_insert;
DROP TRIGGER endpoint_registry_update;
DROP TRIGGER endpoint_registry_delete;
CREATE TRIGGER endpoint_registry_insert AFTER INSERT ON endpoint_registry
BEGIN
  UPDATE http_checks SET config_version=config_version+1, last_scheduled_at=NULL,
    last_result_at=NULL, last_status=NULL, last_effective_status=NULL, last_effective_scheduled_at=NULL, last_http_status=NULL, last_latency_ms=NULL
  WHERE endpoint_id=NEW.endpoint_id;
END;
CREATE TRIGGER endpoint_registry_update AFTER UPDATE OF fingerprint ON endpoint_registry
WHEN OLD.fingerprint <> NEW.fingerprint
BEGIN
  UPDATE http_checks SET config_version=config_version+1, last_scheduled_at=NULL,
    last_result_at=NULL, last_status=NULL, last_effective_status=NULL, last_effective_scheduled_at=NULL, last_http_status=NULL, last_latency_ms=NULL
  WHERE endpoint_id=NEW.endpoint_id;
END;
CREATE TRIGGER endpoint_registry_delete AFTER DELETE ON endpoint_registry
BEGIN
  UPDATE http_checks SET config_version=config_version+1, last_scheduled_at=NULL,
    last_result_at=NULL, last_status=NULL, last_effective_status=NULL, last_effective_scheduled_at=NULL, last_http_status=NULL, last_latency_ms=NULL
  WHERE endpoint_id=OLD.endpoint_id;
END;
