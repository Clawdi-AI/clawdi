import { afterAll, afterEach, beforeEach, expect } from "bun:test";

import { spawn } from "node:child_process";

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";

import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { z } from "zod";
import {
	commitRuntimeAppliedState,
	runtimeInit as runtimeInitWithContext,
	runtimeWatch as runtimeWatchWithContext,
} from "../commands/runtime";
import { getCliVersion } from "../lib/version";
import { runtimeContentSha256, writeRuntimeAppliedState } from "../runtime/applied-state";
import type { RuntimeApplyContext } from "../runtime/apply-identity";
import { applyRuntimeBundleChannelsToManifestLoad as applyRuntimeBundleChannelsToManifestLoadWithContext } from "../runtime/channels";
import {
	hostedManifestEgressProfiles,
	managedMcpHeaderPlaceholder,
} from "../runtime/hosted-egress-profiles";
import { MANAGED_BAILEYS_STATIC_PATCH_TARGETS } from "../runtime/managed-baileys-compat";
import {
	convergeRuntimeManifest as convergeRuntimeManifestWithContext,
	loadRuntimeManifest as loadRuntimeManifestFromContext,
	type RuntimeConvergenceOptions,
	type RuntimeConvergenceResult,
	type RuntimeManifest,
} from "../runtime/manifest";
import {
	hostedRuntimeBundleV2ManifestSchema,
	validateUnmanagedProviderSecretValues,
} from "../runtime/manifest-contract";
import {
	HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
	loadRemoteRuntimeManifest as loadRemoteRuntimeManifestWithContext,
	manifestSecretRefs,
	parseHostedRuntimeBundleV2,
	type RuntimeBundleChannelBinding,
	type RuntimeManifestLoad,
} from "../runtime/manifest-source";
import { getRuntimePaths, type RuntimePaths } from "../runtime/paths";
import { canonicalSecretRefSchema, normalizeSecretValues } from "../runtime/secret-values";
import { ensureRuntimeStateDirs } from "../runtime/state";
import {
	type applySystemdRuntimeUpdate,
	RUNTIME_WATCH_SYSTEM_UNIT,
	readSystemdUnitSnapshot,
} from "../runtime/systemd-transaction";
import { ensureTestOpenClawWorkspaceCli } from "../test-support/runtime-workspace";
import { mockFetch } from "./mock-fetch";

export const HERMES_CONFIG_CLI_MOCK = fileURLToPath(
	new URL("./hermes-config-cli-mock.ts", import.meta.url),
);

export const TEST_PROCESS_USER = String(process.getuid?.() ?? 0);

export const TEST_PROCESS_UID = process.getuid?.() ?? 1_000;

export const TEST_PROCESS_GID = process.getgid?.() ?? 1_000;

export const TEST_RUNNING_CLI_VERSION = getCliVersion();

export const TEST_RUNNING_CLI_SPEC = `clawdi@${TEST_RUNNING_CLI_VERSION}`;

function testHostedRuntimeContract(paths: RuntimePaths) {
	if (!process.env.CLAWDI_RUNTIME_USER) process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
	const user = process.env.CLAWDI_RUNTIME_USER;
	const uid = Number(process.env.CLAWDI_RUNTIME_UID ?? TEST_PROCESS_UID);
	const gid = Number(process.env.CLAWDI_RUNTIME_GID ?? TEST_PROCESS_GID);
	return {
		expectedIdentity: {
			home: paths.userHome,
			user,
			uid,
			gid,
		},
		resolveUserIdentity: () => ({ uid, gid }),
	};
}

export function explicitTestApplyContext(
	manifest: Pick<RuntimeManifest, "generation" | "applyGeneration">,
) {
	return {
		kind: "context-file" as const,
		backend: "incus" as const,
		identity: {
			generation: manifest.applyGeneration ?? manifest.generation,
			manifestETag: `"test-${manifest.generation}"`,
			applyReceiptId: "test-apply-receipt",
			bootNonce: "test-boot-nonce-0001",
		},
		manifestSource: {
			type: "http" as const,
			url: "https://runtime.test/v1/runtime/manifest",
			auth: { type: "bearer" as const, token: "test-runtime-bootstrap-token" },
		},
	};
}

const hostedRuntimeManifestResponseSchema = z
	.object({
		manifest: hostedRuntimeBundleV2ManifestSchema,
		secretValues: z.record(canonicalSecretRefSchema, z.string()).default({}),
	})
	.strict()
	.superRefine(validateUnmanagedProviderSecretValues);

export function normalizeHostedManifestFixture(value: unknown): {
	manifest: RuntimeManifest;
	secretValues: Record<string, string>;
} {
	const parsed = hostedRuntimeManifestResponseSchema.parse(value);
	return {
		manifest: parsed.manifest,
		secretValues: normalizeSecretValues(parsed.secretValues),
	};
}

export let currentTestApplyContext = explicitTestApplyContext({ generation: 1 });

export function runtimeInit(opts: Parameters<typeof runtimeInitWithContext>[0] = {}) {
	const paths = getRuntimePaths();
	return runtimeInitWithContext({
		...opts,
		applyContext: opts.applyContext ?? currentTestApplyContext,
		hostedRuntimeContract: opts.hostedRuntimeContract ?? testHostedRuntimeContract(paths),
	});
}

function liveTestApplyContext(): RuntimeApplyContext {
	return {
		get kind() {
			return currentTestApplyContext.kind;
		},
		get backend() {
			return currentTestApplyContext.backend;
		},
		get identity() {
			return currentTestApplyContext.identity;
		},
		get manifestSource() {
			return currentTestApplyContext.manifestSource;
		},
	};
}

export function runtimeWatch(opts: Parameters<typeof runtimeWatchWithContext>[0] = {}) {
	const paths = getRuntimePaths();
	return runtimeWatchWithContext({
		...opts,
		applyContext: opts.applyContext ?? liveTestApplyContext(),
		hostedRuntimeContract: opts.hostedRuntimeContract ?? testHostedRuntimeContract(paths),
	});
}

export function loadRemoteRuntimeManifest(
	paths: RuntimePaths,
	opts: Parameters<typeof loadRemoteRuntimeManifestWithContext>[1] = {},
) {
	return loadRemoteRuntimeManifestWithContext(paths, {
		...opts,
		applyContext: opts.applyContext ?? currentTestApplyContext,
	});
}

export function loadRuntimeManifest(
	paths: RuntimePaths,
	opts: { applyContext?: RuntimeApplyContext } = {},
) {
	return loadRuntimeManifestFromContext(paths, {
		applyContext: opts.applyContext ?? currentTestApplyContext,
	});
}

export function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: RuntimeConvergenceOptions = {},
) {
	if (!process.env.CLAWDI_RUNTIME_MODE) process.env.CLAWDI_RUNTIME_MODE = "hosted";
	if (!process.env.CLAWDI_RUNTIME_USER) process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
	ensureTestOpenClawWorkspaceCli(load.manifest, paths);
	ensureRuntimeStateDirs(paths);
	const requiredSecretRefs = new Set(manifestSecretRefs(load.manifest));
	const defaultSecretValues = Object.fromEntries(
		Object.entries(TEST_RUNTIME_SERVICE_SECRET_VALUES).filter(([ref]) =>
			requiredSecretRefs.has(ref),
		),
	);
	return convergeRuntimeManifestWithContext(
		{
			...load,
			secretValues: { ...defaultSecretValues, ...load.secretValues },
			applyContext: load.applyContext ?? explicitTestApplyContext(load.manifest),
		},
		paths,
		{
			...opts,
			systemdApply: opts.systemdApply,
			hostedRuntimeContract: opts?.hostedRuntimeContract ?? testHostedRuntimeContract(paths),
		},
	);
}

export function convergeAndCommitTestRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: Omit<RuntimeConvergenceOptions, "commitAuthority"> = {},
) {
	let officialServiceCommandRevisions: Record<string, string> = {};
	const convergence = convergeRuntimeManifest(load, paths, {
		...opts,
		commitAuthority: (_committed, authority) => {
			officialServiceCommandRevisions = authority.officialServiceCommandRevisions;
		},
	});
	if (convergence.installErrors.length === 0) {
		writeTestRuntimeAppliedState(paths, load, convergence, { officialServiceCommandRevisions });
	}
	return convergence;
}

export function hermesManagedBaileysRoot(home: string): string {
	return join(
		home,
		".hermes",
		"hermes-agent",
		"scripts",
		"whatsapp-bridge",
		"node_modules",
		"@whiskeysockets",
		"baileys",
	);
}

export function seedManagedBaileysArtifact(baileysRoot: string): void {
	const sourceRoot = resolve(
		import.meta.dir,
		"../../../whatsapp-baileys-sidecar/node_modules/baileys",
	);
	for (const relativePath of [
		"package.json",
		...MANAGED_BAILEYS_STATIC_PATCH_TARGETS.map((target) => target.relativePath),
	]) {
		const destination = join(baileysRoot, relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(sourceRoot, relativePath), destination);
	}
}

