-- Dedicated deployment control database. Never apply to Dev, Stage, or Prod.
CREATE TABLE IF NOT EXISTS preview_releases (
  branch_key TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  document TEXT NOT NULL CHECK (json_valid(document))
);
