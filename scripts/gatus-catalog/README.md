# Gatus catalog provisioner

This tool reconciles a reviewed, sanitized Gatus catalog using the atomic D1 batch in `syncGatusCatalog`. It starts a **local-only** Wrangler Worker with an explicitly configured D1 binding. The Worker and its inspector listen on loopback, accept one authenticated catalog operation, and have no deployed route. The wrapper uses an ephemeral token and deletes its private configuration, local state, and logs on normal exit or a handled interruption. A forced termination can leave temporary files behind. An interrupted or timed-out operation can have an unknown outcome: inspect the database before retrying.

The target and catalog inputs must be regular owner-only files. The target file is JSON with these fields:

```json
{
  "environment": "staging",
  "accountId": "<32-hex-account-id>",
  "databaseId": "<validation-database-uuid>",
  "databaseName": "status-gatus-validation-<unique-suffix>",
  "protectedDatabaseIds": ["<live-staging-uuid>", "<production-uuid>"]
}
```

Independently verify the account, target name and UUID, and both protected database UUIDs before making the file. Staging targets must be disposable `status-gatus-validation-...` databases and cannot match any protected UUID. The CLI compares those values with explicit expected IDs and, in remote mode, asks Wrangler for the target database's current name and UUID before running the local Worker. The protected IDs are a caller-provided safeguard; they do not replace an account inventory. The target's migrations must already be applied in remote mode.

The catalog is a JSON array of objects with exactly `kind`, `key`, `name`, `group`, `staleAfterSeconds`, and `advisory`; no URLs, credentials, headers, or other fields are accepted. Retired source rows and their historical incident/maintenance relationships are retained. Empty, duplicate, malformed and conflicting inventories are rejected.

```sh
node --import tsx scripts/gatus-catalog/provision.mts \
  --target staging --mode local \
  --target-config /private/path/target.json --catalog /private/path/catalog.json \
  --expected-account <account-id> --expected-database <database-uuid>
```

`--mode local` creates and removes a simulated D1 database. To target the verified disposable staging database, use `--mode remote`; the code still runs locally, while its D1 binding connects to the selected remote resource. Production requires both an explicit `--target production` and `--allow-production`, with a matching production target configuration; do not reuse the staging validation configuration. These options do not grant authorization. No production operation should run until its routing, identity, data, and rollback requirements have been verified.

For production the tool accepts only the `status-board-production` database name and remote mode. Verify its account and UUID independently, supply those values as `--expected-account` and `--expected-database`, and include the other live and staging database IDs in `protectedDatabaseIds`. The selected production database must not appear in that list. Confirm the current provider name and ID and review the complete, current catalog before invoking the command; do not use inferred freshness values or a provisional catalog. After a timeout or interrupted run, inspect the active and retired source rows before retrying.

Run the provisioner tests with `node --import tsx --test scripts/gatus-catalog/provision.test.mts`; they require loopback access for local Workers and D1 simulation. A local test does not verify remote-binding behavior or a production inventory.
