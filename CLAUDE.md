# Clawdi Cloud

iCloud for AI Agents. Centralized management of agent sessions, skills, vault, memory, and more.

## Project Structure

```
apps/web/          Next.js 15 dashboard (Clerk auth, shadcn/ui, Tailwind v4)
packages/cli/      CLI tool (TypeScript, Bun)
packages/shared/   Shared types, constants, utilities
backend/           Python FastAPI backend (async PostgreSQL, Clerk JWT)
infra/             Docker Compose, Dockerfile
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

### Infrastructure

```bash
docker compose -f infra/docker-compose.yml up -d   # Start PostgreSQL + Redis
```

## Tech Stack

- **Web**: Next.js 15, React 19, Tailwind CSS v4, shadcn/ui, TanStack Query, Zustand, Clerk
- **CLI**: TypeScript, Bun, Commander
- **Backend**: FastAPI, SQLAlchemy 2.0 async, asyncpg, Alembic, Pydantic Settings
- **Database**: PostgreSQL (structured data + metadata)
- **File Store**: S3/R2/local filesystem (sessions JSONL, skills MD)
- **Cache**: Redis
- **Tooling**: Bun, Turbo, Biome, Ruff, TypeScript strict mode

## Architecture

- **Storage split**: PG for metadata, File Store (S3/R2) for file-type data (sessions, skills)
- **Provider pattern**: Memory uses pluggable providers (Mem0, Cognee, built-in pgvector)
- **Dual auth**: Clerk JWT for web dashboard, ApiKey for CLI
- **Vault secrets never reach the web**: `vault/resolve` endpoint only accepts ApiKey (CLI)
- **Vault data model**: Three-level Jingui-style (Vault → Section → Field), `clawdi://` URI references
- **Sync state is client-side**: stored in `~/.clawdi/sync.json`, server API is stateless
- **Agent adapters**: each agent (Claude Code, Codex, OpenClaw, Hermes) has its own adapter

## Data Model

Core tables: User, AgentEnvironment, Session, Skill, Vault, VaultItem, ApiKey, CronJob, Channel, UserSetting

## Conventions

- All comments in code must be in English
- Use Biome for JS/TS formatting and linting
- Use Ruff for Python linting and formatting
- UI components in `apps/web/src/components/ui/` (shadcn pattern)
- Shared types in `packages/shared/src/types/`
