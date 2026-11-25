-- Extend advanced checks with request settings and metadata-only Vault references.
DROP TRIGGER http_checks_advanced_config_validate_insert;
DROP TRIGGER http_checks_advanced_config_validate_update;
CREATE TRIGGER http_checks_advanced_config_validate_insert BEFORE INSERT ON http_checks
WHEN NEW.advanced_config IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.advanced_config) OR json_type(NEW.advanced_config) <> 'object'
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.advanced_config)
    WHERE key NOT IN ('method', 'acceptedStatusRanges', 'keyword', 'assertions', 'timeoutMs', 'attempts', 'degradedAboveMs', 'auth', 'headers', 'body', 'vaultHeaders'))
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
    (json_type(NEW.advanced_config, '$.method') <> 'text' OR upper(json_extract(NEW.advanced_config, '$.method')) NOT IN ('GET', 'HEAD', 'POST'))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.headers') IS NOT NULL AND (
    json_type(NEW.advanced_config, '$.headers') <> 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.headers') WHERE type <> 'text' OR lower(key) IN ('authorization','proxy-authorization','cookie','set-cookie'))
  ) THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.body') IS NOT NULL AND (
    json_type(NEW.advanced_config, '$.body') <> 'text' OR upper(COALESCE(json_extract(NEW.advanced_config, '$.method'),'GET')) <> 'POST' OR
    length(CAST(json_extract(NEW.advanced_config, '$.body') AS BLOB)) > 16384 OR NOT json_valid(json_extract(NEW.advanced_config, '$.body'))
  ) THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.vaultHeaders') IS NOT NULL AND (
    json_type(NEW.advanced_config, '$.vaultHeaders') <> 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.vaultHeaders') AS h WHERE h.type <> 'object' OR
      EXISTS (SELECT 1 FROM json_each(h.value) WHERE key NOT IN ('vaultId','secretId')) OR
      json_type(h.value, '$.vaultId') IS NOT 'integer' OR json_extract(h.value, '$.vaultId') NOT BETWEEN 1 AND 9007199254740991 OR
      json_type(h.value, '$.secretId') IS NOT 'integer' OR json_extract(h.value, '$.secretId') NOT BETWEEN 1 AND 9007199254740991)
  ) THEN RAISE(ABORT, 'invalid advanced check configuration') END;
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
    WHERE key NOT IN ('method', 'acceptedStatusRanges', 'keyword', 'assertions', 'timeoutMs', 'attempts', 'degradedAboveMs', 'auth', 'headers', 'body', 'vaultHeaders'))
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
    (json_type(NEW.advanced_config, '$.method') <> 'text' OR upper(json_extract(NEW.advanced_config, '$.method')) NOT IN ('GET', 'HEAD', 'POST'))
    THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.headers') IS NOT NULL AND (
    json_type(NEW.advanced_config, '$.headers') <> 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.headers') WHERE type <> 'text' OR lower(key) IN ('authorization','proxy-authorization','cookie','set-cookie'))
  ) THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.body') IS NOT NULL AND (
    json_type(NEW.advanced_config, '$.body') <> 'text' OR upper(COALESCE(json_extract(NEW.advanced_config, '$.method'),'GET')) <> 'POST' OR
    length(CAST(json_extract(NEW.advanced_config, '$.body') AS BLOB)) > 16384 OR NOT json_valid(json_extract(NEW.advanced_config, '$.body'))
  ) THEN RAISE(ABORT, 'invalid advanced check configuration') END;
  SELECT CASE WHEN json_type(NEW.advanced_config, '$.vaultHeaders') IS NOT NULL AND (
    json_type(NEW.advanced_config, '$.vaultHeaders') <> 'object' OR
    EXISTS (SELECT 1 FROM json_each(NEW.advanced_config, '$.vaultHeaders') AS h WHERE h.type <> 'object' OR
      EXISTS (SELECT 1 FROM json_each(h.value) WHERE key NOT IN ('vaultId','secretId')) OR
      json_type(h.value, '$.vaultId') IS NOT 'integer' OR json_extract(h.value, '$.vaultId') NOT BETWEEN 1 AND 9007199254740991 OR
      json_type(h.value, '$.secretId') IS NOT 'integer' OR json_extract(h.value, '$.secretId') NOT BETWEEN 1 AND 9007199254740991)
  ) THEN RAISE(ABORT, 'invalid advanced check configuration') END;
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
