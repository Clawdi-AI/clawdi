<h1 align="center">Clawdi</h1>

<p align="center">
  <strong>The best home for all your AI agents — Projects, sessions, memory, skills, cron jobs, and app connections.</strong>
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
  <a href="https://deepwiki.com/Clawdi-AI/clawdi">Docs</a> ·
  <a href="https://www.npmjs.com/package/clawdi">npm</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/ai-providers.md">AI Providers</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#cli-reference">CLI Reference</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

<p align="center">
  <img src="docs/images/dashboard-preview.png" alt="Clawdi dashboard" width="900">
</p>

<p align="center">
  <a href="https://www.star-history.com/#Clawdi-AI/clawdi&Date">
    <img src="https://api.star-history.com/svg?repos=Clawdi-AI/clawdi&type=Date" alt="Clawdi star history chart">
  </a>
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
- Background sync daemons installed and started for every registered agent
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
- **Project sharing** — Share read-only Project access from the dashboard or CLI, accept it from a share page or CLI inbox, and explicitly attach accepted Projects to Agents when they should be used at runtime.
- **Session sync** — Push local session history to the dashboard for review and recall.
- **Vault secrets** — Store secrets server-side, commit only `clawdi://` references, and resolve them at runtime.
- **AI Providers** — Define model providers once, keep keys in env/Vault/auth profiles, and render verified Codex or Hermes runtime config without proxying BYOK model traffic.
- **App connections** — Hook agents into Notion, Gmail, Drive, Calendar, Linear, GitHub, and more from the dashboard. Tools show up inside every connected agent automatically over MCP.
- **MCP tools** — Memory, vault, and connector tools served through the Model Context Protocol so any MCP-aware agent can use them.

In practice — teach one agent something:

```text
remember that this repo uses Bun for TypeScript and PDM for backend scripts
```

Later, in a different agent or a fresh session, ask "what package manager should I use here?" — it can call Clawdi memory search and answer from your actual context instead of guessing.

Run a fullstack dev command with vault references without putting plaintext secrets on disk:

```bash
printf '%s\n' "$OPENAI_API_KEY" | clawdi vault set OPENAI_API_KEY --stdin
clawdi vault import --vault prod --section stripe --project personal --yes .env.stripe
echo "OPENAI_API_KEY=clawdi://project/<project-id>/vault/default/field/OPENAI_API_KEY" > .env.clawdi
clawdi run --dry-run --env-file .env.clawdi -- npm run dev
clawdi run --env-file .env.clawdi -- npm run dev
clawdi read clawdi://project/<project-id>/vault/default/field/OPENAI_API_KEY
clawdi inject --dry-run --in .env.clawdi --out .env.local
clawdi inject --force --in .env.clawdi --out .env.local
```

Vaults are account-level key bundles. Projects attach to a Vault to use the same shared key set. `clawdi vault set`, `clawdi vault import`, `clawdi vault rm`, and `clawdi vault list` print the concrete Project target or exact references that include the Project ID. `vault set` supports `--value` and `--stdin` for scripts; `vault import` supports `--vault`, `--section`, `--project`, and warns about skipped invalid dotenv identifiers. Use `clawdi vault attach <vault> --project <project>` to make an existing Vault available in another Project, and `clawdi vault detach <vault> --project <project>` to remove one Project's access without deleting keys. `vault rm` deletes a key from the shared Vault; when a Vault is attached to multiple Projects, it requires `--global`. Project-relative references such as `clawdi://default/OPENAI_API_KEY` still work for portable templates, but exact references are the default copy/read UX.

Agents should prefer `clawdi run --env-file .env.clawdi -- <command>` when they can launch the tool themselves. Use `clawdi inject` only for tools that must read a physical `.env.local`; generated files are written owner-only and should stay gitignored.

Use `--dry-run` on `clawdi read`, `clawdi inject`, `clawdi run`, and `clawdi vault resolve` to verify provenance without requesting plaintext values. `clawdi doctor` checks vault metadata only; it does not resolve stored secrets.

Sync a local agent CLI credential profile to another machine:

```bash
clawdi agent credentials import codex
clawdi agent credentials import claude-code
clawdi agent credentials import gh
clawdi agent credentials materialize codex
clawdi agent credentials materialize claude-code
clawdi agent credentials materialize gh
```

