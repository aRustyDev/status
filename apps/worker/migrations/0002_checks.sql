CREATE TABLE http_checks (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL UNIQUE REFERENCES components(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (1, 5)),
  expected_status INTEGER NOT NULL CHECK (expected_status BETWEEN 100 AND 599),
  config_version INTEGER NOT NULL DEFAULT 1,
  last_scheduled_at INTEGER,
  last_result_at INTEGER,
  last_status TEXT CHECK (last_status IN ('up', 'down')),
  last_http_status INTEGER,
  last_latency_ms INTEGER,
  mutation_key TEXT
);

CREATE TABLE http_check_results (
  check_id TEXT NOT NULL REFERENCES http_checks(id) ON DELETE CASCADE,
  config_version INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up', 'down')),
  http_status INTEGER,
  latency_ms INTEGER NOT NULL,
  PRIMARY KEY (check_id, config_version, scheduled_at)
);
CREATE INDEX http_check_results_scheduled ON http_check_results(scheduled_at);

CREATE TRIGGER http_checks_limit_insert BEFORE INSERT ON http_checks
WHEN NEW.enabled = 1 AND (SELECT COUNT(*) FROM http_checks WHERE enabled = 1) >= 20
BEGIN
  SELECT RAISE(ABORT, 'maximum enabled checks reached');
END;

CREATE TRIGGER http_checks_limit_update BEFORE UPDATE OF enabled ON http_checks
WHEN NEW.enabled = 1 AND OLD.enabled = 0 AND (SELECT COUNT(*) FROM http_checks WHERE enabled = 1) >= 20
BEGIN
  SELECT RAISE(ABORT, 'maximum enabled checks reached');
END;
