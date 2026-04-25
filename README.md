<h1 align="center">Clawdi</h1>

<p align="center">
  <strong>The best home for all your AI agents — environments, sessions, memory, skills, cron jobs, and app connections.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clawdi"><img src="https://img.shields.io/npm/v/clawdi?style=for-the-badge&logo=npm&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/Clawdi-AI/clawdi/actions/workflows/cli-publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/Clawdi-AI/clawdi/cli-publish.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI" alt="CI status"></a>
  <a href="https://github.com/Clawdi-AI/clawdi/stargazers"><img src="https://img.shields.io/github/stars/Clawdi-AI/clawdi?style=for-the-badge&logo=github" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://clawdi.ai">Website</a> ·
  <a href="https://github.com/Clawdi-AI/clawdi">GitHub</a> ·
  <a href="https://www.npmjs.com/package/clawdi">npm</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#cli-reference">CLI Reference</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

<p align="center">
  <img src="docs/images/dashboard-preview.png" alt="Clawdi dashboard" width="900">
</p>

> Think of Clawdi as iCloud for AI agents — install once on any device, and your Claude Code, Codex, Hermes, and OpenClaw agents share the same memory, secrets, skills, sessions, and app connections. Switch frameworks or machines; nothing gets lost.

The fastest way to try it is hosted Clawdi Cloud. The whole stack is also here: MIT-licensed CLI, FastAPI backend, Next.js dashboard, database schema, migrations, and docs. Use the hosted service, self-host it, fork it, or build your own agent sync layer from the pieces.

## Quickstart

```bash
npm i -g clawdi

clawdi auth login
clawdi setup
clawdi doctor
```

That gets you:

- Browser-based login to Clawdi Cloud
- Agent auto-detection for Claude Code, Codex, Hermes, and OpenClaw
- MCP registration so your agent can call Clawdi tools
- The bundled `clawdi` skill installed into each detected agent
- A health check that verifies auth, agent paths, vault access, and MCP config

