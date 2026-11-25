-- Allow only a metadata-only Vault Basic reference in persisted check settings.
-- Suppress automation during credential faults and the first subsequent observation.
ALTER TABLE http_checks ADD COLUMN transition_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (transition_suppressed IN (0,1));
DROP TRIGGER http_checks_advanced_config_validate_insert;
DROP TRIGGER http_checks_advanced_config_validate_update;
CREATE TRIGGER http_checks_advanced_config_validate_insert BEFORE INSERT ON http_checks
WHEN NEW.advanced_config IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.advanced_config) OR json_type(NEW.advanced_config) <> 'object'
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.advanced_config)
    WHERE key NOT IN ('method', 'acceptedStatusRanges', 'keyword', 'assertions', 'timeoutMs', 'attempts', 'degradedAboveMs', 'auth'))
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
  -- References are metadata only. Never permit inline credentials or extra fields.
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.auth') IS NOT NULL AND (
    json_type(NEW.advanced_config, '$.auth') <> 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.auth') WHERE key NOT IN ('type','basic')) OR
    json_type(NEW.advanced_config, '$.auth.type') IS NOT 'text' OR json_extract(NEW.advanced_config, '$.auth.type') <> 'basic' OR
    json_type(NEW.advanced_config, '$.auth.basic') IS NOT 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.auth.basic') WHERE key <> 'vault') OR
    json_type(NEW.advanced_config, '$.auth.basic.vault') IS NOT 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.auth.basic.vault') WHERE key NOT IN ('vaultId','secretId')) OR
    json_type(NEW.advanced_config, '$.auth.basic.vault.vaultId') IS NOT 'integer' OR
    json_extract(NEW.advanced_config, '$.auth.basic.vault.vaultId') NOT BETWEEN 1 AND 9007199254740991 OR
    json_type(NEW.advanced_config, '$.auth.basic.vault.secretId') IS NOT 'integer' OR
    json_extract(NEW.advanced_config, '$.auth.basic.vault.secretId') NOT BETWEEN 1 AND 9007199254740991
  ) THEN RAISE(ABORT, 'invalid advanced check configuration') END;
END;
CREATE TRIGGER http_checks_advanced_config_validate_update BEFORE UPDATE OF advanced_config ON http_checks
WHEN NEW.advanced_config IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.advanced_config) OR json_type(NEW.advanced_config) <> 'object'
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.advanced_config)
    WHERE key NOT IN ('method', 'acceptedStatusRanges', 'keyword', 'assertions', 'timeoutMs', 'attempts', 'degradedAboveMs', 'auth'))
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
  -- References are metadata only. Never permit inline credentials or extra fields.
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.auth') IS NOT NULL AND (
    json_type(NEW.advanced_config, '$.auth') <> 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.auth') WHERE key NOT IN ('type','basic')) OR
    json_type(NEW.advanced_config, '$.auth.type') IS NOT 'text' OR json_extract(NEW.advanced_config, '$.auth.type') <> 'basic' OR
    json_type(NEW.advanced_config, '$.auth.basic') IS NOT 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.auth.basic') WHERE key <> 'vault') OR
    json_type(NEW.advanced_config, '$.auth.basic.vault') IS NOT 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.auth.basic.vault') WHERE key NOT IN ('vaultId','secretId')) OR
    json_type(NEW.advanced_config, '$.auth.basic.vault.vaultId') IS NOT 'integer' OR
    json_extract(NEW.advanced_config, '$.auth.basic.vault.vaultId') NOT BETWEEN 1 AND 9007199254740991 OR
    json_type(NEW.advanced_config, '$.auth.basic.vault.secretId') IS NOT 'integer' OR
    json_extract(NEW.advanced_config, '$.auth.basic.vault.secretId') NOT BETWEEN 1 AND 9007199254740991
  ) THEN RAISE(ABORT, 'invalid advanced check configuration') END;
END;
