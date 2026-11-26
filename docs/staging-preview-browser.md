# Open a staging preview

Install the repository dependencies and Playwright's Chromium browser. Obtain the preview selector from the deployment workflow, then run:

```sh
npx playwright install chromium
node scripts/preview-browser.mjs https://status.sow.foo/ 1.0123456789abcdef0123456789abcdef
```

Replace the example URL and selector with the values returned by the deployment workflow. Sign in through Cloudflare Access in the browser window. The launcher sends the selector to the specified HTTPS origin on navigation, asset, and API requests. Each invocation opens a separate browser profile, so two previews can be used side by side. Closing the browser removes its temporary profile and extension.

For API clients, send the same `X-Status-Preview` header with every request to the staging origin, alongside the normal Access authentication. Requests without a selector reach the baseline staging deployment. Staging data is shared, so identify test records with the preview selector and leave test monitors disabled when exercising configuration changes.
