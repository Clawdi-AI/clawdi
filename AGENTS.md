# Clawdi

iCloud for AI Agents. Centralized management of agent sessions, skills, vault, memory, and more.

This is the canonical repo-wide instruction file for coding agents. Agent-specific
entrypoints such as `CLAUDE.md` should point here instead of duplicating these
instructions.

## Project Structure

```
apps/web/          Next.js 15 dashboard (Clerk auth, shadcn/ui, Tailwind v4)
packages/cli/      CLI tool (TypeScript, Bun)
packages/shared/   Shared types, constants, utilities
backend/           Python FastAPI backend (async PostgreSQL, Clerk JWT)
docs/              Documentation, plans, scenarios
```

## Commands

### Development

```bash
bun install              # Install all dependencies
bun run dev              # Start web app dev server (Turbopack)
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

- **Web**: Next.js 15, React 19, Tailwind CSS v4, shadcn/ui, TanStack Query, Zustand, Clerk
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
- **Two encryption keys**: `VAULT_ENCRYPTION_KEY` (AES-256-GCM for vault data at rest) and `ENCRYPTION_KEY` (HS256 for MCP proxy JWTs) are kept separate for key separation
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