export function seedHermesManagedBaileys(home: string): void {
	const bridgeRoot = join(home, ".hermes", "hermes-agent", "scripts", "whatsapp-bridge");
	seedManagedBaileysArtifact(hermesManagedBaileysRoot(home));
	writeFileSync(join(bridgeRoot, "package.json"), '{"name":"hermes-whatsapp-bridge"}\n');
	writeFileSync(join(bridgeRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
}

export function applyRuntimeBundleChannelsToManifestLoad(
	load: RuntimeManifestLoad,
	paths?: RuntimePaths,
): RuntimeManifestLoad {
	return applyRuntimeBundleChannelsToManifestLoadWithContext(
		{ ...load, applyContext: load.applyContext ?? explicitTestApplyContext(load.manifest) },
		paths,
	);
}

const ENV_KEYS = [
	"HOME",
	"CLAWDI_HOME",
	"CLAWDI_STATE_DIR",
	"CLAWDI_RUNTIME_MODE",
	"CLAWDI_HOST_POLICY_PATH",
	"CLAWDI_SERVICE_STATE_DIR",
	"CLAWDI_RUN_DIR",
	"CLAWDI_RUNTIME_HOME",
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS",
	"CLAWDI_RUNTIME_TEST_CONTEXT_FILE",
	"CLAWDI_RUNTIME_INSTALL_TIMEOUT",
	"CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER",
	"CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK",
	"OPENCLAW_AGENT_DIR",
	"OPENCLAW_STATE_DIR",
	"CLAWDI_RUNTIME_TEST_HERMES_INSTALLER",
	"CODEX_HOME",
	"CLAWDI_CODEX_INSTALL_DISABLED",
	"CUSTOM_RUNTIME_TOKEN",
	"CLAWDI_RUNTIME_MANIFEST_TIMEOUT_MS",
	"CLAWDI_RUNTIME_APPLY_IDENTITY_FILE",
	"CLAWDI_API_URL",
	"CLAWDI_SYSTEMD_APPLY",
	"CLAWDI_SYSTEMD_SYSTEM_ROOT",
	"CLAWDI_SYSTEMCTL_PATH",
	"CLAWDI_RUNTIME_USER",
	"CLAWDI_RUNTIME_UID",
	"CLAWDI_RUNTIME_GID",
	"CLAWDI_EGRESS_UID",
	"CLAWDI_EGRESS_GID",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

let originalEnv: Partial<Record<EnvKey, string>>;

let originalUmask: number;

export let root: string;

const fakeSystemdStateRoots = new Set<string>();

const gatewayServers: ReturnType<typeof Bun.serve>[] = [];

export function fakeSystemdStatePath(
	stateRoot: string,
	scope: "system" | "user",
	unit: string,
	state: "active" | "enabled" | "failed" | "not-found" | "pid" | "reload",
): string {
	return join(stateRoot, `${scope}-${unit}.${state}`);
}

function seedFakeSystemdProcess(stateRoot: string, scope: "system" | "user", unit: string): void {
	const pidPath = fakeSystemdStatePath(stateRoot, scope, unit, "pid");
	if (existsSync(pidPath)) {
		const existingPid = Number(readFileSync(pidPath, "utf8").trim());
		if (Number.isSafeInteger(existingPid) && existingPid > 0) {
			try {
				process.kill(existingPid, "SIGTERM");
			} catch {}
		}
	}
	const child = spawn("sleep", ["300"], { stdio: "ignore" });
	if (!child.pid) throw new Error(`failed to start fake process for ${unit}`);
	child.unref();
	writeFileSync(fakeSystemdStatePath(stateRoot, scope, unit, "active"), "\n");
	writeFileSync(pidPath, `${child.pid}\n`);
}

export function seedFakeSystemdSnapshotProcesses(
	_paths: RuntimePaths,
	stateRoot: string,
	snapshot: Parameters<typeof applySystemdRuntimeUpdate>[1],
): void {
	for (const [scope, units] of [
		["system", snapshot.system],
		["user", snapshot.user],
	] as const) {
		for (const unit of units.keys()) {
			writeFileSync(fakeSystemdStatePath(stateRoot, scope, unit, "enabled"), "\n");
			if (unit === "clawdi-runtime-watch.service") {
				writeFileSync(fakeSystemdStatePath(stateRoot, scope, unit, "active"), "\n");
				continue;
			}
			seedFakeSystemdProcess(stateRoot, scope, unit);
		}
	}
}

export function writeFakeSystemdManager(input: {
	path: string;
	logPath: string;
	stateRoot: string;
	failNextGatewayRestart?: string;
	failNextSidecarRestart?: string;
	sidecarReadyPath?: string;
}): void {
	fakeSystemdStateRoots.add(input.stateRoot);
	mkdirSync(input.stateRoot, { recursive: true });
	mkdirSync(dirname(input.path), { recursive: true });
	writeFileSync(
		input.path,
		`#!/usr/bin/env bash
set -euo pipefail
raw="$*"
printf '%s\\n' "$raw" >> '${input.logPath}'
scope=system
if [ "\${1:-}" = "--user" ]; then
  scope=user
  shift
fi
command="\${1:-}"
shift || true
state_path() {
  printf '%s/%s-%s.%s' '${input.stateRoot}' "$scope" "$1" "$2"
}
start_process() {
  unit="$1"
  pid_path="$(state_path "$unit" pid)"
  if [ -f "$pid_path" ]; then kill "$(cat "$pid_path")" 2>/dev/null || true; fi
  sleep 300 >/dev/null 2>&1 &
  printf '%s\n' "$!" > "$pid_path"
}
case "$command" in
  show)
    first=1
    for unit in "$@"; do
      case "$unit" in --all|--property=*) continue ;; esac
      if [ "$first" = "0" ]; then printf '\\n'; fi
      first=0
      load_state=loaded
      active_state=inactive
      [ ! -f "$(state_path "$unit" active)" ] || active_state=active
      [ ! -f "$(state_path "$unit" failed)" ] || active_state=failed
      if [ -f "$(state_path "$unit" not-found)" ]; then load_state=not-found; active_state=inactive; fi
      need_daemon_reload=no
      [ ! -f "$(state_path "$unit" reload)" ] || need_daemon_reload=yes
      main_pid=0
      [ ! -f "$(state_path "$unit" pid)" ] || main_pid="$(cat "$(state_path "$unit" pid)")"
      printf 'LoadState=%s\\nActiveState=%s\\nMainPID=%s\\nNeedDaemonReload=%s\\nJob=\\nInvocationID=%032x\\n' "$load_state" "$active_state" "$main_pid" "$need_daemon_reload" "$((main_pid + 1))"
    done
    ;;
  cat)
    [ "\${1:-}" != "--no-pager" ] || shift
    for unit in "$@"; do
      if [ "$scope" = user ]; then
        path="$HOME/.config/systemd/user/$unit"
      else
        path="\${CLAWDI_SYSTEMD_SYSTEM_ROOT:-/etc/systemd/system}/$unit"
      fi
      if [ -f "$path" ]; then cat "$path"; else printf '# fixture unit: %s\\n' "$unit"; fi
    done
    ;;
  is-enabled)
    quiet=0
    if [ "\${1:-}" = "--quiet" ]; then quiet=1; shift; fi
    status=0
    for unit in "$@"; do
      if [ -f "$(state_path "$unit" enabled)" ] || [ -L "$HOME/.config/systemd/user/default.target.wants/$unit" ]; then
        if [ "$quiet" = "0" ]; then printf 'enabled\\n'; fi
      else
        if [ "$quiet" = "0" ]; then printf 'disabled\\n'; fi
        status=1
      fi
    done
    exit "$status"
    ;;
  start)
    for unit in "$@"; do
      rm -f "$(state_path "$unit" failed)" "$(state_path "$unit" not-found)"
      touch "$(state_path "$unit" active)"
      start_process "$unit"
      if [ "$unit" = "clawdi-runtime-sidecar.service" ] && [ -n '${input.sidecarReadyPath ?? ""}' ]; then touch '${input.sidecarReadyPath ?? ""}'; fi
    done
    ;;
  restart)
    if [ "$scope" = user ] && [ "$*" = "openclaw-gateway.service" ] && [ -n '${input.failNextGatewayRestart ?? ""}' ] && [ -f '${input.failNextGatewayRestart ?? ""}' ]; then
      rm -f '${input.failNextGatewayRestart ?? ""}'
      rm -f "$(state_path "openclaw-gateway.service" failed)" "$(state_path "openclaw-gateway.service" not-found)"
      touch "$(state_path "openclaw-gateway.service" active)"
      start_process "openclaw-gateway.service"
      printf 'injected gateway restart failure\n' >&2
      exit 42
    fi
    if [ "$*" = "clawdi-runtime-sidecar.service" ] && [ -n '${input.failNextSidecarRestart ?? ""}' ] && [ -f '${input.failNextSidecarRestart ?? ""}' ]; then
      rm -f '${input.failNextSidecarRestart ?? ""}'
      rm -f "$(state_path "clawdi-runtime-sidecar.service" failed)" "$(state_path "clawdi-runtime-sidecar.service" not-found)"
      touch "$(state_path "clawdi-runtime-sidecar.service" active)"
      start_process "clawdi-runtime-sidecar.service"
      printf 'injected sidecar restart failure\\n' >&2
      exit 42
    fi
    for unit in "$@"; do
      rm -f "$(state_path "$unit" failed)" "$(state_path "$unit" not-found)"
      touch "$(state_path "$unit" active)"
      start_process "$unit"
      if [ "$unit" = "clawdi-runtime-sidecar.service" ] && [ -n '${input.sidecarReadyPath ?? ""}' ]; then touch '${input.sidecarReadyPath ?? ""}'; fi
    done
    ;;
  stop)
    for unit in "$@"; do
      if [ -f "$(state_path "$unit" pid)" ]; then kill "$(cat "$(state_path "$unit" pid)")" 2>/dev/null || true; fi
      rm -f "$(state_path "$unit" active)" "$(state_path "$unit" failed)" "$(state_path "$unit" pid)"
    done
    ;;
	  enable)
	    start_now=0
	    if [ "\${1:-}" = "--now" ]; then start_now=1; shift; fi
	    for unit in "$@"; do
	      touch "$(state_path "$unit" enabled)"
      if [ "$start_now" = "1" ]; then rm -f "$(state_path "$unit" failed)" "$(state_path "$unit" not-found)"; touch "$(state_path "$unit" active)"; start_process "$unit"; fi
    done
    ;;
  disable) for unit in "$@"; do rm -f "$(state_path "$unit" enabled)"; done ;;
  reset-failed) for unit in "$@"; do rm -f "$(state_path "$unit" failed)"; done ;;
  daemon-reload) rm -f '${input.stateRoot}'/"$scope"-*.reload ;;
  *)
    printf 'unexpected systemctl command: %s\\n' "$raw" >&2
    exit 64
    ;;
esac
`,
	);
	chmodSync(input.path, 0o700);
}

export function seedCurrentCliInstall(state: string, version = "1.2.3-test"): void {
	const paths = getRuntimePaths();
	if (paths.serviceStateRoot !== state) throw new Error("CLI fixture state root mismatch");
	const active = paths.cliManagedBin;
	const target = join(paths.cliNpmPrefix, "bin", "clawdi");
	mkdirSync(dirname(active), { recursive: true });
	mkdirSync(dirname(target), { recursive: true });
	mkdirSync(paths.statusRoot, { recursive: true });
	writeFileSync(
		target,
		`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${version}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"ok"}'
  exit 0
fi
echo "seeded clawdi"
`,
	);
	chmodSync(target, 0o700);
	rmSync(active, { force: true });
	symlinkSync(target, active);
}

export function setRuntimeApplyContextFixture(
	identity: {
		generation: number;
		manifestETag: string;
		applyReceiptId: string;
		bootNonce: string;
	},
	contextOverrides: Partial<TestRuntimeContextFixture> = {},
): void {
	const contextValues: TestRuntimeContextFixture = {
		manifestSourceUrl: "https://runtime.test/v1/runtime/manifest",
		bootstrapBearer: "file-runtime-token",
		...contextOverrides,
	};
	currentTestApplyContext = {
		kind: "context-file",
		backend: "incus",
		identity,
		manifestSource: {
			type: "http",
			url: contextValues.manifestSourceUrl,
			auth: { type: "bearer", token: contextValues.bootstrapBearer },
		},
	};
}

interface RuntimeCliFixtureIdentity {
	packageSpec: string;
	registry: string | null;
	npmPrefix: string;
	activeTarget: string;
	version: string;
}

export function createVersionedCliFixture(
	paths: RuntimePaths,
	version: string,
	npmPrefix = join(paths.cliNpmPrefix, "packages", version),
): RuntimeCliFixtureIdentity {
	const activeTarget = join(npmPrefix, "bin", "clawdi");
	mkdirSync(dirname(activeTarget), { recursive: true });
	writeFileSync(
		activeTarget,
		`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${version}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"ok"}'
  exit 0
fi
exit 64
`,
		{ mode: 0o700 },
	);
	chmodSync(activeTarget, 0o700);
	return {
		packageSpec: `clawdi@${version}`,
		registry: "https://registry.npmjs.org",
		npmPrefix,
		activeTarget,
		version,
	};
}

export function pointManagedCliAt(paths: RuntimePaths, identity: RuntimeCliFixtureIdentity): void {
	mkdirSync(dirname(paths.cliManagedBin), { recursive: true });
	rmSync(paths.cliManagedBin, { force: true });
	symlinkSync(identity.activeTarget, paths.cliManagedBin);
}

export function cliManifest(version: string) {
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "dep_cli_transaction",
		environmentId: "env_cli_transaction",
		instanceId: "iid_cli_transaction",
		generation: 1,
		issuedAt: "2026-07-29T00:00:00Z",
		controlPlane: { apiUrl: "https://cloud-api.test" },
		clawdiCli: { source: "npm:clawdi", packageSpec: `clawdi@${version}` },
		runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
		recovery: {},
	};
}

export const TEST_EGRESS_ENGINE_PIN = {
	type: "mitmproxy" as const,
	version: "12.2.3",
	url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
	sha256: "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
};

export const TEST_HOSTED_LOCALE = {
	language: "en" as const,
	timezone: "UTC",
};

export const TEST_HOSTED_CODEX_SECRET_REF = "secret://tool.codex.apiKey";

export const TEST_HOSTED_CODEX_SECRET_VALUES = {
	[TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool",
};

export const TEST_RUNTIME_SERVICE_SECRET_VALUES = {
	"secret://clawdi/auth-token": "test-runtime-auth-token",
	"secret://runtime/openclaw/gateway-token": "test-openclaw-gateway-token",
};

export const TEST_HOSTED_CODEX_TERMINAL_TOOLING = {
	codex: {
		enabled: true,
		provider_id: "clawdi-managed-v2",
		primary_model: { provider_id: "clawdi-managed-v2", model: "gpt-5.5" },
		provider: {
			kind: "openai-compatible",
			type: "openai",
			baseUrl: "https://sub2api.test/v1",
			apiMode: "openai_responses",
			managed_by: "clawdi",
			runtimeEnvName: "CLAWDI_AI_API_KEY",
			apiKeySecretRef: TEST_HOSTED_CODEX_SECRET_REF,
		},
	},
};

export function hostedRequiredState() {
	return {
		egressEngine: TEST_EGRESS_ENGINE_PIN,
		providers: {
			default: {
				kind: "openai-compatible",
				status: "error",
				error: { code: "provider_not_found", message: "fixture provider unavailable" },
			},
		},
		terminalTooling: TEST_HOSTED_CODEX_TERMINAL_TOOLING,
		liveSync: { enabled: false, agents: [] },
		recovery: { cacheManifest: true, allowOfflineBoot: true },
	};
}

export function hostedSystemFixture(
	_home: string,
	_workspace = join(_home, "clawdi"),
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		openclawControlUiAllowedOrigins: ["https://agent.example.test"],
		openclawGatewayAuth: {
			mode: "token",
			tokenRef: "secret://runtime/openclaw/gateway-token",
			deviceAuthRequired: false,
			activation: {
				enabled: true,
				capability: "openclaw-native-auth-v1",
			},
		},
		...overrides,
	};
}

export function hostedHermesSystemFixture(
	home: string,
	workspace = join(home, "clawdi"),
): Record<string, unknown> {
	void home;
	void workspace;
	return {
		hermesDashboardAuth: {
			mode: "oidc",
			provider: "self-hosted",
			deploymentId: "hdep_hermesfixture",
			issuer: "https://api.example.test/v2/hermes/oidc",
			clientId: "clawdi-hermes-hdep_hermesfixture-r1",
			accessRevision: 1,
			publicUrl: "https://agent.example.test/hermes",
			trustedProxies: ["10.173.0.1"],
			activation: { enabled: true, capability: "hermes-self-hosted-oidc-v1" },
		},
	};
}

export function runtimeWatchLocaleManifest(
	home: string,
	generation: number,
	language: "en" | "fr" = "en",
	timezone = "UTC",
): RuntimeManifest {
	const payload = hostedRuntimeWatchLocalePayload(home, generation, language, timezone);
	return normalizeHostedManifestFixture({
		manifest: payload.manifest,
		secretValues: {
			...TEST_HOSTED_CODEX_SECRET_VALUES,
			...TEST_RUNTIME_SERVICE_SECRET_VALUES,
		},
	}).manifest;
}

export interface HostedRuntimeResponseFixture {
	manifest: Record<string, unknown>;
	secretValues?: Record<string, string>;
	channelBindings?: RuntimeBundleChannelBinding[];
}

export function testBundleEtag(label: string): string {
	return `"sha256:${runtimeContentSha256({ testBundleEtag: label })}"`;
}

export function hostedRuntimeBundleResponse(
	payload: HostedRuntimeResponseFixture,
	options: {
		applyGeneration?: number;
		etag?: string;
		sourceRevision?: string;
		includeRuntimeServiceSecrets?: boolean;
	} = {},
): Response {
	seedMitmproxyCache();
	const channelBindings = payload.channelBindings ?? [];
	const selectedRuntime = payload.manifest.runtime;
	const runtimeServiceSecretValues = {
		"secret://clawdi/auth-token": TEST_RUNTIME_SERVICE_SECRET_VALUES["secret://clawdi/auth-token"],
		...(selectedRuntime === "openclaw"
			? {
					"secret://runtime/openclaw/gateway-token":
						TEST_RUNTIME_SERVICE_SECRET_VALUES["secret://runtime/openclaw/gateway-token"],
				}
			: {}),
	};
	const secretValues = {
		...TEST_HOSTED_CODEX_SECRET_VALUES,
		...(options.includeRuntimeServiceSecrets === false ? {} : runtimeServiceSecretValues),
		...(payload.secretValues ?? {}),
	};
	const etagSourceRevision = options.etag?.match(/^"sha256:([a-f0-9]{64})"$/)?.[1];
	const sourceRevision =
		options.sourceRevision ??
		etagSourceRevision ??
		runtimeContentSha256({
			manifest: payload.manifest,
			channelBindings,
			secretValues,
		});
	if (!/^[a-f0-9]{64}$/.test(sourceRevision)) {
		throw new Error("hosted runtime bundle fixture sourceRevision must be 64 hex characters");
	}
	const etag = options.etag ?? `"sha256:${sourceRevision}"`;
	if (etag !== `"sha256:${sourceRevision}"`) {
		throw new Error("hosted runtime bundle fixture ETag must name its sourceRevision");
	}
	return new Response(
		JSON.stringify({
			schemaVersion: "clawdi.hosted-runtime.bundle.v2",
			sourceRevision,
			manifest: payload.manifest,
			...(options.applyGeneration === undefined
				? {}
				: { applyGeneration: options.applyGeneration }),
			channelBindings,
			secretValues,
		}),
		{
			status: 200,
			headers: {
				"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
				etag,
			},
		},
	);
}

export async function loadCanonicalBundleFixture(fixturePath: string, paths?: RuntimePaths) {
	if (!process.env.CLAWDI_SERVICE_STATE_DIR) {
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "var", "lib", "clawdi");
	}
	if (!process.env.CLAWDI_RUN_DIR) process.env.CLAWDI_RUN_DIR = join(root, "run", "clawdi");
	const runtimePaths = paths ?? getRuntimePaths();
	const raw: unknown = JSON.parse(readFileSync(fixturePath, "utf-8"));
	if (!isRecord(raw) || !isRecord(raw.manifest)) {
		throw new Error("test fixture must contain a hosted runtime manifest response");
	}
	const generation =
		typeof raw.manifest.applyGeneration === "number"
			? raw.manifest.applyGeneration
			: raw.manifest.generation;
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
		throw new Error("test hosted runtime manifest must contain a non-negative apply generation");
	}
	setRuntimeApplyGeneration(generation, CANONICAL_TEST_CONTEXT);
	const secretValues: Record<string, string> = {};
	if (isRecord(raw.secretValues)) {
		for (const [ref, value] of Object.entries(raw.secretValues)) {
			if (typeof value !== "string") throw new Error(`test fixture secret ${ref} must be a string`);
			secretValues[ref] = value;
		}
	}
	const fixture: HostedRuntimeResponseFixture = {
		manifest: raw.manifest,
		secretValues,
	};
	const fetchMock = mockFetch([
		{
			method: "GET",
			path: "/v1/runtime/manifest",
			response: () => hostedRuntimeBundleResponse(fixture),
		},
	]);
	try {
		return await loadRemoteRuntimeManifest(runtimePaths);
	} finally {
		fetchMock.restore();
	}
}

