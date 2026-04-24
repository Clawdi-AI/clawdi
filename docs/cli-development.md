# CLI development

Guide for contributors hacking on `packages/cli/`. Commands below are run from the repo root unless noted.

## Running the CLI locally

Four ways to exercise the CLI, ordered from fastest inner loop to
closest-to-end-user:

| When you want to… | Use |
| --- | --- |
| Iterate on a command with instant reload | `bun run packages/cli/src/index.ts <args>` |
| Verify the bundled output + bin wrapper | `bun --cwd packages/cli run build` then `node packages/cli/bin/clawdi.mjs <args>` |
| Exercise a globally-installed CLI from source | `bun link` (see below) |
| Simulate an `npm publish` | `bun pm pack` (see below) |

Read-only local commands (`skill init`, `config *`, `status --json` while
unauthenticated) work without a backend. Anything that hits the API
(`auth login`, `setup`, `push`, `pull`, `doctor`, `skill install/list/rm`,
`memory *`, `vault *`, `run`) targets `$CLAWDI_API_URL`, which defaults to
the baked-in production URL for release builds and `http://localhost:8000`
for dev builds (`bun run dev` / `build:dev`).

## Link (`bun link`) — simulated global install

```bash
cd packages/cli
bun run build          # bin/clawdi.mjs imports ../dist/index.js
bun link               # register @clawdi/cli for linking

# In any other directory
bun link @clawdi/cli
which clawdi           # ~/.bun/install/global/.../clawdi
clawdi --version
```

Re-run `bun run build` after every source change — the bin wrapper always
executes the compiled bundle.

Clean up:

```bash
bun unlink @clawdi/cli    # in the other directory
cd packages/cli && bun unlink   # in the package
```

## Pack (`bun pm pack`) — simulated publish

Catches bugs that only show up in the tarball an npm user actually
installs (missing `files` entries, absent `LICENSE`, stale `dist/`,
workspace deps leaking into `dependencies`, …):

```bash
cd packages/cli
bun run build
bun pm pack                                  # → clawdi-cli-0.1.0.tgz
tar -tzf clawdi-cli-0.1.0.tgz | head   # inspect contents
bun install -g ./clawdi-cli-0.1.0.tgz
clawdi --version
bun uninstall -g @clawdi/cli
rm clawdi-cli-*.tgz
```

## Install into a dockerized agent

End-to-end smoke: install the packed CLI *inside* a real agent image,
chat with the agent so it produces real session data, then have clawdi
read it back. Catches install-time issues (missing runtime deps, Bun /
libc compatibility, workspace deps leaking into `dependencies`) and
adapter-versus-real-data drift that the fixture tests can't.

Example with Hermes (`nousresearch/hermes-agent`). Prerequisite:
`OPENROUTER_API_KEY` in your shell — Hermes's default provider.

```bash
# 0. Pack the CLI on the host.
cd packages/cli
bun run build
bun pm pack                # → clawdi-cli-0.1.0.tgz

# 1. Start the container. The upstream ENTRYPOINT bootstraps
#    $HERMES_HOME and launches the Hermes TUI as PID 1 — we leave it
#    idle (never `docker attach`) and chat via fresh `docker exec`
#    sessions instead, so Ctrl-C can never kill the container.
#    Two -e flags below are upstream workarounds, not clawdi config:
#      OPENROUTER_API_KEY — Hermes's default LLM provider
#      PATH               — upstream ships the `hermes` shim in
#                           /opt/hermes/.venv/bin, which isn't on the
#                           default PATH; without this, entrypoint.sh's
#                           `exec hermes` fails and the container dies
#    Linux only: add --add-host=host.docker.internal:host-gateway
docker run -dit --name hermes \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -e PATH=/opt/hermes/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  nousresearch/hermes-agent

# 2. Chat with Hermes so state.db accumulates real sessions. Each
#    exec opens a fresh hermes instance sharing /opt/data/state.db;
#    Ctrl-C / quit exits only this session, PID 1 keeps the container
#    alive so state persists.
docker exec -it hermes hermes

# 3. Copy tarball in, install Bun + CLI.
docker cp clawdi-cli-*.tgz hermes:/tmp/
docker exec hermes bash -lc '
  apt-get update -qq && apt-get install -y -qq curl unzip
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo "export PATH=\$HOME/.bun/bin:\$PATH" >> ~/.bashrc
  bun install -g /tmp/clawdi-cli-*.tgz
'

# 4. Verify. `host.docker.internal` resolves to your host (auto on
#    Docker Desktop). `HERMES_HOME=/opt/data` is baked into the image
#    as an ENV, so the adapter finds the SQLite automatically.
docker exec hermes bash -lc '
  clawdi config set apiUrl http://host.docker.internal:8000
  clawdi doctor                                 # Agent: Hermes should be ✓
  clawdi push --agent hermes --all --dry-run    # expect the session count you just chatted
'

# 5. Cleanup.
docker rm -f hermes
rm clawdi-cli-*.tgz
```

Two image-specific wrinkles worth knowing:

- **`HERMES_HOME=/opt/data`** is baked into the image (not `~/.hermes`).
  clawdi's `getHermesHome()` reads `$HERMES_HOME` first, so the adapter
  picks up the right path without extra config.