By default the CLI talks to hosted Clawdi Cloud. Want to run your own backend? See [Own the Stack](#own-the-stack).

Requires Node ≥ 22.5 (the CLI uses the built-in `node:sqlite` module).

You can also try without installing:

```bash
npx clawdi --help
```

Headless environment? Use the manual flow:

```bash
clawdi auth login --manual
```

## Why Clawdi

AI agents are still treated like isolated apps. Claude Code has one set of sessions and instructions. Codex has another. Secrets sit in shell profiles and `.env` files. Useful memories get trapped in whichever agent happened to learn them. App integrations get rebuilt from scratch every time you switch tools.

Clawdi is the shared layer underneath:

- **Cross-agent memory** — Store durable preferences, decisions, facts, and project context once. Search them from any connected agent.
- **Portable skills** — Upload or install agent instructions once, then sync them into every registered agent.
- **Session sync** — Push local session history to the dashboard for review and recall.
- **Vault secrets** — Store secrets server-side and inject them only when running a command.
- **App connections** — Hook agents into Notion, Gmail, Drive, Calendar, Linear, GitHub, and more from the dashboard. Tools show up inside every connected agent automatically over MCP.
- **MCP tools** — Memory, vault, and connector tools served through the Model Context Protocol so any MCP-aware agent can use them.

In practice — teach one agent something:

```text
remember that this repo uses Bun for TypeScript and PDM for backend scripts
```

Later, in a different agent or a fresh session, ask "what package manager should I use here?" — it can call Clawdi memory search and answer from your actual context instead of guessing.

Run a command with vault secrets without putting them on disk:

```bash
clawdi vault set OPENAI_API_KEY
clawdi run -- python scripts/ingest.py
```

Install a shared skill into every registered agent at once:

```bash
clawdi skill install anthropics/skills/artifacts-builder
```

## Roadmap

Today Clawdi gives one person a shared layer across their agents. Two bigger bets come next.

The first is autonomy. Agents should work without you at the keyboard.

- Cron jobs for recurring agent runs.
- Remote control for agents on any of your machines.
- Automatic memory built from session history.

The second is making Clawdi multi-player. Today every Clawdi belongs to one person. That's the wrong shape for teams.

- Shared memory, skills, and connections, with access controls.
- An agent-to-agent channel for handoff and ask-for-help.
- Task tracking that every connected agent can use.

We'll also keep adding adapters. Cursor, OpenCode, Amp, Pi, and others. The same memory, skills, and connections follow you everywhere.

Want any of this sooner? [Open an issue](https://github.com/Clawdi-AI/clawdi/issues). What's loud is what we build first.

## Hosted or Self-Hosted

Clawdi has two intended paths.

### Use Clawdi Cloud

Best for trying it in minutes.

```bash
npm i -g clawdi
clawdi auth login
clawdi setup
```

The published CLI defaults to the hosted API. You get the least setup friction and can focus on wiring agents, memories, skills, and vault secrets.

### Own the Stack

Best when you want to inspect, modify, self-host, or build on Clawdi.

```bash
git clone https://github.com/Clawdi-AI/clawdi.git
cd clawdi
bun install
docker compose up -d postgres
```

Then run the backend and dashboard locally:

```bash
cd backend
cp .env.example .env
pdm install
pdm migrate
pdm dev
```

```bash
cd ../apps/web
cp .env.example .env.local
bun run dev
```

Point your CLI at your local backend:

```bash
clawdi config set apiUrl http://localhost:8000
```

Local self-hosting currently expects:

- Node.js 22.5+ and Bun 1.3+
- Python 3.12 with PDM
- PostgreSQL 16 with `pg_trgm` and `pgvector`
- Clerk keys for dashboard auth
- Two generated encryption keys for vault data and MCP proxy JWTs

See [`backend/.env.example`](backend/.env.example) and [`apps/web/.env.example`](apps/web/.env.example) for the exact environment variables.

## What Is In This Repo

```text
apps/web/          Next.js 16 dashboard with Clerk auth, shadcn/ui, Tailwind v4
packages/cli/      Published `clawdi` CLI, agent adapters, and MCP server
packages/shared/   Shared API types, schemas, and constants
backend/           FastAPI backend, SQLAlchemy models, Alembic migrations
docs/              Architecture notes, scenarios, and development guides
```

The system is deliberately boring where it should be:

- FastAPI API server
- PostgreSQL for structured data and memory search
- File storage for session and skill bodies
- Local CLI state under `~/.clawdi`
- MCP stdio server spawned by each agent
- No Redis, Celery, or hidden worker fleet required for the core local stack

For the deeper map, read [`docs/architecture.md`](docs/architecture.md).

## Supported Agents

| Agent | Sessions | Skills | MCP setup |
| --- | --- | --- | --- |
| Claude Code | Yes | Yes | Automatic |
| Codex | Yes | Yes | Automatic |
| Hermes | Yes | Yes | Automatic |
| OpenClaw | Yes | Yes | Manual MCP hint where required |

Each agent has a dedicated adapter in [`packages/cli/src/adapters`](packages/cli/src/adapters). Adding another agent means implementing the same adapter shape: detect it, read sessions, read/write skills, and define how commands run with injected env.

## CLI Reference

| Command | What it does |
| --- | --- |
| `clawdi auth login` / `logout` | Authenticate this machine |
| `clawdi status [--json]` | Show auth and sync state |
| `clawdi setup [--agent <type>]` | Register local agents, install MCP, install the bundled skill |
| `clawdi teardown [--agent <type>]` | Remove Clawdi's local agent wiring |
| `clawdi push` | Upload sessions and skills |
| `clawdi pull` | Download cloud skills into registered agents |
| `clawdi memory list/search/add/rm` | Manage cross-agent long-term memory |
| `clawdi skill list/add/install/rm/init` | Manage portable skills |
| `clawdi vault set/list/import` | Manage encrypted secrets |
| `clawdi run -- <cmd>` | Run a command with vault secrets injected |
| `clawdi doctor` | Diagnose auth, agent paths, vault, and MCP config |
| `clawdi update` | Check for a newer CLI version |
| `clawdi mcp` | Start the MCP stdio server used by agents |

Every command supports `--help`.

App connections are configured in the [Clawdi Cloud dashboard](https://clawdi.ai) and surface inside agents automatically over MCP — there is no CLI command to manage them.

## Development

Install dependencies:

```bash
bun install
```

Run the web app and workspace dev tasks:

```bash
bun run dev
```

Run the backend:

```bash
cd backend
pdm dev
```

Run checks:

```bash
bun run check
bun run typecheck

cd backend
pdm lint
pdm test
```

Run the CLI from source:

```bash
bun run packages/cli/src/index.ts --help
```

Build and link the CLI locally:

```bash
cd packages/cli
bun run build
bun link
clawdi --version
```

## Troubleshooting

Run the diagnostic first:

```bash
clawdi doctor
```

Common issues:

- **`clawdi auth login` fails** - Re-run login, or use `clawdi auth login --manual` in headless environments.
- **No supported agent detected** - Install a supported agent or pass `--agent claude_code`, `--agent codex`, `--agent hermes`, or `--agent openclaw`.
- **Memory search is empty** - Add a memory first with `clawdi memory add "..."`, then verify with `clawdi memory search "..."`.
- **Local backend cannot start because `vector` is missing** - Install `pgvector` for your PostgreSQL 16 instance, or use the included Docker Compose database.
- **Agent MCP tools look stale** - Run `clawdi setup --agent <type>` again and restart the agent.

## License

MIT. See [`LICENSE`](LICENSE).
