-- Request bodies and credentials are deliberately never stored here.
CREATE TABLE mutation_receipts (
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_version INTEGER NOT NULL,
  attempt_token TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,
  result_id TEXT,
  result_alias INTEGER,
  result_version INTEGER,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, request_key)
);
CREATE INDEX mutation_receipts_expiry ON mutation_receipts(expires_at);

CREATE TRIGGER mutation_receipt_actor_guard BEFORE INSERT ON mutation_receipts
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_id AND version=NEW.actor_version AND role IN ('operator','admin'))
BEGIN
  SELECT RAISE(ABORT, 'Mutation identity changed');
END;
