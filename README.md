# Clawdi Cloud

> iCloud for AI Agents. Centralized management of sessions, skills, vault secrets, and cross-agent memory for Claude Code, Codex, OpenClaw, Hermes, and more.

This README covers how to run the project locally, install the `clawdi` CLI on your machine, and use the day-to-day commands. For architecture and design notes see `CLAUDE.md`.

---

## Prerequisites

- **Node.js 22+** and **[Bun](https://bun.sh) 1.3+** — web app, CLI, monorepo tooling (pinned in `package.json → engines`)
- **Python 3.12** and **[uv](https://docs.astral.sh/uv/)** (or `pdm`) — backend
- **PostgreSQL 16** with the `pg_trgm` and `pgvector` extensions (a `docker-compose.yml` is provided so you don't have to install locally)
- A **[Clerk](https://clerk.com)** account for auth (dev instance is fine)

No Redis, no Celery — background work has been removed from this codebase; the backend is a single FastAPI process.

### PostgreSQL via Docker (recommended)

```bash
docker compose up -d postgres
# Listens on localhost:5433 with database clawdi_cloud, user/pass clawdi/clawdi_dev.
```

### PostgreSQL native (macOS example)

```bash
brew install postgresql@16 pgvector
brew services start postgresql@16

createuser -s clawdi
psql postgres -c "ALTER USER clawdi WITH PASSWORD 'clawdi_dev';"
createdb -O clawdi clawdi_cloud
```

`pg_trgm` ships with PostgreSQL; `pgvector` is the `brew install pgvector` package above. Both extensions are enabled by our Alembic migrations — you don't have to `CREATE EXTENSION` manually.

If you already have Postgres running under a different user / port, skip the role creation and just edit `DATABASE_URL` in `backend/.env` to match (e.g. `postgresql+asyncpg://<you>@localhost:5432/clawdi_cloud`).

---

## Repository layout

```
apps/web/          Next.js 16 dashboard (Clerk auth, shadcn/ui, Tailwind v4)
packages/cli/      `clawdi` CLI (TypeScript, Bun, Commander)
packages/shared/   Shared types / constants between web and CLI
backend/           Python FastAPI backend (async SQLAlchemy, asyncpg, Alembic)
docs/              Design docs, scenarios, plans
```

---

## First-time setup

### 1. Clone and install JS/TS dependencies

```bash
git clone <this-repo>.git clawdi-cloud
cd clawdi-cloud
bun install
```

This installs workspace deps for `apps/web`, `packages/cli`, `packages/shared`.

### 2. Set up the backend

```bash
cd backend
cp .env.example .env

# Fill in at minimum:
#   CLERK_PEM_PUBLIC_KEY   — from Clerk dashboard → JWT public key
#   VAULT_ENCRYPTION_KEY   — generate with: python3 -c "import os; print(os.urandom(32).hex())"
#   ENCRYPTION_KEY         — same format as VAULT_ENCRYPTION_KEY
#   DATABASE_URL           — adjust if your PG isn't at the .env.example default
#                            (clawdi:clawdi_dev@localhost:5433/clawdi_cloud)
#   COMPOSIO_API_KEY       — optional, only if you want connector tools (Gmail / GitHub / etc.)

# Memory embedder is configured via env too. Default works out of the box
# (Local mode downloads ~1GB of ONNX on first use, no API key needed).
# For OpenAI / OpenRouter instead, set:
#   MEMORY_EMBEDDING_MODE=api
#   MEMORY_EMBEDDING_API_KEY=sk-...
#   MEMORY_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1   (optional)

pdm install                           # install Python deps
pdm migrate                           # apply all Alembic migrations
```

### 3. Configure the web dashboard

```bash
cd ../apps/web
cp .env.example .env.local

# Fill in:
#   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
#   CLERK_SECRET_KEY=sk_test_...
#   NEXT_PUBLIC_API_URL=http://localhost:8000  (default usually fine)
```

---

## Running locally

Two processes, two terminals:

**Terminal 1 — backend** (FastAPI on `:8000`):
```bash
cd backend
pdm dev
```

**Terminal 2 — web dashboard** (Next.js on `:3000`):
```bash
bun run dev              # from repo root
# or: cd apps/web && bun run dev
```

Open <http://localhost:3000>, sign in via Clerk, then go to the user menu → **API Keys** → create one. You'll need it to authenticate the CLI.

---

## Installing the `clawdi` CLI

The CLI is a TypeScript/Bun tool that connects a local agent (Claude Code, Codex, etc.) to your Clawdi Cloud account.

```bash
cd packages/cli
bun install              # first time only (already done by root `bun install`)
bun run build            # bundles to dist/index.js
bun link                 # exposes `clawdi` on your PATH via Bun's global bin
```

Verify:
```bash
clawdi --version
clawdi --help
```

**Rebuilding after CLI changes**: `bun run build` in `packages/cli/`. Since `bun link` symlinks to `dist/index.js`, rebuild is all that's needed — no re-link.

**During CLI development** (no rebuild loop): `bun run packages/cli/src/index.ts <command>` from repo root runs source directly.

---

## Using the CLI

### Point the CLI at your backend (if not localhost)

The CLI defaults to `http://localhost:8000`. To point at a deployed instance:

```bash
clawdi config set apiUrl https://clawdi.your-company.com

# or, one-off override without writing to disk:
export CLAWDI_API_URL=https://clawdi.your-company.com
```

Inspect / change / clear config:
```bash
clawdi config list
clawdi config get apiUrl
clawdi config unset apiUrl
```

Stored at `~/.clawdi/config.json`. The `CLAWDI_API_URL` env var always wins over the stored value.

### Authenticate once

```bash
clawdi login             # paste the API key from the web dashboard
clawdi status            # verify auth works
```

Credentials live in `~/.clawdi/auth.json` (mode 0600).

### Connect your agent

```bash
clawdi setup             # auto-detect installed agents, register each
# or target one explicitly:
clawdi setup --agent claude_code
```

This does three things per agent:
1. Registers the machine as an `AgentEnvironment` in the backend
2. Registers the clawdi MCP server with the agent (e.g. `claude mcp add-json clawdi ...`, `codex mcp add clawdi ...`, or edits Hermes's YAML)
3. Installs the bundled `clawdi` skill into the agent's skills directory so it gets memory-retrieval guidance

Supported agents: `claude_code`, `codex`, `hermes`, `openclaw`.

### Sync

Push local sessions and skills up to the cloud, or pull cloud skills down to your agents:

```bash
clawdi sync up            # upload sessions + skills from the current agent
clawdi sync down          # download cloud skills into local agent directories

# Optional flags:
clawdi sync up --agent codex --modules sessions       # specific agent + only sessions
clawdi sync up --since 2026-01-01                     # override the stored cursor
clawdi sync up --project /path/to/project             # only this project (default: cwd)
clawdi sync up --all                                  # all projects, ignore cwd filter
clawdi sync up --dry-run                              # preview, no uploads
```

When multiple agents are registered on the same machine, the interactive arrow-key picker chooses one; `--agent` skips the prompt.

### Memory (cross-agent long-term recall)

```bash
clawdi memory list                    # list all memories
clawdi mem list                       # same, shorter alias
clawdi memory search "<query>"        # natural-language search (any language)
clawdi memory add "<content>"         # store a memory
clawdi memory rm <id>                 # delete by id
```

**How memory works in your agent**: after `clawdi setup`, your agent has three MCP tools plus a `clawdi` skill that tells it when to use them:

- `memory_search` — called automatically when you reference your own context. "What do I usually use for X?" or "we discussed before how to …" auto-triggers it.
- `memory_add` — called automatically when you say "remember this" or when the agent learns a durable preference / decision.
- `memory_extract` — batch-propose memories from the current conversation. Say "extract memories" at the end of a session; the agent lists up to 5 candidates, you confirm, and only then are they saved. Works the same across Claude Code / Codex / Hermes / OpenClaw.

### Vault (secrets)

Store secrets server-side; inject them into subprocesses at runtime. Secrets never reach the web dashboard — `vault/resolve` only accepts API-key (CLI) auth.

```bash
clawdi vault set API_KEY              # prompts for the value (masked)
clawdi vault set mydb/prod/password   # three-level path: vault/section/field
clawdi vault list                     # see stored keys (values never shown)
clawdi vault import .env              # bulk import from a .env file

clawdi run -- python app.py           # run a command with vault secrets in env
clawdi run -- docker compose up
```

### Skills (portable agent instructions)

```bash
clawdi skill list                          # list synced skills in the cloud
clawdi skill add ./path/to/my-skill/       # upload a directory (must contain SKILL.md)
clawdi skill add ./my-skill.md             # upload a single file
clawdi skill install anthropics/skills     # install a skill from a GitHub repo
clawdi skill install anthropics/skills/artifacts-builder   # specific path inside a repo
clawdi skill rm <skill-key>                # remove from cloud
```

After a `skill install`, the tar.gz is also extracted into **every** registered agent's local skills directory on your machine, so you don't have to `sync down` separately.

### MCP server mode

```bash
clawdi mcp                 # runs the MCP server (stdio transport)
```

Agents don't run this directly — they spawn it via their MCP registration from `clawdi setup`. Listed here for debugging.

---

## Daily workflow (what you'll actually do)

1. Morning: open Claude Code / Codex in a project. They're already connected from the one-time `clawdi setup`.
2. Work as usual. When you tell Claude "remember that the user prefers X", it calls `memory_add`; when you later ask "what do I usually X?" in a fresh session, it calls `memory_search` automatically.
3. Before knocking off: `clawdi sync up` (or set up a cron) to push your sessions to the cloud so they appear in the web dashboard for you to review later.

---

## Command reference (cheat sheet)

| Command | What it does |
|---|---|
| `clawdi login` / `logout` / `status` | Authenticate the CLI / inspect auth state |
| `clawdi config list / get / set / unset` | Read or change CLI config (`apiUrl`, etc.) |
| `clawdi setup [--agent <type>]` | Register local agent(s), install MCP + clawdi skill |
| `clawdi sync up` | Push sessions + skills to the cloud |
| `clawdi sync down` | Pull skills from the cloud to local agent dirs |
| `clawdi vault set / list / import` | Store / list / bulk-import secrets |
| `clawdi skill list / add / install / rm` | Manage skills (cloud + local) |
| `clawdi memory list / search / add / rm` (`mem` alias) | Cross-agent long-term memory |
| `clawdi mcp` | Start MCP stdio server (invoked by agents) |
| `clawdi run -- <cmd>` | Run a command with vault secrets injected |

All subcommands accept `--help` for full options.

---

## Troubleshooting

**`clawdi login` fails with 401**
Your API key is wrong or revoked. Re-create one from the web dashboard → user menu → API Keys.

**Backend crashes on startup: "extension vector is not available"**
`pgvector` isn't installed in your PostgreSQL. On macOS: `brew install pgvector` and restart Postgres.

**Memory search in Claude Code returns empty for obvious queries**
Restart Claude Code so it re-fetches MCP tool schemas from the latest `clawdi mcp`. If it still misses, the query may genuinely not match anything embedded — check `clawdi memory search "<query>"` directly to see what the API returns.

**First `memory_search` / `memory_add` after a backend restart is slow (~10s)**
Local embedding mode (default) lazy-loads the ~1GB mpnet model on first use. Subsequent calls are <500ms. To skip the local model, set `MEMORY_EMBEDDING_MODE=api` in `backend/.env` and provide an OpenAI / OpenRouter key.

**`clawdi sync up` says "No supported agent detected"**
Run `clawdi setup` first, or pass `--agent claude_code` explicitly if auto-detection is finding the wrong directory.

**Claude Code's `memory_search` description looks stale**
You may need to `clawdi setup --agent claude_code` again — it'll now overwrite the installed skill with the latest bundled version.

---

## Contributing

- Code comments in English
- Biome for JS/TS (`bun run check`), Ruff for Python (`pdm lint`)
- Backend type hints and async/await, no sync DB calls in request handlers
- Web app follows the Next.js 16 conventions already in the repo — check `CLAUDE.md` and existing files before introducing new patterns
- `bun run check` and `bun run typecheck` must stay green before you push; a `lefthook` pre-commit hook auto-runs `biome check --write` on staged files
