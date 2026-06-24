# Clawdi Coolify Backend

This directory contains the non-secret, OSS-safe Coolify contract for running
the Clawdi backend. The dashboard can be deployed separately; this stack covers
only backend runtime processes.

The intended Coolify shape is deliberately small:

- `clawdi-backend`: FastAPI API, one Uvicorn process, port `8000`.
- `clawdi-channels-worker`: headless native channels worker, no FQDN, no
  exposed port, and no HTTP health check.

Both Applications pull the same immutable open-source backend image used by the
self-hosted Docker Compose stack:

```text
ghcr.io/clawdi-ai/clawdi-backend:<full-git-sha>
```

The image is built from `backend/Dockerfile`. There is no separate
deployment-specific backend image.

## Files

- `.env.example`: runtime env key contract. Store real values as Coolify
  environment shared variables and wire each Application env row as
  `KEY={{environment.KEY}}`.
- `production-stack.json`: expected non-secret Application shape, image source,
  command, storage mounts, deployment tag, and operational constraints. It is a
  public template, not a live production value dump.
- `audit_stack.py`: read-only live configuration audit. It checks Application
  shape, storage, env wiring, and optional deployment commit parity without
  printing secret values.
- `deploy_ghcr_runtime.py`: updates Docker Image Application image tags and
  queues deployments through the Coolify API.

Do not commit real env files, Coolify exports, access tokens, generated compose
snapshots, or environment-specific overlays. Local overlays such as
`infra/deploy/coolify/production-stack.local.json` and
`infra/deploy/coolify/production-stack.live.json` are ignored by git.

## Coolify Setup

Create two Docker Image Applications in the same Coolify project/environment and
attach the `clawdi-runtime` deployment tag:

1. `clawdi-backend`
2. `clawdi-channels-worker`

Configure both Applications with the fields recorded in `production-stack.json`.
Use placeholders in committed files and put environment-specific destination,
route, and host storage values in an ignored local overlay.

The API and worker intentionally receive the same env key set even when a key is
mostly used by HTTP handlers. This keeps deploy drift obvious and avoids a
second worker-specific env contract. The audit is exact about key parity:
every key in `.env.example`, including optional empty keys, must exist on each
Application as a runtime-only shared environment variable, and extra Application
env rows are treated as drift.

Coolify may return resolved values for shared env rows instead of the literal
`{{environment.KEY}}` reference. The audit verifies shared/runtime flags, key
parity, and cross-Application value digests rather than relying on the stored
value text for shared rows.

`production-stack.json` also records source/deploy Application settings such as
auto deploy, preview deploys, and container label behavior. Coolify's public
Application API may not expose every setting on every installed version. The
audit checks any setting field it can see and prints how many require manual
verification; verify the remaining settings in the Coolify UI or through a
read-only control-plane query.

Keep `clawdi-channels-worker` at one replica. The combined worker should be
operated as a singleton until every loop in `app.workers.channels` has an
explicit multi-replica lease or claim contract.

## Runtime State

PostgreSQL must provide the extensions used by Clawdi:

- `vector`
- `pg_trgm`

The self-host compose stack uses `pgvector/pgvector:pg16`. Coolify deployments
can use a Coolify resource, an external managed database, or a host database as
long as `DATABASE_URL` points to a reachable PostgreSQL 16-compatible endpoint
with those extensions available.

The default file store is local. In that mode, the API and channels worker must
mount the same persistent path at `/data/files`. If the file store is moved to
object storage later, this shared host-path requirement can be removed with the
file-store implementation change.

The backend image runs as the non-root `app` user with uid/gid `1000`. For
Coolify host-path storage, create the host directories before deployment and
make them writable by uid/gid `1000`; named Docker volumes in the self-host
compose path get the image ownership on first initialization.

```bash
install -d -o 1000 -g 1000 -m 775 <host-files-path> <host-fastembed-cache-path>
```

Containers can reach a host database through `host.docker.internal` when the
Application keeps the `--add-host=host.docker.internal:host-gateway` run option
from the stack manifest. If your database is a Coolify resource or an external
managed database, set `DATABASE_URL` to that hostname instead.

## Audit

Validate the template locally:

```bash
python3 -m py_compile infra/deploy/coolify/*.py
python3 -m json.tool infra/deploy/coolify/production-stack.json >/dev/null
```

Audit live Coolify resources without printing secret values:

```bash
COOLIFY_API_URL=https://coolify.example.com \
COOLIFY_TOKEN=... \
python3 infra/deploy/coolify/audit_stack.py \
  --stack-manifest infra/deploy/coolify/production-stack.local.json \
  --phase none
```

Audit phases:

- `none`: check shape/env/storage/tag without asserting running state.
- `api-only`: require `clawdi-backend` running, while allowing worker
  Applications to keep their current state. This checks an API-only deploy
  without pretending it changed worker runtime state.
- `live`: require all Applications running and, when `--expect-commit` is set,
  latest successful deployment history matching that full git SHA.

`--expect-commit` always checks configured Application image fields. Deployment
history is checked only in `live` phase, where every Application should have
completed a deployment. Use `--skip-deployment-commit-audit` only when
intentionally validating a live-shaped state before every Application has a
completed deployment record.

## Image Release

The image workflow publishes the same OSS images that self-hosted users can
build locally:

```text
.github/workflows/clawdi-image-release.yml
```

It always pushes `ghcr.io/clawdi-ai/clawdi-backend:<full-git-sha>`. When
`build_web=true`, it also pushes `ghcr.io/clawdi-ai/clawdi-web:<full-git-sha>`
using the explicit `NEXT_PUBLIC_*` build variables supplied to that workflow
run. The Coolify deploy step uses only the backend image because this Coolify
stack owns backend runtime processes.

Set `deploy=false` to build and publish an image without touching Coolify.
Set `deploy=true` with one of these deployment scopes. The script updates image
tags only for the Applications selected by the deployment scope:

- `api-only`: update and deploy only the API. Use this for isolated API fixes;
  workers keep running their previously configured image.
- `all`: update all Applications, then deploy API first and workers second.
  Use this for normal live releases so the API and worker run the same image
  commit.

After deployment, the workflow audits the live Coolify configuration with
`audit_stack.py`. `api-only` dispatches audit with `--phase api-only`; `all`
dispatches audit with `--phase live --expect-commit <full-git-sha>`.

Automatic releases can be enabled after the Coolify stack is the live runtime.
When `Backend CI` succeeds on `main`, `.github/workflows/clawdi-image-release.yml`
checks whether backend image inputs changed. If they did, and the repository
variable `CLAWDI_COOLIFY_AUTO_DEPLOY` is set to `true`, the workflow builds the
backend image, deploys the `all` scope through Coolify, waits for completion,
and runs the live audit. If backend image inputs did not change, the automatic
path runs a live audit without publishing or deploying a new image.

The workflow uses the public `production-stack.json` template by default, which
is safe because deploy only needs the app names, roles, and deployment tag to
resolve live Coolify resources. Environment-specific audits should use an
ignored local overlay with the real destination and storage values.

The API start command runs `alembic upgrade head` before Uvicorn starts. Keep
migrations backward-compatible and short enough for the API health-check startup
budget, or run long data migrations manually before deploying the image.