export function hostedRuntimeWatchLocalePayload(
	home: string,
	generation: number,
	language: "en" | "fr" = "fr",
	timezone = "Europe/Paris",
): HostedRuntimeResponseFixture {
	return {
		manifest: {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			runtime: "openclaw",
			deploymentId: "dep_watch_locale",
			environmentId: "env_watch_locale",
			...hostedRequiredState(),
			instanceId: "iid_watch_locale",
			generation,
			issuedAt: "2026-07-11T00:00:00Z",
			locale: { language, timezone },
			system: hostedSystemFixture(home),
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: TEST_RUNNING_CLI_SPEC,
				registry: "https://registry.npmjs.org",
			},
			egressProfiles: { profiles: [] },
			runtimes: {
				openclaw: hostedOpenClawRuntime({}),
			},
		},
		secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
	};
}

export async function hostedChannelBundleLoad(
	home: string,
	runtime: "hermes" | "openclaw",
	generation: number,
	channelBindings: RuntimeBundleChannelBinding[],
	secretValues: Record<string, string>,
): Promise<RuntimeManifestLoad> {
	const payload = hostedRuntimeWatchLocalePayload(home, generation, "en", "UTC");
	const { primary_model: _primary, ...entry } =
		runtime === "hermes" ? hostedHermesRuntime() : hostedOpenClawRuntime();
	const response = hostedRuntimeBundleResponse({
		manifest: {
			...payload.manifest,
			runtime,
			providers: {},
			system: runtime === "hermes" ? hostedHermesSystemFixture(home) : hostedSystemFixture(home),
			runtimes: {
				[runtime]: {
					...entry,
					providerMode: "unmanaged",
					provider_ids: [],
					run: entry.run,
				},
			},
		},
		channelBindings,
		secretValues,
	});
	return applyRuntimeBundleChannelsToManifestLoad(
		parseHostedRuntimeBundleV2(await response.json(), "test://channel-bundle"),
	);
}

