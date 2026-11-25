# Cloudflare deployment and operations

This guide describes the Workers deployment in this fork. The staging gateway serves the adapted upstream React reader and admin console, with the legacy board retained for rollback. The upstream Node deployment guides do not configure these Workers.

## Prerequisites

Use a Cloudflare account with Workers, D1, an active DNS zone, and Cloudflare Access connected to the engineering team's identity provider. Choose separate hostnames, Access applications, and D1 databases for staging and production. Record the Cloudflare Access team domain and each application's audience tag. An engineer with the appropriate Cloudflare permissions must create the bindings and configure the hostnames.

For private checks, create a Cloudflare Tunnel with connectivity to each private origin and register an HTTP VPC Service for that origin. The tunnel connector must resolve the configured hostname and reach the service. Workers VPC requires `cloudflared` 2025.7.0 or later and QUIC transport (`auto` or `quic`), with outbound UDP port 7844 allowed. Configure certificate validation and a private CA in the VPC Service when needed. Workers VPC is a Cloudflare beta product. See [VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) and [Cloudflare Tunnel for Workers VPC](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/).

Install the repository's Node and npm versions, then install dependencies from the lockfile:

```sh
npm ci
npm run build -w @bsp/board
```

## Configure each environment

The checked-in staging configurations contain placeholders, no routes, no endpoint registry, and a disabled probe schedule. Fill in the environment-specific values locally before deployment; never commit credentials or private endpoint details.

For a standalone legacy board, configure `apps/worker/wrangler.jsonc` with the matching custom-domain route, D1 `DB` binding, `ACCESS_TEAM_DOMAIN`, and `ACCESS_AUD`. In the staging gateway deployment, the gateway owns the custom-domain route, and the internal API Workers use the matching D1 and Access settings in their gateway configurations. `ACCESS_TEAM_DOMAIN` identifies the Access team, and `ACCESS_AUD` is the audience tag of the Access application protecting that hostname. Use the values from your own Cloudflare account. Keep `workers_dev` and `preview_urls` disabled and protect the entire hostname, including assets and `/api` paths, with an Access policy for the engineering team. Test the policy before publishing the route. Consult [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/) for non-inheritable bindings and variables.

The probe Worker uses the same environment's D1 database. In both Worker configs, set `ENDPOINTS` to the same JSON array of approved endpoints. Each item has an `id`, `name`, and absolute `url`. Public targets use HTTPS. Private targets also specify the configured VPC Service binding and service ID, as in `[{"id":"api","name":"API","url":"https://api.internal/health","binding":"PRIVATE_API","serviceId":"<VPC_SERVICE_ID>","revision":"1"}]`. The optional `revision` identifies the target configuration and must be changed whenever the service itself is changed without changing its ID. Configure the VPC Service binding in `apps/probe/wrangler.jsonc`. Infrastructure administrators manage the endpoint list and bindings. Keep staging and production databases, routes, and endpoint lists separate. A component displays the most severe of its manual status, enabled HTTP check status, and active incident impact. An enabled check with no recent result is unknown; active maintenance appears separately and does not hide an incident or a failure.

In the Cloudflare monitor editor, the Checks panel supports an optional keyword, header and JSON assertions, a degraded latency threshold, and up to 20 accepted HTTP status ranges. A configured range replaces the single expected status; removing the last range restores it. Test and scheduled checks use the same validation and evaluator. GET and HEAD are supported, but HEAD cannot use keyword or JSON checks. Redirects are not followed, even if their status appears in an accepted range. Only approved destinations can be checked.

> [!WARNING]
> **Not released yet.** Cloudflare monitor tags require a build from the `main` branch (see [Deployment](deployment.md)).

