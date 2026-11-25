# Cloudflare static fallback

Static fallback keeps a saved status-page snapshot in a private R2 bucket. Administrators can enable publication, set the refresh interval, check storage access, and publish immediately from the Static fallback page. The page reports the most recent attempts and the last successful publication. The snapshot contains the same reader data as the live Cloudflare page, including up to 14 days of native monitor uptime. Draft incidents are excluded.

The fallback Worker runs on a route in front of the gateway's Custom Domain. It tries the live reader and status API for a navigation to `/`. If either fails or times out, it serves the last successful snapshot and its own status-reader assets. The snapshot banner shows when the copy was taken and warns when it is stale. Reloading after the live page recovers returns to the live reader. Admin routes, API requests, and writes continue to the gateway. A saved copy remains in the bucket after publication is disabled, but the Worker stops serving it.

The fallback Worker validates the Cloudflare Access JWT before serving the copy, assets, or snapshot. Protect the entire hostname with the existing Access application. Keep the bucket private, disable workers.dev and preview URLs, and do not expose its contents through a public R2 domain. Fallback serving does not require the gateway or D1, but still depends on Cloudflare Access, Workers, R2, and DNS.

## Deployment

Use a dedicated private bucket for each environment. Bind it as `FALLBACK_BUCKET` to the operations Worker and fallback Worker. The operations Worker requires `FALLBACK_READY=true` and a one-minute Cron Trigger for scheduled publication. Build the shared package and live reader normally, then build the fallback reader with `BSP_FALLBACK_BUILD=true npm run build -w @bsp/status`. Deploy the fallback Worker with the matching Access team domain and audience, the private bucket, and a service binding to the existing gateway. Place its route on the existing protected hostname in front of the gateway Custom Domain. Preserve all existing bindings, secrets, routes, variables, and schedules when deploying the operations Worker.

Verify Access denial without a session, check bucket access in the admin page, enable publication, and confirm a successful initial and scheduled push. Test a controlled gateway failure on staging and verify the saved copy at the same URL, followed by recovery on reload. Check that admin and write requests do not reach the fallback. Record deployment versions and restore the normal gateway binding after the test.

For rollback, remove the fallback Worker route to return traffic directly to the gateway Custom Domain. Disable publication in the admin page or remove the operations Worker's readiness setting and cron trigger. Retain the private bucket according to the environment's data retention policy.
