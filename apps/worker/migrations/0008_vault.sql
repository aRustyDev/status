-- Values are AES-GCM ciphertext; the encryption key is a Worker secret, not D1 data.
CREATE TABLE vaults (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE vault_secrets (
  id INTEGER PRIMARY KEY, vault_id INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('value','userpass','json')),
  ciphertext TEXT NOT NULL, nonce TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, UNIQUE (vault_id, name)
);
CREATE INDEX vault_secrets_vault ON vault_secrets(vault_id);

-- Binds this database to one key, preventing silent mixed-key writes.
CREATE TABLE vault_key_verifier (id INTEGER PRIMARY KEY CHECK (id=1), nonce TEXT NOT NULL, ciphertext TEXT NOT NULL);