export function hostedEgressSecretRotationPayload(
	home: string,
	egressEngine: typeof TEST_EGRESS_ENGINE_PIN,
	secret: string,
	runtime: "openclaw" | "hermes" = "openclaw",
): HostedRuntimeResponseFixture {
	return {
		manifest: {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			runtime,
			deploymentId: "dep_watch_egress_secret_rotation",
			environmentId: "env_watch_egress_secret_rotation",
			...hostedRequiredState(),
			instanceId: "iid_watch_egress_secret_rotation",
			generation: 41,
			issuedAt: "2026-07-28T00:00:00Z",
			locale: TEST_HOSTED_LOCALE,
			system: runtime === "openclaw" ? hostedSystemFixture(home) : hostedHermesSystemFixture(home),
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			egressEngine,
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: TEST_RUNNING_CLI_SPEC,
				registry: "https://registry.npmjs.org",
			},
			runtimes:
				runtime === "openclaw"
					? { openclaw: hostedOpenClawRuntime() }
					: { hermes: hostedHermesRuntime() },
			providers: {
				default: {
					kind: "openai-compatible",
					type: "custom_openai_compatible",
					baseUrl: "https://provider.test/v1",
					models: [{ id: "gpt-test" }],
					apiMode: "openai_responses",
					managed_by: "clawdi",
					runtimeEnvName: "CLAWDI_AI_API_KEY",
					apiKeySecretRef: "secret://provider.default.apiKey",
				},
			},
		},
		secretValues: { "secret://provider.default.apiKey": secret },
	};
}

export function hostedCliManifestResponse(
	home: string,
	packageSpec: string,
	opts: { providerSecretRef?: string } = {},
): HostedRuntimeResponseFixture {
	const provider = opts.providerSecretRef
		? {
				kind: "openai-compatible",
				type: "custom_openai_compatible",
				baseUrl: "https://provider.test/v1",
				models: [{ id: "gpt-5" }],
				apiMode: "openai_responses",
				managed_by: "clawdi",
				runtimeEnvName: "CLAWDI_AI_API_KEY",
				apiKeySecretRef: opts.providerSecretRef,
			}
		: hostedRequiredState().providers.default;
	return {
		manifest: {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			runtime: "openclaw",
			deploymentId: "dep_cli_package_spec",
			environmentId: "env_cli_package_spec",
			...hostedRequiredState(),
			providers: { default: provider },
			instanceId: "iid_cli_package_spec",
			generation: 1,
			issuedAt: "2026-07-12T00:00:00Z",
			locale: TEST_HOSTED_LOCALE,
			system: hostedSystemFixture(home),
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec,
				registry: "https://registry.npmjs.org",
			},
			runtimes: {
				openclaw: hostedOpenClawRuntime({}),
			},
		},
		secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
	};
}

export function fakeOpenClawConfigSchemaCommand(): string {
	return `if [ "$*" = "config schema" ]; then
  printf '%s\n' '{"type":"object","properties":{"memory":{"type":"object","properties":{"search":{"type":"object"}}}}}'
  exit 0
fi`;
}

export function fakeOpenClawConfigPatchCommand(configPath: string): string {
	return `${fakeOpenClawConfigSchemaCommand()}
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  patch="$(cat)"
  CLAWDI_TEST_OPENCLAW_PATCH="$patch" '${process.execPath}' - <<'NODE'
const fs = require("node:fs");
const configPath = ${JSON.stringify(configPath)};
const current = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const patch = JSON.parse(process.env.CLAWDI_TEST_OPENCLAW_PATCH);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const merge = (currentValue, patchValue) => {
  if (!isRecord(patchValue)) return patchValue;
  const next = isRecord(currentValue) ? { ...currentValue } : {};
  for (const [key, value] of Object.entries(patchValue)) {
    if (value === null) delete next[key];
    else next[key] = merge(next[key], value);
  }
  return next;
};
fs.writeFileSync(configPath, JSON.stringify(merge(current, patch)) + "\\n");
NODE
  exit 0
fi`;
}

export function seedOpenClawBinary(home: string): void {
	writeOpenClawConfigMutationFixture(home);
	const openclawBin = join(home, ".local", "bin", "openclaw");
	const configPath = join(home, ".openclaw", "openclaw.json");
	const unitPath = join(home, ".config", "systemd", "user", "openclaw-gateway.service");
	const workspace = join(home, ".openclaw", "workspace");
	mkdirSync(dirname(openclawBin), { recursive: true });
	mkdirSync(join(home, ".openclaw"), { recursive: true });
	writeFileSync(
		openclawBin,
		`#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\n'
  exit 0
fi
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"${workspace}"}]\n'
  exit 0
fi
if [ "$*" = "gateway install --force --json" ]; then
  mkdir -p '${dirname(unitPath)}'
  printf '%s\n' '[Unit]' '[Service]' 'ExecStart=${openclawBin} gateway run' > '${unitPath}'
  printf '{"ok":true}\n'
  exit 0
fi
${fakeOpenClawConfigPatchCommand(configPath)}
exit 0
`,
	);
	chmodSync(openclawBin, 0o700);
}

