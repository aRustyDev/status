# Isolated Actions editor preview

This branch-only fixture provides a headless Actions editor through a dedicated Access-protected origin. It is for synthetic test data and must not be merged into main or used for real credentials. The ordinary staging viewer and shared staging gateway remain read-only.

The ingress in `scripts/isolated-actions-editor/ingress.mjs` verifies the dedicated Access app JWT, client identity, origin, selector, and the browser's expected release. It checks the current Flagship route before using the existing private dispatcher and rejects a response with a different release. The selected Operations Worker checks the forwarded expected release before initializing a fixture or accepting an editor request. A stale headless session must be reopened using the new successful deployment summary; requests for a retired or different release fail closed.

Each new commit gets a fresh isolated schema database. The editor fixture is initialized for the authorized identity on its first request, so test records from an older release do not carry over.

Only the Actions editor, its required assets and synthetic Vault metadata, and bounded Actions CRUD routes are available. The test identity can alter only its own unlinked Actions using the synthetic destination and Vault value. The preview probe disables Actions and has no cron, and the synthetic destination's service binding is absent. This preview must not send external Actions.

The dedicated Access app must have a service-only policy and an origin-bound credential separate from the staging viewer. Store the client secret in the project secret store, never in source or logs. Rotating the service token's secret preserves its client ID; update the secret-store item and verify the new credential before ending any grace period. Monitor the token's own expiration and renew it before expiry. Replacing the token with a new client ID, changing the Access app or changing the origin requires an explicit fixture configuration update. Revoke the dedicated token and retire the isolated ingress and Access app when the fixture is no longer needed.

The ingress's local unit and dispatcher integration tests use synthetic signing keys and bindings:

```sh
node --test scripts/isolated-actions-editor/ingress.test.mjs
node --import tsx --test scripts/isolated-actions-editor/ingress-dispatcher.test.mjs
```

Use a separately controlled trusted preview-browser checkout, not code from this feature branch, to handle credentials. Take the exact 40-character revision from the successful Branch previews deployment summary. The trusted launcher must send `X-Status-Editor-Expected-Release` on every same-origin request and verify the response revision. Close the run and wait for its owner to exit. Never pass a secret on a command line.