- **The `hermes` shim lives in `/opt/hermes/.venv/bin/`**, not
  `/usr/local/bin/`. That's an upstream Dockerfile oversight — the
  `-e PATH=...` above is a workaround; a proper fix would be an
  `ENV PATH=/opt/hermes/.venv/bin:$PATH` in the upstream Dockerfile.

Without an API key, `hermes` still launches but can't respond; you'd
validate installation and adapter `detect()` but not session parsing.

## Running the backend

Full-pipe commands need the Clawdi Cloud backend on `:8000`. PostgreSQL
(with `pgvector` + `pg_trgm`) must be running first — see the root
README for setup details.

```bash
cd backend
uv sync       # install Python deps
pdm migrate   # alembic upgrade head
pdm dev       # uvicorn app.main:app --reload on :8000
```

Once it's up, a canonical smoke loop:

```bash
clawdi auth login     # paste an API key from the web dashboard
clawdi setup          # register this machine + install the built-in skill
clawdi doctor         # all ✓ means the full pipe is wired up
clawdi push --dry-run # preview what push would upload
```

## Typecheck / test / build

```bash
bun install
bun run --cwd packages/cli typecheck   # tsc --noEmit
bun run --cwd packages/cli test        # ~160 tests, < 3s
bun run --cwd packages/cli build       # produces dist/
```

## Testing

All tests run with `bun test` (< 3s for the full suite, ~160 tests) and never
touch the network, your real `~/.clawdi`, or a real agent install. They're
designed to be safe to run on every file save.

### Layers

| Layer | What it covers | Lives in |
| --- | --- | --- |
| Unit | Pure libs: `api-client` retry/errors, `config`, `sanitize`, `frontmatter`, `source-parser`, `tty`, `version` | `tests/*.test.ts` |
| Adapter regression | Per-agent `collectSessions` / `collectSkills` / `writeSkillArchive` against pre-built fixture `$HOME`s | `tests/adapters/*.test.ts` |
| Command regression | `push` / `pull` / `doctor` / `update` / `skill init` with `globalThis.fetch` mocked; assert golden payloads and filesystem state | `tests/commands/*.test.ts` |
| Process smoke | Spawn `bun src/index.ts <args>` — catches bundle / import-level breakage the in-process tests can't see | `tests/smoke.test.ts` |
| Release checklist | Manual; see below | — |

### Fixtures

Synthetic `$HOME` directories for each agent live under
`tests/fixtures/{claude-code,codex,hermes,openclaw}/`. They're regenerated by
one script:

```bash
bun scripts/generate-fixtures.ts
```

Each fixture mirrors the real agent's on-disk layout with enough structure
to exercise every parser branch (tokens, message roles, multiple sessions,
`projectFilter`), and every fixture includes a `skills/node_modules/…` (and
equivalent) sentinel so the adapter tests assert `SKIP_DIRS` actually
filters. The root `.gitignore` has explicit negation rules that keep these
sentinels committed despite `node_modules/` being globally ignored.

Shape:

- `claude-code/` — JSONL with 5 entries (user/assistant messages + usage blocks); `skills/demo` + `skills/node_modules` (SKIP_DIRS sentinel)
- `codex/` — single rollout JSONL under `sessions/YYYY/MM/DD/`: `session_meta` + `turn_context` + `response_item` messages + `event_msg` token_count; `skills/demo` + `skills/.system` (dot-prefix skip) + `skills/node_modules` (SKIP_DIRS)
- `hermes/` — SQLite `state.db` with 3 sessions (plain-string model, JSON-blob model, empty); `skills/core/demo` (nested) + `skills/node_modules/bad` (verifies SKIP_DIRS applies during recursion, not just top-level)
- `openclaw/` — `sessions.json` index + `<id>.jsonl` transcript (with a `model_change` event); `skills/demo` + `skills/node_modules` (SKIP_DIRS)

Fixtures are committed (not regenerated on every test run). Regenerate only
when an upstream agent's on-disk format changes and a test breaks.

### Running tests

```bash
bun test                              # everything (~160 tests, < 3s)
bun test tests/adapters/              # adapter layer only
bun test tests/commands/push.test.ts  # just push regression
bun run test:watch                    # watch mode
```

## Release checklist (manual)

Before publishing `@clawdi/cli`:

1. `bun test` passes
2. `bun run build` produces a `dist/` that `node bin/clawdi.mjs --version` runs
3. On a machine with each agent actually installed, run:
   - `clawdi setup --yes` — registers every detected agent + installs the bundled `clawdi` skill + wires up MCP where possible
   - `clawdi doctor` — expects all ✓
   - `clawdi push --agent claude_code --dry-run` (sanity: session count looks right)
   - `clawdi push --agent codex --dry-run`
   - `clawdi push --agent hermes --dry-run` (will warn about no project filter; needs Bun)
   - `clawdi push --agent openclaw --dry-run`
4. `clawdi teardown --agent claude_code --yes` then re-run `clawdi setup --agent claude_code --yes` — verifies the inverse cleanly removes env file + bundled skill + MCP entry, and re-setup restores everything
5. `clawdi mcp` launched from a real Claude Code `.mcp.json`; call `memory_search` and see a response
