# Docker Compose

Run these commands from the repository root. Copy the example configuration and set the production secrets before starting:

```sh
cp .docker/dev/.env.example .env
# Edit .env; set JWT_SECRET and VAULT_ENCRYPTION_KEY.
docker compose --project-directory . --env-file .env -f .docker/compose.yml up -d
```

The base file pulls the configured published image and stores data and backups in named volumes. Use the same Compose options for `pull`, `logs`, `stop`, and other commands. The project directory keeps Compose's project name based on the checkout directory. If an existing deployment used a different project name, set `COMPOSE_PROJECT_NAME` to that name to continue using its volumes.

To build the image from this checkout, add `-f .docker/dev/compose.yml` before the Compose command and use `up -d --build`. See [development setup](dev/README.md) and the [deployment guide](../docs/src/deployment.md).
