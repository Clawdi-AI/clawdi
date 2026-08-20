# Backend development

Guide for contributors working on `backend/`. Commands in this document assume
you start at the repository root unless a command changes directory.

## Clerk lifecycle subscription

Standalone Clawdi lazy-creates a Clerk user only after a verified JWT is used;
do not subscribe `user.created`. Configure the direct signed webhook endpoint
`POST /v1/webhooks/clerk` for exactly `user.updated` and `user.deleted`.
`user.updated` refreshes the current `banned` value from Clerk's Backend API
and reversibly gates all Clawdi authentication, including API keys;
`user.deleted` remains an irreversible tombstone followed by cleanup. Session,
organization, messaging, and billing webhooks are intentionally unsupported.

Set `CLERK_WEBHOOK_SIGNING_SECRET`, `CLERK_SECRET_KEY`, and
`CLERK_JWT_ISSUER`. Backend API calls use the pinned Clerk API version
`2026-05-12`.

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
throwaway production-pinned PostgreSQL 18.4 service with pgvector 0.8.6, checks
its runtime contract, applies Alembic migrations, and runs pytest. It also uses
fake home/cache directories backed by container tmpfs and does not reuse the
dev database.

The PDM `test` command returns to the same Docker entrypoint. Raw
`uv run pytest` remains an explicit host-local workflow only.

The host-local commands below are opt-in for fast backend iteration after you
have installed dependencies locally.

Run these before sending backend changes for review:

```bash
cd backend
uv lock --check
uv run python scripts/check_dependency_authority.py
uv run python scripts/outbound_api_governance.py
# Load the locked optional SDK only for its direct-import type audit.
uv sync --frozen --no-install-project --extra mem0
uv run python scripts/type_governance.py owned
uv run python scripts/type_governance.py strict
uv run python scripts/type_governance.py exceptions
uv run ruff check .
uv run ruff format --check .
uv run python -m compileall app scripts tests alembic
```

## Python type governance

BasedPyright runs from the uv development environment. The owned gate covers
all 185 production modules in standard mode and applies strict mode to 183 of
them. CI also sends every changed `backend/app/**/*.py` file to the fail-closed
exact-path gate. The gate rejects empty, missing, partial, or malformed
analysis rather than treating it as success. Its production-file discovery is
dynamic, so a new `app/**/*.py` module cannot silently fall outside the gate.

The default development and test dependency set intentionally omits Mem0. Type
audits install the locked `[mem0]` optional extra explicitly so BasedPyright can
inspect the adapter's official lazy imports; the optional extra remains the
single dependency authority for that SDK.

Generate the complete non-gating inventory with:

```bash
cd backend
uv run --extra mem0 python scripts/type_governance.py inventory
```

The current CI Python 3.14 non-gating BasedPyright 1.39.10 inventory is:

| Area | Files | Errors |
| --- | ---: | ---: |
| `app` | 185 | 0 |
| `tests` | 138 | 615 |
| `scripts` | 13 | 2 |
| `alembic` | 65 | 4 |
| **Total** | **401** | **621** |

Warnings and information diagnostics are both zero in every area. This table
records inventory, not accepted debt: no baseline or suppression file is
used. Non-production counts may vary in a host-local environment with a
different interpreter; the production `app` result is the zero-diagnostic
invariant. Every first-party production module is clean in its owned gate.

The strict-equivalent production audit reports 34 diagnostics across one
retained standard-mode adapter and one runtime-observation compatibility
module with byte-frozen symbols; the other 183 production files are
strict-clean. The five reviewed SDK boundary owners have these exact gates:

| SDK boundary | Gate / diagnostics | Locked upstream and first-party normalization |
| --- | --- | --- |
| `core/sentry.py` | strict / 0 | `sentry-sdk==2.68.0`; typed `Event`/`Hint` enter one recursive object boundary, credential-shaped keys are redacted, and no SDK response enters application state. |
| `services/composio.py` | strict / 0 | `composio==0.20.0`, `composio-client==1.43.0`, `mcp==2.0.0`; generated request types and exact first-party Pydantic wire models cover every consumed SDK/MCP result, while SDK error families map to sanitized domain failures. |
| `services/file_store_s3.py` | strict / 0 | `boto3==1.43.67`, `botocore==1.43.67`, `boto3-stubs==1.43.67`, `boto3-stubs-full==1.43.67`, and `botocore-stubs==1.43.67`; the all-in-one generated service bundle resolves the complete public `boto3.client` overload while the S3 literal overload returns the generated `S3Client`. The runtime construction call is unchanged, and the adapter validates operation metadata, error payloads, `StreamingBody`, and bytes before returning. |
| `services/memory_provider_mem0.py` | standard / 19 | Optional `mem0ai==2.0.18` publishes no `py.typed`; strict-mode missing-stub and Unknown diagnostics stay localized to the two official lazy import blocks and the five public operation callables. Construction uses the public `MemoryClient` path, each consumed operation is checked for existence and callability, and strict Pydantic wire models validate add/search/list/count/get/delete results before domain conversion. See the [official export](https://github.com/mem0ai/mem0/blob/v2.0.18/mem0/__init__.py) and [client source](https://github.com/mem0ai/mem0/blob/v2.0.18/mem0/client/main.py). |
| `services/postgres_listener.py` | strict / 0 | `asyncpg==0.31.0`, `asyncpg-stubs==0.31.3`; listener callbacks accept a validated string payload only, and connection/listener failures map to `PostgresListenerError`. |

The five Boto distributions use their latest common public patch, 1.43.67:
[boto3](https://pypi.org/pypi/boto3/1.43.67/json),
[botocore](https://pypi.org/pypi/botocore/1.43.67/json),
[boto3-stubs](https://pypi.org/pypi/boto3-stubs/1.43.67/json),
[boto3-stubs-full](https://pypi.org/pypi/boto3-stubs-full/1.43.67/json), and
[botocore-stubs](https://pypi.org/pypi/botocore-stubs/1.43.67/json).
The generated base stubs declare both public `boto3.client("s3")` and
`Session.client("s3")` as returning `S3Client`. With only the S3 extra,
BasedPyright also sees unresolved return types in the same overload set for
services whose generated packages are absent, so strict mode reports the
member as partially Unknown. The official all-in-one bundle supplies those
generated return types, including its 1.43.67 `mypy_boto3_s3` module. The
standalone [S3 distribution](https://pypi.org/pypi/mypy-boto3-s3/1.43.66/json)
is published separately and currently ends at 1.43.66, while the
application keeps boto3's public default-session construction path unchanged.
The official botocore 1.43.67 and formerly pinned 1.43.62 S3 models have the
same `PutObject`, `GetObject`, `HeadObject`, and `DeleteObject` operation
shapes used by this adapter. Their only transitive shape difference for those
operations is the unused `Expires` field (`string` versus `timestamp`); the
adapter neither sends nor consumes it, so the common-version pin does not
change its Bucket, Key, Body, ContentType, status, or stream contract.

No local SDK stub or mirrored overload is used to hide diagnostics.
`STANDARD_ONLY` contains exactly Mem0, and the owned production exclusion set
is empty. The exception audit pins the remaining per-file strict diagnostic
counts (Mem0 19, runtime-observation compatibility 15), so either added
debt or a typing improvement fails until the exact allowlist is reviewed. The
public `S3ObjectStoreClient` protocol is a first-party storage facade, not a
substitute type for boto: the adapter itself retains the generated official
`S3Client`.

`app/routes/sessions.py` is separately listed in
`RUNTIME_OBSERVATION_COMPATIBILITY_ONLY`. The module owns canonical Clawdi
`/v1` APIs; it is not a legacy or Hosted v1 deployment module. Its 15 strict
diagnostics occur only inside three repository byte-frozen pre-v2
runtime-observation and heartbeat compatibility symbols:

| Frozen symbol | Pinned strict diagnostics |
| --- | --- |
| `_runtime_desired_provider_binding` | 8: `reportMissingTypeArgument` 1, `reportUnknownArgumentType` 4, `reportUnknownParameterType` 1, `reportUnknownVariableType` 2 |
| `_enabled_runtime_names` | 6: `reportMissingTypeArgument` 1, `reportUnknownArgumentType` 1, `reportUnknownMemberType` 1, `reportUnknownParameterType` 1, `reportUnknownVariableType` 2 |
| `_bounded_runtime_observed` | 1: `reportUnknownVariableType` 1 |

BasedPyright strict selection is file-scoped, so the byte freeze prevents an
honest source-level fix for the bare `dict` annotations without changing those
symbols. The exception audit therefore resolves every diagnostic line to its
top-level AST symbol and requires the exact per-symbol rule counts above. A
diagnostic outside those symbols, a rule change, added debt, or stale debt all
fail the gate. No baseline, suppression, adapter stub, or redundant wrapper is
used to hide the remaining compatibility boundary. Hosted v1 product and
deployment infrastructure are outside this repository and are not part of the
exception.

Done: `owned` reports 185 files and `strict` reports 183 files, with every
diagnostic count equal to zero; `exceptions` reports the exact 34-diagnostic
strict debt above; `inventory` reports all four areas above.

## External API import ownership and contracts

`scripts/outbound_api_governance.py` mechanically parses import statements in
all 185 production modules. It requires exact equality for the 26 third-party
import roots and 14 reviewed external/network import families, and confines
SDKs with dynamic or incomplete upstream typing to five first-party boundary
owners. A new or stale root or owner fails until it is explicitly reviewed.
Unreviewed stacks including `requests`, `aiohttp`, `urllib3`,
`urllib.request`, `http.client`, `grpc`, `ftplib`, `imaplib`, `poplib`,
`smtplib`, `telnetlib`, and `xmlrpc.client` are rejected in production code.

This AST check is deliberately only an import and ownership inventory. It does
not resolve receivers, aliases, calls, lexical scopes, or control flow, and it
does not claim to statically interpret arbitrary Python. Those semantic safety
claims instead come from the BasedPyright owned/strict gates above, official
SDK types or pinned official source, typed request construction, runtime
validation of every consumed response, narrow sanitized exception mapping, and
contract tests using real official clients, models, or transports.

Mem0 is the only standard-mode production adapter, and its exact file and
strict diagnostic count are ratcheted by `type_governance.py`; the import
inventory prevents dynamic SDKs from gaining another owner. S3 uses the
strict-clean generated official client/stubs and validates metadata, error
bodies, streams, and returned bytes. Mem0 calls the pinned public
`MemoryClient`, keeps its untyped operation results as `object`, and validates
every consumed result with strict Pydantic wire models. Tests exercise the
official S3 model/pins and the real Mem0 client over an official HTTPX
transport. No scanner-side inferred type, homemade upstream protocol,
suppression, or unchecked provider response is accepted as evidence.

The maintained boundary contracts are:

| Provider / boundary | Typed request boundary | Response normalization and failure mapping |
| --- | --- | --- |
| Clerk JWT/JWKS and Backend API (`core/auth.py`, `routes/clerk_webhooks.py`, `routes/cli_auth.py`) | Typed JWT claims, fixed algorithms/audience/issuer, Clerk API-version headers, and explicit request bodies | `PyJWK` plus `ClerkUserResponse`/`ClerkAuthorityResponse`/JSON adapters; invalid keys, payloads, HTTP, and lifecycle states fail closed through sanitized auth or 502/503 mappings. |
| Codex/Clerk OAuth (`routes/ai_providers.py`, `services/codex_oauth.py`, OAuth attempt/revoke services) | First-party dataclasses, bounded form fields, `JsonObject`, and secret-bearing request fields | Bounded `TypeAdapter` JSON parsing and required token fields; pending/rate-limit/provider/network states map without provider body leakage. Revocation consumes status only. |
| Discord and Telegram REST (`channel_routers/shared.py`, `channel_routers/telegram.py`, `services/channels.py`) | `JsonValue` payloads and provider-specific command/message shapes | Success requires exact `ok`, message/application/command ids, names, and command type where used. Malformed 2xx responses become controlled 502s; rate-limit and provider failures retain established sanitized mappings. Telegram file proxying is an intentional authority-checked opaque byte/status path. |
| Discord Gateway (`services/discord_gateway_worker.py`) | Pinned `websockets==17.0.1` frames are emitted from typed first-party gateway payloads | Every received frame crosses `TypeAdapter[JsonValue]` and exact opcode/sequence validation; protocol/network errors remain inside the reconnect boundary. |
| WhatsApp first-party sidecar (`services/whatsapp_native_transport.py`) | Typed runtime commands and recursively encoded `JsonValue` node payloads | Response JSON is size-bounded and validated into mappings with exact required booleans, ids, events, and runtime status; unavailable/rejected/protocol errors are distinct and redacted. |
| Generic AI provider probes and agent webhooks (`services/ai_provider_connection.py`, `services/channel_webhooks.py`, `services/safe_public_http.py`) | SSRF-pinned public URLs, typed headers, and `JsonValue` request bodies | Bounded bytes plus exact provider-shape JSON validation for probes; webhook delivery intentionally consumes status only. DNS/TLS/connect/timeout/size errors use narrow first-party classes. |
| OpenAI-compatible embeddings and extraction (`services/embedding.py`, `services/memory_extraction.py`) | Official `openai==2.52.0` request models, fixed 768 dimensions, generated chat params, and strict JSON schema | Exactly one finite 768-vector or one non-empty completion is required, then Pydantic validates the extraction domain. Official API exception subclasses map to sanitized 502/503 semantics. |
| Local FastEmbed (`services/embedding.py`) | Locked `fastembed==0.8.0` model name and a single-string batch | The SDK iterable is normalized to exactly 768 finite real floats; malformed vectors and documented model/runtime failures become `EmbeddingUpstreamError`. |
| GitHub Contents/raw downloads (`services/skill_installer.py`) | Parsed owner/repo/ref/path and HTTPS-only GitHub URLs | Strict Pydantic Contents entries, exact raw-host/repo/ref prefix, UTF-8, response and archive size caps; 404 is the only absence fallback and all other failures are sanitized. |
| Composio generated SDK, high-level session API, and MCP (`services/composio.py`) | Generated `AuthConfigCreateParams`/`ConnectedAccountCreateParams`, typed domain arguments, and first-party MCP session data | Every consumed generated model is revalidated by an exact first-party Pydantic wire model; MCP results are revalidated by official MCP models. SDK families map to `ComposioFailure` without leaking secrets/details. |
| S3 (`services/file_store_s3.py`) | Generated `S3Client` operations with typed bucket/key/bytes/content type | Every consumed operation validates 2xx response metadata; `StreamingBody`, error payloads, and body bytes are strict-validated and streams always close. Botocore/client failures become `S3ObjectStoreError` or exact not-found. |
| Mem0 (`services/memory_provider_mem0.py`) | The pinned official `MemoryClient` signatures accept typed messages, filters, metadata, pagination, and ids | Strict Pydantic add/search/list/get/count models require real ids and field types; delete must still return a JSON object even though its contents are status-only. Missing SDK, transient/network, provider, and malformed-response failures map to distinct sanitized first-party errors. |
| PostgreSQL notifications (`services/postgres_listener.py`) | Typed DSN/channel/callback inputs and pinned asyncpg listener signatures | Notification payload must be a string before leaving the adapter; registration/connection/close failures become `PostgresListenerError`. |
| Sentry (`core/sentry.py`) | Typed configuration and official event/hint types | Recursive redaction is applied before SDK delivery; Sentry produces no response consumed by Clawdi domain code. |

Run the executable import inventory and its direct invariant tests with:

```bash
cd backend
uv run python scripts/outbound_api_governance.py
uv run pytest -q tests/test_outbound_api_governance.py
```

Backend tests require a real PostgreSQL database with `pgvector` and `pg_trgm`
available. The pytest fixtures read `DATABASE_URL` and do not create or migrate
the schema for you; the database must already be at this branch's Alembic head.

Long-lived shared test databases rot because other branches migrate or stamp
them differently. The reliable pattern is a throwaway Postgres on a free port:

```bash
POSTGRES_IMAGE="$(<config/postgres-image.txt)"
CID=$(
  docker run --rm -d \
    -e POSTGRES_USER=clawdi \
    -e POSTGRES_PASSWORD=clawdi_test \
    -e POSTGRES_DB=clawdi_test \
    -p 127.0.0.1::5432 \
    "$POSTGRES_IMAGE"
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
uv run python scripts/check_postgres_runtime.py
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
| Pair codes | Claimed/revoked codes and long-expired pending codes use the short unbound-message horizon (24 hours by default). Live codes are preserved. |
| Agent references | Active Telegram file/message authorization stays durable. Discord interaction-token references expire after 20 minutes; references without an active link otherwise use the delivered-message horizon. |
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

Queue gauges include only currently deliverable authority: the Account, Link,
and Binding must be active, unarchived, and identity-consistent. Historical rows
under retired authority do not create false stuck alerts. Account-scoped pending
outbound rows remain visible when they do not require a Link.

Message text and non-secret provider JSON are not scrubbed ahead of row
retention. Text is active channel activity history, pending Telegram replay
needs the provider payload, and Telegram/Discord tutorial cooldowns read
delivered payload markers. The narrow exception is Discord interaction
credentials: Discord documents a 15-minute token lifetime, so after a five-minute
safety margin the worker deletes the corresponding Agent references and removes
only the root interaction `token` or `INTERACTION_CREATE` `d.token` field. The
remaining message/content/context and dedupe tombstone stay intact, including
for pending rows. The hourly worker removes eligible secrets on its next sweep;
`msg_router_channel_retention_secret_scrubs_total` records completed scrubs and
the retention-budget metric exposes a backlog that outlives the per-run bound.

Retention selects use dedicated partial/composite indexes for their fixed
provider/state predicates and oldest-first columns. The indexes are created
concurrently so migration does not block live channel writes.

Protocol references:

- [Telegram `getUpdates`](https://core.telegram.org/bots/api#getupdates)
- [Discord interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [PostgreSQL locking clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [SQLAlchemy `with_for_update`](https://docs.sqlalchemy.org/en/20/core/selectable.html#sqlalchemy.sql.expression.Select.with_for_update)

The channels-worker role is non-proxied. Port 8000 is the worker process-local
health/metrics listener, not an externally routed API endpoint. When running
that process directly, or from inside its container/network namespace,
`curl -fsS http://127.0.0.1:8000/metrics | rg 'msg_router_channel_(queue|retention)'`
prints the queue and retention metric families.
