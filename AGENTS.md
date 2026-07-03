# Clawdi

iCloud for AI Agents: CLI, FastAPI backend, TanStack dashboard, shared types,
agent adapters, memory, vault, skills, channels, and sync.

## Start Here

1. Keep code, comments, docs, file names, and identifiers in English.
2. Keep OSS boundaries clean. Hosted infrastructure is owned outside this repo
   by first-party hosted control planes; this repo must not contain hosted
   service runbooks, private addresses, or internal deployment details.
3. Maintain agent docs with [`docs/agent-docs-guide.md`](docs/agent-docs-guide.md).
4. Prefer repo-local conventions over new abstractions.

## Repository Map

```text
apps/web/          TanStack Start dashboard
backend/           FastAPI backend, async PostgreSQL, Alembic
packages/cli/      TypeScript/Bun CLI, adapters, MCP stdio server
packages/shared/   Shared types, constants, generated API client
packages/whatsapp-baileys-sidecar/  WhatsApp Baileys sidecar package
docs/              Contributor docs, ADRs, plans, scenarios
```

For architecture and ownership, read [`docs/architecture.md`](docs/architecture.md).

## Local End-to-End

Install dependencies once:

```bash
bun install
```

Terminal 1, backend:

```bash
docker compose up -d postgres
cd backend
cp .env.example .env
uv sync
python3 - <<'PY'
import secrets
for name in ("VAULT_ENCRYPTION_KEY", "ENCRYPTION_KEY", "ADMIN_API_KEY"):
    print(f"{name}={secrets.token_hex(32)}")
PY
```

Set those three generated values in `backend/.env`. Also set:

```dotenv
DEV_AUTH_BYPASS=true
DEV_AUTH_TOKEN=dev-bypass
```

Run backend:

```bash
pdm migrate
pdm dev
```

Done: `curl -sS http://localhost:8000/health` returns `{"status":"ok"}`.

Terminal 2, web:

```bash
cd apps/web
cp .env.example .env.local
```

Set:

```dotenv
VITE_CLAWDI_API_URL=http://localhost:8000
VITE_DEV_AUTH_BYPASS=true
VITE_DEV_AUTH_TOKEN=dev-bypass
```

Run:

```bash
bun run dev
```

Done: `http://localhost:3000` opens the dashboard without Clerk login.

Terminal 3, CLI:

```bash
export ADMIN_API_KEY="<value-from-backend-env>"
curl -sS -X POST http://localhost:8000/v1/admin/auth/keys \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"target_clerk_id":"dev_browser","label":"local-cli"}' \
  | jq -r .raw_key
```

Use the printed `clawdi_...` key:

```bash
bun run packages/cli/src/index.ts config set apiUrl http://localhost:8000
bun run packages/cli/src/index.ts auth login --manual
bun run packages/cli/src/index.ts setup
bun run packages/cli/src/index.ts doctor
```

Done: `doctor` shows green `Auth`, `API reachability`, `Environments`, `Vault
metadata`, and `MCP connectors`; unavailable local agents may show `not
installed`.

Cleanup:

```bash
docker compose down
```

Use `docker compose down -v` only when intentionally wiping the local database.

## Verification

Workspace checks:

```bash
bun run typecheck
bun run test
bun run check
```

Done: all three commands exit 0 and do not modify the worktree.

Backend checks:

```bash
cd backend
uv run ruff check .
uv run ruff format --check .
uv run python -m compileall app scripts tests alembic
```

Backend pytest needs a migrated throwaway PostgreSQL. Use
[`docs/backend-development.md#verification`](docs/backend-development.md#verification).
Done: `uv run pytest -q` exits 0 against that database.

Frontend checks:

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web test src/hosted/oss-clean.test.ts
bunx biome check apps/web/src
bun run --cwd apps/web build:oss
```

Done: all web commands exit 0. See
[`docs/frontend-development.md#verification`](docs/frontend-development.md#verification).

CLI checks:

```bash
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli test
bun test packages/shared/src
bun run --cwd packages/whatsapp-baileys-sidecar typecheck
bun run --cwd packages/whatsapp-baileys-sidecar test
```

Done: command output reports passing tests/typechecks.

## Owner Docs

- Backend: [`docs/backend-development.md`](docs/backend-development.md)
- Frontend: [`docs/frontend-development.md`](docs/frontend-development.md)
- CLI: [`docs/cli-development.md`](docs/cli-development.md)
- API compatibility: [`docs/api-compatibility.md`](docs/api-compatibility.md)
- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Agent identity ADR: [`docs/adr/0001-agent-identity-is-the-stable-domain-object.md`](docs/adr/0001-agent-identity-is-the-stable-domain-object.md)
- AI Providers: [`docs/ai-providers.md`](docs/ai-providers.md)
- Managed runtime: [`docs/managed-runtime.md`](docs/managed-runtime.md)
- Daemon testing: [`docs/clawdi-daemon-test-guide.md`](docs/clawdi-daemon-test-guide.md)
- Releases: [`docs/runbooks/release.md`](docs/runbooks/release.md)

## Compatibility Rules

- `/v1/agents` is canonical for Agent identity.
- `/v1/environments` and hidden `/api/*` routes are compatibility aliases.
- Session payloads still use `environment_id` as the legacy wire name for the
  stable agent id.
- API compatibility is additive-only for released surfaces.
- Do not bulk-rewrite `/api` strings; many belong to external protocols or
  fixtures. Follow [`docs/api-compatibility.md`](docs/api-compatibility.md).
- Never hand-edit `packages/shared/src/api/api.generated.ts`; regenerate it
  with the backend workflow.

Done: compatibility changes include focused backend tests for canonical and
legacy paths.

## Package Managers

- Use Bun for JavaScript/TypeScript; the repo declares `packageManager:
  bun@1.3.14`.
- Do not introduce Yarn/Corepack globally.
- Use `uv` and PDM scripts for backend workflows.

## Conventions

- Use Biome for JS/TS formatting and linting.
- Use Ruff for Python linting and formatting.
- Keep UI primitives under `apps/web/src/components/ui/`.
- Keep shared public types under `packages/shared/src/types/`.
- Store local MCP launch wrappers in `~/.agents/mcp`; Codex and Claude Code
  registrations should point at those wrappers.
- Do not store plaintext tokens or private keys in shell startup files,
  dotfiles, or repo files.
