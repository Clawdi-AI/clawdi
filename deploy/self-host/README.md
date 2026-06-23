# Self-hosted Docker Compose

This compose file is the OSS self-host path. It is separate from the root
`docker-compose.yml`, which remains dev-only Postgres for local backend work.

The stack runs:

- `postgres`: PostgreSQL 16 with pgvector; the backend migrations create the
  required `vector` and `pg_trgm` extensions.
- `migrate`: one-shot Alembic upgrade.
- `api`: FastAPI backend on `:8000`.
- `channels-worker`: the native channels worker process.
- `web`: optional dashboard, enabled with the `web` profile.

API and `channels-worker` intentionally share the same backend image and the
same `/data/files` volume. This is the same open-source backend image contract
used by Coolify deployments: `ghcr.io/clawdi-ai/clawdi-backend:<tag>` is built
from `backend/Dockerfile`. The file store is local-only today, so splitting the
worker into a second container without a shared file volume would break session
and skill file reads.

The optional dashboard uses the matching open-source web image contract:
`ghcr.io/clawdi-ai/clawdi-web:<tag>` is built from `apps/web/Dockerfile`.
Next.js public variables are compiled into the browser bundle at image build
time, so a published web image is only correct when its baked
`NEXT_PUBLIC_*` values match the deployment. For a custom public API URL,
Clerk publishable key, or hosted-mode setting, rebuild the web image with the
matching build args instead of changing only container runtime env.

## Usage

```bash
cp deploy/self-host/.env.example deploy/self-host/.env
$EDITOR deploy/self-host/.env
docker compose --env-file deploy/self-host/.env -f deploy/self-host/docker-compose.yml up -d postgres api channels-worker
```

By default the compose file builds `backend/Dockerfile` locally and tags the
result as `ghcr.io/clawdi-ai/clawdi-backend:local`. To run a published backend
image instead, set `CLAWDI_BACKEND_IMAGE_TAG` to an available tag before
starting the stack.

To also run the dashboard:

```bash
docker compose --env-file deploy/self-host/.env -f deploy/self-host/docker-compose.yml --profile web up -d
```

With the `web` profile enabled, compose builds `apps/web/Dockerfile` locally
and tags it as `ghcr.io/clawdi-ai/clawdi-web:local`. To run a published web
image instead, set `CLAWDI_WEB_IMAGE_TAG` to an available tag whose build-time
public variables match this deployment.

The dashboard requires Clerk auth configuration. Fill both
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` before enabling the
`web` profile.

For a reverse proxy, set `PUBLIC_API_URL`, `WEB_ORIGIN`, `CORS_ORIGINS`, and
`TRUST_FORWARDED_FOR=true` in `.env`, then bind `API_HOST` / `WEB_HOST` to the
appropriate interface.