The editor's Tags panel adds coloured labels to Cloudflare-managed monitors. Start typing to select an existing label and its colour, or add a new label with one of the offered colours. Tags appear on the admin monitor list, where selecting tags filters for monitors carrying all of them. They also appear in the BSP public monitor payload, so do not put confidential information in tag labels. A monitor can have up to 20 tags; labels are 1–40 characters and colours are six-digit hex values. The API accepts tags as `{ "label": "production", "color": "#6366f1" }` objects. Omitting `tags` from an update preserves the existing tags. Gatus-managed monitors remain read-only and return no tags. Subscriber filtering by tag is not supported by the Cloudflare profile.

Add the binding to the selected probe environment with its Cloudflare VPC Service ID:

```jsonc
"vpc_services": [{ "binding": "PRIVATE_API", "service_id": "<VPC_SERVICE_ID>" }]
```

Before synchronizing an existing pre-registry deployment, disable and drain its scheduled probe as described below. Apply D1 migrations to the intended database with the board Worker's config and environment. Check the account and database ID before passing `--remote`:

```sh
npx wrangler d1 migrations list DB --config apps/worker/wrangler.jsonc --env staging --remote
npx wrangler d1 migrations apply DB --config apps/worker/wrangler.jsonc --env staging --remote
```

## Synchronize endpoint identities

The D1 endpoint registry stores hashes of each approved URL, binding name, service ID, and optional revision. A registry change atomically invalidates affected check results. The board displays unknown for a mismatch; the guarded probe refuses mismatched targets and checks the registry again when saving results. Display names are not part of the target identity. Configure the same endpoint JSON in both Workers and make the `serviceId` match the `vpc_services` binding. Runtime bindings cannot report their service ID or detect an out-of-band edit to a VPC Service. Treat its configuration as controlled infrastructure: stop checks and update the `revision` whenever its origin, ports, TLS, or resolver changes. The sync generator verifies both Worker lists, the configured D1 IDs, and VPC binding IDs; it cannot verify the live VPC Service contents.

For the **first upgrade** from a pre-registry probe, disable its Cron Trigger, deploy that disabled version, confirm the trigger is removed and all pre-registry scheduled invocations have finished before synchronizing the registry. The additive migration may be applied earlier while the registry remains empty. Cloudflare says a Cron Trigger deletion can take up to 15 minutes to propagate, and a scheduled invocation can run for up to 15 minutes; allow for both periods and confirm the old invocations have drained before proceeding. See [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). A pre-registry probe does not enforce this fence and must not run after synchronization. Do not roll back the probe to a pre-registry version after this upgrade; restoring a pre-registry board also loses mismatch masking. An ordinary Worker rollback does not roll back the registry or D1 data.

For each endpoint change, serialize deployments. The registry fence prevents old results from being saved, but a running invocation may already have captured an older registry snapshot and can still contact an old target. For strict network revocation, stop and drain probes before changing or removing any endpoint. Always stop and drain probes before changing a live VPC Service itself. Update both local Worker configs, including a new revision for a changed VPC Service. Apply migrations before synchronization. Generate and review a SQL file with the intended environment and D1 database ID, then apply it to that same database. Both Workers must have an explicit `ENDPOINTS` value; use `[]` to intentionally remove all endpoints. The config files must be valid JSON when using the generator (remove JSONC comments first):

```sh
node --import tsx apps/probe/scripts/sync-endpoints.ts staging > /tmp/status-staging-endpoints.sql
cat /tmp/status-staging-endpoints.sql
npx wrangler d1 execute DB --config apps/worker/wrangler.jsonc --env staging --remote --file /tmp/status-staging-endpoints.sql
```

Each endpoint upsert or removal and its invalidation are atomic; the full file can be partially applied if an operation fails. Checks with mismatched definitions remain unknown and do not record results. Review errors and rerun the full sync before deploying matching board and guarded probe configurations. Never run concurrent registry synchronizations. Restore the Cron Trigger only after the guarded probe and matching registry are deployed. The SQL contains endpoint IDs and fingerprints, not URLs, but protect it as operational configuration. Never infer that a successful sync validates network reachability.