export function writeOpenClawConfigMutationFixture(
	home: string,
	initialConfig: Record<string, unknown> = {},
): { configPath: string; commandLog: string; mutationLog: string } {
	const commandPath = join(home, ".local", "bin", "openclaw");
	const packageRoot = join(home, ".local", "lib", "node_modules", "openclaw");
	const configPath = join(home, ".openclaw", "openclaw.json");
	const commandLog = join(home, ".openclaw-test-commands.log");
	const mutationLog = join(home, ".openclaw-test-mutation.json");
	mkdirSync(dirname(commandPath), { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
	writeFileSync(commandLog, "");
	writeFileSync(mutationLog, "[]");
	writeFileSync(
		commandPath,
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> '${commandLog}'
if [ "\${1:-}" = "--version" ]; then printf 'openclaw test-version\n'; exit 0; fi
if [ "$*" = "agents list --json" ]; then
  if grep -q 'legacyInvalidConfig' '${configPath}' 2>/dev/null; then exit 1; fi
  printf '[{"id":"main","workspace":"${home}/.openclaw/workspace"}]\n'
  exit 0
fi
if [ "$*" = "config validate --json" ] && grep -q 'legacyInvalidConfig' '${configPath}' 2>/dev/null; then
  printf '{"valid":false,"path":"${configPath}","issues":[{"path":"meta","message":"Invalid input"},{"path":"agents","message":"Invalid input"}]}\n'
  exit 1
fi
if [ "$*" = "doctor --fix --non-interactive" ]; then
  if [ -d "$HOME/.openclaw/tmp" ]; then test "$(stat -c %a "$HOME/.openclaw/tmp")" = 700; fi
  printf '{}\n' > '${configPath}'
  exit 0
fi
if [ "\${1:-}" = "plugins" ] && grep -q 'legacyInvalidConfig' '${configPath}' 2>/dev/null; then
  exit 1
fi
${fakeOpenClawConfigSchemaCommand()}
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then cat >/dev/null; fi
exit 0
`,
	);
	chmodSync(commandPath, 0o700);
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "openclaw",
			type: "module",
			exports: { "./plugin-sdk/config-mutation": "./config-mutation.mjs" },
		}),
	);
	writeFileSync(
		join(packageRoot, "config-mutation.mjs"),
		`import { readFileSync, writeFileSync } from "node:fs";
export async function mutateConfigFile(options) {
  if (options.base !== "source") throw new Error("expected source config mutation");
  if (options.afterWrite?.mode !== "none") throw new Error("expected no SDK-owned restart");
  const before = JSON.parse(readFileSync(${JSON.stringify(configPath)}, "utf8"));
  const draft = structuredClone(before);
  const mutationResult = await options.mutate(draft, { snapshot: {}, previousHash: null, attempt: 1 });
  const next = JSON.stringify(draft, null, 2) + "\\n";
  const beforeBytes = Buffer.byteLength(JSON.stringify(before, null, 2) + "\\n");
  const nextBytes = Buffer.byteLength(next);
  if (nextBytes < Math.floor(beforeBytes * 0.5) && options.writeOptions?.allowConfigSizeDrop !== true) {
    throw new Error(\`size-drop:\${beforeBytes}->\${nextBytes}\`);
  }
  writeFileSync(${JSON.stringify(configPath)}, next);
  const mutations = JSON.parse(readFileSync(${JSON.stringify(mutationLog)}, "utf8"));
  mutations.push({
    base: options.base,
    afterWrite: options.afterWrite,
    allowConfigSizeDrop: options.writeOptions?.allowConfigSizeDrop,
    explicitSetPaths: options.writeOptions?.explicitSetPaths,
    unsetPaths: options.writeOptions?.unsetPaths,
    beforeBytes,
    nextBytes,
    mutationResult,
  });
  writeFileSync(${JSON.stringify(mutationLog)}, JSON.stringify(mutations));
}
export async function readConfigFileSnapshotForWrite() {
  const config = JSON.parse(readFileSync(${JSON.stringify(configPath)}, "utf8"));
  return {
    snapshot: {
      valid: true,
      config,
      sourceConfig: structuredClone(config),
    },
  };
}
`,
	);
	return { configPath, commandLog, mutationLog };
}

export function openClawDiscordPluginInspectFixture(pluginSource: string): Record<string, unknown> {
	return {
		plugin: {
			id: "discord",
			source: pluginSource,
			origin: "global",
			status: "loaded",
			version: "1.2.3",
			enabled: true,
		},
		install: {
			source: "npm",
			spec: "@openclaw/discord",
			installPath: dirname(pluginSource),
			resolvedName: "@openclaw/discord",
			resolvedVersion: "1.2.3",
			integrity: "sha512-test",
		},
	};
}

export function openClawWhatsAppPluginInspectFixture(
	pluginSource: string,
	source: "npm" | "clawhub" = "npm",
	version = "2026.7.1",
): Record<string, unknown> {
	return {
		plugin: {
			id: "whatsapp",
			source: pluginSource,
			origin: "global",
			status: "loaded",
			version,
			enabled: true,
		},
		install:
			source === "npm"
				? {
						source: "npm",
						spec: "@openclaw/whatsapp",
						installPath: dirname(pluginSource),
						version,
						resolvedName: "@openclaw/whatsapp",
						resolvedVersion: version,
						resolvedSpec: `@openclaw/whatsapp@${version}`,
						integrity: "sha512-test",
					}
				: {
						source: "clawhub",
						spec: `clawhub:@openclaw/whatsapp@${version}`,
						clawhubPackage: "@openclaw/whatsapp",
						installPath: dirname(pluginSource),
						version,
						integrity: "sha256-test",
						npmIntegrity: "sha512-test",
						clawpackSha256: "sha256-test-clawpack",
					},
	};
}

export function seedOfficialOpenClawServiceInstaller(home: string): void {
	const openclawBin = join(home, ".local", "bin", "openclaw");
	const openclawConfig = join(home, ".openclaw", "openclaw.json");
	const unitPath = join(home, ".config", "systemd", "user", "openclaw-gateway.service");
	const workspace = join(home, ".openclaw", "workspace");
	mkdirSync(dirname(openclawBin), { recursive: true });
	writeFileSync(
		openclawBin,
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"${workspace}"}]\\n'
  exit 0
fi
${fakeOpenClawConfigPatchCommand(openclawConfig)}
if [ "$*" = "gateway install --force --json" ]; then
  mkdir -p '${dirname(unitPath)}'
  printf '%s\\n' '[Unit]' '[Service]' 'ExecStart=${openclawBin} gateway run' > '${unitPath}'
  printf '{"ok":true}\\n'
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
	);
	chmodSync(openclawBin, 0o700);
}

export function seedHostedCodexPackage(
	home: string,
	version: string,
	options: { executable?: boolean; validPackageJson?: boolean } = {},
): { packageJson: string; realBin: string } {
	const npmPrefix = join(home, ".local");
	const packageJson = join(npmPrefix, "lib", "node_modules", "@openai", "codex", "package.json");
	const realBin = join(npmPrefix, "bin", "codex");
	mkdirSync(dirname(packageJson), { recursive: true });
	mkdirSync(dirname(realBin), { recursive: true });
	writeFileSync(
		packageJson,
		options.validPackageJson === false
			? "not-json\n"
			: JSON.stringify({ name: "@openai/codex", version }),
	);
	writeFileSync(realBin, "#!/bin/sh\nexit 0\n");
	chmodSync(realBin, options.executable === false ? 0o600 : 0o755);
	return { packageJson, realBin };
}

export function writeHostedCodexNpmInstaller(
	binDir: string,
	markerPath: string,
	installedVersion: string,
	installedName = "@openai/codex",
): void {
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(binDir, "npm"),
		[
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			`printf 'install\\n' >> '${markerPath}'`,
			"prefix=''",
			"registry=''",
			"scoped_registry=''",
			'test "${!#}" = "@openai/codex"',
			'while [ "$#" -gt 0 ]; do',
			'  case "$1" in',
			'    --prefix) prefix="$2"; shift 2 ;;',
			'    --registry) registry="$2"; shift 2 ;;',
			'    --@openai:registry=*) scoped_registry="${1#*=}"; shift ;;',
			"    *) shift ;;",
			"  esac",
			"done",
			'test "$registry" = "https://registry.npmjs.org"',
			'test "$scoped_registry" = "$registry"',
			'mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@openai/codex"',
			`printf '%s\\n' '{"name":"${installedName}","version":"${installedVersion}"}' > "$prefix/lib/node_modules/@openai/codex/package.json"`,
			"printf '#!/bin/sh\\nexit 0\\n' > \"$prefix/bin/codex\"",
			'chmod 755 "$prefix/bin/codex"',
			"",
		].join("\n"),
	);
	chmodSync(join(binDir, "npm"), 0o755);
}

export function seedRuntimeWatchLocaleBaseline(
	home: string,
	state: string,
	run: string,
	connection?: { apiUrl: string; agentId: string },
): RuntimePaths {
	mkdirSync(join(run, "secrets"), { recursive: true });
	seedOpenClawBinary(home);
	process.env.HOME = home;
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_SERVICE_STATE_DIR = state;
	process.env.CLAWDI_RUN_DIR = run;
	process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
	process.env.CLAWDI_AUTH_TOKEN = "file-runtime-token";
	setRuntimeApplyGeneration(1, CANONICAL_TEST_CONTEXT);
	seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
	writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
	const paths = getRuntimePaths();
	seedMitmproxyCache(paths);
	const payload = hostedRuntimeWatchLocalePayload(home, 1, "en", "UTC");
	if (connection) {
		payload.manifest.environmentId = connection.agentId;
		payload.manifest.controlPlane = { cloudApiUrl: connection.apiUrl };
	}
	const sourceRevision = testBundleEtag("manifest-locale-1").slice(8, -1);
	const load: RuntimeManifestLoad = {
		manifest: normalizeHostedManifestFixture({
			manifest: payload.manifest,
			secretValues: { ...TEST_HOSTED_CODEX_SECRET_VALUES, ...TEST_RUNTIME_SERVICE_SECRET_VALUES },
		}).manifest,
		sourceBundle: {
			schemaVersion: "clawdi.hosted-runtime.bundle.v2",
			sourceRevision,
			manifest: payload.manifest,
			channelBindings: [],
			secretValues: {},
		},
		sourceRevision,
		channelBindings: [],
		source: "remote-datasource",
		sourcePath: "https://runtime.test/v1/runtime/manifest",
		offline: false,
		secretValues: {
			...TEST_HOSTED_CODEX_SECRET_VALUES,
			"secret://clawdi/auth-token":
				TEST_RUNTIME_SERVICE_SECRET_VALUES["secret://clawdi/auth-token"],
			"secret://runtime/openclaw/gateway-token":
				TEST_RUNTIME_SERVICE_SECRET_VALUES["secret://runtime/openclaw/gateway-token"],
		},
		applyContext: currentTestApplyContext,
	};
	const convergence = convergeRuntimeManifest(load, paths);
	if (convergence.installErrors.length > 0) throw new Error(convergence.installErrors.join("; "));
	writeTestRuntimeAppliedState(paths, load, convergence, {
		etag: testBundleEtag("manifest-locale-1"),
	});
	return paths;
}

export function installSuccessfulSystemctlFixture(
	sidecarReadyPath = join(root, "run", "clawdi", "egress", "systemd", "ca.pem"),
	systemctlLog?: string,
): void {
	const systemctlPath = join(root, "bin", "systemctl");
	writeFakeSystemdManager({
		path: systemctlPath,
		logPath: systemctlLog ?? join(root, "systemctl-success.log"),
		stateRoot: join(root, "systemctl-success-state"),
		sidecarReadyPath,
	});
	process.env.CLAWDI_SYSTEMD_APPLY = "1";
	process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
	process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
}

export function startHealthyOpenClawGateway(port = 0) {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (request.method === "GET" && path === "/readyz") {
				return Response.json({ ready: true });
			}
			if (request.method === "HEAD" && path === "/") {
				return new Response(null, { status: 200 });
			}
			return new Response(null, { status: 404 });
		},
	});
	gatewayServers.push(server);
	return { port: server.port };
}

export function cachedMitmproxyBinary(
	paths: RuntimePaths,
	pin: typeof TEST_EGRESS_ENGINE_PIN,
): string {
	return join(paths.egressEngineMaintainedRoot, pin.version, pin.sha256, "mitmdump");
}

export function seedMitmproxyCache(paths = getRuntimePaths()): typeof TEST_EGRESS_ENGINE_PIN {
	const binary = cachedMitmproxyBinary(paths, TEST_EGRESS_ENGINE_PIN);
	mkdirSync(dirname(binary), { recursive: true });
	writeFileSync(binary, "#!/usr/bin/env sh\necho fake mitmdump\n");
	chmodSync(binary, 0o755);
	return TEST_EGRESS_ENGINE_PIN;
}

type HostedRunFixture = {
	args?: string[];
	secretEnv?: Record<string, string>;
};

type HostedRuntimeFixtureEntry = {
	enabled: boolean;
	providerMode: "configured" | "unmanaged";
	install: { source: "official" };
	run?: HostedRunFixture;
	services?: Record<string, HostedRunFixture>;
	provider_ids: string[];
	primary_model: { provider_id: string; model: string };
};

