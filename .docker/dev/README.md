# Building the Docker image

Run these commands from the repository root:

```sh
cp .docker/dev/.env.example .env
# Edit .env; set JWT_SECRET and VAULT_ENCRYPTION_KEY.
docker compose --project-directory . --env-file .env -f .docker/compose.yml -f .docker/dev/compose.yml up -d --build
```

The local override builds `.docker/dev/Dockerfile` with the repository root as its context and tags it `better-status-page:local`. Keep the same Compose options for subsequent commands. To build the image without starting it:

```sh
docker build -f .docker/dev/Dockerfile -t better-status-page:local .
```

`Dockerfile.dockerignore` points to `.dockerignore` so Docker applies the ignore rules to this Dockerfile's repository-root build context. The root `.env` also works for a bare-metal Node installation.
