-- Dedicated control D1 only: never apply this schema to application databases.
-- A lost lease is intentionally not expired automatically. A controller must
-- drain and wait for explicit release before changing the active release.
CREATE TABLE IF NOT EXISTS preview_execution_fences (
  selector TEXT PRIMARY KEY,
  active_release TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'draining')),
  CHECK (state <> 'active' OR active_release IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS preview_execution_leases (
  lease_id TEXT PRIMARY KEY,
  selector TEXT NOT NULL,
  release TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS preview_execution_leases_selector ON preview_execution_leases(selector);
CREATE TABLE IF NOT EXISTS preview_email_quota (
  selector TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS preview_email_quota_recent ON preview_email_quota(selector, sent_at);
-- Only the trusted per-release fence service can access this control D1.
-- Never delete a reservation after an ambiguous provider result.
CREATE TABLE IF NOT EXISTS preview_mail_reservations (
  selector TEXT NOT NULL,
  release TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('delivery','confirmation')),
  item TEXT NOT NULL,
  PRIMARY KEY(selector, release, kind, item)
);