All migrations reside in `apps/worker/migrations`. The following commands are for a standalone legacy board deployment, not the staging gateway. **Do not deploy the legacy Worker with its custom-domain route while the gateway owns that hostname**: the configured route can take traffic away from the gateway and its upstream screens. Use the gateway rollback procedure below for the staging cutover. For a standalone board, build and deploy the Worker with the same environment:

```sh
npm run build -w @bsp/board
npx wrangler deploy --config apps/worker/wrangler.jsonc --env staging --dry-run
npx wrangler deploy --config apps/worker/wrangler.jsonc --env staging
npx wrangler deploy --config apps/probe/wrangler.jsonc --env staging --dry-run
npx wrangler deploy --config apps/probe/wrangler.jsonc --env staging
```

For a separately configured standalone production board, replace `staging` with `production`. The staging gateway configuration does not include a production environment; provision and verify one before any production gateway deployment. Apply the complete migration set and synchronize endpoint identities before deploying the guarded board and probe Workers. Production starts with an empty Cron Trigger list. After the board is verified, set the production probe environment's `triggers.crons` to `["* * * * *"]` and deploy the probe Worker. Deployment options and the local CLI version are shown by `npx wrangler deploy --help`.

## Bootstrap the first administrator

After the board is deployed and protected by Access, the intended administrator signs in once. A verified Access identity is created as a viewer. A Cloudflare administrator then queries the selected environment's D1 `users` table for the account's `id`, `issuer`, `subject`, `email`, `role`, and `version`. Confirm the identity and application before updating that exact row to `admin` and incrementing `version`. Use the D1 console or `wrangler d1 execute` with `--remote`, the board config, and the explicit environment. Do not paste tokens or credentials into logs or chat. The promoted user can assign roles in the admin interface after refreshing.

Backup provisioning, retention and isolated recovery verification are described in [Cloudflare D1 backups and recovery](cloudflare-backups.md). The Backups capability stays disabled until its dedicated service is provisioned and verified.

## Audit history

The administrator-only Audit Log lists application mutations, including monitor, check, incident, maintenance, and role changes. It does not record Cloudflare Access sign-ins or denied requests; use Access logs for those events. Filters and pagination use the operations API, and details are restricted to an allowlist of non-sensitive values. Check events retain the associated monitor UUID and basic scheduling and status settings. Names, incident text, endpoint identifiers, advanced check configuration and credentials are not included in new audit details. Existing records are filtered on read, but their stored values are not rewritten; treat database access and backups accordingly. Deploy both operations and monitoring Workers to apply the new recording rules to both mutation paths.

## Staging verification

1. Sign in as a viewer, operator, and administrator. Confirm unauthenticated requests are rejected, viewers cannot write, operators cannot change roles, and administrators can view audit events. Check the JSON endpoints directly as well as the pages.
2. Create a component, draft an incident, and confirm readers cannot see the draft. Publish it, add an update, and resolve it. Verify the audit history and that a stale edit returns a conflict.
3. Schedule a future maintenance window and confirm it appears before start, changes state at its start and end, and can end early. Publish an overlapping incident and confirm both the impact and maintenance badge are visible.
4. Configure one approved public HTTPS check and one private VPC Service check. Verify success, unexpected HTTP status, timeout, and recovery. Confirm an unregistered destination cannot be selected and a failure does not publish an incident. Check Workers Logs for scheduled and completed probes without logging secrets or response bodies.
5. Verify the reader page on a direct load, the `/admin` deep links, Access expiry, and the expected D1 database and hostname for the environment. Exercise the previous Worker version against the upgraded staging schema before production.

A successful dry run validates packaging; it does not validate Access, D1, Tunnel reachability, or actual scheduled execution. Record the staging environment, timestamp, and outcome of each check before production rollout.

### Staging rehearsal

The staging rehearsal covered role enforcement, incidents, maintenance transitions, probe recovery, Access session expiry, and rollback. See the cutover plan for the recorded outcomes. Environment-specific identifiers and internal endpoints are maintained outside this public repository.

