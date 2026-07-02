#!/usr/bin/env bash
# Production Kubernetes hosted runtime smoke test.
#
# This creates a temporary k3d cluster and validates the production Pod shape:
#   - one Clawdi runtime sidecar running the default "serve" entrypoint
#   - multiple official OpenClaw/Hermes runtime containers in the same Pod
#   - spec.shareProcessNamespace: true
#   - no Docker socket in the sidecar
#   - runtime config projected through the same-Pod nsenter control adapter
#   - manifest fetched over HTTP with bearer auth, like production

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}"
HERMES_IMAGE="${HERMES_IMAGE:-nousresearch/hermes-agent:latest}"
SIDECAR_IMAGE="${SIDECAR_IMAGE:-clawdi-runtime-sidecar:k3d-production-pod-e2e}"
SKIP_SIDECAR_BUILD="${SKIP_SIDECAR_BUILD:-0}"
PULL_IMAGES="${PULL_IMAGES:-0}"
KEEP_CLUSTER="${KEEP_CLUSTER:-0}"

RUN_ID="clawdi-k3d-e2e-$RANDOM"
CLUSTER="${CLUSTER:-$RUN_ID}"
CONTEXT="k3d-${CLUSTER}"
NAMESPACE="clawdi-runtime-e2e"
RUNTIME_POD="runtime-pod"
MANIFEST_POD="manifest-api"
MANIFEST_SERVICE="manifest-api"
AUTH_TOKEN="clawdi-runtime-k3d-production-pod-e2e-token"
SCRATCH="$(mktemp -d -t clawdi-runtime-k3d-prod-pod-e2e.XXXXXX)"
LOG_DIR="/tmp/clawdi-runtime-k3d-production-pod-e2e-last"
PREVIOUS_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
FAILED=0
CLUSTER_CREATED=0

rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

