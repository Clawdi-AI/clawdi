# Backend development

Guide for contributors working on `backend/`. Commands in this document assume
you start at the repository root unless a command changes directory.

## Local backend loop

Start the development Postgres service first. The root `docker-compose.yml`
uses `pgvector/pgvector:pg16`, exposes Postgres on `127.0.0.1:5433`, and keeps
the backend process on the host for reload speed.

```bash
docker compose up -d postgres
cd backend
cp .env.example .env
uv sync
pdm migrate
pdm dev
```

`pdm dev` is defined in `backend/pyproject.toml` as:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

For local dashboard testing without Clerk, set these local-only values before
starting the backend and web app:

```dotenv
# backend/.env
DEV_AUTH_BYPASS=true
DEV_AUTH_TOKEN=dev-bypass
```

`backend/.env.example` also leaves `VAULT_ENCRYPTION_KEY` and
`ENCRYPTION_KEY` blank. Generate different local-only values before exercising
vault or MCP bridge paths:

```bash
python3 -c 'import os; print(os.urandom(32).hex())'
```

## Verification

Run these before sending backend changes for review:

```bash
cd backend
uv run ruff check .
uv run ruff format --check .
uv run python -m compileall app scripts tests alembic
```

Backend tests require a real PostgreSQL database with `pgvector` and `pg_trgm`
available. The pytest fixtures read `DATABASE_URL` and do not create or migrate
the schema for you; the database must already be at this branch's Alembic head.

Long-lived shared test databases rot because other branches migrate or stamp
them differently. The reliable pattern is a throwaway Postgres on a free port:

```bash
CID=$(
  docker run --rm -d \
    -e POSTGRES_USER=clawdi \
    -e POSTGRES_PASSWORD=clawdi_test \
    -e POSTGRES_DB=clawdi_test \
    -p 127.0.0.1::5432 \
    pgvector/pgvector:pg16
)
cleanup() {
  docker rm -f "$CID" >/dev/null
}
trap cleanup EXIT
until docker exec "$CID" pg_isready -U clawdi -d clawdi_test >/dev/null 2>&1; do
  sleep 1
done
PORT=$(docker port "$CID" 5432/tcp | sed 's/.*://')
export DATABASE_URL="postgresql+asyncpg://clawdi:clawdi_test@127.0.0.1:${PORT}/clawdi_test"

cd backend
uv run alembic upgrade head
uv run pytest -q
```

For focused work, keep the same throwaway database and run targeted tests:

```bash
cd backend
uv run pytest tests/test_agent_endpoints.py -q
uv run pytest tests/test_api_version_alias.py -q
uv run pytest tests/test_agent_default_name_migration.py -q
```

## Alembic migrations

Alembic versions live in `backend/alembic/versions/`. The current branch has a
single Alembic head; verify before adding a migration:

```bash
cd backend
uv run alembic heads
```

Conventions:

- Chain new revisions from the current head. Do not create a side head unless
  you are intentionally writing a merge revision.
- Keep `upgrade()` transactional where PostgreSQL allows it. Avoid manual
  commits inside migrations unless the lock profile requires a separate
  migration and the behavior is documented in the migration file.
- Write `downgrade()` deliberately. Reverse schema changes where practical; if
  a data cleanup cannot be perfectly reversed, keep the schema downgrade safe
  and explain the irreversible part in the migration comments.
- Add a focused migration test when a revision performs data backfills, complex
  PostgreSQL DDL, compatibility cleanup, or an irreversible operation. Existing
  migration tests load the migration module, run real Alembic operations through
  `Operations(MigrationContext.configure(...))`, and isolate scratch tables in a
  temporary schema.

## Generated API client

`packages/shared/src/api/api.generated.ts` is generated from FastAPI OpenAPI.
Never hand-edit it.

When backend request or response schemas change:

```bash
# Terminal 1
cd backend
pdm dev

# Terminal 2, from repo root
bun run generate-api
cd backend
uv run python scripts/check_generated_api.py
```

`scripts/check_generated_api.py` imports the FastAPI app, generates a temporary
OpenAPI TypeScript client with `bunx openapi-typescript`, and diffs it against
the committed file. Commit generated updates together with the backend schema
change so both web and CLI callers see the same types.

## Local database inspection

If Alembic cannot locate a revision on the persistent dev database, the Docker
volume was likely stamped by another branch; reset it with
`docker compose down -v`, then restart Postgres and rerun `pdm migrate`.

For the default dev database:

```bash
psql postgresql://clawdi:clawdi_dev@localhost:5433/clawdi
```

That command requires the `psql` client on your host. If it is not installed,
use the repo's compose service instead:

```bash
docker compose exec postgres psql -U clawdi -d clawdi
```

For a custom async SQLAlchemy URL, strip the `+asyncpg` driver when invoking
`psql`:

```bash
psql "${DATABASE_URL/+asyncpg/}"
```

Useful tables while debugging local setup, sync, auth, and session uploads:

```sql
select id, clerk_id, email, skills_revision, created_at
from users
order by created_at desc
limit 10;

select id, user_id, machine_name, agent_type,
       registration_key is null as explicit_identity,
       default_project_id, last_seen_at
from agent_environments
order by created_at desc
limit 10;

select id, user_id, environment_id, key_prefix, label,
       scopes, revoked_at, last_used_at
from api_keys
order by created_at desc
limit 10;

select id, user_id, environment_id, local_session_id,
       project_path, status, last_activity_at, updated_at
from sessions
order by updated_at desc
limit 10;
```

## Local admin API

Admin endpoints are disabled by default. To exercise them locally, set
`ADMIN_API_KEY` in `backend/.env` to your own local-only random value and
restart `pdm dev`. Do not commit or share that value.

The backend reads that value as `settings.admin_api_key`; requests must send it
in the `X-Admin-Key` header. Empty configuration returns `503`, and an
incorrect header returns `401`.

Mint a local API key for the dev-auth dashboard user. Use the same
`ADMIN_API_KEY` value that your local backend read from `backend/.env`:

```bash
export ADMIN_API_KEY="<value-from-backend-env>"
curl -sS -X POST http://localhost:8000/v1/admin/auth/keys \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"target_clerk_id":"dev_browser","label":"local-cli"}' \
  | jq -r .raw_key
```

Register an explicit local agent identity through the agent-first admin route:

```bash
export AGENT_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
curl -sS -X POST http://localhost:8000/v1/admin/agents \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"target_clerk_id\":\"dev_browser\",
    \"agent_id\":\"${AGENT_ID}\",
    \"machine_id\":\"local-debug\",
    \"machine_name\":\"Local Debug\",
    \"agent_type\":\"codex\",
    \"agent_version\":\"dev\",
    \"os_name\":\"linux\"
  }"
```

Use `/v1/admin/agents` for new local debugging. `/v1/admin/environments`
remains a compatibility alias, but admin routes are hidden from the public
OpenAPI schema.

## Logs in development

Backend logs go to the terminal running `pdm dev`; there is no repo-managed log
file in local development. Uvicorn prints reload and access output, and the app
uses Python `logging` with `logging.basicConfig(level=logging.INFO)` in
`app/main.py`.

`RequestTimingMiddleware` adds `X-Process-Time-Ms` to HTTP responses. Requests
at or above `SLOW_REQUEST_LOG_MS` log as `request_slow`; 5xx responses log as
`request_error`, and uncaught exceptions log as `request_failed`.