On November 23, 2026 at 11:58 p.m. Eastern, the shared monitor editor was verified in staging. Draft tests returned HTTP 200 for both approved public and private destinations. An unexpected-status test failed as expected. A disabled verification monitor was created, edited, and reopened with its destination and response check intact. Existing scheduled public and private checks also returned HTTP 200 after the probe deployment. The verification monitor remains in staging with its check disabled. Staging had no Gatus-backed monitors, so Gatus read-only behavior was verified by the local integration suite. Later local draft-preservation and timeout fixes have not yet been verified on staging.

## Upstream UI staging gateway

The cutover gateway is configured in `apps/gateway/wrangler.jsonc`. Its staging `UI_MODE` selects `legacy` or `upstream` HTML while both `/api/v1/` and `/api/v1/bsp/` remain routed to the internal Workers. The gateway serves the legacy board from the operations Worker and forwards upstream assets to the status and admin UI Workers. Keep both UI Workers deployed during a rollback so existing tabs can load their assets.

Apply the additive migrations to staging D1 using the existing migration owner before deploying code that reads aliases. Build `@bsp/shared`, `@bsp/board`, `@bsp/status`, and `@bsp/admin`. Deploy the internal Workers first, then the gateway:

```sh
npm run build -w @bsp/shared
npm run build -w @bsp/board
npm run build -w @bsp/status
npm run build -w @bsp/admin
npx wrangler deploy --config apps/probe/wrangler.jsonc --env staging
npx wrangler deploy --config apps/gateway/status-api.wrangler.jsonc --env staging
npx wrangler deploy --config apps/gateway/monitoring-api.wrangler.jsonc --env staging
npx wrangler deploy --config apps/gateway/api.wrangler.jsonc --env staging
npx wrangler deploy --config apps/gateway/status.wrangler.jsonc --env staging
npx wrangler deploy --config apps/gateway/admin.wrangler.jsonc --env staging
npx wrangler deploy --config apps/gateway/wrangler.jsonc --env staging
```

Run the checks and rollback rehearsal in `.agents/plans/2026-11-23-better-status-page-cloudflare-ui.md` before leaving the gateway in upstream mode. To roll back the HTML, set staging `UI_MODE` to `legacy` in the gateway configuration and redeploy the gateway. Keep both internal API contracts and UI Workers deployed so already-open upstream tabs can still load assets and use their APIs. Switch the same setting back to `upstream` and redeploy when the checks pass. Do not deploy `apps/worker/wrangler.jsonc` to the gateway-owned staging hostname as a rollback shortcut.

These gateway configurations currently define staging only. Production needs separately reviewed environment-specific gateway, internal Worker, Access, D1, endpoint, and route settings; substituting `production` in the staging commands is not sufficient.

The three API Worker configurations carry the same `ENDPOINTS` and D1 settings as the board and probe. Update all of them together when an approved target changes. The endpoint synchronization generator validates each configured gateway API environment against the probe before emitting SQL. Continue to use the probe drain, registry synchronization, and VPC revision procedures above.

Apply migrations 0005 through 0008 before deploying the updated Workers. The monitoring API needs a `PROBE` service binding to the staging probe for draft tests. Set `MONITOR_MODAL` to `upstream` in the operations API environment to enable the shared monitor editor. Remove that setting and redeploy the operations API to restore the previous editor. Deploy the probe and monitoring API before enabling the editor, and deploy the gateway so monitor test requests reach the monitoring API.

## Production deployment and rollback

Before applying a production migration, capture a D1 Time Travel bookmark with the selected production database and verify its restore window. Apply additive migrations first, deploy the board, and verify the protected board before deploying and enabling the probe schedule. Check scheduled and completed checks, failure counts, and stale results in Workers Logs.

To stop checks without taking down the board, remove or disable the probe Worker's Cron Trigger using the managed deployment configuration and redeploy that Worker. Roll back a Worker deployment using a registry-aware version after confirming compatibility with the current schema and the registered endpoint definitions. Worker rollbacks do not restore D1 data. If data recovery is required, use the recorded D1 bookmark following the [Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) and coordinate the restoration because it affects all writes since that point.
