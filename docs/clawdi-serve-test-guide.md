# Testing `clawdi serve`

How to verify the daemon works on your machine, end to end. Two
paths: the **automated script** (one command, ~10 seconds) and
the **manual workflow** (lets you click around the dashboard
while it's running).

## Prerequisites

- Postgres running on `localhost:5433` with the `clawdi` DB
  (this is the dev default; see `README.md` for the full setup)
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
| 4 | `clawdi serve` reaches `engine.start` log line |
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
bun run dev
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
export CLAWDI_ENVIRONMENT_ID="$ENV_ID"
export CLAUDE_CONFIG_DIR=/tmp/manual-claude   # fake skills dir
mkdir -p $CLAUDE_CONFIG_DIR/skills/test-skill
cat > $CLAUDE_CONFIG_DIR/skills/test-skill/SKILL.md <<'EOF'
---
name: test-skill
description: manual test
---
# Test
EOF

# CLAWDI_SERVE_DEBUG=1 prints debug-level events on stderr.
CLAWDI_SERVE_DEBUG=1 bun run packages/cli/src/index.ts serve --agent claude_code
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
scope-explicit upload route — `SCOPE_ID` is the env's
`default_scope_id`:

```sh
SCOPE_ID=$(curl -s -H "Authorization: Bearer $RAW_KEY" \
  http://localhost:8000/api/scopes/default | jq -r .scope_id)
echo "# edited from the dashboard $(date)" >> /tmp/manual-claude/skills/test-skill/SKILL.md
TAR=$(mktemp); ( cd /tmp/manual-claude/skills && tar czf $TAR test-skill )
curl -X POST "http://localhost:8000/api/scopes/$SCOPE_ID/skills/upload" \
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
clawdi serve install --agent claude_code
clawdi serve status --agent claude_code
clawdi serve uninstall --agent claude_code  # when done
```

Logs land at `~/.clawdi/serve/logs/<agent>.{stdout,stderr}.log`
on macOS and via `journalctl --user -u clawdi-serve-<agent>` on
Linux.

## Troubleshooting

**`serve.no_auth`** — `~/.clawdi/auth.json` missing AND no
`CLAWDI_AUTH_TOKEN` env. Run `clawdi auth login` or set the env.

**`serve.no_environment`** — no `~/.clawdi/environments/<agent>.json`,
no `--environment-id` flag, no `CLAWDI_ENVIRONMENT_ID` env. Run
`clawdi setup` or pass `--environment-id` explicitly.

**`watcher.fs_watch_failed` → falls back to poll** — expected
inside containers / overlay-fs. The 30s poll picks up edits but
with a delay. Forced by `CLAWDI_SERVE_MODE=container`.

**`engine.heartbeat_failed`** — backend unreachable or env_id
unknown. Check `CLAWDI_API_URL` and that the env still exists
server-side.

## Running `clawdi serve` inside an agent image (clawdi-monorepo)

The daemon was designed for laptops but works inside the clawdi
agent container with three caveats. The clawdi.ai monorepo's
control plane drives the dashboard's `POST /api/auth/keys`
flow on the user's behalf to mint a deploy key bound to the env,
then bakes the resulting key into the pod's environment. No
backend-to-backend secret involved — the user's Clerk JWT is the
only conduit.

### Env vars the container must set

| Var | Role |
|---|---|
| `CLAWDI_AUTH_TOKEN` | Deploy key. Bypasses `~/.clawdi/auth.json` so no interactive login is needed. |
| `CLAWDI_ENVIRONMENT_ID` | The env this pod represents. Bypasses `~/.clawdi/environments/*.json`. |
| `CLAWDI_API_URL` | Cloud backend (e.g. `https://cloud-api.clawdi.ai`). |
| `CLAWDI_SERVE_MODE=container` | Forces poll mode (overlay-fs doesn't fire fs.watch reliably). |

### Per-agent paths

| Agent | What you need to set |
|---|---|
| Hermes | `HERMES_HOME=/data/hermes` (or wherever the pod stores `state.db`). The adapter reads SQLite via `node:sqlite` (Node 22.5+) or `bun:sqlite` — both are built-in, no native bindings to ship. |
| OpenClaw | `OPENCLAW_STATE_DIR=/data/openclaw` (state lives outside `$HOME` in production). `OPENCLAW_AGENT_ID=<id>` if the pod runs a single agent personality; omit to sync every agent under `agents/`. |

### What NOT to do

- **Don't run `clawdi serve install`** inside the container. Install
  is for laptop / VPS users where launchd or systemd will respawn
  the daemon. The agent image's entrypoint (Docker / k8s) is
  already supervising; install would write a unit file inside
  the ephemeral container fs.
- **Don't expect `~/.clawdi/sessions-lock.json` to survive a pod
  restart** unless `~/.clawdi/` is on a persistent volume. Without
  the volume, every restart re-pushes every session. Mount
  `~/.clawdi/` as a named volume to avoid this.

### Entrypoint shape

```sh
exec clawdi serve --agent ${CLAWDI_AGENT_TYPE:-hermes}
```

`--agent` is required when `CLAWDI_ENVIRONMENT_ID` is set (the
env-pick logic uses agent_type to disambiguate the local
adapter to load).
