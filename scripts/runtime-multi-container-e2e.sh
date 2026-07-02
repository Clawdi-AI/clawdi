#!/usr/bin/env bash
# End-to-end smoke test for the hosted runtime multi-container topology.
#
# Runs one Clawdi runtime sidecar container against multiple external
# official agent containers:
#   - openclaw-a: official OpenClaw image, isolated state volume
#   - openclaw-b: official OpenClaw image, isolated state volume
#   - hermes-a:   official Hermes image, isolated state volume
#
# The sidecar does not launch agent processes. It converges an external runtime
# manifest, projects config through deployment-provided control commands, records
# observed versions, writes live-sync target ids, and leaves bridge/MCP HTTP
# disabled unless the manifest explicitly requests them.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}"
HERMES_IMAGE="${HERMES_IMAGE:-nousresearch/hermes-agent:latest}"
SIDECAR_IMAGE="${SIDECAR_IMAGE:-clawdi-runtime-sidecar:multi-container-e2e}"
SKIP_SIDECAR_BUILD="${SKIP_SIDECAR_BUILD:-0}"
PULL_IMAGES="${PULL_IMAGES:-0}"

RUN_ID="clawdi-mc-e2e-$(date +%s)-$RANDOM"
SCRATCH="$(mktemp -d -t clawdi-runtime-mc-e2e.XXXXXX)"
LOG_DIR="/tmp/clawdi-runtime-multi-container-e2e-last"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

OPENCLAW_A="${RUN_ID}-openclaw-a"
OPENCLAW_B="${RUN_ID}-openclaw-b"
HERMES_A="${RUN_ID}-hermes-a"
SIDECAR="${RUN_ID}-sidecar"
AUTH_TOKEN="clawdi-runtime-multi-container-e2e-token"
FAILED=0