export function hostedOpenClawRuntime(
	overrides: Partial<HostedRuntimeFixtureEntry> = {},
): HostedRuntimeFixtureEntry {
	process.env.OPENCLAW_GATEWAY_TOKEN ??= "test-openclaw-gateway-token";
	const {
		provider_ids = ["default"],
		primary_model = { provider_id: provider_ids[0] ?? "default", model: "gpt-test" },
		...entryOverrides
	} = overrides;
	return {
		enabled: true,
		install: { source: "official" },
		providerMode: "configured",
		provider_ids,
		primary_model,
		run: {
			args: ["gateway", "run"],
			secretEnv: {
				OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
			},
		},
		services: {},
		...entryOverrides,
	};
}

export function hostedHermesRuntime(
	overrides: Partial<HostedRuntimeFixtureEntry> = {},
): HostedRuntimeFixtureEntry {
	const {
		provider_ids = ["default"],
		primary_model = { provider_id: provider_ids[0] ?? "default", model: "gpt-test" },
		...entryOverrides
	} = overrides;
	return {
		enabled: true,
		install: { source: "official" },
		providerMode: "configured",
		provider_ids,
		primary_model,
		run: {
			args: ["gateway", "run"],
		},
		services: {
			dashboard: {
				args: ["dashboard", "--host", "0.0.0.0", "--port", "9119", "--no-open"],
			},
		},
		...entryOverrides,
	};
}

function hostedOAuthEnvelope(accessToken: string, refreshToken: string): string {
	const auth = JSON.stringify({
		tokens: {
			access_token: accessToken,
			refresh_token: refreshToken,
			id_token: "hosted-id-token",
			account_id: "hosted-account",
		},
		last_refresh: "2026-07-31T00:00:00Z",
	});
	return JSON.stringify({
		schemaVersion: 1,
		kind: "local_agent_profile",
		tool: "codex",
		profile: "default",
		files: [{ logicalName: "auth.json", content: auth }],
	});
}

export function hostedOAuthRuntimeLoad(input: {
	home: string;
	runtime: "hermes" | "openclaw";
	generation: number;
	credentialRevision: string;
	accessToken: string;
	refreshToken: string;
}): RuntimeManifestLoad {
	seedMitmproxyCache();
	const providerId = "openai-codex";
	const secretRef = `secret://provider.${providerId}.oauthProfile`;
	const runtime =
		input.runtime === "hermes"
			? hostedHermesRuntime({
					provider_ids: [providerId],
					primary_model: { provider_id: providerId, model: "gpt-5.2-codex" },
				})
			: hostedOpenClawRuntime({
					provider_ids: [providerId],
					primary_model: { provider_id: providerId, model: "gpt-5.2-codex" },
				});
	const normalized = normalizeHostedManifestFixture({
		manifest: {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			runtime: input.runtime,
			deploymentId: "dep_hosted_oauth",
			environmentId: "env_hosted_oauth",
			...hostedRequiredState(),
			providers: {
				[providerId]: {
					kind: "openai-compatible",
					type: "openai",
					baseUrl: "https://api.openai.com/v1",
					models: [{ id: "gpt-5.2-codex" }],
					apiMode: "openai_responses",
					managed_by: "user",
					auth: {
						type: "agent_profile",
						tool: "codex",
						profile: "default",
						credentialSecretRef: secretRef,
						credentialRevision: input.credentialRevision,
					},
				},
			},
			instanceId: "iid_hosted_oauth",
			generation: input.generation,
			issuedAt: "2026-07-31T00:00:00Z",
			locale: TEST_HOSTED_LOCALE,
			system:
				input.runtime === "hermes"
					? hostedHermesSystemFixture(input.home)
					: hostedSystemFixture(input.home),
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: TEST_RUNNING_CLI_SPEC,
				registry: "https://registry.npmjs.org",
			},
			runtimes: { [input.runtime]: runtime },
		},
		secretValues: {
			[secretRef]: hostedOAuthEnvelope(input.accessToken, input.refreshToken),
			...TEST_HOSTED_CODEX_SECRET_VALUES,
			...TEST_RUNTIME_SERVICE_SECRET_VALUES,
		},
	});
	return {
		...normalized,
		source: "remote-datasource",
		sourcePath: "https://runtime-source.test/desired-state",
		offline: false,
	};
}

function systemdUnitFileName(name: string): string {
	return `${name}.service`;
}

export function readSystemdSystemUnit(paths: RuntimePaths, name: string): string {
	return readFileSync(join(paths.systemdSystemRoot, systemdUnitFileName(name)), "utf-8");
}

export function readSystemdUserServiceConfig(paths: RuntimePaths, name: string): string {
	const unitPath = join(paths.systemdUserRoot, systemdUnitFileName(name));
	const dropInPath = join(
		paths.systemdUserRoot,
		`${systemdUnitFileName(name)}.d`,
		"10-clawdi-hosted.conf",
	);
	return [
		existsSync(unitPath) ? readFileSync(unitPath, "utf-8") : "",
		existsSync(dropInPath) ? readFileSync(dropInPath, "utf-8") : "",
	].join("\n");
}

export function readSystemdEnvFile(paths: RuntimePaths, name: string): string {
	return readFileSync(join(paths.systemdEnvRoot, `${systemdUnitFileName(name)}.env`), "utf-8");
}

export function systemdEnvDigest(envFile: string): string {
	const match = envFile.match(/^CLAWDI_MANAGED_CONTENT_DIGEST="([^"]+)"$/m);
	expect(match?.[1]).toBeTruthy();
	return match?.[1] ?? "";
}

export function expectExistingFileNotToContain(path: string, value: string): void {
	if (!existsSync(path)) return;
	expect(readFileSync(path, "utf-8")).not.toContain(value);
}

export function expectProviderEgressProfileUsesSecretRef(
	profiles: unknown,
	secretRef: string,
	plaintextSecret: string,
): void {
	expect(Array.isArray(profiles)).toBe(true);
	const providerProfiles = (profiles as Array<Record<string, unknown>>).filter(
		(profile) => profile.kind === "provider" && profile.owner === "provider-projection",
	);
	const matchingProfiles = providerProfiles.filter((profile) =>
		JSON.stringify(profile).includes(`"secretRef":"${secretRef}"`),
	);
	expect(matchingProfiles.length).toBeGreaterThan(0);
	const providerProfileText = JSON.stringify(matchingProfiles[0]);
	expect(providerProfileText).toContain(`"secretRef":"${secretRef}"`);
	expect(providerProfileText).toContain('"type":"secretRef"');
	expect(providerProfileText).not.toContain(plaintextSecret);
}

export function expectEgressProfileBundleUsesSecretRef(
	bundlePath: string | null,
	secretRef: string,
	plaintextSecret: string,
): void {
	expect(bundlePath).toBeTruthy();
	if (!bundlePath) throw new Error("expected egress profile bundle path");
	const bundleText = readFileSync(bundlePath, "utf-8");
	expect(bundleText).toContain(secretRef);
	expect(bundleText).not.toContain(plaintextSecret);
	const bundle = JSON.parse(bundleText) as { profiles?: unknown };
	expectProviderEgressProfileUsesSecretRef(bundle.profiles, secretRef, plaintextSecret);
}

export function expectMitmSecretFileIsSidecarOnly(
	paths: RuntimePaths,
	egressSecretFile: string | null,
	secretRef: string,
	plaintextSecret: string,
): void {
	expect(egressSecretFile).toBe(join(paths.managedSecretRoot, "egress-secrets.json"));
	if (!egressSecretFile) throw new Error("expected egress secret file path");
	expect(egressSecretFile.startsWith(paths.userHome)).toBe(false);
	expect(egressSecretFile.startsWith(paths.serviceStateRoot)).toBe(false);
	const secretFileStat = statSync(egressSecretFile);
	expect(secretFileStat.mode & 0o777).toBe(0o600);
	expect(statSync(dirname(egressSecretFile)).mode & 0o777).toBe(0o711);
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		expect(secretFileStat.uid).toBe(0);
		expect(secretFileStat.gid).toBe(0);
	}
	const secrets = JSON.parse(readFileSync(egressSecretFile, "utf-8")) as Record<string, string>;
	expect(secrets[secretRef]).toBe(plaintextSecret);
}

export function hermesModelProviderPluginDir(home: string): string {
	return join(home, ".hermes", "plugins", "model-providers", "clawdi");
}

export function readHermesConfigYaml(home: string): Record<string, unknown> {
	const parsed = parseYaml(readFileSync(join(home, ".hermes", "config.yaml"), "utf-8"));
	if (!isRecord(parsed)) {
		throw new Error("Expected Hermes config.yaml to parse to a YAML object.");
	}
	return parsed;
}

export function readOpenClawMcpServers(home: string): Record<string, unknown> {
	const config = expectRecord(
		JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf-8")),
		"OpenClaw config",
	);
	const mcp = expectRecord(config.mcp, "OpenClaw MCP config");
	return expectRecord(mcp.servers, "OpenClaw MCP servers");
}

export function managedRemoteMcpServer(serverName: string, revision: string) {
	return {
		url: `https://mcp.clawdi.test/${serverName}/${revision}`,
		transport: "streamable-http" as const,
		headers: {
			Authorization: { secretRef: `secret://mcp/${serverName}`, prefix: "Bearer " },
		},
	};
}

export function nativeManagedRemoteMcpServer(serverName: string, revision: string) {
	const server = managedRemoteMcpServer(serverName, revision);
	return {
		...server,
		headers: {
			Authorization: `Bearer ${managedMcpHeaderPlaceholder(serverName, "Authorization")}`,
		},
	};
}

