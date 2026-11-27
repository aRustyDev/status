# Run a Status Page preview browser

From a trusted checkout with the repository dependencies installed, take each selector and exact 40-character commit from the **Branch previews** or **Staging preview** deployment summary. A routine run uses remote headless Chromium and a staging viewer. The launcher verifies `/api/v1/auth/me`, its role, and the resolved commit before opening each UI. Supply one selector and commit to `open`, or two pairs to `compare`.

```sh
op run --env-file scripts/preview/browser-access.env.refs -- node scripts/preview-browser.mjs compare "$FLAG_A" "$SHA_A" "$FLAG_B" "$SHA_B" --path /
```

The owner prints a run ID and stays in the foreground. From a second shell, use that run ID to inspect, capture, share on request, or close the tabs. These commands do not need 1Password.

```sh
node scripts/preview-browser.mjs inspect "$RUN" a
node scripts/preview-browser.mjs screenshot "$RUN" b /tmp/preview-b.png
node scripts/preview-browser.mjs show "$RUN" b
node scripts/preview-browser.mjs close "$RUN"
```

## Provision the staging viewer

1. Create a dedicated Access service token and authorize it with a **Service Auth** policy assigned to the staging application on `status.sow.foo`. Store its client ID, secret, and permitted origin together in a project-only 1Password vault. Give the runtime service account read access to that vault. Keep the Cloudflare provisioning token separate.
2. Set `DEPLOYMENT_ENVIRONMENT=staging`, `PREVIEW_BROWSER_ORIGIN=https://status.sow.foo`, and `PREVIEW_BROWSER_CLIENT_ID` on the staging operations, status, and monitoring API Workers with the new auth code. Add `previewBrowserOrigin` and `previewBrowserClientId` to the protected branch and manual-slot settings for each preview environment. Deploy the updated gateway and regenerate the target releases. The fixed app identity has ID `preview-browser` and role `viewer`. Its credentials are independent of deployment verification and production.
3. Supply `BROWSER_RUN_API_TOKEN` scoped to Browser Rendering – Edit and the staging `BROWSER_RUN_ACCOUNT_ID`. Configure the runner's `OP_SERVICE_ACCOUNT_TOKEN` from its own bootstrap secret store. The shipped [Access secret references](../scripts/preview/browser-access.env.refs) resolve the viewer credential without writing secret values to disk. Configure the runtime's Browser Run API token separately.

The browser context sends `X-Status-Preview` for the chosen selector. The gateway echoes `X-Status-Preview-Commit` for the selected release. Each context has independent browser storage. Dev and Stage previews within an environment can share a database. Schema previews have dedicated databases. To revoke this pilot, remove the viewer policy from staging and revoke its service token and project-vault runner access. [Reusable skill](../skills/preview-browser/SKILL.md) · [Preview deployment settings](../scripts/preview/README.md)
