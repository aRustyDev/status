# Run a Status Page preview browser

From a trusted checkout with the repository dependencies installed, take each selector and exact 40-character commit from the **Branch previews** deployment summary. A routine run uses remote headless Chromium and a staging viewer. The launcher verifies `/api/v1/auth/me`, its role, and the resolved commit before opening each UI. Supply one selector and commit to `open`, or two pairs to `compare`.

```sh
node scripts/preview-browser.mjs compare "$FLAG_A" "$SHA_A" "$FLAG_B" "$SHA_B" --path /
```

On a provisioned Mac this command resolves the staging viewer through its service account. Start the owner with an empty environment to reproduce a cold start after locking the 1Password desktop app.

```sh
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  node scripts/preview-browser.mjs open "$FLAG_A" "$SHA_A" --path /
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
2. Set `DEPLOYMENT_ENVIRONMENT=staging`, `PREVIEW_BROWSER_ORIGIN=https://status.sow.foo`, and `PREVIEW_BROWSER_CLIENT_ID` on the staging operations, status, and monitoring API Workers with the new auth code. Add `previewBrowserOrigin` and `previewBrowserClientId` to the protected branch settings for each preview environment. Deploy the updated gateway and regenerate the target releases. The fixed app identity has ID `preview-browser` and role `viewer`. Its credentials are independent of deployment verification and production.
3. On the runner Mac, sign in to the provisioning account in 1Password and run `scripts/preview/macos/install-runner.sh` once. This installs a signed helper under `~/Library/Application Support/Status Preview Browser/`, creates **Status Preview Browser Runner** with 30-day expiry and `read_items` on the project vault, and saves its bootstrap token in the macOS login Keychain. Running setup again checks the existing account. The provisioning account for this pilot is `my.1password.com`.
4. For hosted sessions, supply a Browser Rendering – Edit credential in `BROWSER_RUN_API_TOKEN`. With the Mac helper configured, the launcher can also use the existing Wrangler login. Cloudflare authentication has its own expiration. On another runner, inject its service-account token through that runner's secret store and run `op run --env-file scripts/preview/browser-access.env.refs -- node scripts/preview-browser.mjs ...` with the Browser Run credential supplied separately. [Access secret references](../scripts/preview/browser-access.env.refs)

The Mac helper uses a fresh 1Password CLI configuration directory for every lookup, disables its cache and desktop unlock integration, and reads the one staging viewer item. The browser owner receives the Access credentials and account ID. The service-account token stays between the Keychain helper and 1Password CLI. The macOS login Keychain must be accessible to the logged-in runner. To check the service identity and visible vault after locking 1Password, run:

```sh
"$HOME/Library/Application Support/Status Preview Browser/status-preview-vault" verify
```

For rotation or decommissioning, revoke the old service-account token in 1Password and remove the Keychain generic password with service `dev.arusty.status.preview-browser.1password` and account `Status Preview Browser Runner`. Run setup again to provision its replacement. If a provisioning operation is interrupted, check 1Password for the account before replacing an incomplete Keychain record. The Access viewer token has its own rotation schedule.

The browser context sends `X-Status-Preview` for the chosen selector. The gateway echoes `X-Status-Preview-Commit` for the selected release. Each context has independent browser storage. Dev and Stage previews within an environment can share a database. Schema previews have dedicated databases. To revoke this pilot, remove the viewer policy from staging and revoke its service token and project-vault runner access. [Reusable skill](../.agents/skills/preview-browser/SKILL.md) · [Preview deployment settings](branch-previews.md)