cleanup() {
  set +e
  if [ "$FAILED" = 1 ]; then
    echo
    echo "=== FAILURE — logs at $LOG_DIR/ ==="
    for file in "$LOG_DIR"/*.log "$LOG_DIR"/*.json "$LOG_DIR"/*.yaml; do
      [ -e "$file" ] || continue
      echo "=== $(basename "$file") ==="
      tail -120 "$file" 2>/dev/null
    done
  fi
  docker rm -f "$SIDECAR" "$OPENCLAW_A" "$OPENCLAW_B" "$HERMES_A" >/dev/null 2>&1 || true
  chmod -R u+rwX "$SCRATCH" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH" >/dev/null 2>&1 || \
    docker run --rm -v /tmp:/host-tmp --entrypoint sh node:24-bookworm-slim \
      -lc "rm -rf /host-tmp/$(basename "$SCRATCH")" >/dev/null 2>&1 || true
}
trap cleanup EXIT

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok() { printf "  ✓ %s\n" "$*"; }
fail() {
  printf "  ✗ %s\n" "$*" >&2
  FAILED=1
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_image() {
  local image="$1"
  if docker image inspect "$image" >/dev/null 2>&1; then
    return
  fi
  if [ "$PULL_IMAGES" = 1 ]; then
    docker pull "$image" >"$LOG_DIR/pull-${image//[\/:]/_}.log" 2>&1 \
      || fail "failed to pull $image; see $LOG_DIR"
    return
  fi
  fail "missing image $image; rerun with PULL_IMAGES=1"
}

runtime_container() {
  local name="$1"
  local image="$2"
  shift 2
  docker run -d \
    --name "$name" \
    --network none \
    "$@" \
    --entrypoint sh \
    "$image" \
    -lc 'trap "exit 0" TERM INT; while :; do sleep 3600; done' \
    >"$LOG_DIR/${name}.cid" 2>"$LOG_DIR/${name}.log" \
    || fail "failed to start $name; see $LOG_DIR/${name}.log"
}

docker_exec_json() {
  local out="$1"
  shift
  docker exec "$@" >"$out" 2>"$out.stderr"
}

json_string_file_value() {
  python3 - "$1" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1]))
if isinstance(value, str):
    print(value)
else:
    print(json.dumps(value, sort_keys=True))
PY
}

require_command docker
require_command python3

DOCKER_BIN="$(command -v docker)"
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
[ -S "$DOCKER_SOCK" ] || fail "Docker socket not found at $DOCKER_SOCK"

bold "1) checking images"
require_image "$OPENCLAW_IMAGE"
require_image "$HERMES_IMAGE"
if [ "$SKIP_SIDECAR_BUILD" != 1 ]; then
  docker build \
    -f "$REPO_ROOT/packages/cli/Dockerfile.runtime-sidecar" \
    -t "$SIDECAR_IMAGE" \
    "$REPO_ROOT" \
    >"$LOG_DIR/sidecar-build.log" 2>&1 \
    || fail "sidecar image build failed; see $LOG_DIR/sidecar-build.log"
fi
require_image "$SIDECAR_IMAGE"
ok "images ready"

bold "2) preparing isolated volumes"
mkdir -p \
  "$SCRATCH/etc" \
  "$SCRATCH/home" \
  "$SCRATCH/run" \
  "$SCRATCH/service" \
  "$SCRATCH/workspace/openclaw-a" \
  "$SCRATCH/workspace/openclaw-b" \
  "$SCRATCH/workspace/hermes-a" \
  "$SCRATCH/state/openclaw-a" \
  "$SCRATCH/state/openclaw-b" \
  "$SCRATCH/state/hermes-a"
chmod -R 0777 "$SCRATCH/state" "$SCRATCH/workspace"
cat >"$SCRATCH/etc/host-policy.json" <<'JSON'
{
  "schemaVersion": "clawdi.hostPolicy.v1",
  "mode": "hosted",
  "cliUpdateMode": "managed",
  "immutableShim": true,
  "deniedCommands": [
    { "command": "setup", "reason": "hosted runtime uses controller-supplied desired state" },
    { "command": "teardown", "reason": "hosted runtime lifecycle is controller-owned" },
    { "command": "update", "reason": "runtime CLI updates are manifest-controlled" }
  ],
  "managedState": ["/etc/clawdi", "/var/lib/clawdi", "/run/clawdi"],
  "writableState": ["/home/clawdi", "/var/lib/clawdi", "/run/clawdi", "/tmp", "/workspace", "/state"],
  "systemWritableState": ["/etc/clawdi", "/var/lib/clawdi", "/run/clawdi", "/state"],
  "userWritableState": ["/home/clawdi", "/tmp", "/workspace"],
  "ordinaryUserDeniedState": ["/etc/clawdi", "/var/lib/clawdi", "/run/clawdi"]
}
JSON
ok "volumes at $SCRATCH"

bold "3) starting official runtime containers"
runtime_container "$OPENCLAW_A" "$OPENCLAW_IMAGE" \
  -v "$SCRATCH/state/openclaw-a:/state/openclaw-a" \
  -v "$SCRATCH/workspace/openclaw-a:/workspace/openclaw-a"
runtime_container "$OPENCLAW_B" "$OPENCLAW_IMAGE" \
  -v "$SCRATCH/state/openclaw-b:/state/openclaw-b" \
  -v "$SCRATCH/workspace/openclaw-b:/workspace/openclaw-b"
runtime_container "$HERMES_A" "$HERMES_IMAGE" \
  -e HERMES_HOME=/state/hermes-a \
  -v "$SCRATCH/state/hermes-a:/state/hermes-a" \
  -v "$SCRATCH/workspace/hermes-a:/workspace/hermes-a"
docker exec -e OPENCLAW_STATE_DIR=/state/openclaw-a "$OPENCLAW_A" openclaw --version \
  >"$LOG_DIR/openclaw-version.log" 2>&1
docker exec "$HERMES_A" /opt/hermes/bin/hermes --version \
  >"$LOG_DIR/hermes-version.log" 2>&1
OPENCLAW_VERSION="$(sed -n '1p' "$LOG_DIR/openclaw-version.log")"
HERMES_VERSION="$(sed -n '1p' "$LOG_DIR/hermes-version.log")"
ok "OpenClaw: $OPENCLAW_VERSION"
ok "Hermes: $HERMES_VERSION"

bold "4) writing external runtime manifest"
OPENCLAW_A="$OPENCLAW_A" \
OPENCLAW_B="$OPENCLAW_B" \
HERMES_A="$HERMES_A" \
OPENCLAW_IMAGE="$OPENCLAW_IMAGE" \
HERMES_IMAGE="$HERMES_IMAGE" \
OPENCLAW_VERSION="$OPENCLAW_VERSION" \
HERMES_VERSION="$HERMES_VERSION" \
python3 - "$SCRATCH/manifest.json" <<'PY'
import json
import os
import sys

out = sys.argv[1]

def openclaw_target(agent_id, container, state_dir, workspace, model, base_url, key_env):
    return {
        "type": "openclaw",
        "enabled": True,
        "environmentId": f"env-{agent_id}",
        "image": {"ref": os.environ["OPENCLAW_IMAGE"], "pullPolicy": "IfNotPresent"},
        "version": {"desired": os.environ["OPENCLAW_VERSION"], "upgradePolicy": "pinned"},
        "execution": {
            "mode": "external",
            "home": "/home/node",
            "stateDir": state_dir,
            "workspace": workspace,
            "controlCommand": {
                "command": "docker",
                "args": [
                    "exec",
                    "-i",
                    "-e",
                    f"OPENCLAW_STATE_DIR={state_dir}",
                    "-e",
                    "HOME=/home/node",
                    container,
                    "openclaw",
                ],
                "env": {},
            },
            "versionCommand": {
                "command": "docker",
                "args": [
                    "exec",
                    "-e",
                    f"OPENCLAW_STATE_DIR={state_dir}",
                    container,
                    "openclaw",
                    "--version",
                ],
                "env": {},
            },
            "terminal": {"container": container, "user": "node", "cwd": workspace, "env": {}},
        },
    }

manifest = {
    "schemaVersion": "clawdi.hosted-runtime.manifest.v1",
    "deploymentId": "runtime-multi-container-e2e",
    "environmentId": "env-runtime-multi-container-e2e",
    "instanceId": "pod-runtime-multi-container-e2e",
    "generation": 1,
    "issuedAt": "2026-07-01T00:00:00Z",
    "system": {"home": "/home/clawdi", "workspace": "/workspace"},
    "controlPlane": {"cloudApiUrl": "https://api.example.test"},
    "runtimeTargets": {
        "openclaw-a": openclaw_target(
            "openclaw-a",
            os.environ["OPENCLAW_A"],
            "/state/openclaw-a",
            "/workspace/openclaw-a",
            "gpt-openclaw-a",
            "https://provider-a.example.test/v1",
            "OPENCLAW_A_API_KEY",
        ),
        "openclaw-b": openclaw_target(
            "openclaw-b",
            os.environ["OPENCLAW_B"],
            "/state/openclaw-b",
            "/workspace/openclaw-b",
            "gpt-openclaw-b",
            "https://provider-b.example.test/v1",
            "OPENCLAW_B_API_KEY",
        ),
        "hermes-a": {
            "type": "hermes",
            "enabled": True,
            "environmentId": "env-hermes-a",
            "image": {"ref": os.environ["HERMES_IMAGE"], "pullPolicy": "IfNotPresent"},
            "version": {"desired": os.environ["HERMES_VERSION"], "upgradePolicy": "pinned"},
            "execution": {
                "mode": "external",
                "home": "/state/hermes-a",
                "stateDir": "/state/hermes-a",
                "workspace": "/workspace/hermes-a",
                "versionCommand": {
                    "command": "docker",
                    "args": [
                        "exec",
                        os.environ["HERMES_A"],
                        "/opt/hermes/bin/hermes",
                        "--version",
                    ],
                    "env": {},
                },
                "terminal": {
                    "container": os.environ["HERMES_A"],
                    "user": "hermes",
                    "cwd": "/workspace/hermes-a",
                    "env": {"HERMES_HOME": "/state/hermes-a"},
                },
            },
        },
    },
    "providers": {
        "openclaw-a": {
            "type": "openai",
            "baseUrl": "https://provider-a.example.test/v1",
            "model": "gpt-openclaw-a",
            "apiMode": "openai_responses",
            "runtimeEnvName": "OPENCLAW_A_API_KEY",
            "apiKeySecretRef": "provider.openclaw-a.apiKey",
        },
        "openclaw-b": {
            "type": "openai",
            "baseUrl": "https://provider-b.example.test/v1",
            "model": "gpt-openclaw-b",
            "apiMode": "openai_responses",
            "runtimeEnvName": "OPENCLAW_B_API_KEY",
            "apiKeySecretRef": "provider.openclaw-b.apiKey",
        },
        "hermes-a": {
            "type": "openai",
            "baseUrl": "https://provider-h.example.test/v1",
            "model": "gpt-hermes-a",
            "apiMode": "openai_responses",
            "runtimeEnvName": "HERMES_A_API_KEY",
            "apiKeySecretRef": "provider.hermes-a.apiKey",
        },
    },
    "mcp": {},
    "tools": {"catalog": "runtime-multi-container-e2e"},
    "recovery": {},
}
response = {
    "manifest": manifest,
    "secretValues": {
        "provider.openclaw-a.apiKey": "sk-openclaw-a-e2e",
        "provider.openclaw-b.apiKey": "sk-openclaw-b-e2e",
        "provider.hermes-a.apiKey": "sk-hermes-a-e2e",
    },
}
with open(out, "w") as f:
    json.dump(response, f, indent=2)
    f.write("\n")
PY
ok "manifest ready"

run_sidecar_clawdi() {
  local output="$1"
  shift
  docker run --rm \
    --name "$SIDECAR" \
    --network none \
    -e CLAWDI_RUNTIME_MODE=hosted \
    -e CLAWDI_AUTH_TOKEN="$AUTH_TOKEN" \
    -e CLAWDI_NO_AUTO_UPDATE=1 \
    -e CLAWDI_RUNTIME_VERSION_TIMEOUT=30000 \
    -v "$DOCKER_SOCK:/var/run/docker.sock" \
    -v "$DOCKER_BIN:/usr/local/bin/docker:ro" \
    -v "$SCRATCH/etc:/etc/clawdi" \
    -v "$SCRATCH/home:/home/clawdi" \
    -v "$SCRATCH/service:/var/lib/clawdi" \
    -v "$SCRATCH/run:/run/clawdi" \
    -v "$SCRATCH/workspace:/workspace" \
    -v "$SCRATCH/state:/state" \
    -v "$SCRATCH/manifest.json:/e2e/manifest.json:ro" \
    "$SIDECAR_IMAGE" \
    "$@" \
    >"$output" 2>"$output.stderr"
}

bold "5) converging manifest in sidecar container"
run_sidecar_clawdi "$LOG_DIR/runtime-init.json" \
  clawdi runtime init --manifest-file /e2e/manifest.json --non-interactive --json \
  || fail "runtime init failed; see $LOG_DIR/runtime-init.json.stderr"
python3 - "$LOG_DIR/runtime-init.json" <<'PY'
import json
import sys

status = json.load(open(sys.argv[1]))
assert status["status"] == "ok", status
assert sorted(status["enabledRuntimes"]) == ["hermes-a", "openclaw-a", "openclaw-b"], status
conv = status["convergence"]
assert conv["mcpHttpAuthTokenFile"] is None, conv
assert conv["runConfigs"] == [], conv
assert len(conv["liveSyncEnvironments"]) == 3, conv
PY
ok "runtime init converged"

bold "6) validating OpenClaw official containers"
docker_exec_json "$LOG_DIR/openclaw-a-providers.json" \
  -e OPENCLAW_STATE_DIR=/state/openclaw-a \
  "$OPENCLAW_A" openclaw config get models.providers --json
docker_exec_json "$LOG_DIR/openclaw-b-providers.json" \
  -e OPENCLAW_STATE_DIR=/state/openclaw-b \
  "$OPENCLAW_B" openclaw config get models.providers --json
docker_exec_json "$LOG_DIR/openclaw-a-default.json" \
  -e OPENCLAW_STATE_DIR=/state/openclaw-a \
  "$OPENCLAW_A" openclaw config get agents.defaults.model.primary --json
docker_exec_json "$LOG_DIR/openclaw-b-default.json" \
  -e OPENCLAW_STATE_DIR=/state/openclaw-b \
  "$OPENCLAW_B" openclaw config get agents.defaults.model.primary --json
docker_exec_json "$LOG_DIR/openclaw-a-mcp.json" \
  -e OPENCLAW_STATE_DIR=/state/openclaw-a \
  "$OPENCLAW_A" openclaw mcp show clawdi --json
docker_exec_json "$LOG_DIR/openclaw-b-mcp.json" \
  -e OPENCLAW_STATE_DIR=/state/openclaw-b \
  "$OPENCLAW_B" openclaw mcp show clawdi --json
python3 - "$LOG_DIR" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
a = json.load(open(root / "openclaw-a-providers.json"))
b = json.load(open(root / "openclaw-b-providers.json"))
assert sorted(a.keys()) == ["openclaw-a"], a
assert sorted(b.keys()) == ["openclaw-b"], b
assert a["openclaw-a"]["baseUrl"] == "https://provider-a.example.test/v1", a
assert b["openclaw-b"]["baseUrl"] == "https://provider-b.example.test/v1", b
assert json.load(open(root / "openclaw-a-default.json")) == "openclaw-a/gpt-openclaw-a"
assert json.load(open(root / "openclaw-b-default.json")) == "openclaw-b/gpt-openclaw-b"
for name in ["openclaw-a-mcp.json", "openclaw-b-mcp.json"]:
    mcp = json.load(open(root / name))
    assert mcp["url"] == "https://api.example.test/mcp/clawdi", mcp
    assert mcp["transport"] == "streamable-http", mcp
    assert mcp["headers"]["Authorization"].startswith("Bearer "), mcp
PY
ok "OpenClaw provider/default/MCP projections are isolated"

bold "7) validating Hermes official container"
docker exec "$HERMES_A" sh -lc 'cat /state/hermes-a/config.yaml' >"$LOG_DIR/hermes-a-config.yaml"
docker exec -i \
  -e HERMES_HOME=/state/hermes-a \
  "$HERMES_A" \
  /opt/hermes/.venv/bin/python - <<'PY' >"$LOG_DIR/hermes-a-runtime.json"
import json
from hermes_cli.config import load_config

cfg = load_config()
model = cfg["model"]
provider = cfg["providers"]["hermes-a"]
print(json.dumps({
    "model_provider": model["provider"],
    "model_default": model["default"],
    "provider_api": provider["api"],
    "provider_transport": provider["transport"],
    "provider_default_model": provider["default_model"],
    "mcp_url": cfg["mcp_servers"]["clawdi"]["url"],
    "mcp_transport": cfg["mcp_servers"]["clawdi"]["transport"],
    "mcp_has_auth": cfg["mcp_servers"]["clawdi"]["headers"]["Authorization"].startswith("Bearer "),
}, sort_keys=True))
PY
python3 - "$LOG_DIR/hermes-a-runtime.json" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1]))
assert data["model_provider"] == "custom:hermes-a", data
assert data["model_default"] == "gpt-hermes-a", data
assert data["provider_api"] == "https://provider-h.example.test/v1", data
assert data["provider_transport"] == "codex_responses", data
assert data["provider_default_model"] == "gpt-hermes-a", data
assert data["mcp_url"] == "https://api.example.test/mcp/clawdi", data
assert data["mcp_transport"] == "streamable-http", data
assert data["mcp_has_auth"] is True, data
PY
ok "Hermes config loads in the official container"

bold "8) validating sidecar state, identity, and defaults"
run_sidecar_clawdi "$LOG_DIR/runtime-status.json" clawdi runtime status --json \
  || fail "runtime status failed; see $LOG_DIR/runtime-status.json.stderr"
run_sidecar_clawdi "$LOG_DIR/runtime-doctor.json" clawdi runtime doctor --json \
  || fail "runtime doctor failed; see $LOG_DIR/runtime-doctor.json.stderr"
docker run --rm -v "$SCRATCH:/scratch" --entrypoint sh node:24-bookworm-slim \
  -lc 'chmod -R a+rX /scratch/service /scratch/home /scratch/run /scratch/state' \
  >/dev/null 2>&1 || true
python3 - "$SCRATCH" "$AUTH_TOKEN" <<'PY'
import json
import os
import sys
from pathlib import Path

scratch = Path(sys.argv[1])
token = sys.argv[2]
service = scratch / "service"
run = scratch / "run"
supervisor = (run / "supervisor" / "supervisord.conf").read_text()
assert "[program:clawdi-runtime-bridge]" not in supervisor, supervisor
assert "[program:clawdi-mcp-http]" not in supervisor, supervisor
for agent_id in ["openclaw-a", "openclaw-b", "hermes-a"]:
    assert f"[program:clawdi-daemon-{agent_id}]" in supervisor, supervisor
    assert f'CLAWDI_AGENT_ID="{agent_id}"' in supervisor, supervisor

env_dir = scratch / "home" / ".clawdi" / "environments"
for agent_id, agent_type, state_dir in [
    ("openclaw-a", "openclaw", "/state/openclaw-a"),
    ("openclaw-b", "openclaw", "/state/openclaw-b"),
    ("hermes-a", "hermes", "/state/hermes-a"),
]:
    env = json.load(open(env_dir / f"{agent_id}.json"))
    assert env["agentId"] == agent_id, env
    assert env["agentType"] == agent_type, env
    assert env["stateDir"] == state_dir, env
    inv = json.load(open(service / "install-inventory" / f"{agent_id}.json"))
    assert inv["status"] == "external", inv
    assert inv["version"]["observed"], inv
    assert inv["version"]["upgradeAvailable"] is False, inv

sync = json.load(open(service / "sync" / "runtimes.json"))
assert sorted(sync["runtimes"].keys()) == ["hermes-a", "openclaw-a", "openclaw-b"], sync
assert sync["runtimes"]["openclaw-a"]["externalStateDir"] == "/state/openclaw-a", sync
assert sync["runtimes"]["openclaw-b"]["externalStateDir"] == "/state/openclaw-b", sync
assert sync["runtimes"]["hermes-a"]["externalStateDir"] == "/state/hermes-a", sync

leaks = []
for root, _, files in os.walk(service):
    for file in files:
        path = Path(root) / file
        try:
            if token in path.read_text(errors="ignore"):
                leaks.append(str(path.relative_to(service)))
        except OSError:
            pass
assert leaks == [], leaks
PY
ok "sidecar state uses unique agent ids and keeps bridge/MCP HTTP off"

bold "all checks passed"
echo
echo "Artifacts: $LOG_DIR"
echo "OpenClaw A default: $(json_string_file_value "$LOG_DIR/openclaw-a-default.json")"
echo "OpenClaw B default: $(json_string_file_value "$LOG_DIR/openclaw-b-default.json")"
echo "Hermes runtime: $(cat "$LOG_DIR/hermes-a-runtime.json")"
