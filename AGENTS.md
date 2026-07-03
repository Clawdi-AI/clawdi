# Clawdi

iCloud for AI Agents. Centralized management of agent sessions, skills, vault, memory, and more.

This is the canonical repo-wide instruction file for coding agents. Agent-specific
entrypoints such as `CLAUDE.md` should point here instead of duplicating these
instructions.

## Start Here

Clawdi Cloud is an OSS cross-agent sync and recall layer. The local CLI reads
agent sessions and skills from Claude Code, Codex, Hermes, and OpenClaw, syncs
them to a FastAPI backend, exposes shared memory/vault/project data, and powers
a TanStack dashboard on the same backend.

1. Read this file first, then use the linked docs below for details.
2. Keep code, comments, docs, file names, and identifiers in English.
3. Keep OSS boundaries clean: production and hosted operations are managed
   outside this repository by first-party hosted control planes; this repo does
   not contain production addresses or hosted-service runbooks.

## Project Structure

```
apps/web/          TanStack Start dashboard (Clerk auth, shadcn/ui, Tailwind v4)
packages/cli/      CLI tool (TypeScript, Bun)
packages/shared/   Shared types, constants, utilities
packages/whatsapp-baileys-sidecar/  WhatsApp channel sidecar package
backend/           Python FastAPI backend (async PostgreSQL, Clerk JWT)
docs/              Documentation, plans, scenarios
```

## Local End-to-End

This is the canonical local-stack runbook. Other docs should link here instead
of duplicating backend + web + CLI bring-up steps.

Install dependencies once:

```bash
bun install
```

Configure the local backend in terminal 1, from the repository root:

```bash
docker compose up -d postgres
cd backend
cp .env.example .env
uv sync
```

In `backend/.env`, set `DEV_AUTH_BYPASS=true`, keep
`DEV_AUTH_TOKEN=dev-bypass`, and set different local-only values for
`VAULT_ENCRYPTION_KEY`, `ENCRYPTION_KEY`, and `ADMIN_API_KEY`. Generate them
with:

```bash
python3 - <<'PY'
import secrets
for name in ("VAULT_ENCRYPTION_KEY", "ENCRYPTION_KEY", "ADMIN_API_KEY"):
    print(f"{name}={secrets.token_hex(32)}")
PY
```

In that same `backend/` shell, run migrations and the backend:

```bash
pdm migrate
pdm dev
```

In another terminal, confirm the backend and database are reachable:

```bash
curl -sS http://localhost:8000/health
```

Expected response:

```json
{"status":"ok"}
```

Start the dashboard in terminal 2, from the repository root, with matching
bypass values:

```bash
cd apps/web
cp .env.example .env.local
# Set these in .env.local:
# VITE_CLAWDI_API_URL=http://localhost:8000
# VITE_DEV_AUTH_BYPASS=true
# VITE_DEV_AUTH_TOKEN=dev-bypass
bun run dev
```

Open `http://localhost:3000`. Create an API key in the local dashboard, or mint
one through the local admin API using the `ADMIN_API_KEY` value from
`backend/.env`:

```bash
export ADMIN_API_KEY="<value-from-backend-env>"
curl -sS -X POST http://localhost:8000/v1/admin/auth/keys \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"target_clerk_id":"dev_browser","label":"local-cli"}' \
  | jq -r .raw_key
```

The command prints a `clawdi_...` API key. Paste that key into
`auth login --manual` below.

Then point the dev CLI at the local backend in terminal 3, from the repository
root:

```bash
bun run packages/cli/src/index.ts config set apiUrl http://localhost:8000
bun run packages/cli/src/index.ts auth login --manual  # paste the local API key
bun run packages/cli/src/index.ts setup
bun run packages/cli/src/index.ts doctor
```

On a machine where every supported agent is installed or detectable, expected
`clawdi doctor` output has the same shape as:

```text
clawdi doctor

  ✓ Auth — <user-id-or-email>
  ✓ API reachability — http://localhost:8000
  ✓ Agent: Claude Code — <version-or-detected>
  ✓ Agent: Hermes — <version-or-detected>
  ✓ Agent: OpenClaw — <version-or-detected>
  ✓ Agent: Codex — <version-or-detected>
  ✓ Environments — <registered-agent-types>
  ✓ Vault metadata — 0 vaults reachable
  ✓ MCP connectors — config reachable

All checks passed.
```

Agent rows reflect what is installed on the machine. If a supported agent is
not installed, `doctor` reports `not installed`; the local stack is still wired
when `Auth`, `API reachability`, `Environments`, `Vault metadata`, and
`MCP connectors` are green for the agents you registered.

Cleanup:

```bash
# Stop foreground backend/web/daemon processes with Ctrl-C.
docker compose down
```

Use a volume reset only when you intentionally want to wipe the local dev
database, for example after Alembic reports a revision from another branch:

```bash
docker compose down -v
```

## Test Suites

```bash
bun run typecheck                  # Turbo TypeScript check
bun run test                       # Turbo JS/TS tests
bun run check                      # Biome CI check
```

```bash
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli test
bun test packages/shared/src
bun run --cwd packages/whatsapp-baileys-sidecar typecheck
bun run --cwd packages/whatsapp-baileys-sidecar test
```

The canonical web verification set lives in
`docs/frontend-development.md#verification`.

Backend tests require a Postgres database migrated to this branch's Alembic
head. Use the throwaway-Postgres pattern in
`docs/backend-development.md#verification`, then run:

```bash
cd backend
uv run ruff check .
uv run ruff format --check .
uv run python -m compileall app scripts tests alembic
uv run pytest -q
```

## Key Docs

- `docs/backend-development.md` — backend dev loop, throwaway Postgres tests,
  Alembic, generated API client, local DB/admin debugging.