export function writeFakeOpenClawMcpBinary(
	home: string,
	options: {
		callsPath?: string;
		failSetFile?: string;
		failUnsetFile?: string;
		failSetServer?: string;
	} = {},
): { commandPath: string; configPath: string } {
	const commandPath = join(home, ".local", "bin", "openclaw");
	const configPath = join(home, ".openclaw", "openclaw.json");
	const workspace = join(home, ".openclaw", "workspace");
	const logSet = options.callsPath
		? `printf 'set %s\\n' "\${3:?missing server name}" >> '${options.callsPath}'`
		: ":";
	const logUnset = options.callsPath
		? `printf 'unset %s\\n' "\${3:?missing server name}" >> '${options.callsPath}'`
		: ":";
	const failSetFile = options.failSetFile
		? `if [ -e '${options.failSetFile}' ]; then exit 42; fi`
		: ":";
	const failUnsetFile = options.failUnsetFile
		? `if [ -e '${options.failUnsetFile}' ]; then exit 43; fi`
		: ":";
	const failSetServer = options.failSetServer
		? `if [ "\${3}" = '${options.failSetServer}' ]; then exit 42; fi`
		: ":";
	mkdirSync(dirname(commandPath), { recursive: true });
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(
		commandPath,
		`#!/usr/bin/env bash
set -euo pipefail
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"${workspace}"}]\n'
  exit 0
fi
${fakeOpenClawConfigPatchCommand(configPath)}
if [ "\${1:-} \${2:-}" = "skills install" ]; then
  source="\${3:?missing source}"; shift 3; slug=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--as" ]; then slug="\${2:?missing slug}"; shift; fi
    shift
  done
  rm -rf "${workspace}/skills/$slug"
  mkdir -p "${workspace}/skills/$slug"
  cp -R "$source/." "${workspace}/skills/$slug/"
  exit 0
fi
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "set" ]; then
  ${logSet}
  ${failSetFile}
  ${failSetServer}
  node - '${configPath}' "\${3}" "\${4:?missing server config}" <<'NODE'
const fs = require("node:fs");
const [path, name, raw] = process.argv.slice(2);
const config = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
config.mcp ??= {};
config.mcp.servers ??= {};
config.mcp.servers[name] = JSON.parse(raw);
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\\n");
NODE
  exit 0
fi
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "unset" ]; then
  ${logUnset}
  ${failUnsetFile}
  node - '${configPath}' "\${3:?missing server name}" <<'NODE'
const fs = require("node:fs");
const [path, name] = process.argv.slice(2);
const config = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
if (!config.mcp?.servers || !Object.hasOwn(config.mcp.servers, name)) process.exit(44);
delete config.mcp.servers[name];
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\\n");
NODE
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
	);
	chmodSync(commandPath, 0o700);
	return { commandPath, configPath };
}

export function expectRecord(input: unknown, label: string): Record<string, unknown> {
	if (!isRecord(input)) {
		throw new Error(`Expected ${label} to be a YAML object.`);
	}
	return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function writeHermesVersionBinary(home: string, version: string): string {
	const hermesBin = join(home, ".local", "bin", "hermes");
	mkdirSync(dirname(hermesBin), { recursive: true });
	writeFileSync(
		hermesBin,
		[
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			`if [ "\${1:-}" = "--version" ]; then`,
			`  echo "Hermes Agent v${version} (2026-07-01)"`,
			"  exit 0",
			"fi",
			`if [ "\${1:-}" = "config" ]; then`,
			`  exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"`,
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(hermesBin, 0o700);
	writeHermesDashboardPython(home, true);
	return hermesBin;
}

export function hermesTestPythonScript(compatible: boolean): string {
	const venv = process.env.CLAWDI_TEST_HERMES_VENV;
	if (!venv) throw new Error("Run runtime tests through the Docker CLI test runner");
	return `#!/usr/bin/env bash
case "$*" in
  *hermes-managed-env.json*|*"from hermes_cli import profiles"*) exec '${join(venv, "bin", "python")}' "$@" ;;
esac
${compatible ? "exit 0" : "printf '%s\\n' 'missing capture_signals' >&2\nexit 1"}
`;
}

export function writeHermesDashboardPython(home: string, compatible: boolean): string {
	const python = join(home, ".hermes", "hermes-agent", "venv", "bin", "python");
	mkdirSync(dirname(python), { recursive: true });
	writeFileSync(python, hermesTestPythonScript(compatible));
	chmodSync(python, 0o700);
	return python;
}

export function writeFakeOpenClawProviderAuthSdk(directory: string, callsPath: string): string {
	const sdkPath = join(directory, "fake-openclaw-provider-auth.mjs");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		sdkPath,
		`import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const callsPath = ${JSON.stringify(callsPath)};
const failurePath = callsPath + ".fail";
const defaultAgentDir = () => join(
  process.env.OPENCLAW_STATE_DIR || join(process.env.HOME, ".openclaw"),
  "agents",
  "main",
  "agent",
);
const resolveAgentDir = (agentDir) => agentDir || defaultAgentDir();
const storePath = (agentDir) => join(resolveAgentDir(agentDir), "openclaw-agent.sqlite");
const readStore = (agentDir) => {
  const path = storePath(agentDir);
  return existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { profiles: {}, order: {}, lastGood: {}, usageStats: {} };
};
export function ensureAuthProfileStoreForLocalUpdate(agentDir) {
  appendFileSync(callsPath, "ensure " + agentDir + "\\n");
  return readStore(agentDir);
}
export function listProfilesForProvider(store, provider) {
  appendFileSync(callsPath, "list " + provider + "\\n");
  const providerKey = provider.trim().toLowerCase();
  return Object.entries(store.profiles)
    .filter(([, credential]) => credential?.provider?.trim().toLowerCase() === providerKey)
    .map(([profileId]) => profileId);
}
export async function updateAuthProfileStoreWithLock({ agentDir, updater }) {
  appendFileSync(callsPath, "update " + agentDir + "\\n");
  const store = readStore(agentDir);
  const changed = await updater(store);
  if (changed) {
    mkdirSync(resolveAgentDir(agentDir), { recursive: true });
    writeFileSync(storePath(agentDir), JSON.stringify(store, null, 2) + "\\n", { mode: 0o600 });
  }
  return store;
}
export async function removeProviderAuthProfilesWithLock({ provider, agentDir }) {
  appendFileSync(callsPath, "remove " + provider + " " + (agentDir || "default") + "\\n");
  if (existsSync(failurePath)) {
    const remaining = Number(readFileSync(failurePath, "utf8").trim());
    if (!Number.isSafeInteger(remaining) || remaining <= 0) {
      throw new Error("simulated provider-auth cleanup failure");
    }
    writeFileSync(failurePath, String(remaining - 1));
  }
  const providerKey = provider.trim().toLowerCase();
  return updateAuthProfileStoreWithLock({
    agentDir,
    updater: (store) => {
      const profileIds = Object.entries(store.profiles)
        .filter(([, credential]) => credential?.provider?.trim().toLowerCase() === providerKey)
        .map(([profileId]) => profileId);
      let changed = false;
      for (const profileId of profileIds) {
        delete store.profiles[profileId];
        if (store.usageStats?.[profileId]) delete store.usageStats[profileId];
        changed = true;
      }
      for (const key of Object.keys(store.order || {})) {
        if (key.trim().toLowerCase() === providerKey) {
          delete store.order[key];
          changed = true;
        }
      }
      for (const key of Object.keys(store.lastGood || {})) {
        if (key.trim().toLowerCase() === providerKey) {
          delete store.lastGood[key];
          changed = true;
        }
      }
      if (store.order && Object.keys(store.order).length === 0) delete store.order;
      if (store.lastGood && Object.keys(store.lastGood).length === 0) delete store.lastGood;
      if (store.usageStats && Object.keys(store.usageStats).length === 0) delete store.usageStats;
      return changed;
    },
  });
}
`,
	);
	return sdkPath;
}

export function hostedHermesProviderLoad(home: string): RuntimeManifestLoad {
	seedMitmproxyCache();
	const normalized = normalizeHostedManifestFixture({
		manifest: {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			runtime: "hermes",
			deploymentId: "dep_hermes_provider",
			environmentId: "env_hermes_provider",
			...hostedRequiredState(),
			providers: {
				hermes: {
					kind: "openai-compatible",
					type: "custom_openai_compatible",
					baseUrl: "https://hermes-provider.example.test/v1",
					models: [
						{
							id: "kimi/kimi-for-coding",
							context_window: 262144,
							max_tokens: 32768,
							input_modalities: ["text", "image"],
							supports_vision: true,
							supports_tools: true,
							supports_reasoning: true,
						},
					],
					apiMode: "openai_chat",
					managed_by: "user",
					runtimeEnvName: "HERMES_PROVIDER_API_KEY",
					apiKeySecretRef: "secret://provider.hermes.apiKey",
				},
			},
			instanceId: "iid_hermes_provider",
			generation: 1,
			issuedAt: "2026-06-22T00:00:00Z",
			locale: TEST_HOSTED_LOCALE,
			system: hostedHermesSystemFixture(home),
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: TEST_RUNNING_CLI_SPEC,
				registry: "https://registry.npmjs.org",
			},
			runtimes: {
				hermes: hostedHermesRuntime({
					provider_ids: ["hermes"],
					primary_model: { provider_id: "hermes", model: "kimi/kimi-for-coding" },
				}),
			},
		},
		secretValues: {
			"secret://provider.hermes.apiKey": "sk-hermes-provider",
			...TEST_HOSTED_CODEX_SECRET_VALUES,
			...TEST_RUNTIME_SERVICE_SECRET_VALUES,
		},
	});
	return {
		...normalized,
		source: "remote-datasource",
		sourcePath: "https://runtime-source.test/desired-state",
		offline: false,
	};
}

export function hostedHermesDashboardCapabilityLoad(home: string): RuntimeManifestLoad {
	const load = hostedHermesProviderLoad(home);
	load.manifest.runtime = "hermes";
	load.manifest.runtimes.hermes.services = {
		dashboard: {
			args: ["dashboard", "--host", "0.0.0.0", "--port", "9119", "--no-open"],
			env: {},
			prependPath: [],
		},
	};
	load.manifest.hermesDashboardAuth = {
		mode: "oidc",
		provider: "self-hosted",
		deploymentId: "hdep_hermesfixture",
		issuer: "https://api.example.test/v2/hermes/oidc",
		clientId: "clawdi-hermes-hdep_hermesfixture-r1",
		accessRevision: 1,
		publicUrl: "https://agent.example.test/hermes",
		trustedProxies: ["10.173.0.1"],
		activation: { enabled: true, capability: "hermes-self-hosted-oidc-v1" },
	};
	return load;
}

