# Connect a project

Set the credential's permitted origin independently in the secret store. Keep the config and launcher in a trusted checkout. Feature branch code runs on the preview deployment. Use the project's Playwright installation; the launcher resolves it from the working directory.

```json
{
  "origin": "https://preview.example.com",
  "backend": "cloudflare",
  "auth": "access",
  "selectorHeader": "X-Preview",
  "revisionHeader": "X-Preview-Revision",
  "identity": { "path": "/api/me", "equals": { "role": "viewer", "id": "browser-viewer" } }
}
```

The origin's gateway must return the resolved revision in the configured response header on both the identity endpoint and the document. It must authorize a dedicated machine principal for the relevant app role. The optional `selectorPattern` and `revisionPattern` restrict project identifiers. The launcher attaches the selector and Access headers to requests for the configured origin. The project gateway should strip reusable credentials before forwarding to branch code. Each side supports one top-level tab and same-origin UI assets and API requests. Service workers are blocked.

Use a Cloudflare Access Service Auth policy that includes the specific service token at the preview app. Give each project and environment a separate identity. Runtime variables for the Access token are `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `PREVIEW_ACCESS_ORIGIN`. Cloudflare Browser Run separately requires `BROWSER_RUN_ACCOUNT_ID` and `BROWSER_RUN_API_TOKEN` with Browser Rendering – Edit. A read-only 1Password service account scoped to a dedicated project vault can supply these through `op run --env-file <references-file> -- node ...`. Provision its bootstrap token once in the runner's secret store. Keep Cloudflare Access administration credentials with the provisioning operator. Rotate each credential independently. [Access credentials](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) · [Browser Run](https://developers.cloudflare.com/browser-run/get-started/) · [1Password service accounts](https://developer.1password.com/docs/service-accounts/)

Use `backend: "local"` for a private dev server. For an unauthenticated development fixture, set `auth` to `none` and omit `identity` if the app has no principal endpoint. A loopback HTTPS fixture may set `allowSelfSignedLoopback: true` for its local browser context. Use synthetic credentials in this mode.