cleanup() {
	set +e
	if [ "$FAILED" = 1 ]; then
		echo
		echo "=== FAILURE - logs at $LOG_DIR/ ==="
		kubectl --context "$CONTEXT" -n "$NAMESPACE" get all -o wide \
			>"$LOG_DIR/kubectl-get-all.txt" 2>&1 || true
		kubectl --context "$CONTEXT" -n "$NAMESPACE" describe pod "$RUNTIME_POD" \
			>"$LOG_DIR/runtime-pod-describe.txt" 2>&1 || true
		kubectl --context "$CONTEXT" -n "$NAMESPACE" describe pod "$MANIFEST_POD" \
			>"$LOG_DIR/manifest-api-describe.txt" 2>&1 || true
		for container in sidecar openclaw-a openclaw-b hermes-a; do
			kubectl --context "$CONTEXT" -n "$NAMESPACE" logs "$RUNTIME_POD" -c "$container" \
				>"$LOG_DIR/runtime-${container}.log" 2>&1 || true
		done
		kubectl --context "$CONTEXT" -n "$NAMESPACE" logs "$MANIFEST_POD" \
			>"$LOG_DIR/manifest-api.log" 2>&1 || true
		for file in "$LOG_DIR"/*; do
			[ -e "$file" ] || continue
			echo "=== $(basename "$file") ==="
			tail -120 "$file" 2>/dev/null
		done
	fi

	if [ "$KEEP_CLUSTER" != 1 ] && [ "$CLUSTER_CREATED" = 1 ]; then
		k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
	fi
	if [ -n "$PREVIOUS_CONTEXT" ]; then
		kubectl config use-context "$PREVIOUS_CONTEXT" >/dev/null 2>&1 || true
	fi
	rm -rf "$SCRATCH" >/dev/null 2>&1 || true
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

kubectl_e2e() {
	kubectl --context "$CONTEXT" -n "$NAMESPACE" "$@"
}

runtime_exec() {
	local container="$1"
	shift
	kubectl_e2e exec "$RUNTIME_POD" -c "$container" -- "$@"
}

write_manifest_payload() {
	OPENCLAW_IMAGE="$OPENCLAW_IMAGE" \
	HERMES_IMAGE="$HERMES_IMAGE" \
	OPENCLAW_VERSION="$OPENCLAW_VERSION" \
	HERMES_VERSION="$HERMES_VERSION" \
	python3 - "$SCRATCH/manifest.json" <<'PY'
import json
import os
import sys

out = sys.argv[1]

def openclaw_target(agent_id, state_dir, workspace, model, base_url):
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
                "command": "/usr/local/bin/clawdi-runtime-nsenter",
                "args": [
                    "--state-dir",
                    state_dir,
                    "--marker",
                    "/app/openclaw.mjs",
                    "--workdir",
                    workspace,
                    "--",
                    "/usr/local/bin/openclaw",
                ],
                "env": {},
            },
            "versionCommand": {
                "command": "/usr/local/bin/clawdi-runtime-nsenter",
                "args": [
                    "--state-dir",
                    state_dir,
                    "--marker",
                    "/app/openclaw.mjs",
                    "--workdir",
                    workspace,
                    "--",
                    "/usr/local/bin/openclaw",
                    "--version",
                ],
                "env": {},
            },
            "terminal": {"container": agent_id, "user": "node", "cwd": workspace, "env": {}},
        },
    }

manifest = {
    "schemaVersion": "clawdi.hosted-runtime.manifest.v1",
    "deploymentId": "runtime-k3d-production-pod-e2e",
    "environmentId": "env-runtime-k3d-production-pod-e2e",
    "instanceId": "pod-runtime-k3d-production-pod-e2e",
    "generation": 1,
    "issuedAt": "2026-07-02T00:00:00Z",
    "system": {"home": "/home/clawdi", "workspace": "/workspace"},
    "controlPlane": {"cloudApiUrl": "https://api.example.test"},
    "runtimeTargets": {
        "openclaw-a": openclaw_target(
            "openclaw-a",
            "/state/openclaw-a",
            "/workspace/openclaw-a",
            "gpt-openclaw-a",
            "https://provider-a.example.test/v1",
        ),
        "openclaw-b": openclaw_target(
            "openclaw-b",
            "/state/openclaw-b",
            "/workspace/openclaw-b",
            "gpt-openclaw-b",
            "https://provider-b.example.test/v1",
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
                    "command": "/usr/local/bin/clawdi-runtime-nsenter",
                    "args": [
                        "--state-dir",
                        "/state/hermes-a",
                        "--marker",
                        "/opt/hermes/bin/hermes",
                        "--workdir",
                        "/workspace/hermes-a",
                        "--",
                        "/opt/hermes/bin/hermes",
                        "--version",
                    ],
                    "env": {},
                },
                "terminal": {
                    "container": "hermes-a",
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
    "tools": {"catalog": "runtime-k3d-production-pod-e2e"},
    "recovery": {},
}

response = {
    "manifest": manifest,
    "secretValues": {
        "provider.openclaw-a.apiKey": "sk-openclaw-a-k3d-prod-pod-e2e",
        "provider.openclaw-b.apiKey": "sk-openclaw-b-k3d-prod-pod-e2e",
        "provider.hermes-a.apiKey": "sk-hermes-a-k3d-prod-pod-e2e",
    },
}

with open(out, "w") as f:
    json.dump(response, f, indent=2)
    f.write("\n")
PY
}

write_k8s_resources() {
	cat >"$SCRATCH/channels.json" <<'JSON'
[]
JSON
	cat >"$SCRATCH/host-policy.json" <<'JSON'
{
  "schemaVersion": "clawdi.hostPolicy.v1",
  "mode": "hosted",
  "cliUpdateMode": "managed",
  "immutableShim": true,
  "deniedCommands": [
    { "command": "setup", "reason": "hosted runtime uses controller-supplied desired state" },
    { "command": "teardown", "reason": "hosted runtime lifecycle is controller-owned" },
    { "command": "update", "reason": "runtime CLI updates are manifest-controlled" },
    { "command": "config set", "reason": "hosted runtime config is manifest-controlled" },
    { "command": "config unset", "reason": "hosted runtime config is manifest-controlled" }
  ],
  "managedState": ["/etc/clawdi", "/var/lib/clawdi", "/run/clawdi"],
  "writableState": ["/home/clawdi", "/var/lib/clawdi", "/run/clawdi", "/tmp", "/workspace", "/state"],
  "systemWritableState": ["/etc/clawdi", "/var/lib/clawdi", "/run/clawdi", "/state"],
  "userWritableState": ["/home/clawdi", "/tmp", "/workspace"],
  "ordinaryUserDeniedState": ["/etc/clawdi", "/var/lib/clawdi", "/run/clawdi"]
}
JSON
	SIDECAR_IMAGE="$SIDECAR_IMAGE" \
	OPENCLAW_IMAGE="$OPENCLAW_IMAGE" \
	HERMES_IMAGE="$HERMES_IMAGE" \
	AUTH_TOKEN="$AUTH_TOKEN" \
	NAMESPACE="$NAMESPACE" \
	MANIFEST_POD="$MANIFEST_POD" \
	MANIFEST_SERVICE="$MANIFEST_SERVICE" \
	RUNTIME_POD="$RUNTIME_POD" \
	python3 - "$SCRATCH/manifest.json" "$SCRATCH/channels.json" "$SCRATCH/host-policy.json" "$SCRATCH/k8s-resources.json" <<'PY'
import json
import os
import sys

manifest_path, channels_path, policy_path, out = sys.argv[1:]
namespace = os.environ["NAMESPACE"]
sidecar_image = os.environ["SIDECAR_IMAGE"]
openclaw_image = os.environ["OPENCLAW_IMAGE"]
hermes_image = os.environ["HERMES_IMAGE"]
auth_token = os.environ["AUTH_TOKEN"]
manifest_pod = os.environ["MANIFEST_POD"]
manifest_service = os.environ["MANIFEST_SERVICE"]
runtime_pod = os.environ["RUNTIME_POD"]

manifest_server = r'''
const fs = require("node:fs");
const http = require("node:http");
const token = process.env.AUTH_TOKEN;
const manifest = fs.readFileSync("/e2e/manifest.json");
const channels = fs.readFileSync("/e2e/channels.json");
http.createServer((req, res) => {
  const path = new URL(req.url, "http://manifest-api.local").pathname;
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (path === "/api/runtime/manifest") {
    res.writeHead(200, {
      "content-type": "application/json",
      "etag": "\"runtime-k3d-production-pod-e2e-1\""
    });
    res.end(manifest);
    return;
  }
  if (path === "/api/channels") {
    res.writeHead(200, {
      "content-type": "application/json",
      "etag": "\"runtime-k3d-production-pod-e2e-channels-1\""
    });
    res.end(channels);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}).listen(19090, "0.0.0.0", () => {
  console.log("manifest-api listening on :19090");
});
'''

volumes = [
    {"name": "state-openclaw-a", "emptyDir": {}},
    {"name": "state-openclaw-b", "emptyDir": {}},
    {"name": "state-hermes-a", "emptyDir": {}},
    {"name": "workspace-openclaw-a", "emptyDir": {}},
    {"name": "workspace-openclaw-b", "emptyDir": {}},
    {"name": "workspace-hermes-a", "emptyDir": {}},
    {"name": "sidecar-home", "emptyDir": {}},
    {"name": "sidecar-service", "emptyDir": {}},
    {"name": "sidecar-run", "emptyDir": {}},
    {"name": "host-policy", "configMap": {"name": "runtime-host-policy"}},
]

all_volume_mounts = [
    {"name": "state-openclaw-a", "mountPath": "/state/openclaw-a"},
    {"name": "state-openclaw-b", "mountPath": "/state/openclaw-b"},
    {"name": "state-hermes-a", "mountPath": "/state/hermes-a"},
    {"name": "workspace-openclaw-a", "mountPath": "/workspace/openclaw-a"},
    {"name": "workspace-openclaw-b", "mountPath": "/workspace/openclaw-b"},
    {"name": "workspace-hermes-a", "mountPath": "/workspace/hermes-a"},
]

runtime_sleep = {
    "command": ["sh", "-lc"],
    "args": ['trap "exit 0" TERM INT; while :; do sleep 3600; done'],
}

resources = [
    {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "runtime-manifest", "namespace": namespace},
        "data": {
            "manifest.json": open(manifest_path).read(),
            "channels.json": open(channels_path).read(),
        },
    },
    {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "runtime-host-policy", "namespace": namespace},
        "data": {"host-policy.json": open(policy_path).read()},
    },
    {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": manifest_pod, "namespace": namespace, "labels": {"app": manifest_pod}},
        "spec": {
            "restartPolicy": "Never",
            "containers": [
                {
                    "name": "manifest-api",
                    "image": sidecar_image,
                    "imagePullPolicy": "IfNotPresent",
                    "command": ["node", "-e", manifest_server],
                    "env": [{"name": "AUTH_TOKEN", "value": auth_token}],
                    "ports": [{"containerPort": 19090, "name": "http"}],
                    "volumeMounts": [
                        {"name": "manifest-data", "mountPath": "/e2e", "readOnly": True}
                    ],
                }
            ],
            "volumes": [{"name": "manifest-data", "configMap": {"name": "runtime-manifest"}}],
        },
    },
    {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {"name": manifest_service, "namespace": namespace},
        "spec": {
            "selector": {"app": manifest_pod},
            "ports": [{"name": "http", "port": 19090, "targetPort": "http"}],
        },
    },
    {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": runtime_pod, "namespace": namespace},
        "spec": {
            "shareProcessNamespace": True,
            "restartPolicy": "Never",
            "terminationGracePeriodSeconds": 5,
            "initContainers": [
                {
                    "name": "volume-permissions",
                    "image": sidecar_image,
                    "imagePullPolicy": "IfNotPresent",
                    "command": ["sh", "-lc", "chmod -R 0777 /state /workspace /home/clawdi /var/lib/clawdi /run/clawdi"],
                    "volumeMounts": [
                        *all_volume_mounts,
                        {"name": "sidecar-home", "mountPath": "/home/clawdi"},
                        {"name": "sidecar-service", "mountPath": "/var/lib/clawdi"},
                        {"name": "sidecar-run", "mountPath": "/run/clawdi"},
                    ],
                }
            ],
            "containers": [
                {
                    "name": "openclaw-a",
                    "image": openclaw_image,
                    "imagePullPolicy": "IfNotPresent",
                    **runtime_sleep,
                    "env": [{"name": "OPENCLAW_STATE_DIR", "value": "/state/openclaw-a"}],
                    "volumeMounts": [
                        {"name": "state-openclaw-a", "mountPath": "/state/openclaw-a"},
                        {"name": "workspace-openclaw-a", "mountPath": "/workspace/openclaw-a"},
                    ],
                },
                {
                    "name": "openclaw-b",
                    "image": openclaw_image,
                    "imagePullPolicy": "IfNotPresent",
                    **runtime_sleep,
                    "env": [{"name": "OPENCLAW_STATE_DIR", "value": "/state/openclaw-b"}],
                    "volumeMounts": [
                        {"name": "state-openclaw-b", "mountPath": "/state/openclaw-b"},
                        {"name": "workspace-openclaw-b", "mountPath": "/workspace/openclaw-b"},
                    ],
                },
                {
                    "name": "hermes-a",
                    "image": hermes_image,
                    "imagePullPolicy": "IfNotPresent",
                    **runtime_sleep,
                    "env": [{"name": "HERMES_HOME", "value": "/state/hermes-a"}],
                    "volumeMounts": [
                        {"name": "state-hermes-a", "mountPath": "/state/hermes-a"},
                        {"name": "workspace-hermes-a", "mountPath": "/workspace/hermes-a"},
                    ],
                },
                {
                    "name": "sidecar",
                    "image": sidecar_image,
                    "imagePullPolicy": "IfNotPresent",
                    "securityContext": {
                        "privileged": True,
                        "allowPrivilegeEscalation": True,
                    },
                    "env": [
                        {"name": "CLAWDI_RUNTIME_MODE", "value": "hosted"},
                        {"name": "CLAWDI_AUTH_TOKEN", "value": auth_token},
                        {"name": "CLAWDI_NO_AUTO_UPDATE", "value": "1"},
                        {"name": "CLAWDI_RUNTIME_VERSION_TIMEOUT", "value": "30000"},
                        {
                            "name": "CLAWDI_RUNTIME_MANIFEST_URL",
                            "value": f"http://{manifest_service}.{namespace}.svc.cluster.local:19090/api/runtime/manifest",
                        },
                    ],
                    "volumeMounts": [
                        *all_volume_mounts,
                        {"name": "sidecar-home", "mountPath": "/home/clawdi"},
                        {"name": "sidecar-service", "mountPath": "/var/lib/clawdi"},
                        {"name": "sidecar-run", "mountPath": "/run/clawdi"},
                        {
                            "name": "host-policy",
                            "mountPath": "/etc/clawdi/host-policy.json",
                            "subPath": "host-policy.json",
                            "readOnly": True,
                        },
                    ],
                },
            ],
            "volumes": volumes,
        },
    },
]

with open(out, "w") as f:
    json.dump({"apiVersion": "v1", "kind": "List", "items": resources}, f, indent=2)
    f.write("\n")
PY
}

wait_for_boot_status() {
	local attempt
	for attempt in $(seq 1 120); do
		if kubectl_e2e exec "$RUNTIME_POD" -c sidecar -- sh -lc \
			'test -s /var/lib/clawdi/cache/boot-status.json && cat /var/lib/clawdi/cache/boot-status.json' \
			>"$LOG_DIR/boot-status.json" 2>"$LOG_DIR/boot-status.stderr"; then
			if python3 - "$LOG_DIR/boot-status.json" <<'PY'
import json
import sys

status = json.load(open(sys.argv[1]))
assert status["status"] == "ok", status
assert status["stage"] == "final", status
assert sorted(status["enabledRuntimes"]) == ["hermes-a", "openclaw-a", "openclaw-b"], status
conv = status["convergence"]
assert conv["mcpHttpAuthTokenFile"] is None, conv
assert conv["runConfigs"] == [], conv
assert len(conv["liveSyncEnvironments"]) == 3, conv
PY
			then
				return
			fi
		fi
		sleep 2
	done
	fail "sidecar did not converge to ok boot status"
}

require_command docker
require_command kubectl
require_command k3d
require_command python3

bold "1) checking and building images"
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

bold "2) reading official runtime versions"
docker run --rm --entrypoint sh "$OPENCLAW_IMAGE" -lc 'OPENCLAW_STATE_DIR=/tmp/openclaw openclaw --version' \
	>"$LOG_DIR/openclaw-version.raw.log" 2>"$LOG_DIR/openclaw-version.stderr" \
	|| fail "failed to read OpenClaw version"
docker run --rm --entrypoint /opt/hermes/bin/hermes "$HERMES_IMAGE" --version \
	>"$LOG_DIR/hermes-version.raw.log" 2>"$LOG_DIR/hermes-version.stderr" \
	|| fail "failed to read Hermes version"
OPENCLAW_VERSION="$(sed -n '1p' "$LOG_DIR/openclaw-version.raw.log")"
HERMES_VERSION="$(sed -n '1p' "$LOG_DIR/hermes-version.raw.log")"
printf "%s\n" "$OPENCLAW_VERSION" >"$LOG_DIR/openclaw-version.log"
printf "%s\n" "$HERMES_VERSION" >"$LOG_DIR/hermes-version.log"
ok "OpenClaw: $OPENCLAW_VERSION"
ok "Hermes: $HERMES_VERSION"

bold "3) creating temporary k3d cluster"
k3d cluster create "$CLUSTER" \
	--servers 1 \
	--agents 0 \
	--wait \
	--k3s-arg "--disable=traefik@server:*" \
	>"$LOG_DIR/k3d-create.log" 2>&1 \
	|| fail "failed to create k3d cluster; see $LOG_DIR/k3d-create.log"
CLUSTER_CREATED=1
kubectl config use-context "$CONTEXT" >/dev/null
kubectl --context "$CONTEXT" create namespace "$NAMESPACE" \
	>"$LOG_DIR/namespace-create.log" 2>&1 \
	|| fail "failed to create namespace"
ok "cluster $CLUSTER ready"

bold "4) importing images into k3d"
for image in "$SIDECAR_IMAGE" "$OPENCLAW_IMAGE" "$HERMES_IMAGE"; do
	k3d image import -c "$CLUSTER" "$image" \
		>"$LOG_DIR/import-${image//[\/:]/_}.log" 2>&1 \
		|| fail "failed to import $image"
done
ok "images imported"

bold "5) applying manifest API and runtime Pod"
write_manifest_payload
write_k8s_resources
kubectl --context "$CONTEXT" apply -f "$SCRATCH/k8s-resources.json" \
	>"$LOG_DIR/kubectl-apply.log" 2>&1 \
	|| fail "failed to apply k8s resources; see $LOG_DIR/kubectl-apply.log"
kubectl_e2e wait --for=condition=Ready "pod/$MANIFEST_POD" --timeout=120s \
	>"$LOG_DIR/manifest-api-wait.log" 2>&1 \
	|| fail "manifest API pod did not become ready"
kubectl_e2e wait --for=condition=Ready "pod/$RUNTIME_POD" --timeout=180s \
	>"$LOG_DIR/runtime-pod-wait.log" 2>&1 \
	|| fail "runtime pod did not become ready"
ok "pods ready"

bold "6) waiting for sidecar serve convergence"
wait_for_boot_status
ok "sidecar serve fetched remote manifest and converged"

bold "7) validating official OpenClaw containers"
runtime_exec openclaw-a env OPENCLAW_STATE_DIR=/state/openclaw-a openclaw config get models.providers --json \
	>"$LOG_DIR/openclaw-a-providers.json" 2>"$LOG_DIR/openclaw-a-providers.stderr"
runtime_exec openclaw-b env OPENCLAW_STATE_DIR=/state/openclaw-b openclaw config get models.providers --json \
	>"$LOG_DIR/openclaw-b-providers.json" 2>"$LOG_DIR/openclaw-b-providers.stderr"
runtime_exec openclaw-a env OPENCLAW_STATE_DIR=/state/openclaw-a openclaw config get agents.defaults.model.primary --json \
	>"$LOG_DIR/openclaw-a-default.json" 2>"$LOG_DIR/openclaw-a-default.stderr"
runtime_exec openclaw-b env OPENCLAW_STATE_DIR=/state/openclaw-b openclaw config get agents.defaults.model.primary --json \
	>"$LOG_DIR/openclaw-b-default.json" 2>"$LOG_DIR/openclaw-b-default.stderr"
runtime_exec openclaw-a env OPENCLAW_STATE_DIR=/state/openclaw-a openclaw mcp show clawdi --json \
	>"$LOG_DIR/openclaw-a-mcp.json" 2>"$LOG_DIR/openclaw-a-mcp.stderr"
runtime_exec openclaw-b env OPENCLAW_STATE_DIR=/state/openclaw-b openclaw mcp show clawdi --json \
	>"$LOG_DIR/openclaw-b-mcp.json" 2>"$LOG_DIR/openclaw-b-mcp.stderr"
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
ok "OpenClaw config is isolated per agent_id"

bold "8) validating official Hermes container"
runtime_exec hermes-a sh -lc 'cat /state/hermes-a/config.yaml' \
	>"$LOG_DIR/hermes-a-config.yaml" 2>"$LOG_DIR/hermes-a-config.stderr"
kubectl_e2e exec -i "$RUNTIME_POD" -c hermes-a -- \
	env HERMES_HOME=/state/hermes-a /opt/hermes/.venv/bin/python - <<'PY' >"$LOG_DIR/hermes-a-runtime.json"
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

bold "9) validating sidecar state and default-off surfaces"
runtime_exec sidecar sh -lc 'cat /run/clawdi/supervisor/supervisord.conf' \
	>"$LOG_DIR/supervisord.conf" 2>"$LOG_DIR/supervisord.stderr"
runtime_exec sidecar clawdi runtime status --json \
	>"$LOG_DIR/runtime-status.json" 2>"$LOG_DIR/runtime-status.stderr"
runtime_exec sidecar clawdi runtime doctor --json \
	>"$LOG_DIR/runtime-doctor.json" 2>"$LOG_DIR/runtime-doctor.stderr"
runtime_exec sidecar python3 - <<'PY' >"$LOG_DIR/sidecar-state.json"
import json
import os
from pathlib import Path

token = os.environ["CLAWDI_AUTH_TOKEN"]
service = Path("/var/lib/clawdi")
run = Path("/run/clawdi")
home = Path("/home/clawdi")
supervisor = (run / "supervisor" / "supervisord.conf").read_text()
assert "[program:clawdi-runtime-bridge]" not in supervisor, supervisor
assert "[program:clawdi-mcp-http]" not in supervisor, supervisor
for agent_id in ["openclaw-a", "openclaw-b", "hermes-a"]:
    assert f"[program:clawdi-daemon-{agent_id}]" in supervisor, supervisor
    assert f'CLAWDI_AGENT_ID="{agent_id}"' in supervisor, supervisor

env_dir = home / ".clawdi" / "environments"
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
print(json.dumps({"status": "ok", "agent_ids": sorted(sync["runtimes"].keys())}))
PY
ok "sidecar is target-id keyed; bridge and sidecar-local MCP stay off"

bold "all checks passed"
echo
echo "Artifacts: $LOG_DIR"
echo "Cluster: $CLUSTER (deleted on exit unless KEEP_CLUSTER=1)"
echo "OpenClaw A default: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])))' "$LOG_DIR/openclaw-a-default.json")"
echo "OpenClaw B default: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])))' "$LOG_DIR/openclaw-b-default.json")"
echo "Hermes runtime: $(cat "$LOG_DIR/hermes-a-runtime.json")"