- `docs/frontend-development.md` — web dev loop, Bun commands, OSS build
  boundary, frontend tests.
- `docs/api-compatibility.md` — `/v1/agents`, deprecated environment aliases,
  hidden `/api` aliases, additive-only compatibility.
- `docs/clawdi-daemon-test-guide.md` — daemon e2e and manual verification.
- `docs/architecture.md` — current system map and module ownership.
- `docs/adr/0001-agent-identity-is-the-stable-domain-object.md` — Agent
  identity terminology and compatibility invariants.
- `docs/cli-development.md` — CLI-specific dev, tests, packaging, release notes.

## Repeated Gotchas

- Backend pytest does not bootstrap schema; always migrate a throwaway Postgres
  to the current branch head before running tests.
- Never hand-edit `packages/shared/src/api/api.generated.ts`; regenerate and run
  `backend/scripts/check_generated_api.py`.
- API compatibility is additive-only for released surfaces; old fields, shapes,
  status codes, and error bodies stay stable.
- Do not bulk-rewrite `/api` strings that belong to external wire formats such
  as Discord v10, BlueBubbles, OpenAI-compatible URLs, Composio, or fixtures.

## Product Terminology

- **Clawdi Cloud** is this open-source repository and product surface: CLI,
  backend, dashboard, shared packages, and docs.
- Use **hosted agents** or **hosted agent service** only as generic product
  terms for managed remote agent runtime behavior.
- The hosted agent service implementation is outside this repository. This
  repository may define API contracts, dashboard UI, and CLI behavior that
  integrate with hosted agents, but it does not contain the hosted agent runtime
  service itself.
- Do not add non-OSS repository names, checkout paths, production addresses, or
  hosted-service run details to this OSS repository.
- Avoid introducing legacy repo/path names in new examples unless the
  surrounding text is explicitly about public backwards compatibility.

## Commands

### Development

```bash
bun install              # Install all dependencies
bun run dev              # Start workspace dev servers
bun run build            # Build all workspaces
bun run typecheck        # Type-check all workspaces
```

### Code Quality

```bash
bun run check            # Biome CI check (lint + format, read-only)
bun run check:fix        # Biome check + auto-fix
```

### CLI (from repo root)

```bash
bun run packages/cli/src/index.ts --help        # Run CLI in dev
bun run packages/cli/src/index.ts sync --help   # Test subcommands
```

### Backend (from backend/)

```bash
uv sync                  # Install Python dependencies
pdm dev                  # Start FastAPI dev server
pdm migrate              # Run Alembic migrations
pdm lint                 # Ruff lint
pdm format               # Ruff format
```

## Release Management

Release operations live in `docs/runbooks/release.md`; CLI-specific release
details live in `docs/cli-development.md#releasing`; the user-facing changelog
lives in `CHANGELOG.md`.

- CLI/npm releases use `clawdi-cli-vX.Y.Z`; bump `packages/cli/package.json`
  and let `.github/workflows/cli-publish.yml` publish.
- Clawdi app/backend/web releases use `clawdi-YYYY-MM-DD` for the first UTC
  release of a day, then `clawdi-YYYY-MM-DD-2`, `-3`, and so on for
  additional releases that same day. They are created by
  `.github/workflows/clawdi-release.yml`.
- Release notes and `CHANGELOG.md` entries should be user-facing only. Include
  notable features, behavior changes, fixes, deprecations, removals, security
  notes, and user actions. Omit migrations, CI, deployment steps, refactors,
  generated files, and other implementation-only details.

## Tech Stack

- **Web**: TanStack Start, TanStack Router, React 19, Tailwind CSS v4, shadcn/ui, TanStack Query, Zustand, Clerk
- **CLI**: TypeScript, Bun, Commander
- **Backend**: FastAPI, SQLAlchemy 2.0 async, asyncpg, Alembic, Pydantic Settings
- **Database**: PostgreSQL with `pgvector` (embeddings) and `pg_trgm` (fuzzy search)
- **File Store**: S3/R2/local filesystem (sessions JSONL, skills MD)
- **Embeddings**: fastembed (local ONNX) or OpenAI-compatible API
- **Tooling**: Bun, Turbo, Biome, Ruff, TypeScript strict mode

PostgreSQL setup (including `pgvector` + `pg_trgm`) is documented in `README.md`.

## Architecture

- **Storage split**: PG for metadata, File Store (S3/R2/local) for file-type data (sessions, skills)
- **Provider pattern**: Memory uses pluggable providers (Builtin pgvector, Mem0)
- **Dual auth**: Clerk JWT for web dashboard, ApiKey for CLI
- **Vault secrets never reach the web**: `vault/resolve` endpoint only accepts ApiKey (CLI)
- **Vault data model**: Three-level Jingui-style (Vault -> Section -> Field), `clawdi://` URI references
- **Two encryption keys**: `VAULT_ENCRYPTION_KEY` (AES-256-GCM for vault data at rest) and `ENCRYPTION_KEY` (HS256 for MCP bridge JWTs) are kept separate for key separation
- **Sync state is client-side**: stored in `~/.clawdi/sync.json`, server API is stateless
- **Agent adapters**: each agent (Claude Code, Codex, OpenClaw, Hermes) has its own adapter in `packages/cli/src/adapters/`

## Data Model

Core tables: User, UserSetting, AgentEnvironment, Session, Skill, Memory, Vault, VaultItem, ApiKey

## Conventions

- All comments in code must be in English
- Use Biome for JS/TS formatting and linting
- Use Ruff for Python linting and formatting
- UI components in `apps/web/src/components/ui/` (shadcn pattern)
- Shared types in `packages/shared/src/types/`
