# Cloudflare D1 backups and recovery

The Cloudflare admin's Backups page initiates a D1 SQL export through a private Worker and stores it in a private R2 bucket. Export can temporarily lock the source database, so coordinate with active writers. The D1 export is a database snapshot; it does **not** include Worker bindings and secrets, Access policies, endpoint configuration, VPC/Tunnel configuration, Gatus data, or other external resources. Keep those resources and their recovery information separately.

Backups contain application data, including identities and unpublished incidents. Restrict bucket, Worker, and download access to the administrators who need it. A checksum detects corruption, not malicious replacement of both the object and its manifest. Automatic scheduling and in-browser restore are unavailable. Create exports deliberately and monitor the Workflow status; the Workflow concurrency limit serializes exports. The list is ordered by request time and supports pagination.

## Provisioning

1. Identify the exact account, environment, D1 database, and a dedicated private R2 bucket. Create a bucket separate from production and other applications. Configure and verify a 30-day lifecycle policy for both `jobs/` and `exports/`, or explicitly choose and document a different retention period. R2 lifecycle expiration is asynchronous. Protect or separately archive any backup needed longer.
2. Provision a dedicated Cloudflare API token with the minimum D1 permissions needed for export. D1 export requires D1 Edit; do not reuse an operator's OAuth credential. Restrict its account and resources as Cloudflare permits, record its owner and expiry, and rotate it separately. Store it as the backup Worker's `D1_EXPORT_TOKEN` secret; never put its value in source, environment variables committed to Git, logs, or screenshots. See [Cloudflare's D1 backup workflow](https://developers.cloudflare.com/workflows/examples/backup-d1/).
3. Set `ACCOUNT_ID` and `DATABASE_ID` in an environment-specific backup Worker configuration, bind `BACKUP_BUCKET`, and deploy the Worker and Workflow. The Worker must have no public route or workers.dev endpoint. Its service endpoint trusts requests from the private service binding; only bind it to the protected operations Worker. Traces are disabled for this Worker to avoid recording signed export URLs.
4. Add the `BACKUPS` service binding to the matching operations Worker. Set `BACKUPS_READY` to `true` only after the isolated recovery test below passes and after confirming that the Worker points to the intended environment. Otherwise leave it disabled. Preserve existing D1, Gatus, probe, Access and endpoint settings when deploying.
5. In the admin page, create an export, wait until it is complete, and use **Verify** to compare the stored object with its recorded SHA-256 and size. A successful check does not prove that an import will succeed. Download and compare the file's SHA-256 with the value shown in the page before an isolated recovery test.

## Isolated recovery test

Never test restoration against the active staging or production database. Create a new, explicitly named D1 database with no application or probe bindings and confirm its account, ID and empty state. The following commands are examples: substitute the verified database name and the protected local SQL path, and do not include secrets in command arguments.

```sh
npx wrangler d1 create status-backup-restore-test
npx wrangler d1 info status-backup-restore-test
npx wrangler d1 execute status-backup-restore-test --remote --file /secure/path/status-backup.sql
npx wrangler d1 execute status-backup-restore-test --remote --command "PRAGMA quick_check"
```

`d1 execute --file` imports into the named target. Confirm its identity at the interactive prompt; never use a live database as the test target. Check the integrity result, schema migrations, and representative row counts against the source snapshot. Keep this database isolated: imported schedules and check settings must not be connected to a running probe. Treat the SQL file and test database as sensitive and use the organization's approved retention and disposal process.

For real recovery, stop and drain writers and probes, verify and record the target identity and existing Time Travel bookmark, and follow the organization's approved recovery process. Import/restore can overwrite data and cancel or disrupt live work; use explicit human confirmation at the destructive operation. D1 Time Travel restores in place and cannot currently clone a database to an isolated target. See [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