function hostedCodexTerminalProvider(baseUrl: string): Record<string, unknown> {
	return {
		kind: "openai-compatible",
		type: "openai",
		baseUrl,
		apiMode: "openai_responses",
		managed_by: "clawdi",
		runtimeEnvName: "CLAWDI_AI_API_KEY",
		apiKeySecretRef: TEST_HOSTED_CODEX_SECRET_REF,
	};
}

export function hostedSingleProviderModeLoad(
	home: string,
	runtimeName: "openclaw" | "hermes",
	providerMode: "configured" | "unmanaged",
	generation: number,
	instanceId = "iid_provider_mode",
): RuntimeManifestLoad {
	const configuredRuntime =
		runtimeName === "openclaw"
			? hostedOpenClawRuntime({
					providerMode: "configured",
					provider_ids: ["clawdi-managed"],
					primary_model: { provider_id: "clawdi-managed", model: "gpt-5.5" },
				})
			: hostedHermesRuntime({
					providerMode: "configured",
					provider_ids: ["clawdi-managed"],
					primary_model: { provider_id: "clawdi-managed", model: "gpt-5.5" },
				});
	const { primary_model: _primaryModel, ...runtimeWithoutPrimaryModel } = configuredRuntime;
	const runtime =
		providerMode === "configured"
			? configuredRuntime
			: { ...runtimeWithoutPrimaryModel, providerMode: "unmanaged" as const, provider_ids: [] };
	const providers =
		providerMode === "configured"
			? {
					"clawdi-managed": {
						kind: "openai-compatible",
						type: "custom_openai_compatible",
						baseUrl: "https://managed.provider.example.test/v1",
						models: [{ id: "gpt-5.5" }],
						apiMode: "openai_responses",
						managed_by: "clawdi",
						runtimeEnvName: "CLAWDI_AI_API_KEY",
						apiKeySecretRef: "secret://provider.clawdi-managed.apiKey",
					},
				}
			: {};
	const codexProvider = hostedCodexTerminalProvider(
		"https://clawdi-managed.provider.example.test/v1",
	);
	const terminalTooling = {
		codex: {
			enabled: true,
			provider_id: "clawdi-managed",
			primary_model: { provider_id: "clawdi-managed", model: "gpt-5.5" },
			provider: codexProvider,
		},
	};
	seedMitmproxyCache();
	const normalized = normalizeHostedManifestFixture({
		manifest: {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			runtime: runtimeName,
			deploymentId: "dep_provider_mode",
			environmentId: "env_provider_mode",
			...hostedRequiredState(),
			providers,
			terminalTooling,
			instanceId,
			generation,
			issuedAt: "2026-07-14T00:00:00Z",
			locale: TEST_HOSTED_LOCALE,
			system:
				runtimeName === "openclaw" ? hostedSystemFixture(home) : hostedHermesSystemFixture(home),
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: TEST_RUNNING_CLI_SPEC,
				registry: "https://registry.npmjs.org",
			},
			runtimes: { [runtimeName]: runtime },
		},
		secretValues: {
			...(providerMode === "configured"
				? { "secret://provider.clawdi-managed.apiKey": "sk-managed-provider" }
				: {}),
			...TEST_HOSTED_CODEX_SECRET_VALUES,
			...TEST_RUNTIME_SERVICE_SECRET_VALUES,
		},
	});
	return {
		...normalized,
		source: "remote-datasource",
		sourcePath: "https://runtime-source.test/desired-state",
		offline: false,
	};
}

export function hostedManagedOpenClawV2Load(home: string, generation: number): RuntimeManifestLoad {
	const load = hostedSingleProviderModeLoad(home, "openclaw", "configured", generation);
	const providerId = "clawdi-v2-deployment-42";
	const providers: NonNullable<RuntimeManifest["projection"]>["providers"] = {
		[providerId]: {
			...load.manifest.projection?.providers?.["clawdi-managed"],
			model: "sol",
			models: [{ id: "sol" }],
			apiMode: "openai_chat",
		},
	};
	load.manifest = {
		...load.manifest,
		runtimes: {
			openclaw: {
				...load.manifest.runtimes.openclaw,
				provider_ids: [providerId],
				primary_model: { provider_id: providerId, model: "sol" },
			},
		},
		projection: { ...load.manifest.projection, providers },
		egressProfiles: hostedManifestEgressProfiles({
			providers,
			terminalTooling: load.manifest.projection?.terminalTooling,
		}),
	};
	return load;
}

export function writeTestRuntimeAppliedState(
	paths: RuntimePaths,
	load: RuntimeManifestLoad,
	convergence: RuntimeConvergenceResult,
	input: {
		etag?: string;
		sourceRevision?: string;
		activated?: Record<string, string>;
		officialServiceCommandRevisions?: Record<string, string>;
	} = {},
): void {
	const applyContext = load.applyContext;
	if (applyContext) currentTestApplyContext = applyContext;
	const sourceRevision =
		input.sourceRevision ??
		load.sourceRevision ??
		runtimeContentSha256({
			manifest: load.sourceBundle ?? load.manifest,
			channelBindings: load.channelBindings ?? [],
			secretValues: load.secretValues ?? {},
		});
	const selectedRuntime = load.manifest.runtime;
	const providerIds = selectedRuntime
		? [...new Set(load.manifest.runtimes[selectedRuntime]?.provider_ids ?? [])].sort()
		: [];
	const systemdUnits = readSystemdUnitSnapshot(paths);
	const activated =
		input.activated ??
		Object.fromEntries([
			...[...systemdUnits.system].filter(([unit]) => unit !== RUNTIME_WATCH_SYSTEM_UNIT),
			...systemdUnits.user,
		]);
	if (load.sourceBundle !== undefined) {
		// Canonical bundles need the real source-cache commit as well as the applied receipt.
		commitRuntimeAppliedState({
			load,
			paths,
			convergence,
			sourceRevision,
			etag: input.etag ?? load.etag ?? `"sha256:${sourceRevision}"`,
			applyIdentity: applyContext?.identity ?? null,
			activated,
			officialServiceCommandRevisions: input.officialServiceCommandRevisions ?? {},
		});
		return;
	}
	writeRuntimeAppliedState(
		{
			schemaVersion: "clawdi.runtimeAppliedState.v2",
			appliedAt: new Date().toISOString(),
			instanceId: load.manifest.instanceId,
			etag: input.etag ?? load.etag ?? `"sha256:${sourceRevision}"`,
			sourceRevision,
			generation: load.manifest.generation,
			...(applyContext
				? {
						applyGeneration: applyContext.identity.generation,
						manifestETag: applyContext.identity.manifestETag,
						applyReceiptId: applyContext.identity.applyReceiptId,
						bootNonce: applyContext.identity.bootNonce,
					}
				: {}),
			contentIdentity: {
				sourcePath: load.sourcePath,
				sha256: runtimeContentSha256({
					manifest: load.sourceBundle ?? load.manifest,
					secretValues: load.secretValues ?? {},
				}),
			},
			activated,
			officialServiceCommandRevisions: input.officialServiceCommandRevisions ?? {},
			providerIds,
			projectedProviderIds: convergence.projectedProviderIds,
		},
		paths,
	);
}

const OFFLINE_RUNTIME_APPLY_IDENTITY = {
	generation: 3,
	manifestETag: '"manifest-etag-offline"',
	applyReceiptId: "apply-receipt-offline-0001",
	bootNonce: "boot-nonce-offline-000001",
};

interface TestRuntimeContextFixture {
	manifestSourceUrl: string;
	bootstrapBearer: string;
}

export const CANONICAL_TEST_CONTEXT: TestRuntimeContextFixture = {
	manifestSourceUrl: "https://runtime.test/v1/runtime/manifest",
	bootstrapBearer: "file-runtime-token",
};

export function writeCanonicalApplyContext(
	identity: typeof OFFLINE_RUNTIME_APPLY_IDENTITY,
	context: TestRuntimeContextFixture = CANONICAL_TEST_CONTEXT,
): void {
	currentTestApplyContext = {
		kind: "context-file",
		backend: "incus",
		identity,
		manifestSource: {
			type: "http",
			url: context.manifestSourceUrl,
			auth: { type: "bearer", token: context.bootstrapBearer },
		},
	};
}

export function setRuntimeApplyGeneration(
	generation: number,
	context: TestRuntimeContextFixture = CANONICAL_TEST_CONTEXT,
): void {
	writeCanonicalApplyContext(
		{
			generation,
			manifestETag: `"test-manifest-${generation}"`,
			applyReceiptId: `test-apply-receipt-${String(generation).padStart(4, "0")}`,
			bootNonce: `test-boot-nonce-${String(generation).padStart(6, "0")}`,
		},
		context,
	);
}

export function installRuntimeTestHooks() {
	beforeEach(() => {
		originalUmask = process.umask(0o022);
		originalEnv = {};
		process.exitCode = undefined;
		for (const key of ENV_KEYS) {
			const value = process.env[key];
			if (value !== undefined) originalEnv[key] = value;
			delete process.env[key];
		}
		root = join(tmpdir(), `clawdi-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		currentTestApplyContext = explicitTestApplyContext({ generation: 1 });
	});

	afterEach(() => {
		for (const server of gatewayServers.splice(0)) server.stop(true);
		for (const stateRoot of fakeSystemdStateRoots) {
			if (!existsSync(stateRoot)) continue;
			for (const entry of readdirSync(stateRoot)) {
				if (!entry.endsWith(".pid")) continue;
				const pid = Number(readFileSync(join(stateRoot, entry), "utf8").trim());
				if (Number.isSafeInteger(pid) && pid > 0) {
					try {
						process.kill(pid, "SIGTERM");
					} catch {}
				}
			}
		}
		fakeSystemdStateRoots.clear();
		process.umask(originalUmask);
		for (const key of ENV_KEYS) delete process.env[key];
		for (const [key, value] of Object.entries(originalEnv)) {
			process.env[key as EnvKey] = value;
		}
		process.exitCode = 0;
		rmSync(root, { recursive: true, force: true });
	});

	afterAll(() => {
		process.exitCode = 0;
	});
}