Credential profile sync is separate from `clawdi run`: it stores and restores a supported tool's local auth file, while `run` injects explicit `clawdi://` references into one child process. Profiles default to your stable Personal Project so `import` on one machine and `materialize` on another resolve the same namespace. They are personal backup/restore artifacts: shared Project viewers and env-bound Agent keys cannot materialize them. macOS Keychain imports are guarded behind `--source keychain` and require explicit `--keychain-service` plus `--keychain-account`; Clawdi does not guess or silently scrape credential-store items, and Keychain reads cannot use `--yes`.

Current vault storage is server-managed encryption. Clawdi avoids plaintext secrets in repo files and local templates, but the backend can decrypt stored vault values and credential profiles today. Do not treat this release as zero-knowledge.

Install a shared skill into every registered agent at once:

```bash
clawdi skill install anthropics/skills/artifacts-builder
```

## Roadmap

Today Clawdi gives individuals and read-only Project collaborators a shared layer across their agents. Two bigger bets come next.

The first is autonomy. Agents should work without you at the keyboard.

- Cron jobs for recurring agent runs.
- Remote control for agents on any of your machines.
- Automatic memory built from session history.

The second is deepening multi-player workflows beyond read-only Project sharing.

- Richer team roles and broader access controls.
- Shared memory, skills, and connections.
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
- Two generated encryption keys for vault data and MCP bridge JWTs
- **One backend process** until v1.5. The `clawdi daemon` realtime SSE fan-out lives in process memory (`backend/app/services/sync_events.py`), so a broadcast on worker A doesn't reach a daemon attached to worker B. Run a single uvicorn worker (or one gunicorn worker with `--workers 1`) behind your reverse proxy. Multi-process fan-out via Postgres LISTEN/NOTIFY ships in v1.5.

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
| `clawdi config list/get/set/unset` | Read or write CLI configuration |
| `clawdi setup [--agent <type>] [--no-daemon]` | Register local agents, install MCP, install the bundled skill, and install/start daemons by default |
| `clawdi teardown [--agent <type>]` | Remove Clawdi's local agent wiring |
| `clawdi daemon run/install/status/logs/doctor/restart/uninstall` | Run and manage the background sync daemon (`serve` remains a legacy alias) |
| `clawdi push` | Upload sessions and skills |
| `clawdi pull` | Download cloud skills into registered agents |
| `clawdi session list/extract` | Inspect local agent sessions |
| `clawdi memory list/search/add/rm` | Manage cross-agent long-term memory |
| `clawdi skill list/add/install/rm/init` | Manage portable skills |
| `clawdi project create/list/show/share/share-links/invite/invites/members/leave/unshare` | Manage Projects and read-only sharing |
| `clawdi inbox [accept/decline/forget]` | Accept invitations and share links |
| `clawdi agent projects list/attach/detach/move` | View the fixed Agent Project and manage attached Projects |
| `clawdi agent credentials import/materialize` | Sync local CLI credential profiles for Codex, Claude Code, and GitHub CLI; explicit Keychain import requires service/account options |
| `clawdi ai-provider ...` | Manage portable model providers, auth refs, Codex OAuth/profile auth, tests, and provider-only export/import |
| `clawdi runtime render/apply/inspect` | Preview AI Provider runtime projections, apply verified Codex/Hermes config, and inspect runtime state |
| `clawdi project folder link/status/unlink` | Link a local folder to a Project for vault reference selection |
| `clawdi vault set/list/import/attach/detach/rm` | Manage encrypted secrets, Project access, and copy exact references |
| `clawdi read <clawdi://...>` | Explicitly print one vault reference value |
| `clawdi inject --in <file> --out <file>` | Render `clawdi://` references into templates |
| `clawdi run --env-file <file> -- <cmd>` | Run a command with explicit vault references resolved |
| `clawdi doctor` | Diagnose auth, agent paths, vault, and MCP config |
| `clawdi update` | Install the latest CLI version (`--check` only reports) |
| `clawdi mcp` | Start the MCP stdio server used by agents |

Auto-update is enabled by default for all newer releases, including majors. Human CLI invocations update the global CLI in the background; installed daemons check on their own cadence, install silently, then let launchd/systemd restart them onto the new code. Disable both with `CLAWDI_NO_AUTO_UPDATE=1` or `clawdi config set autoUpdate false`.

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
- **Agent MCP tools look stale** - Run `clawdi setup --agent <type>` again, then `clawdi daemon restart --all`.

## License

MIT. See [`LICENSE`](LICENSE).
