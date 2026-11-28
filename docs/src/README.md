# Status

A private engineering status board built on Cloudflare Workers, D1, and Cloudflare Access. This repository incorporates [Better Status Page](https://github.com/BElluu/BetterStatusPage); the Workers deployment serves adapted upstream React status and admin screens through a gateway, with the original focused board retained for rollback. The upstream Node application and its deployment instructions are separate; only the capabilities supported by the Workers APIs are enabled.

The board supports services, manual health, incident drafts and updates, one-time maintenance windows, viewer/operator/admin roles, and audit history. A separate scheduled Worker checks approved HTTP endpoints and stores results in D1. Public checks use HTTPS; private checks use a scoped Workers VPC Service and Cloudflare Tunnel. Check failures change service health but do not automatically publish incidents. Maintenance is displayed alongside service and incident status.

## Repository layout

- `apps/gateway` — staging gateway, internal Worker configurations, and static-asset routing.
- `apps/admin` and `apps/status` — adapted upstream React console and reader used by the Workers deployment.
- `apps/admin-node` and `apps/status-node` — pinned upstream console and reader for the Node/Docker deployment.
- `apps/board` — legacy React board retained for rollback.
- `apps/worker` — Access-verified APIs, legacy assets, and D1 migrations.
- `apps/probe` — scheduled HTTP checks and endpoint synchronization tooling.
- `apps/api` and `packages/shared` — upstream Node API and shared code.

## Build and test the Workers board

Use the Node version in `.nvmrc` and install dependencies from the lockfile:

```sh
npm ci
npm run build -w @bsp/shared
npm run build -w @bsp/board
npm run build -w @bsp/admin
npm run build -w @bsp/status
node --import tsx --test apps/gateway/test/*.test.mts
npm run typecheck -w @status/worker
npm run typecheck -w @status/probe
USE_WORKERS_D1=1 npm test -w @status/worker
npm test -w @status/probe
npx playwright install chromium
npm run test:e2e -w @bsp/board
```

The Worker tests use local D1 and the browser suite includes a Workers-runtime integration test with a test-signed Access assertion. They do not replace live Access and private-network verification. Root-level `npm run build` and `npm test` also cover the Node application and shared frontends.

## Deployment

Follow [Cloudflare deployment and operations](cloudflare-deployment.md) for Access, D1, endpoint registry, staging verification, deployment, and rollback. Protect the entire board hostname with Access. The included gateway configuration is staging-only. Production requires its own gateway and service bindings, hostname, Access policy, D1 database, and endpoint configuration.

See [UPSTREAM.md](UPSTREAM.md) and [the Better Status Page license notice](../../THIRD_PARTY_LICENSE_BetterStatusPage) for upstream attribution.
