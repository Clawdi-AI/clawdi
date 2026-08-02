# Backend development

Guide for contributors working on `backend/`. Commands in this document assume
you start at the repository root unless a command changes directory.

## Local backend loop

Use the canonical local-stack runbook in
[`AGENTS.md`](../AGENTS.md#local-end-to-end) to start Postgres, configure
`backend/.env`, run migrations, start the backend, and mint a local CLI key.
This backend guide only records backend-specific commands and contributor
checks.

`pdm dev` is defined in `backend/pyproject.toml` as:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The root `docker-compose.yml` keeps only development infrastructure in Docker.
The backend process runs on the host for reload speed.

## Verification

The clean default backend test path is the Docker runner from the repository
root:

```bash
scripts/test.sh backend
# Equivalent from the backend project:
cd backend && pdm test
```

That command bind-mounts the host checkout read-only, copies it into an
isolated container workspace, runs `uv sync` inside the container, starts a
throwaway `pgvector/pgvector:pg16` Postgres service, applies Alembic migrations,
and runs pytest. It also uses fake home/cache directories backed by container
tmpfs and does not reuse the dev database.

The PDM `test` command returns to the same Docker entrypoint. Raw
`uv run pytest` remains an explicit host-local workflow only.

The host-local commands below are opt-in for fast backend iteration after you
have installed dependencies locally.

Run these before sending backend changes for review:

```bash
cd backend
uv lock --check
uv run python scripts/check_dependency_authority.py
uv run python scripts/type_governance.py owned
uv run ruff check .
uv run ruff format --check .
uv run python -m compileall app scripts tests alembic
```

## Python type governance

BasedPyright runs in standard mode from the uv development environment. The
owned-path gate is a zero-diagnostic ratchet for the small explicit `include`
list in `pyproject.toml`. CI also sends every changed `backend/app/**/*.py`
file to the fail-closed exact-path gate. The gate rejects empty, missing,
partial, or malformed analysis rather than treating it as success.

Generate the complete non-gating inventory with:

```bash
cd backend
uv run python scripts/type_governance.py inventory
```

The inventory at the initial BasedPyright 1.39.9 standard-mode baseline is:

| Area | Files | Errors |
| --- | ---: | ---: |
| `app` | 177 | 157 |
| `tests` | 111 | 177 |
| `scripts` | 11 | 2 |
| `alembic` | 54 | 4 |
| **Total** | **353** | **340** |

Warnings and information diagnostics are both zero in every area. This table
records inventory, not accepted debt: no baseline or suppression file is
used, and only the explicit zero-diagnostic owned paths gate existing code.

Done: the `owned` command exits 0 with `filesAnalyzed` equal to 3 and all
diagnostic counts equal to 0; the `inventory` command reports all four areas.

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
OpenAPI TypeScript client through the repo's pinned
`scripts/openapi-typescript.sh` wrapper, and diffs it against the committed
file. The wrapper keeps `openapi-typescript` on a compatible TypeScript 5 peer
while the workspace can use the newer TypeScript compiler. Commit generated
updates together with the backend schema change so both web and CLI callers see
the same types.

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

Admin endpoints are disabled by default. The local setup and key-minting flow is
in [`AGENTS.md`](../AGENTS.md#local-end-to-end). To exercise admin endpoints
locally, set `ADMIN_API_KEY` in `backend/.env` to your own local-only random
value and restart `pdm dev`. Do not commit or share that value.

The backend reads that value as `settings.admin_api_key`; requests must send it
in the `X-Admin-Key` header. Empty configuration returns `503`, and an
incorrect header returns `401`.

Use `/v1/admin/auth/keys` to mint local CLI keys for the dev-auth dashboard
user. The canonical command is in the local-stack runbook.

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

Global runtime configuration uses the registered `app_settings` surface. The
first setting, `clerk_cli_oauth`, is one atomic JSON value; there are no
per-user overrides or environment fallbacks. List/read/update it with the
existing admin key:

```bash
curl -sS -X PUT http://localhost:8000/v1/admin/settings/clerk_cli_oauth \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"value":{"enabled":true,"schema_version":1,"issuer":"https://clerk.example","client_id":"client_cli","application_id":"oauthapp_cli","redirect_uri":"http://127.0.0.1:18473/oauth/callback","audience":"clawdi-cloud-api","authorized_parties":["https://accounts.example"]}}'
```

Done: the command returns HTTP 200 JSON containing
`"key":"clerk_cli_oauth"` and the canonicalized whole value.

The value is strictly validated and canonicalized before the setting and its
control-plane audit event commit together. JWT signatures are verified against
`CLERK_JWT_ISSUER/.well-known/jwks.json` by default. Self-hosters can set
`CLERK_PEM_PUBLIC_KEY` as a supported networkless override; it accepts a
verbatim, escaped-newline, or base64-encoded PEM. `CLERK_SECRET_KEY` remains the
server-only key used to revoke a refresh grant. Never include either secret in
the setting. Empty `audience` and `authorized_parties` values disable binding
for those optional token claims.

## Logs in development

Backend logs go to the terminal running `pdm dev`; there is no repo-managed log
file in local development. Uvicorn prints reload and access output, and the app
uses Python `logging` with `logging.basicConfig(level=logging.INFO)` in
`app/main.py`.

`RequestTimingMiddleware` adds `X-Process-Time-Ms` to HTTP responses. Requests
at or above `SLOW_REQUEST_LOG_MS` log as `request_slow`; 5xx responses log as
`request_error`, and uncaught exceptions log as `request_failed`.

## Channel queue retention

The channels worker drains retention hourly in independently committed batches.
`CHANNEL_MESSAGE_CLEANUP_BATCH_SIZE` bounds each record kind per transaction and
`CHANNEL_MESSAGE_CLEANUP_MAX_BATCHES` bounds one run. PostgreSQL row locks with
`SKIP LOCKED` let overlapping cleaners divide eligible rows without deleting
pending work or waiting on one another.

Retention ownership is deliberately narrow:

| State | Retention rule |
| --- | --- |
| Accounts, links, secrets, bindings, aliases, credentials | Durable product and authorization state; owner lifecycle controls deletion. |
| Messages and deliveries | Bound pending inbox and pending outbox rows are durable and are never time-pruned. Delivered inbound, terminal Telegram/Discord outbound, and old unbound inbound rows use the configured message horizons; delivery rows cascade with their message. |
| Debug events | Telegram/Discord operational history uses the delivered-message horizon. |
| Pair codes | Claimed/revoked codes and codes expired beyond the message horizon are ephemeral. Live codes are preserved. |
| Agent references | Active Telegram file/message authorization stays durable. Expired Discord interaction-token references and references without an active link use the message horizon. Discord documents a 15-minute interaction-token lifetime. |
| Scheduled messages | Durable pending product work; the generic retention worker does not delete it. |

Telegram documents that upstream updates are not kept longer than 24 hours,
but Clawdi does not silently apply that limit to the shared bound inbox. Discord
does not have the same coordinated drop contract, and the current schema has no
terminal drop outcome. Instead, the worker exports provider-specific pending
age/count metrics and logs a warning after
`CHANNEL_MESSAGE_STUCK_PENDING_HOURS` (24 hours by default). Alert when
`msg_router_channel_queue_stuck_pending` is non-zero or when
`msg_router_channel_retention_budget_exhaustions_total` increases. The worker's
existing `/health` readiness contract is unchanged; its process-local `/metrics`
surface exposes these gauges and counters.

Message text and provider JSON are not scrubbed ahead of row retention. Text is
active channel activity history, pending Telegram replay needs the provider
payload, and Telegram/Discord tutorial cooldowns read delivered payload markers.
Introducing a second compaction horizon would change those consumers and needs
an explicit product contract; the worker does not guess one.

Protocol references:

- [Telegram `getUpdates`](https://core.telegram.org/bots/api#getupdates)
- [Discord interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [PostgreSQL locking clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [SQLAlchemy `with_for_update`](https://docs.sqlalchemy.org/en/20/core/selectable.html#sqlalchemy.sql.expression.Select.with_for_update)

Done: with the channels worker running,
`curl -fsS http://127.0.0.1:8000/metrics | rg 'msg_router_channel_(queue|retention)'`
prints the queue and retention metric families.
