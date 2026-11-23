# Plan for the staging status page

Serve Better Status Page’s original React status page at `/` and its original admin console at `/admin/`. Keep both behind Cloudflare Access and point them at a same-origin Workers API under `/api/v1/`. The initial staging deployment served the purpose-built `apps/board` UI; the current rehearsal state is recorded below. The upstream apps are already in the repo. Their Vite base paths set the public URLs. The gateway maps those URLs to each build as described in check 8. [Current Worker config](../../apps/worker/wrangler.jsonc#L9) · [Status app config](../../apps/status/vite.config.ts#L8) · [Admin app config](../../apps/admin/vite.config.ts#L8)

## Workers and routing

| Worker | Responsibility |
|---|---|
| **Gateway** | Own the staging hostname. Verify Access identity, check the origin of browser writes, and route requests to the UI and API Workers. |
| **Status UI** | Serve the upstream `apps/status` build at `/`. |
| **Admin UI** | Serve the upstream `apps/admin` build at `/admin/`, including direct links to console pages. |
| **Status API** | Serve the board layout, component health, published incidents, maintenance, and available uptime history from D1. |
| **Operations API** | Manage components, incidents, maintenance, local user roles, and audit history. Preserve version checks and atomic audit writes. |
| **Monitoring API** | Manage HTTP check settings, expose the deployment-approved destination list, and serve check diagnostics to the admin console. |
| **Probe** | Keep running scheduled HTTP checks and recording results. Retain the existing private-network binding here. |

Only the gateway gets a hostname. It uses Service Bindings to reach the other Workers and passes verified identity to the APIs. The APIs enforce permissions for their own operations. Both frontends use the same `/api/v1/` origin, and the services share the existing D1 database with one migration owner. [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/binding/) · [HTTP Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/) · [RPC Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)

## What works at cutover

| Upstream area | Enabled | Visible but greyed out |
|---|---|---|
| **Status page** | Upstream layout and theme, overall and component health, incident updates, planned maintenance, and uptime charts backed by retained probe data | Subscriptions and history ranges beyond retained data |
| **Admin dashboard and monitors** | Service health, incident and maintenance summaries, approved HTTP check configuration, and available probe history | Run-now checks, unsupported monitor types, arbitrary destinations, and dependency editing |
| **Incidents and maintenance** | Draft, publish, update, and resolve incidents. Schedule, edit, end, or cancel one-time maintenance. | Incident templates, subscriber notifications, and recurring maintenance |
| **Administration** | Existing user role changes and audit history | User invitations and password management, page builder, branding editor, reports, notification integrations, imports, API tokens, and backups |

Use a server-provided capability list to drive the disabled states. Keep controls in their upstream locations and explain their unavailability in accessible text. Gate unsupported routes, reads, and writes, including secondary requests made after a form saves. Role checks apply separately, so a viewer can read the board and an operator can publish incidents without gaining admin permissions.

## Cutover decisions and staging checks

Use a viewer session for the reader and separate operator and admin sessions for writes. Run the checks on the protected staging hostname with identifiable test records. Each checkbox needs a recorded outcome, the deployed gateway version, and the relevant UI, HTTP, or audit evidence. Unchecked items below remain open for the current candidate; historical results do not by themselves approve the updated build.

### 1. Show unknown health when an enabled check goes stale

Carry the Worker's effective component health through the Status API. A missing sample, a sample older than three check intervals, or an endpoint fingerprint mismatch makes the check **Unknown**. Show that state on the card and in the overall headline when all other components are healthy. A known degradation, outage, or active incident still takes precedence. Reserve **All operational** for a nonempty board whose visible components are all operational. [Worker health calculation](../../apps/worker/src/index.ts#L139) · [Upstream headline](../../apps/status/src/App.tsx#L254)

- [ ] Start with a healthy board, then use a staging fixture with one enabled check whose last success is older than three intervals. Confirm the API, card, and headline report unknown. Repeat before the first sample. Verify that a manual outage takes precedence and that a fresh matching success restores the healthy headline once the outage clears.

### 2. Make the incident form's two actions explicit

Require an opening update and label the submit action **Save as draft** or **Publish**. Honor the selected initial status on both the incident and its opening update. In the upstream UI's API, commit the incident, opening update, component links, and create audit entry in one D1 batch. For immediate publication, set the published state and record the publish audit entry in that batch. Publishing a saved draft uses its ID and the version the operator saw. Confirm success in the form only after the chosen action commits. [Upstream incident form](../../apps/admin/src/pages/Incidents.tsx#L531) · [Existing incident mutations](../../apps/worker/src/index.ts#L219)

- [ ] As operator, save a draft with a distinctive opening message. Confirm one create audit entry and that a viewer cannot see the incident in the reader or its API. Publish that same draft and verify one publish entry and the same message and service links on the reader. Create a second incident directly with **Publish** and initial status **Identified**. Verify immediate visibility, one opening update with that status, and one create and one publish entry. An empty opening update must leave both incident and audit counts unchanged.

### 3. Save only the monitor settings the user can change

Give component details and HTTP check configuration separate save actions in the monitor screen. Operators can edit a component's name, manual health, and order. Admins can also configure its HTTP check using the deployment-approved destination list. Each action sends one versioned mutation for the edited record. Gate notification-channel, dependency, and action-link writes as well as their controls and reads. The respective APIs enforce these permissions. [Upstream monitor save](../../apps/admin/src/components/monitors/MonitorFormModal.tsx#L230) · [Worker role checks](../../apps/worker/src/index.ts#L182)

- [ ] With browser network recording on, edit a component as operator and an approved check as admin. After each save, verify a success message, one mutation, one audit entry, and the saved value after reload. The trace should contain zero notification, dependency, or action-link writes. Verify HTTP 403 for a viewer's component edit and an operator's check edit, with no data or audit changes. A stale edit from a second tab must return 409 and preserve the first save.

### 4. Keep both HTTP contracts available through rollback

Keep the current board on its existing `/api/v1/` routes, including the UUID-based `/api/v1/public/status` response with `components`. Route the upstream clients through a distinct same-origin prefix, `/api/v1/bsp/`, including `/api/v1/bsp/public/status` with `monitors` and numeric IDs. Both contracts use the same Access identity and D1 records. Persist unique numeric aliases per entity type, backfill existing UUIDs, and allocate aliases for new records written through either contract. Preserve relationship IDs and optimistic versions across both views. [Current board client](../../apps/board/src/main.tsx#L72) · [Upstream status client](../../apps/status/src/App.tsx#L160)

Roll out the gateway with both API routes before changing which UI it serves. Rollback switches the HTML back to the registry-aware board while both APIs and both builds' hashed assets remain reachable for open tabs. Keep the migrated D1 database and scheduled probe in service throughout the rehearsal.

- [ ] Leave a legacy board tab open across the switch. Fetch status from that tab and from a new reader tab and compare the same component by name, UUID, and numeric alias. Create and publish an incident in the new console. Switch HTML back, open the legacy board afresh, and post an update there. Verify both still-open clients can refetch the incident, its update, and its service links. Switch forward and confirm the numeric alias, UUID, audit sequence, and ongoing probe samples survived both switches.

### 5. Attribute uptime to the check configuration that produced it

For reader charts and admin diagnostics, select results for the component's check ID **and** its current `config_version`. Retargeting the check or moving it to another component starts a new series. Report empty buckets and a null uptime percentage until that version has samples. Use the probe's 14-day retention limit for chart ranges, including the reader cards that currently request 30 days. Keep earlier rows for their normal retention period. [Result keys](../../apps/worker/migrations/0002_checks.sql#L17) · [Check reconfiguration](../../apps/worker/src/index.ts#L332) · [Probe retention](../../apps/probe/src/index.ts#L110)

- [ ] Record a failing sample for a fixture check on service A. Move the same check to service B with a different approved destination and expected success. Before its next scheduled result, verify both views for B show no samples and no percentage. After the first success, verify only B's new sample contributes. Compare against the two D1 configurations and check that ranges beyond 14 days are disabled.

### 6. Generate a layout that can show incidents and planned work

Generate monitor nodes in D1 component order, followed by top-level `incidents` and `maintenance` nodes with `filter: 'all'`. These blocks expose published incident history and future one-time maintenance even when every component is healthy. Keep drafts and cancelled windows out of reader responses. [Layout node types](../../packages/shared/src/types/layout.ts) · [Reader maintenance query](../../apps/status/src/App.tsx#L189)

- [ ] With components operational, resolve a published fixture incident and schedule a future window. Load `/` as a viewer. Verify both titles are visible in their respective blocks, the layout contains both top-level nodes, and the maintenance request succeeds. Check the incident timeline and the window's start time. At the scheduled boundaries, verify the window moves from upcoming to active to past. Cancel a separate future window and verify it disappears from the reader.

### 7. Use Cloudflare Access for both frontends

Use the verified identity lookup behind `/api/v1/auth/me` for both the reader and the console, exposing it through the upstream API prefix as well. Replace upstream password, setup, and logout flows. Both clients send `X-Requested-With: XMLHttpRequest` on API fetches and recognize an HTTP 401 from Access even when the body has no application error code. On expiry, hide protected data, offer sign-in, and retain the operator's unsaved form in memory for the same identity. Explicit sign-out clears local session state and navigates to `/cdn-cgi/access/logout`. [Reader session handling](../../apps/status/src/App.tsx#L81) · [Reader sign-out](../../apps/status/src/components/AccountMenu.tsx#L38) · [Cloudflare Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

- [ ] Expire a staging test session with the reader open and an unsaved admin edit. Trigger a read and a save. Verify both receive 401 and offer sign-in, and that the refused save produces no audit entry. Reauthenticate as the same operator and submit the preserved edit once. In separate fresh sessions, select **Sign out** from each frontend and verify navigation to Access logout. Before signing in again, confirm that an AJAX read from each signed-out session receives 401.

### 8. Mount the admin build at its public path

Keep Vite's base at `/admin/`. Have the gateway redirect `/admin` to `/admin/` and strip exactly one `/admin` prefix from the request it forwards to the Admin UI Worker. For example, public `/admin/assets/<chunk>.js` resolves to `/assets/<chunk>.js` in `apps/admin/dist`. The browser keeps the public URL for React Router. Serve the admin index for console navigations, return 404 for missing assets, and route `/api/` requests before either UI fallback. [Admin Vite config](../../apps/admin/vite.config.ts#L8) · [Cloudflare SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)

- [ ] In a fresh authenticated operator session with the browser cache disabled, open `/admin`, then directly load and refresh `/admin/monitors`. Verify the redirect, the rendered monitors screen, and successful JavaScript and CSS responses with the correct content types, including the lazy-loaded monitors chunk. A missing `/admin/assets/` chunk must return 404, and an unknown API route must return a JSON 404. Open `/` in another tab and confirm it shows the reader.

## Rollout and completion

1. Build both frontends and compare their supported screens with the pinned upstream version using matching desktop and mobile fixtures. Check keyboard access and the explanations for disabled controls. [Pinned upstream version](../../UPSTREAM.md#L3)
2. Record the staging gateway/board and probe versions, current D1 migration, endpoint registry, and representative component, incident, maintenance, user, audit, and probe records. Apply additive migrations through the existing migration owner. Deploy the internal Workers and the gateway serving the legacy HTML with both API contracts.
3. Switch staging to the upstream HTML and run checks 1–8, including the rollback and switch forward in check 4. Confirm the baseline records still resolve, the public and private scheduled checks still record samples, and a failed probe alone does not publish an incident. Follow the existing staging runbook for Access and probe verification. [Cloudflare deployment and operations](../../docs/cloudflare-deployment.md#staging-verification)
4. Keep the upstream HTML active when all eight checks pass and the results are recorded. If a check fails, switch staging HTML back to the board, retain both API routes, and repeat the staging rehearsal with the fix.

## Staging rehearsal record — November 23, 2026

An earlier rehearsal recorded the eight scenarios below. Later rollout review found two failures: disabled incident controls explained their unavailability only in tooltips, and the reader's unpositioned status blocks overlapped. Each failure caused a return to the legacy board. The fixes were deployed for retesting, but the complete rollout gate remains open and staging has returned to the legacy board. Switch to the upstream screens only after all required checks pass; return to the legacy board on any failure. The administrator role and normal Access session duration were restored after the temporary role and expiry tests. Environment-specific deployment IDs, endpoints, and detailed audit records remain in the private operational record.

Earlier rehearsal evidence:

1. Missing and stale samples displayed Unknown; manual outage precedence and recovery were verified. A later API-only follow-up confirmed the no-sample state through both API contracts; it did not repeat the reader presentation check.
2. Operator draft, publication, direct Identified publication, viewer visibility, required opening update, and audit entries were verified.
3. Operator component and administrator check edits each produced one mutation and audit entry; disallowed writes returned 403 and a stale update returned 409. Browser recording covered same-origin fetch and XMLHttpRequest traffic.
4. Both API contracts, stable aliases, incident updates across rollback, audit entries, and continued public and private probe samples were verified.
5. A moved and retargeted check began with empty history and accumulated only the new configuration's samples; earlier samples remained retained.
6. The viewer saw incident history and scheduled maintenance, including boundary transitions and cancellation. The later overlap failure was retested on the fixed reader build as described below.
7. Expired reads and saves returned 401 without a refused-save audit entry; reauthentication preserved the operator draft. Both sign-outs reached Access logout and later AJAX reads returned 401. A modal obstruction found during rehearsal was fixed and retested; the subsequent expiry-notification privacy change was later tested with an instrumented build as described below.
8. With browser caching disabled, the admin redirect, direct monitors load and refresh, JavaScript and CSS content types, missing asset and unknown API 404 responses, and reader were verified.

A read-only baseline confirmed that all four D1 migrations were applied with none pending, the endpoint registry matched its synchronization preview, and representative scheduled checks were healthy. Detailed values are retained privately.

A local synthetic-fixture comparison exercised the pinned Node and adapted Cloudflare reader, dashboard, monitors, incidents, and maintenance screens at 1440 and 390 pixels. Each pair displayed its expected page heading, with no horizontal document overflow; the reader captures used the same expanded incident state. The adapted reader's coordinate-free layout also passed real-browser non-overlap checks at both widths after expanding a long incident. These are semantic and geometry checks, not a pixel-equivalence claim or a substitute for live staging validation. `npm run test:e2e -w @bsp/status` runs the durable geometry regression. The final-build staging keyboard observations are recorded below.


### Final-build staging follow-up

The fixed live reader was inspected at 1440- and 390-pixel widths, including with an expanded incident; the reader blocks did not overlap. The fixed admin incident screen visibly explained unavailable actions. Keyboard observations are recorded below.

Before a fixture check's first sample, the final reader showed Unknown on the card and in the headline; both status APIs returned null for the last-check time. The fixture was restored afterward.

A revoked session caused an admin save to return 401, hid the protected draft, and created no audit entry. Reauthentication as the same identity recovered the draft, which was then saved. An initial attempt to trigger natural expiry did not reproduce it, and a later browser interruption prevented completion of the test. Further observations and the remaining gap are recorded below. The temporary role, normal Access duration, and fixture configuration were restored. Staging is serving the legacy board while the rollout gate is incomplete.

The CI static check passed using a temporary recovered-attestation workaround for malformed npm registry responses. npm still verifies the signatures and attestations. The recovered snapshots cannot establish whether the registry later adds or withdraws an attestation; remove the workaround when the registry endpoint is restored.


### Final-build keyboard retest

The initial mobile navigation check failed because Escape did not close the drawer, and staging was returned to the legacy board. The fixed admin build was then retested.

On mobile, Enter opened navigation with initial focus on Close, Tab moved to Dashboard, and Escape closed the drawer and returned focus to its opener. Escape also closed the maintenance dialog and returned focus to its opener; the recurring-maintenance and subscriber-notification unavailability explanations were visible.

On desktop, Tab and Shift+Tab were exercised in the incident dialog, and Escape closed it and returned focus to New Incident. The monitor menu opened with Enter and closed with Escape, returning focus to its opener. On the reader, the account menu opened with Enter and closed with Escape; the incident control responded to Enter and Space, and Tab exposed the history-bar text.

These observations do not complete session-expiry validation or determine the final rollout state.


### Session and notification follow-up

In an isolated Chrome session, a short-lived application token was issued and the team-domain session cookie was cleared. After the token expired naturally, an unsaved admin save led both the admin and reader to show session expiry. The audit count and fixture were unchanged. The original draft tab was no longer present after reauthentication, so same-session draft recovery after natural expiry remains unverified.

Separately, a diagnostic admin build set the success notification duration to zero so a real save notification remained present. Signing out in another tab caused a 401; the notification remained in the DOM with `display: none`. After reauthentication as the same identity and Continue, it returned to `display: flex`. This notification observation used an instrumented build and session revocation; it was not a natural-expiry test. The uninstrumented admin build, administrator role, and normal Access duration were restored. Staging remains on the legacy board, and the final rollout gate remains open.
