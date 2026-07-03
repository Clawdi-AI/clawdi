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
`DEV_AUTH_TOKEN=dev-bypass`, and set different local-only
`VAULT_ENCRYPTION_KEY` and `ENCRYPTION_KEY` values. Set `ADMIN_API_KEY` to your
own local random value if you want to mint CLI keys through the local admin API.

In that same `backend/` shell, run migrations and the backend:

```bash
pdm migrate
pdm dev
```

Start the dashboard in terminal 2, from the repository root, with matching
bypass values:

```bash
cd apps/web
cp .env.example .env.local
# Set VITE_DEV_AUTH_BYPASS=true and VITE_DEV_AUTH_TOKEN=dev-bypass in .env.local.
bun run dev
```

Open `http://localhost:3000`. Create an API key in the local dashboard, or use
`docs/backend-development.md#local-admin-api` with the `ADMIN_API_KEY` value
from your own `backend/.env`.

Then point the dev CLI at the local backend in terminal 3, from the repository
root:

```bash
bun run packages/cli/src/index.ts config set apiUrl http://localhost:8000
bun run packages/cli/src/index.ts auth login --manual  # paste the local API key
bun run packages/cli/src/index.ts setup
bun run packages/cli/src/index.ts doctor
```

## Test Suites

```bash
bun run typecheck                  # Turbo TypeScript check
bun run test                       # Turbo JS/TS tests
bun run check                      # Biome CI check
```

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web test
bun run --cwd apps/web build:oss
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli test
bun test packages/shared/src
bun run --cwd packages/whatsapp-baileys-sidecar typecheck
bun run --cwd packages/whatsapp-baileys-sidecar test
```

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
