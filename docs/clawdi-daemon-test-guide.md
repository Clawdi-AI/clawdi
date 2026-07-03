# Testing `clawdi daemon`

How to verify the current singleton `clawdi daemon` works end to end. Some
script names and log paths still say `serve`; that is historical internal
terminology. The user-facing command surface is `clawdi daemon`.

Use the canonical local-stack runbook in [`AGENTS.md`](../AGENTS.md#local-end-to-end)
before running the manual path. It covers backend, dashboard, auth bypass,
local API key minting, health checks, and cleanup.

## Prerequisites

- Postgres running on `localhost:5433` with the `clawdi` DB
  (this is the dev default; see
  [`AGENTS.md`](../AGENTS.md#local-end-to-end) for setup)
- Migrations at head: `cd backend && pdm migrate`
- All deps installed: `bun install`

## Path 1 — automated e2e

The fastest sanity check. Boots a backend on port 18765, seeds a
synthetic user, runs the daemon for ~10 seconds, asserts every
piece of the sync pipeline, then tears everything down.

```sh
scripts/serve-e2e.sh
```

What it checks:

| Step | Verifies |
|---|---|
| 1 | Backend boots and `/health` responds |
| 2 | User + agent_environment + deploy api_key seeded |
| 3 | CLI scratch dirs (`~/.clawdi/`, fake skills dir) exist |
| 4 | `clawdi daemon run` reaches `engine.start` log line |
| 5 | Local SKILL.md edit → cloud row updates within 15s |
| 6 | Cloud-side upload → local SKILL.md picks up the change |
| 7 | Server-side DELETE → daemon removes local dir within 15s |
| 8 | Heartbeat lands and `last_sync_at` is fresh (< 60s) |

Pass = `all checks passed` at the end.

Fail = the failing step's error line + tail of daemon log on
stderr. Logs persist at `/tmp/clawdi-serve-e2e-last/` for
post-mortem (overwritten on next run).

The script is hermetic: re-runnable, no leftover state. The
synthetic test user (`clerk_id = test_serve_e2e`) gets cascade-
deleted in the trap even on Ctrl-C.

## Path 2 — manual end to end

For when you want to **see** the dashboard reflect daemon state.
Three terminals.

### Terminal 1 — backend

```sh
cd backend
pdm dev
```

Leave running.

### Terminal 2 — web dashboard

```sh
bun run --cwd apps/web dev
```

Open `http://localhost:3000` and sign in via Clerk. The first
sign-in auto-creates a `users` row.

### Terminal 3 — daemon

You need three values: an `api_key` (the daemon's auth), an
`environment_id` (the env the daemon services), and a fake skill
dir to watch.

**Option A — use your real Clerk login.** Do `clawdi auth login`
and `clawdi setup` like a normal user. Skip to "Run the daemon".

**Option B — seed a synthetic user + key (no browser).** Fastest
for local iteration. Drives the same `seed_serve_test.py` the e2e
script uses, which mints the api_key directly via the service
layer (no HTTP, no Clerk):

```sh
SEED=$(cd backend && pdm run python scripts/seed_serve_test.py --label manual_test)
USER_ID=$(grep ^USER_ID= <<<"$SEED" | cut -d= -f2)
ENV_ID=$(grep ^ENV_ID= <<<"$SEED" | cut -d= -f2)
RAW_KEY=$(grep ^RAW_KEY= <<<"$SEED" | cut -d= -f2)
echo "user_id=$USER_ID env_id=$ENV_ID raw_key=${RAW_KEY:0:16}..."
```

The seeded user uses a fake `clerk_id = test_manual_test`, so it
won't collide with anyone's real login. Tear it down later with
`pdm run python scripts/seed_serve_test.py --label manual_test --teardown`.

### Run the daemon

```sh
export CLAWDI_AUTH_TOKEN="$RAW_KEY"
export CLAUDE_CONFIG_DIR=/tmp/manual-claude   # fake skills dir
mkdir -p ~/.clawdi/environments
cat > ~/.clawdi/environments/claude_code.json <<EOF
{"id":"$ENV_ID","agentType":"claude_code"}
EOF
mkdir -p $CLAUDE_CONFIG_DIR/skills/test-skill
cat > $CLAUDE_CONFIG_DIR/skills/test-skill/SKILL.md <<'EOF'
---
name: test-skill
description: manual test
---
# Test
EOF

# CLAWDI_SERVE_DEBUG=1 prints debug-level events on stderr.
CLAWDI_SERVE_DEBUG=1 bun run packages/cli/src/index.ts daemon run
```

You should see (filtered to the interesting events):

```json
{"event":"serve.boot",...}
{"event":"engine.start",...}
{"event":"watcher.mode","mode":"fs_events",...}
{"event":"sse.connected",...}
{"event":"engine.skill_pushed",...}   # initial reconcile uploads test-skill
```

### What to verify in the browser

Open `/agents/<env-id>` in the dashboard:
- A green **Daemon online** badge next to the agent name
- A **Sync daemon** card showing `Last sync: a few seconds ago`,
  `Revision seen`, `Queue depth (peak)`, `Dropped events`

Open `/skills`:
- `test-skill` shows up in the Installed list
- No conflict banner (yet)

### Trigger a push (local → cloud)

```sh
echo "# edited locally" >> /tmp/manual-claude/skills/test-skill/SKILL.md
```

Within ~1s the daemon log shows `engine.enqueue_skill_push` →
`engine.skill_pushed`. The dashboard's `/skills/test-skill` page
reflects the new content_hash on refresh.

### Trigger a pull (cloud → local)

A dashboard install (or a marketplace push) lands on the cloud
side. To simulate it from a terminal, push directly through the
project-explicit upload route. `PROJECT_ID` is the agent's
`default_project_id`:

```sh
PROJECT_ID=$(curl -s -H "Authorization: Bearer $RAW_KEY" \
  http://localhost:8000/v1/agents | jq -r '.[0].default_project_id')
echo "# edited from the dashboard $(date)" >> /tmp/manual-claude/skills/test-skill/SKILL.md
TAR=$(mktemp); ( cd /tmp/manual-claude/skills && tar czf $TAR test-skill )
curl -X POST "http://localhost:8000/v1/projects/$PROJECT_ID/skills/upload" \
  -H "Authorization: Bearer $RAW_KEY" \
  -F "skill_key=test-skill" -F "file=@$TAR"
```

The daemon log shows an SSE event arriving and rewriting
local SKILL.md within ~2s.

### Cleanup

`Ctrl-C` the daemon. Drop the test rows when you're done:

```sh
( cd backend && pdm run python scripts/seed_serve_test.py --label manual_test --teardown )
rm -rf /tmp/manual-claude
```

## Path 3 — install as a service (macOS / Linux)

If you want the daemon supervised by launchd / systemd:

```sh
clawdi daemon install
clawdi daemon status --agent claude_code
clawdi daemon uninstall  # when done
```

Logs land at `~/.clawdi/serve/logs/daemon.{stdout,stderr}.log`
on macOS and via `journalctl --user -u clawdi-serve.service` on Linux.

The control RPC listens on loopback HTTP by default:

```sh
clawdi daemon run
clawdi daemon ping
```

The default endpoint is `127.0.0.1:17654`. Pass `--host` and
`--port` on `clawdi daemon run`, `install`, `ping`, or `rotate-token`
to change it.

HTTP RPC requests require bearer-token auth by default. The CLI reads
the daemon token from `~/.clawdi/daemon/control-token`. Remote clients
can pass that token with an `Authorization: Bearer <token>` header, and
daemon commands that call the control endpoint accept
`CLAWDI_DAEMON_RPC_TOKEN` or `--token`.
Treat it as an admin token. Rotate it with
`clawdi daemon rotate-token`.

The CLI intentionally exposes specific daemon commands instead of a generic
raw RPC command. For protocol-level tests or external control clients, call
the HTTP JSON-RPC endpoint directly:

```sh
TOKEN=$(cat ~/.clawdi/daemon/control-token)
curl -s http://127.0.0.1:17654/rpc \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"methods","params":{}}'
```

Daemon control methods use short names: `ping`, `methods`, `status`,
`doctor`, `logs`, `install`, `uninstall`, `restart`, and `rotate_token`.
The user-facing CLI wrappers stay as normal commands such as
`clawdi daemon status`, `clawdi daemon doctor`, and
`clawdi daemon logs`.

Besides daemon control methods, the daemon exposes headless command methods
for `sync.push`, `sync.pull`, `vault.*`, `auth.*`, `update.*`, and
`operation.*`. Long-running commands return an operation id:

```sh
curl -s http://127.0.0.1:17654/rpc \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sync.push","params":{"cwd":"/path/to/project","agent":"codex"}}'

curl -s http://127.0.0.1:17654/rpc \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"operation.status","params":{"id":"<operation-id>"}}'
```

Vault plaintext access is opt-in. `vault.resolve` defaults to a
redacted dry-run unless the request explicitly asks for plaintext.
`vault.read` and `vault.inject` require `confirm_secret_access: true`
before rendering plaintext, and plaintext access cannot be backgrounded
into an operation log. Mutating vault calls that would otherwise prompt
must pass their non-interactive confirmation, such as `yes: true`.

Non-loopback HTTP binds are rejected unless the daemon is started or
installed with `--allow-remote` (or
`CLAWDI_DAEMON_RPC_ALLOW_REMOTE=1`). Do not expose that listener
directly on the public internet: the protocol is cleartext HTTP with an
admin bearer token. Use an SSH tunnel, a private network, or a
TLS-terminating reverse proxy.

## Troubleshooting

**`serve.no_auth`** — `~/.clawdi/auth.json` missing AND no
`CLAWDI_AUTH_TOKEN` env. Run `clawdi auth login` or set the env.

**`serve.no_environment`** — no `~/.clawdi/environments/<agent>.json`.
Run `clawdi setup`; in a single-agent runtime, set both
`CLAWDI_AGENT_TYPE` and `CLAWDI_ENVIRONMENT_ID`.

**`watcher.fs_watch_failed` → falls back to poll** — expected
inside containers / overlay-fs. The 30s poll picks up edits but
with a delay. Forced by `CLAWDI_SERVE_MODE=container`.

**`engine.heartbeat_failed`** — backend unreachable or env_id
unknown. Check `CLAWDI_API_URL` and that the env still exists
server-side.

## Legacy alias testing

Use `/v1/...` in new examples and manual checks. The hidden `/api/...` aliases
exist only for released clients built before the `/v1` prefix migration. Test
them deliberately when changing compatibility behavior; do not use them as the
default path in new documentation.

## Running `clawdi daemon` inside a managed runtime

The daemon was designed for laptops but also works inside a managed runtime
with three caveats. First-party hosted control planes can drive the dashboard's
`POST /v1/auth/keys` flow on the user's behalf to mint a deploy key bound to
the Agent, then inject that key into the runtime environment. No
backend-to-backend secret is required; the user's Clerk JWT is the conduit.

### Env vars the runtime must set

| Var | Role |
|---|---|
| `CLAWDI_AUTH_TOKEN` | Deploy key. Bypasses `~/.clawdi/auth.json` so no interactive login is needed. |
| `CLAWDI_AGENT_TYPE` | Agent adapter to load when the container has no `~/.clawdi/environments/*.json` registry. |
| `CLAWDI_ENVIRONMENT_ID` | The Agent id this single-agent runtime represents. Bypasses `~/.clawdi/environments/*.json`. |
| `CLAWDI_API_URL` | Cloud backend (for example, `https://api.example.test`). |
| `CLAWDI_SERVE_MODE=container` | Forces poll mode (overlay-fs doesn't fire fs.watch reliably). |
| `CLAWDI_DAEMON_RPC_HOST` | HTTP host for the daemon control RPC. Defaults to `127.0.0.1`. |
| `CLAWDI_DAEMON_RPC_PORT` | HTTP port for the daemon control RPC. Defaults to `17654`. Requests still require bearer token auth. |
| `CLAWDI_DAEMON_RPC_ALLOW_REMOTE=1` | Allows the daemon to bind a non-loopback HTTP RPC host. Use only behind SSH tunneling, private networking, or TLS. |
| `CLAWDI_DAEMON_RPC_TOKEN` | Optional client-side bearer token for daemon commands or external HTTP clients when the token file is not local. |

### Per-agent paths

| Agent | What you need to set |
|---|---|
| Hermes | `HERMES_HOME=<hermes-state-dir>` when the runtime does not use Hermes' default HOME path. The adapter reads SQLite via `node:sqlite` (Node 22.5+) or `bun:sqlite` — both are built-in, no native bindings to ship. |
| OpenClaw | `OPENCLAW_STATE_DIR=<openclaw-state-dir>` when the runtime does not use OpenClaw's default HOME path. `OPENCLAW_AGENT_ID=<id>` if the runtime runs a single agent personality; omit to sync every agent under `agents/`. |

### What NOT to do

- **Don't run `clawdi daemon install`** inside the runtime. Install
  is for laptop / VPS users where launchd or systemd will respawn
  the daemon. The runtime's own process supervisor should own restart behavior;
  install would write a unit file inside ephemeral runtime storage.
- **Don't expect `~/.clawdi/sessions-lock.json` to survive a runtime restart**
  unless `~/.clawdi/` is on durable storage. Without durable storage, every
  restart re-pushes every session.

### Entrypoint shape

```sh
exec clawdi daemon run
```

Set `CLAWDI_AGENT_TYPE` when the runtime does not contain a
`~/.clawdi/environments/<agent>.json` registry file.
