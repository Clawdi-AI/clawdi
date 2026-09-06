import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	commitRuntimeAppliedState,
	runtimeAppliedContentIdentity,
	runtimeInit as runtimeInitWithContext,
	runtimePublicContentRevision,
	runtimeWatchPollDelayMs,
	runtimeWatch as runtimeWatchWithContext,
} from "../src/commands/runtime";
import {
	nativeOAuthProfileId,
	oauthCredentialFingerprint,
} from "../src/lib/codex-oauth-native-store";
import { getCliVersion } from "../src/lib/version";
import {
	readRuntimeAppliedState,
	runtimeContentSha256,
	writeRuntimeAppliedState,
} from "../src/runtime/applied-state";
import {
	type RuntimeApplyContext,
	runtimeManifestSourceSchema,
} from "../src/runtime/apply-identity";
import { applyRuntimeBundleChannelsToManifestLoad as applyRuntimeBundleChannelsToManifestLoadWithContext } from "../src/runtime/channels";
import {
	applyRuntimeCliDesiredState,
	completePendingRuntimeCliUpgrade,
	readRuntimeCliBootstrapStatus,
	reconcilePendingRuntimeCliUpgrade,
	rollbackPendingRuntimeCliUpgrade,
} from "../src/runtime/cli-update";
import { withRuntimeConvergeLock } from "../src/runtime/converge-lock";
import {
	deniedCommandReason,
	evaluateHostPolicyForCommand,
	readHostPolicy,
} from "../src/runtime/host-policy";
import {
	hostedManifestEgressProfiles,
	managedMcpHeaderPlaceholder,
} from "../src/runtime/hosted-egress-profiles";
import { createOpenClawHostedContext } from "../src/runtime/hosted-openclaw-context";
import { hostedAiProviderCatalog } from "../src/runtime/hosted-provider-resolution";
import { MANAGED_BAILEYS_STATIC_PATCH_TARGETS } from "../src/runtime/managed-baileys-compat";
import {
	managedSkillReservationLedgerPath,
	releaseManagedSkill,
	reserveManagedSkill,
} from "../src/runtime/managed-skill-reservation";
import {
	convergeRuntimeManifest as convergeRuntimeManifestWithContext,
	loadRuntimeManifest as loadRuntimeManifestFromContext,
	materializeHostedChannelCredentials,
	type RuntimeConvergenceOptions,
	type RuntimeConvergenceResult,
	type RuntimeManifest,
} from "../src/runtime/manifest";
import {
	hostedRuntimeBundleV2ManifestSchema,
	officialInstallArgs,
	validateUnmanagedProviderSecretValues,
} from "../src/runtime/manifest-contract";
import { recordValue } from "../src/runtime/manifest-shared";
import {
	HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
	loadRemoteRuntimeManifest as loadRemoteRuntimeManifestWithContext,
	manifestSecretRefs,
	parseHostedRuntimeBundleV2,
	type RuntimeBundleChannelBinding,
	type RuntimeManifestLoad,
} from "../src/runtime/manifest-source";
import { readHostedRuntimeObserved } from "../src/runtime/observed";
import { detectRuntimeMode, getRuntimePaths, type RuntimePaths } from "../src/runtime/paths";
import { buildRuntimeRunConfig } from "../src/runtime/run-config";
import { canonicalSecretRefSchema, normalizeSecretValues } from "../src/runtime/secret-values";
import {
	buildRuntimeBootStatus,
	ensureRuntimeStateDirs,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../src/runtime/state";
import {
	applySystemdRuntimeUpdate,
	RUNTIME_WATCH_SYSTEM_UNIT,
	readSystemdUnitSnapshot,
} from "../src/runtime/systemd-transaction";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "../src/runtime/systemd-user";
import { TRANSPARENT_EGRESS_PORT } from "../src/runtime/transparent-egress";
import { log } from "../src/serve/log";
import { getDaemonControlTokenPath } from "../src/serve/paths";
import { ensureTestOpenClawWorkspaceCli } from "../src/test-support/runtime-workspace";
import { mockFetch } from "./commands/helpers";

const HERMES_CONFIG_CLI_MOCK = fileURLToPath(
	new URL("../src/test-support/hermes-config-cli-mock.ts", import.meta.url),
);
const TEST_PROCESS_USER = String(process.getuid?.() ?? 0);
const TEST_PROCESS_UID = process.getuid?.() ?? 1_000;
const TEST_PROCESS_GID = process.getgid?.() ?? 1_000;
const TEST_RUNNING_CLI_VERSION = getCliVersion();
const TEST_RUNNING_CLI_SPEC = `clawdi@${TEST_RUNNING_CLI_VERSION}`;

describe("runtime watch poll delay", () => {
	it("jitters each fallback poll between half and one-and-a-half intervals", () => {
		expect([0, 0.5, 1].map((value) => runtimeWatchPollDelayMs(15_000, () => value))).toEqual([
			7_500, 15_000, 22_500,
		]);
	});
});

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

function explicitTestApplyContext(
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

function normalizeHostedManifestFixture(value: unknown): {
	manifest: RuntimeManifest;
	secretValues: Record<string, string>;
} {
	const parsed = hostedRuntimeManifestResponseSchema.parse(value);
	return {
		manifest: parsed.manifest,
		secretValues: normalizeSecretValues(parsed.secretValues),
	};
}

let currentTestApplyContext = explicitTestApplyContext({ generation: 1 });

function runtimeInit(opts: Parameters<typeof runtimeInitWithContext>[0] = {}) {
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

function runtimeWatch(opts: Parameters<typeof runtimeWatchWithContext>[0] = {}) {
	const paths = getRuntimePaths();
	return runtimeWatchWithContext({
		...opts,
		applyContext: opts.applyContext ?? liveTestApplyContext(),
		hostedRuntimeContract: opts.hostedRuntimeContract ?? testHostedRuntimeContract(paths),
	});
}

function loadRemoteRuntimeManifest(
	paths: RuntimePaths,
	opts: Parameters<typeof loadRemoteRuntimeManifestWithContext>[1] = {},
) {
	return loadRemoteRuntimeManifestWithContext(paths, {
		...opts,
		applyContext: opts.applyContext ?? currentTestApplyContext,
	});
}

function loadRuntimeManifest(
	paths: RuntimePaths,
	opts: { applyContext?: RuntimeApplyContext } = {},
) {
	return loadRuntimeManifestFromContext(paths, {
		applyContext: opts.applyContext ?? currentTestApplyContext,
	});
}

function convergeRuntimeManifest(
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

function convergeAndCommitTestRuntimeManifest(
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

function hermesManagedBaileysRoot(home: string): string {
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

function seedHermesManagedBaileys(home: string): void {
	const sourceRoot = resolve(
		import.meta.dir,
		"../../whatsapp-baileys-sidecar/node_modules/baileys",
	);
	const bridgeRoot = join(home, ".hermes", "hermes-agent", "scripts", "whatsapp-bridge");
	const baileysRoot = hermesManagedBaileysRoot(home);
	for (const relativePath of [
		"package.json",
		...MANAGED_BAILEYS_STATIC_PATCH_TARGETS.map((target) => target.relativePath),
	]) {
		const destination = join(baileysRoot, relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(sourceRoot, relativePath), destination);
	}
	writeFileSync(join(bridgeRoot, "package.json"), '{"name":"hermes-whatsapp-bridge"}\n');
	writeFileSync(join(bridgeRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
}

function applyRuntimeBundleChannelsToManifestLoad(
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
let root: string;
const fakeSystemdStateRoots = new Set<string>();

function fakeSystemdStatePath(
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

function seedFakeSystemdSnapshotProcesses(
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

function writeFakeSystemdManager(input: {
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
      case "$unit" in --property=*) continue ;; esac
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
      printf 'LoadState=%s\\nActiveState=%s\\nMainPID=%s\\nNeedDaemonReload=%s\\n' "$load_state" "$active_state" "$main_pid" "$need_daemon_reload"
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

function seedCurrentCliInstall(state: string, version = "1.2.3-test"): void {
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

function setRuntimeApplyContextFixture(
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

function createVersionedCliFixture(
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

function pointManagedCliAt(paths: RuntimePaths, identity: RuntimeCliFixtureIdentity): void {
	mkdirSync(dirname(paths.cliManagedBin), { recursive: true });
	rmSync(paths.cliManagedBin, { force: true });
	symlinkSync(identity.activeTarget, paths.cliManagedBin);
}

function cliManifest(version: string): RuntimeManifest {
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

const TEST_EGRESS_ENGINE_PIN = {
	type: "mitmproxy" as const,
	version: "12.2.3",
	url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
	sha256: "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
};

const TEST_HOSTED_LOCALE = {
	language: "en" as const,
	timezone: "UTC",
};
const TEST_HOSTED_CODEX_SECRET_REF = "secret://tool.codex.apiKey";
const TEST_HOSTED_CODEX_SECRET_VALUES = {
	[TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool",
};
const TEST_RUNTIME_SERVICE_SECRET_VALUES = {
	"secret://clawdi/auth-token": "test-runtime-auth-token",
	"secret://runtime/openclaw/gateway-token": "test-openclaw-gateway-token",
	"secret://runtime/hermes/dashboard-password": "test-hermes-dashboard-password",
	"secret://runtime/hermes/dashboard-session-secret": "test-hermes-dashboard-session-secret",
};
const TEST_HOSTED_CODEX_TERMINAL_TOOLING = {
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

function hostedRequiredState() {
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

function hostedSystemFixture(
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

function hostedHermesSystemFixture(
	home: string,
	workspace = join(home, "clawdi"),
): Record<string, unknown> {
	void home;
	void workspace;
	return {
		hermesDashboardAuth: {
			mode: "password",
			provider: "basic",
			username: "admin",
			passwordSecretRef: "secret://runtime/hermes/dashboard-password",
			sessionSecretRef: "secret://runtime/hermes/dashboard-session-secret",
			sessionTtlSeconds: 43_200,
			publicUrl: "https://agent.example.test/hermes",
			activation: {
				enabled: true,
				capability: "hermes-basic-auth-v1",
			},
		},
	};
}

function runtimeWatchLocaleManifest(
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

interface HostedRuntimeResponseFixture {
	manifest: Record<string, unknown>;
	secretValues?: Record<string, string>;
	channelBindings?: RuntimeBundleChannelBinding[];
}

function testBundleEtag(label: string): string {
	return `"sha256:${runtimeContentSha256({ testBundleEtag: label })}"`;
}

function hostedRuntimeBundleResponse(
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
		...(selectedRuntime === "hermes"
			? {
					"secret://runtime/hermes/dashboard-password":
						TEST_RUNTIME_SERVICE_SECRET_VALUES["secret://runtime/hermes/dashboard-password"],
					"secret://runtime/hermes/dashboard-session-secret":
						TEST_RUNTIME_SERVICE_SECRET_VALUES["secret://runtime/hermes/dashboard-session-secret"],
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

async function loadCanonicalBundleFixture(fixturePath: string, paths?: RuntimePaths) {
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

function hostedRuntimeWatchLocalePayload(
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

function hostedEgressSecretRotationPayload(
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

function hostedCliManifestResponse(
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

function fakeOpenClawConfigSchemaCommand(): string {
	return `if [ "$*" = "config schema" ]; then
  printf '%s\n' '{"type":"object","properties":{"memory":{"type":"object","properties":{"search":{"type":"object"}}}}}'
  exit 0
fi`;
}

function fakeOpenClawConfigPatchCommand(configPath: string): string {
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

function seedOpenClawBinary(home: string): void {
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

function writeOpenClawConfigMutationFixture(
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

function openClawDiscordPluginInspectFixture(pluginSource: string): Record<string, unknown> {
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

function openClawWhatsAppPluginInspectFixture(
	pluginSource: string,
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
		install: {
			source: "clawhub",
			clawhubPackage: "@openclaw/whatsapp",
			installPath: dirname(pluginSource),
			version,
			integrity: "sha256-test",
			npmIntegrity: "sha512-test",
			clawpackSha256: "sha256-test-clawpack",
		},
	};
}

function seedOfficialOpenClawServiceInstaller(home: string): void {
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

function seedHostedCodexPackage(
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
		options.validPackageJson === false ? "not-json\n" : JSON.stringify({ version }),
	);
	writeFileSync(realBin, "#!/bin/sh\nexit 0\n");
	chmodSync(realBin, options.executable === false ? 0o600 : 0o755);
	return { packageJson, realBin };
}

function writeHostedCodexNpmInstaller(
	binDir: string,
	markerPath: string,
	installedVersion: string,
): void {
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(binDir, "npm"),
		[
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			`printf 'install\\n' >> '${markerPath}'`,
			"prefix=''",
			'while [ "$#" -gt 0 ]; do',
			'  if [ "$1" = "--prefix" ]; then prefix="$2"; shift 2; else shift; fi',
			"done",
			'mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@openai/codex"',
			`printf '%s\\n' '{"version":"${installedVersion}"}' > "$prefix/lib/node_modules/@openai/codex/package.json"`,
			"printf '#!/bin/sh\\nexit 0\\n' > \"$prefix/bin/codex\"",
			'chmod 755 "$prefix/bin/codex"',
			"",
		].join("\n"),
	);
	chmodSync(join(binDir, "npm"), 0o755);
}

function seedRuntimeWatchLocaleBaseline(home: string, state: string, run: string): RuntimePaths {
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
	const sourceRevision = testBundleEtag("manifest-locale-1").slice(8, -1);
	const load: RuntimeManifestLoad = {
		manifest: runtimeWatchLocaleManifest(home, 1),
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

function installSuccessfulSystemctlFixture(
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

function cachedMitmproxyBinary(paths: RuntimePaths, pin: typeof TEST_EGRESS_ENGINE_PIN): string {
	return join(paths.egressEngineMaintainedRoot, pin.version, pin.sha256, "mitmdump");
}

function seedMitmproxyCache(paths = getRuntimePaths()): typeof TEST_EGRESS_ENGINE_PIN {
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

function hostedOpenClawRuntime(
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

function hostedHermesRuntime(
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

function hostedOAuthRuntimeLoad(input: {
	home: string;
	runtime: "hermes" | "openclaw";
	generation: number;
	credentialRevision: string;
	accessToken: string;
	refreshToken: string;
}): RuntimeManifestLoad {
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

function readSystemdSystemUnit(paths: RuntimePaths, name: string): string {
	return readFileSync(join(paths.systemdSystemRoot, systemdUnitFileName(name)), "utf-8");
}

function readSystemdUserServiceConfig(paths: RuntimePaths, name: string): string {
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

function readSystemdEnvFile(paths: RuntimePaths, name: string): string {
	return readFileSync(join(paths.systemdEnvRoot, `${systemdUnitFileName(name)}.env`), "utf-8");
}

function systemdEnvDigest(envFile: string): string {
	const match = envFile.match(/^CLAWDI_MANAGED_CONTENT_DIGEST="([^"]+)"$/m);
	expect(match?.[1]).toBeTruthy();
	return match?.[1] ?? "";
}

function expectExistingFileNotToContain(path: string, value: string): void {
	if (!existsSync(path)) return;
	expect(readFileSync(path, "utf-8")).not.toContain(value);
}

function expectProviderEgressProfileUsesSecretRef(
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

function expectEgressProfileBundleUsesSecretRef(
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

function expectMitmSecretFileIsSidecarOnly(
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

function hermesModelProviderPluginDir(home: string): string {
	return join(home, ".hermes", "plugins", "model-providers", "clawdi");
}

function readHermesConfigYaml(home: string): Record<string, unknown> {
	const parsed = parseYaml(readFileSync(join(home, ".hermes", "config.yaml"), "utf-8"));
	if (!isRecord(parsed)) {
		throw new Error("Expected Hermes config.yaml to parse to a YAML object.");
	}
	return parsed;
}

function readOpenClawMcpServers(home: string): Record<string, unknown> {
	const config = expectRecord(
		JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf-8")),
		"OpenClaw config",
	);
	const mcp = expectRecord(config.mcp, "OpenClaw MCP config");
	return expectRecord(mcp.servers, "OpenClaw MCP servers");
}

function managedRemoteMcpServer(serverName: string, revision: string) {
	return {
		url: `https://mcp.clawdi.test/${serverName}/${revision}`,
		transport: "streamable-http" as const,
		headers: {
			Authorization: { secretRef: `secret://mcp/${serverName}`, prefix: "Bearer " },
		},
	};
}

function nativeManagedRemoteMcpServer(serverName: string, revision: string) {
	const server = managedRemoteMcpServer(serverName, revision);
	return {
		...server,
		headers: {
			Authorization: `Bearer ${managedMcpHeaderPlaceholder(serverName, "Authorization")}`,
		},
	};
}

function writeFakeOpenClawMcpBinary(
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

function expectRecord(input: unknown, label: string): Record<string, unknown> {
	if (!isRecord(input)) {
		throw new Error(`Expected ${label} to be a YAML object.`);
	}
	return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function writeHermesVersionBinary(home: string, version: string): string {
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

function writeHermesDashboardPython(home: string, compatible: boolean): string {
	const python = join(home, ".hermes", "hermes-agent", "venv", "bin", "python");
	mkdirSync(dirname(python), { recursive: true });
	writeFileSync(
		python,
		`#!/usr/bin/env bash\n${compatible ? "exit 0" : "printf '%s\\n' 'missing capture_signals' >&2\nexit 1"}\n`,
	);
	chmodSync(python, 0o700);
	return python;
}

function writeFakeOpenClawProviderAuthSdk(directory: string, callsPath: string): string {
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

function hostedHermesProviderLoad(home: string): RuntimeManifestLoad {
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

function hostedHermesDashboardCapabilityLoad(home: string): RuntimeManifestLoad {
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
		mode: "password",
		provider: "basic",
		username: "admin",
		passwordSecretRef: "secret://runtime/hermes/dashboard-password",
		sessionSecretRef: "secret://runtime/hermes/dashboard-session-secret",
		sessionTtlSeconds: 43_200,
		publicUrl: "https://agent.example.test/hermes",
		activation: { enabled: true, capability: "hermes-basic-auth-v1" },
	};
	load.secretValues = {
		...load.secretValues,
		"secret://runtime/hermes/dashboard-password": "dashboard-password",
		"secret://runtime/hermes/dashboard-session-secret": "dashboard-session-secret",
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

function hostedSingleProviderModeLoad(
	home: string,
	runtimeName: "openclaw" | "hermes",
	providerMode: "configured" | "unmanaged",
	generation: number,
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
			instanceId: "iid_provider_mode",
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

function hostedManagedOpenClawV2Load(home: string, generation: number): RuntimeManifestLoad {
	const load = hostedSingleProviderModeLoad(home, "openclaw", "configured", generation);
	const providerId = "clawdi-v2-deployment-42";
	const providers = {
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

function writeTestRuntimeAppliedState(
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

const CANONICAL_TEST_CONTEXT: TestRuntimeContextFixture = {
	manifestSourceUrl: "https://runtime.test/v1/runtime/manifest",
	bootstrapBearer: "file-runtime-token",
};
function writeCanonicalApplyContext(
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

function setRuntimeApplyGeneration(
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

describe("runtime paths", () => {
	it("uses ~/.clawdi in local mode", () => {
		const home = join(root, "home", "alice");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";

		expect(detectRuntimeMode()).toBe("local");
		const paths = getRuntimePaths();
		expect(paths.mode).toBe("local");
		expect(paths.localConfig).toBe(join(home, ".clawdi", "config.json"));
		expect(paths.localAuth).toBe(join(home, ".clawdi", "auth.json"));
		expect(paths.workspaceRoot).toBe(join(home, "clawdi"));
		expect(paths.serviceStateRoot).toBe("/var/lib/clawdi");
		expect(paths.runRoot).toBe("/run/clawdi");
	});

	it("uses hosted runtime state and run path overrides", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = "root";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		expect(detectRuntimeMode()).toBe("hosted");
		const paths = getRuntimePaths();
		expect(paths.mode).toBe("hosted");
		expect(paths.userHome).toBe(home);
		expect(paths.workspaceRoot).toBe(home);
		expect(paths.cliManagedBin).toBe(join(state, "maintained", "clawdi", "bin", "clawdi"));
		expect(paths.cliNpmPrefix).toBe(join(state, "maintained", "clawdi", "npm"));
		expect(paths.cliNpmCache).toBe(join(root, "var", "cache", "clawdi", "npm"));
		expect(paths.egressProfileRoot).toBe(join(run, "egress"));
		expect(paths.egressProfileBundle).toBe(join(run, "egress", "profiles.json"));
	});

	it("reclaims a stale converge lock whose owner process is gone", () => {
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = "root";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const lockDir = join(run, "locks", "converge.lock");
		const ownerPath = join(lockDir, "owner.json");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			ownerPath,
			`${JSON.stringify({
				schemaVersion: "clawdi.runtimeConvergeLockOwner.v1",
				pid: 99_999_999,
				acquiredAt: "2026-06-06T00:00:00Z",
			})}\n`,
		);

		const result = withRuntimeConvergeLock(
			paths,
			() => {
				const owner = JSON.parse(readFileSync(ownerPath, "utf-8"));
				expect(owner.pid).toBe(process.pid);
				expect(readdirSync(join(run, "locks"))).toEqual(["converge.lock"]);
				return "locked";
			},
			{ timeoutMs: 10 },
		);

		expect(result).toBe("locked");
		expect(existsSync(lockDir)).toBe(false);
		expect(readdirSync(join(run, "locks"))).toEqual([]);
	});

	it("reclaims an ownerless converge lock only after the stale timeout window", () => {
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const lockDir = join(run, "locks", "converge.lock");
		mkdirSync(lockDir, { recursive: true });
		const fresh = new Date(Date.now() + 60_000);
		utimesSync(lockDir, fresh, fresh);

		expect(() => withRuntimeConvergeLock(paths, () => "locked", { timeoutMs: 5 })).toThrow(
			/timed out waiting/,
		);

		const stale = new Date(Date.now() - 60_000);
		utimesSync(lockDir, stale, stale);
		const result = withRuntimeConvergeLock(paths, () => "locked", { timeoutMs: 5 });

		expect(result).toBe("locked");
		expect(readdirSync(join(run, "locks"))).toEqual([]);
	});
});

describe("runtime run config", () => {
	it("uses the official Hermes gateway command by default", () => {
		const config = buildRuntimeRunConfig({
			runtime: "hermes",
			enabled: true,
			generatedAt: "2026-06-15T00:00:00.000Z",
			generation: 1,
			instanceId: "iid_hermes_ui",
			commandPath: "/home/clawdi/.local/bin/hermes",
			appRoot: "/home/clawdi/.hermes/hermes-agent",
			workspaceRoot: "/home/clawdi",
		});

		expect(config.defaultArgs).toEqual(["gateway", "run"]);
	});

	it("keeps built-in default args when run settings only add env", () => {
		const config = buildRuntimeRunConfig({
			runtime: "openclaw",
			enabled: true,
			generatedAt: "2026-07-01T00:00:00.000Z",
			generation: 1,
			instanceId: "iid_openclaw_env_only",
			commandPath: "/home/clawdi/.local/bin/openclaw",
			appRoot: "/home/clawdi/.openclaw",
			workspaceRoot: "/home/clawdi",
			settings: {
				env: { OPENCLAW_MODE: "hosted" },
				prependPath: [],
			},
		});

		expect(config.defaultArgs).toEqual(["gateway", "run"]);
		expect(config.env).toEqual({ OPENCLAW_MODE: "hosted" });
	});

	it("allows explicit empty args to override built-in defaults", () => {
		const config = buildRuntimeRunConfig({
			runtime: "openclaw",
			enabled: true,
			generatedAt: "2026-07-01T00:00:00.000Z",
			generation: 1,
			instanceId: "iid_openclaw_empty_args",
			commandPath: "/home/clawdi/.local/bin/openclaw",
			appRoot: "/home/clawdi/.openclaw",
			workspaceRoot: "/home/clawdi",
			settings: {
				args: [],
				env: {},
				prependPath: [],
			},
		});

		expect(config.defaultArgs).toEqual([]);
	});
});

describe("host policy", () => {
	it("uses the first-class built-in hosted contract", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		const result = readHostPolicy();
		expect(result.valid).toBe(true);
		expect(result.source).toBe("builtin");
		expect(result.path).toBeUndefined();
		expect(result.policy?.systemWritableState).toEqual([
			"/etc/clawdi",
			"/var/lib/clawdi",
			"/var/cache/clawdi",
			"/run/clawdi",
		]);
		expect(result.policy?.userWritableState).toEqual(["/home/clawdi", "/tmp"]);
		expect(result.policy?.ordinaryUserDeniedState).toEqual([
			"/etc/clawdi",
			"/var/lib/clawdi",
			"/var/cache/clawdi",
		]);
		expect(deniedCommandReason(result.policy, "setup")).toBe(
			"runtime setup is managed by clawdi runtime init",
		);
		expect(deniedCommandReason(result.policy, "agent reconnect")).toBe(
			"Connected Agent identity is managed outside hosted runtimes",
		);
		expect(deniedCommandReason(result.policy, "update")).toBe(
			"CLI updates are managed by the hosted runtime installation",
		);
		expect(deniedCommandReason(result.policy, "mcp")).toBe(null);
		expect(evaluateHostPolicyForCommand("mcp")).toEqual({
			allowed: true,
			command: "mcp",
			runtimeMode: "hosted",
			policySource: "builtin",
		});
	});

	it("ignores image policy files in hosted mode", () => {
		const path = join(root, "host-policy.json");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_HOST_POLICY_PATH = path;
		writeFileSync(path, "{not-json");

		const result = readHostPolicy(path);
		expect(result.exists).toBe(true);
		expect(result.valid).toBe(true);
		expect(result.source).toBe("builtin");
		expect(result.path).toBeUndefined();
	});

	it("does not infer hosted mode from a policy file", () => {
		const path = join(root, "host-policy.json");
		process.env.CLAWDI_HOST_POLICY_PATH = path;
		writeFileSync(path, "{}");
		expect(detectRuntimeMode()).toBe("local");
	});
});

describe("runtime applied content identity", () => {
	it("keeps low-entropy secret rotation private when a fixture has no ETag", () => {
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_identity",
			environmentId: "env_identity",
			instanceId: "iid_identity",
			generation: 1,
			issuedAt: "2026-07-13T00:00:00.000Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: { secretEnv: { OPENAI_API_KEY: "secret://provider.default.apiKey" } },
				},
			},
			recovery: {},
		};
		const load = (secret: string): RuntimeManifestLoad => ({
			manifest,
			sourceBundle: manifest,
			secretValues: { "secret://provider.default.apiKey": secret },
			source: "remote-datasource",
			sourcePath: "inline-secret-identity",
			offline: false,
		});

		expect(runtimeAppliedContentIdentity(load("000000")).sha256).not.toBe(
			runtimeAppliedContentIdentity(load("000001")).sha256,
		);
		expect(runtimePublicContentRevision(load("000000"))).toBe(
			runtimePublicContentRevision(load("000001")),
		);
	});
});

describe("runtime manifest datasource", () => {
	it("rejects the legacy /api runtime manifest path", () => {
		const parsed = runtimeManifestSourceSchema.safeParse({
			type: "http",
			url: "https://cloud-api.example.test/api/runtime/manifest?environment_id=env_runtime",
			auth: { type: "bearer", token: "test-runtime-token" },
		});
		expect(parsed.success).toBe(false);
	});

	it("fetches hosted-runtime manifests from a configured runtime source", async () => {
		setRuntimeApplyGeneration(3, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_test",
							environmentId: "env_test",
							...hostedRequiredState(),
							instanceId: "iid_remote",
							generation: 3,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime({
									provider_ids: ["default"],
								}),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://sub2api.test/v1",
									models: [{ id: "gpt-5.5" }],
									apiMode: "openai_chat",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://provider.default.apiKey",
								},
							},
							terminalTooling: TEST_HOSTED_CODEX_TERMINAL_TOOLING,
							skills: { entries: { clawdi: { enabled: true, version: 1 } } },
							tools: { catalog: "clawdi-default" },
						},
						secretValues: {
							"secret://provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			setRuntimeApplyGeneration(3, {
				...CANONICAL_TEST_CONTEXT,
				bootstrapBearer: "auth-token",
			});
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			expect(captured).toHaveLength(1);
			expect(captured[0].headers.authorization).toBe("Bearer auth-token");
			expect(loaded.source).toBe("remote-datasource");
			expect(loaded.sourcePath).toBe("https://runtime.test/v1/runtime/manifest");
			expect(loaded.manifest.schemaVersion).toBe("clawdi.runtimeDesiredState.v1");
			expect(loaded.manifest.workspaceRoot).toBeUndefined();
			expect(loaded.manifest.environmentId).toBe("env_test");
			expect(loaded.manifest.controlPlane.apiUrl).toBe("https://cloud-api.test");
			expect(loaded.manifest.clawdiCli?.source).toBe("npm:clawdi");
			expect(loaded.manifest.clawdiCli?.packageSpec).toBe(TEST_RUNNING_CLI_SPEC);
			expect(loaded.manifest.projection?.skills).toEqual({
				entries: { clawdi: { enabled: true, version: 1 } },
			});
			expect(loaded.manifest.projection?.tools).toEqual({ catalog: "clawdi-default" });
			expect(loaded.manifest.projection?.terminalTooling).toEqual(
				TEST_HOSTED_CODEX_TERMINAL_TOOLING,
			);
			expect(loaded.manifest.runtimes.openclaw.install?.url).toBe(
				"https://openclaw.ai/install-cli.sh",
			);
			expect(loaded.manifest.runtimes.openclaw.install?.home).toBe(home);
			expect(loaded.manifest.runtimes.openclaw.install?.args).toEqual(
				officialInstallArgs("openclaw", home),
			);
			expectProviderEgressProfileUsesSecretRef(
				loaded.manifest.egressProfiles?.profiles,
				"secret://provider.default.apiKey",
				"sk-runtime",
			);
			expect(JSON.stringify(loaded.manifest.egressProfiles)).not.toContain("sk-runtime");
			expect(loaded.secretValues).toEqual({
				[TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool",
				"secret://clawdi/auth-token": "test-runtime-auth-token",
				"secret://provider.default.apiKey": "sk-runtime",
				"secret://runtime/openclaw/gateway-token": "test-openclaw-gateway-token",
			});
		} finally {
			restore();
		}
	});

	it("rejects a managed bootstrap tarball from a remote hosted manifest", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const packageSpec = "/usr/local/share/clawdi/bootstrap/clawdi-1.2.3-test.tgz";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => hostedRuntimeBundleResponse(hostedCliManifestResponse(home, packageSpec)),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("errors" in loaded).toBe(true);
			if (!("errors" in loaded)) throw new Error("expected remote manifest rejection");
			expect(loaded.mode).toBe("manifest-rejected");
			expect(loaded.stage).toBe("network");
			expect(loaded.errors.join("\n")).toContain("must be clawdi@<exact-semver>");
		} finally {
			restore();
		}
	});

	for (const packageSpec of ["clawdi@latest", "clawdi"]) {
		it(`rejects ${packageSpec} from a remote hosted manifest`, async () => {
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			mkdirSync(home, { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = join(root, "run", "clawdi");
			process.env.CLAWDI_AUTH_TOKEN = "auth-token";
			const { restore } = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () => hostedRuntimeBundleResponse(hostedCliManifestResponse(home, packageSpec)),
				},
			]);

			try {
				const loaded = await loadRuntimeManifest(getRuntimePaths());
				expect("errors" in loaded).toBe(true);
				if (!("errors" in loaded)) throw new Error("expected remote manifest rejection");
				expect(loaded.errors.join("\n")).toContain("must be clawdi@<exact-semver>");
			} finally {
				restore();
			}
		});
	}

	it("projects direct Hermes dashboard exposure", async () => {
		setRuntimeApplyGeneration(4, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const hermesInstaller = join(root, "install-hermes.sh");
		const hermesConfig = join(home, ".hermes", "config.yaml");
		mkdirSync(home, { recursive: true });
		mkdirSync(dirname(hermesConfig), { recursive: true });
		writeFileSync(
			hermesConfig,
			[
				"providers:",
				"  clawdi:",
				"    api: https://ai-gateway.test/v1",
				"    key_env: OPENAI_API_KEY",
				"    models:",
				"      gpt-5.5: {}",
				"    transport: openai_chat",
				"",
			].join("\n"),
		);
		writeFileSync(
			hermesInstaller,
			`#!/usr/bin/env bash
set -euo pipefail
install -d "$HOME/.local/bin"
cat > "$HOME/.local/bin/hermes" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf '%s\n' 'Hermes Agent v0.20.1 (2026-07-01)'
  exit 0
fi
if [ "\${1:-}" = "config" ]; then
  exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
fi
exit 0
SH
chmod +x "$HOME/.local/bin/hermes"
install -d "$HOME/.hermes/hermes-agent/venv/bin"
cat > "$HOME/.hermes/hermes-agent/venv/bin/python" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/python"
`,
		);
		chmodSync(hermesInstaller, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_HERMES_INSTALLER = hermesInstaller;
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "hermes",
							deploymentId: "dep_direct_hermes",
							environmentId: "env_direct_hermes",
							...hostedRequiredState(),
							instanceId: "iid_direct_hermes",
							generation: 4,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedHermesSystemFixture(home, join(home, "managed-workspace")),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								hermes: hostedHermesRuntime({
									provider_ids: ["clawdi"],
									primary_model: { provider_id: "clawdi", model: "gpt-5.5" },
								}),
							},
							providers: {
								clawdi: {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://ai-gateway.test/v1",
									models: [{ id: "gpt-5.5" }],
									apiMode: "openai_chat",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://provider.default.apiKey",
								},
							},
						},
						secretValues: {
							"secret://provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const paths = getRuntimePaths();
			const loaded = await loadRuntimeManifest(paths);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			const provider = hostedAiProviderCatalog(loaded.manifest, "hermes")?.catalog.providers[0];
			expect(provider?.runtime_env_name).toBe("CLAWDI_AI_API_KEY");
			expectProviderEgressProfileUsesSecretRef(
				loaded.manifest.egressProfiles?.profiles,
				"secret://provider.default.apiKey",
				"sk-runtime",
			);
			const convergence = convergeRuntimeManifest(loaded, paths);
			expect(convergence.installErrors).toEqual([]);
			const hermesEnv = readSystemdEnvFile(paths, "hermes-gateway");
			const hermesDashboardEnv = readSystemdEnvFile(paths, "clawdi-hermes-dashboard");
			const hermesRunConfig = expectRecord(
				JSON.parse(readFileSync(join(paths.runConfigRoot, "hermes.json"), "utf-8")),
				"Hermes run config",
			);
			const hermesDashboardRunConfig = expectRecord(
				JSON.parse(readFileSync(join(paths.runConfigRoot, "hermes+dashboard.json"), "utf-8")),
				"Hermes dashboard run config",
			);
			const providers = expectRecord(readHermesConfigYaml(home).providers, "Hermes providers");
			const managedProvider = expectRecord(providers.clawdi, "Hermes managed provider");
			const hermesRunEnv = expectRecord(hermesRunConfig.env, "Hermes run environment");
			const hermesDashboardRunEnv = expectRecord(
				hermesDashboardRunConfig.env,
				"Hermes dashboard run environment",
			);

			expect(convergence.outputs.systemdSystemUnits).toContain(
				join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"),
			);
			expect(managedProvider.key_env).toBe("CLAWDI_AI_API_KEY");
			expect(hermesEnv).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
			expect(hermesEnv).not.toMatch(/^OPENAI_API_KEY=/m);
			expect(hermesDashboardEnv).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
			expect(hermesDashboardEnv).not.toMatch(/^OPENAI_API_KEY=/m);
			expect(hermesRunEnv.CLAWDI_AI_API_KEY).toBe("clawdi-egress-placeholder");
			expect(hermesRunEnv.OPENAI_API_KEY).toBeUndefined();
			expect(hermesDashboardRunEnv.CLAWDI_AI_API_KEY).toBe("clawdi-egress-placeholder");
			expect(hermesDashboardRunEnv.OPENAI_API_KEY).toBeUndefined();
			expectEgressProfileBundleUsesSecretRef(
				convergence.outputs.egressProfileBundle,
				"secret://provider.default.apiKey",
				"sk-runtime",
			);
			if (!convergence.outputs.egressProfileBundle) {
				throw new Error("expected managed provider egress profile bundle");
			}
			const egressProfileBundle = readFileSync(convergence.outputs.egressProfileBundle, "utf-8");
			expect(egressProfileBundle).toContain('"value": "clawdi-egress-placeholder"');
			expect(readSystemdUserServiceConfig(paths, "hermes-gateway")).not.toContain("sk-runtime");
			expect(readSystemdUserServiceConfig(paths, "clawdi-hermes-dashboard")).not.toContain(
				"sk-runtime",
			);
		} finally {
			restore();
		}
	});

	it("does not reinstall Hermes for dashboard capability drift but preserves cold install", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const installer = join(root, "install-hermes.sh");
		const installerCalls = join(root, "install-hermes.calls");
		const appMarker = join(home, ".hermes", "hermes-agent", "repair-marker");
		const skillMarker = join(home, ".hermes", "skills", "user-skill", "content.txt");
		const command = writeHermesVersionBinary(home, "0.20.1");
		writeHermesDashboardPython(home, false);
		mkdirSync(dirname(skillMarker), { recursive: true });
		writeFileSync(appMarker, "before-repair\n");
		writeFileSync(skillMarker, "user-skill-before-repair\n");
		writeFileSync(
			installer,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' install >> '${installerCalls}'
install -d "$HOME/.local/bin" "$HOME/.hermes/hermes-agent/venv/bin" "$HOME/.hermes/skills/user-skill"
cat > "$HOME/.local/bin/hermes" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'Hermes Agent v0.20.1 (2026-07-01)'
  exit 0
fi
if [ "\${1:-}" = "config" ]; then
  exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
fi
exit 0
SH
chmod +x "$HOME/.local/bin/hermes"
printf '%s\\n' installer-mutated > "$HOME/.hermes/hermes-agent/repair-marker"
printf '%s\\n' installer-mutated > "$HOME/.hermes/skills/user-skill/content.txt"
printf '%s\\n' '#!/usr/bin/env bash' 'exit 0' > "$HOME/.hermes/hermes-agent/venv/bin/python"
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/python"
`,
		);
		chmodSync(installer, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_HERMES_INSTALLER = installer;
		const paths = getRuntimePaths();
		const load = hostedHermesDashboardCapabilityLoad(home);

		const rejected = convergeRuntimeManifest(load, paths);
		expect(rejected.installErrors.join("\n")).toContain(
			"Hermes dashboard runtime is incompatible: missing capture_signals",
		);
		expect(existsSync(installerCalls)).toBe(false);
		expect(readFileSync(appMarker, "utf8")).toBe("before-repair\n");
		expect(readFileSync(skillMarker, "utf8")).toBe("user-skill-before-repair\n");

		rmSync(command);
		const installed = convergeRuntimeManifest(load, paths);
		expect(installed.installErrors).toEqual([]);
		expect(readFileSync(installerCalls, "utf8").trim().split("\n")).toEqual(["install"]);
	});

	it("keeps explicit OpenAI chat providers on direct provider projection", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_chat_provider",
							environmentId: "env_chat_provider",
							...hostedRequiredState(),
							instanceId: "iid_chat_provider",
							generation: 1,
							issuedAt: "2026-06-22T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://ai-gateway.example.test/v1",
									models: [{ id: "gpt-5.4-mini" }],
									apiMode: "openai_chat",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://provider.default.apiKey",
								},
							},
						},
						secretValues: {
							"secret://provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			expect(loaded.manifest.projection?.providers.default).toMatchObject({
				baseUrl: "https://ai-gateway.example.test/v1",
				models: [{ id: "gpt-5.4-mini" }],
				apiMode: "openai_chat",
				runtimeEnvName: "CLAWDI_AI_API_KEY",
			});
			expect(
				loaded.manifest.egressProfiles?.profiles.find(
					(profile) => profile.id === "managed-provider",
				),
			).toMatchObject({
				id: "managed-provider",
				enabled: true,
				kind: "provider",
				match: {
					scheme: "https",
					host: "ai-gateway.example.test",
				},
				rewrite: {
					setHeaders: {
						authorization: {
							type: "secretRef",
							secretRef: "secret://provider.default.apiKey",
							prefix: "Bearer ",
						},
					},
				},
				owner: "provider-projection",
			});
			expect(JSON.stringify(loaded.manifest.egressProfiles)).not.toContain("sk-runtime");
		} finally {
			restore();
		}
	});

	it("derives sidecar-only provider egress profiles from hosted-runtime manifests", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_AUTH_TOKEN = "runtime-auth-token";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_codex_provider",
							environmentId: "env_codex_provider",
							...hostedRequiredState(),
							instanceId: "iid_codex_provider",
							generation: 1,
							issuedAt: "2026-06-22T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://ai-gateway.example.test/v1",
									models: [{ id: "gpt-5.4-mini" }],
									apiMode: "openai_responses",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://provider.default.apiKey",
								},
							},
						},
						secretValues: {
							"secret://provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			expect(
				loaded.manifest.egressProfiles?.profiles.find(
					(profile) => profile.id === "managed-provider",
				),
			).toMatchObject({
				id: "managed-provider",
				enabled: true,
				kind: "provider",
				match: {
					scheme: "https",
					host: "ai-gateway.example.test",
				},
				rewrite: {
					setHeaders: {
						authorization: {
							type: "secretRef",
							secretRef: "secret://provider.default.apiKey",
							prefix: "Bearer ",
						},
					},
				},
				owner: "provider-projection",
			});
			expect(JSON.stringify(loaded.manifest.egressProfiles)).not.toContain("sk-runtime");
		} finally {
			restore();
		}
	});

	it("projects hosted OpenAI chat providers directly into OpenClaw config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-provider-patch.json");
		const openclawCommand = join(root, "openclaw-provider-command.txt");
		const { configPath } = writeOpenClawConfigMutationFixture(home);
		mkdirSync(dirname(openclawBin), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				`printf '%s\\n' "$*" >> '${openclawCommand}'`,
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then',
				`  cat > '${openclawPatch}'`,
				"  exit 0",
				"fi",
				"printf 'unexpected openclaw command: %s\\n' \"$*\" >&2",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);

		const loaded: RuntimeManifestLoad = {
			source: "remote-datasource",
			sourcePath: "https://runtime-source.test/desired-state",
			offline: false,
			secretValues: {
				"secret://provider.default.apiKey": "sk-runtime-provider",
				"secret://runtime/openclaw/gateway-token": "gateway-token",
			},
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_direct_provider",
				environmentId: "env_direct_provider",
				instanceId: "iid_direct_provider",
				generation: 1,
				issuedAt: "2026-06-22T00:00:00Z",
				locale: { language: "fr", timezone: "Europe/Paris" },
				workspaceRoot: join(home, "clawdi"),
				controlPlane: { apiUrl: "https://cloud-api.test" },
				openclawGatewayAuth: {
					mode: "token",
					tokenRef: "secret://runtime/openclaw/gateway-token",
					deviceAuthRequired: false,
					activation: { enabled: true, capability: "openclaw-native-auth-v1" },
				},
				runtimes: {
					openclaw: {
						enabled: true,
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-5.4-mini" },
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: officialInstallArgs("openclaw", home),
						},
					},
					hermes: { enabled: false },
				},
				projection: {
					system: {
						...hostedSystemFixture(home),
						home,
						openclawControlUiAllowedOrigins: ["https://app-v2-18789.k3s.example.test"],
					},
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://ai-gateway.example.test/v1",
							model: "gpt-5.4-mini",
							apiMode: "openai_chat",
							runtimeEnvName: "OPENAI_API_KEY",
							apiKeySecretRef: "secret://provider.default.apiKey",
						},
					},
				},
				egressProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf-8").trim()).toBe("config patch --stdin");
		expect(JSON.parse(readFileSync(openclawPatch, "utf-8"))).toEqual({
			agents: {
				defaults: {
					userTimezone: "Europe/Paris",
				},
			},
			gateway: {
				mode: "local",
				port: 18789,
				bind: "lan",
				auth: {
					mode: "token",
					token: "gateway-token",
				},
				controlUi: {
					allowedOrigins: ["https://app-v2-18789.k3s.example.test"],
					basePath: "/",
					dangerouslyAllowHostHeaderOriginFallback: false,
					dangerouslyDisableDeviceAuth: true,
				},
			},
		});
		const patch = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(patch.agents.defaults.model.primary).toBe("default/gpt-5.4-mini");
		expect(patch.secrets).toEqual({
			providers: {
				default: { source: "env" },
			},
			defaults: {
				env: "default",
			},
		});
		expect(patch.models.providers.default).toMatchObject({
			baseUrl: "https://ai-gateway.example.test/v1",
			apiKey: {
				source: "env",
				provider: "default",
				id: "OPENAI_API_KEY",
			},
		});
		expect(patch.models.providers.default.apiKey.id).not.toBe("CLAWDI_AI_API_KEY");
		expect(patch.models.providers.default.api).toBeUndefined();
		expect(JSON.stringify(patch)).not.toContain("agentRuntime");
		expect(JSON.stringify(patch)).not.toContain("chatgpt.com");
		const runConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		expect(runConfig.defaultArgs).toEqual(["gateway", "run"]);
		expect(runConfig.defaultArgs).not.toContain("--auth");
		expect(runConfig.env.CLAWDI_AI_API_KEY).toBeUndefined();
		expect(runConfig.env.OPENAI_API_KEY).toBeUndefined();
		expect(runConfig.secretEnv).toEqual({ OPENAI_API_KEY: "secret://provider.default.apiKey" });
		expect(runConfig.secretFilePath).toBeNull();
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
	});

	it("pins OpenClaw context and repairs config before provider projection", () => {
		const home = join(root, "invalid-openclaw-config", "home", "clawdi");
		const state = join(root, "invalid-openclaw-config", "var", "lib", "clawdi");
		const run = join(root, "invalid-openclaw-config", "run", "clawdi");
		const openClawTmp = join(home, ".openclaw", "tmp");
		const { configPath, commandLog } = writeOpenClawConfigMutationFixture(home, {
			legacyInvalidConfig: true,
			meta: "legacy",
			agents: [],
		});
		mkdirSync(openClawTmp, { recursive: true });
		chmodSync(openClawTmp, 0o500);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.OPENCLAW_STATE_DIR = "/tmp/untrusted-openclaw-state";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "invalid-openclaw-config", "provider-auth"),
			join(root, "invalid-openclaw-config", "provider-auth-calls.log"),
		);
		const paths = getRuntimePaths();
		const loaded = hostedManagedOpenClawV2Load(home, 1);
		loaded.manifest.egressEngine = seedMitmproxyCache(paths);

		const convergence = convergeRuntimeManifest(loaded, paths);

		expect(convergence.installErrors).toEqual([]);
		const commands = readFileSync(commandLog, "utf8").trim().split("\n");
		const doctorIndex = commands.indexOf("doctor --fix --non-interactive");
		expect(doctorIndex, commands.join(" | ")).toBeGreaterThan(-1);
		expect(commands.some((command) => command.startsWith("plugins "))).toBe(false);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).not.toHaveProperty("legacyInvalidConfig");
		expect(statSync(openClawTmp).mode & 0o777).toBe(0o700);

		const context = createOpenClawHostedContext(loaded.manifest, home);
		loaded.manifest.runtimes.openclaw.enabled = false;
		expect(context.managedApiKeyProjection).toBe(true);
		expect(createOpenClawHostedContext(loaded.manifest, home).managedApiKeyProjection).toBe(false);
	});

	it("removes reserved OpenClaw provider auth from every store only for managed env projection", () => {
		const home = join(root, "model-switch", "home", "clawdi");
		const state = join(root, "model-switch", "var", "lib", "clawdi");
		const run = join(root, "model-switch", "run", "clawdi");
		const activeAgentDir = join(home, "active-openclaw-agent");
		const customAgentDir = join(home, "custom-openclaw-agent");
		const legacyModels = Array.from({ length: 24 }, (_, index) => ({
			id: `legacy-${index}`,
			name: `Legacy managed model ${index}`,
			api: "openai-responses",
			input: ["text", "image"],
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
		}));
		const {
			configPath: openclawConfig,
			commandLog,
			mutationLog,
		} = writeOpenClawConfigMutationFixture(home, {
			gateway: { mode: "local", port: 19_001 },
			logging: { level: "debug" },
			agents: { list: [{ id: "custom", agentDir: customAgentDir }] },
			auth: {
				profiles: {
					"clawdi:default": { provider: "clawdi", mode: "api_key" },
					"managed-config": { provider: "ClAwDi", mode: "token" },
					"clawdi:named-openai": { provider: "openai", mode: "oauth" },
					"openai:user": { provider: "openai", mode: "oauth" },
				},
				order: {
					ClAwDi: ["managed-config", "clawdi:default"],
					openai: ["openai:user", "managed-config", "clawdi:named-openai"],
					"stale-only": ["clawdi:default"],
				},
			},
			models: {
				providers: {
					"user-owned": {
						baseUrl: "https://user.provider.example.test/v1",
						api: "openai-completions",
						models: [{ id: "user-model", name: "User model" }],
					},
					clawdi: {
						baseUrl: "https://managed.provider.example.test/v1",
						api: "openai-responses",
						apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
						models: legacyModels,
					},
				},
			},
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.OPENCLAW_AGENT_DIR = activeAgentDir;
		const providerAuthCalls = join(root, "model-switch", "provider-auth-calls.log");
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "model-switch", "provider-auth"),
			providerAuthCalls,
		);

		const activeStore = join(activeAgentDir, "openclaw-agent.sqlite");
		const mainStore = join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
		const secondaryStore = join(
			home,
			".openclaw",
			"agents",
			"research",
			"agent",
			"openclaw-agent.sqlite",
		);
		const customStore = join(customAgentDir, "openclaw-agent.sqlite");
		const stores = new Map<string, Record<string, unknown>>([
			[
				activeStore,
				{
					profiles: {
						"clawdi:default": {
							type: "api_key",
							provider: "clawdi",
							key: "CLAWDI_AI_API_KEY",
						},
						"clawdi:legitimate": {
							type: "api_key",
							provider: "clawdi",
							key: "sk-real-but-reserved-provider",
						},
						"clawdi:named-openai": {
							type: "oauth",
							provider: "openai",
							access: "preserve-by-provider",
						},
						"openai:user": { type: "oauth", provider: "openai", access: "preserve" },
					},
					order: {
						clawdi: ["clawdi:legitimate", "clawdi:default"],
						openai: ["openai:user", "clawdi:named-openai"],
					},
					lastGood: { clawdi: "clawdi:legitimate", openai: "openai:user" },
					usageStats: {
						"clawdi:default": { lastUsed: 1 },
						"clawdi:legitimate": { lastUsed: 2 },
						"clawdi:named-openai": { lastUsed: 10 },
						"openai:user": { lastUsed: 3 },
					},
				},
			],
			[
				mainStore,
				{
					profiles: {
						"arbitrary-id": { type: "token", provider: "ClAwDi", token: "remove" },
						"anthropic:user": { type: "api_key", provider: "anthropic", key: "preserve" },
					},
					order: { clawdi: ["arbitrary-id"], anthropic: ["anthropic:user"] },
					lastGood: { clawdi: "arbitrary-id", anthropic: "anthropic:user" },
					usageStats: { "arbitrary-id": { lastUsed: 4 }, "anthropic:user": { lastUsed: 5 } },
				},
			],
			[
				secondaryStore,
				{
					profiles: {
						"models-json": { type: "api_key", provider: "clawdi", key: "remove" },
						"user:secondary": { type: "api_key", provider: "user-provider", key: "preserve" },
					},
					order: { clawdi: ["models-json"], "user-provider": ["user:secondary"] },
					lastGood: { clawdi: "models-json", "user-provider": "user:secondary" },
					usageStats: { "models-json": { lastUsed: 6 }, "user:secondary": { lastUsed: 7 } },
				},
			],
			[
				customStore,
				{
					profiles: {
						"custom-agent-clawdi": { type: "oauth", provider: "clawdi", access: "remove" },
						"custom-agent-openai": { type: "oauth", provider: "openai", access: "preserve" },
					},
					order: { clawdi: ["custom-agent-clawdi"], openai: ["custom-agent-openai"] },
					lastGood: { clawdi: "custom-agent-clawdi", openai: "custom-agent-openai" },
					usageStats: {
						"custom-agent-clawdi": { lastUsed: 8 },
						"custom-agent-openai": { lastUsed: 9 },
					},
				},
			],
		]);
		for (const [path, store] of stores) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
		}

		const paths = getRuntimePaths();
		const loaded = hostedManagedOpenClawV2Load(home, 2);
		loaded.manifest.egressEngine = seedMitmproxyCache(paths);

		let failedAuthorityCommit = false;
		writeFileSync(`${providerAuthCalls}.fail`, "1\n");
		const failedCleanup = convergeRuntimeManifest(loaded, paths, {
			commitAuthority: () => {
				failedAuthorityCommit = true;
			},
		});
		rmSync(`${providerAuthCalls}.fail`);
		expect(failedCleanup.installErrors.join("\n")).toContain(
			"simulated provider-auth cleanup failure",
		);
		expect(failedAuthorityCommit).toBe(false);
		const convergence = convergeRuntimeManifest(loaded, paths);

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(commandLog, "utf-8")).not.toContain("config patch --stdin --replace-path");
		const mutations = JSON.parse(readFileSync(mutationLog, "utf8"));
		expect(mutations).toHaveLength(2);
		const mutation = mutations[0];
		expect(mutation).toMatchObject({
			base: "source",
			afterWrite: { mode: "none" },
			allowConfigSizeDrop: true,
		});
		expect(mutation.nextBytes).toBeLessThan(Math.floor(mutation.beforeBytes * 0.5));
		expect(mutation.explicitSetPaths).toContainEqual(["models", "providers", "clawdi"]);
		expect(mutations[1]).toMatchObject({
			base: "source",
			afterWrite: { mode: "none" },
			allowConfigSizeDrop: true,
			mutationResult: true,
		});
		const appliedConfig = JSON.parse(readFileSync(openclawConfig, "utf-8"));
		expect(appliedConfig.agents.defaults.model.primary).toBe("clawdi/sol");
		expect(appliedConfig.models.mode).toBe("replace");
		expect(appliedConfig.models.providers.clawdi.models).toEqual([
			expect.objectContaining({ id: "sol" }),
		]);
		expect(appliedConfig.models.providers.clawdi.api).toBe("openai-responses");
		expect(appliedConfig.models.providers.clawdi.auth).toBe("api-key");
		expect(appliedConfig.models.providers.clawdi.apiKey).toEqual({
			source: "env",
			provider: "default",
			id: "CLAWDI_AI_API_KEY",
		});
		expect(appliedConfig.models.providers["user-owned"].models).toEqual([
			{ id: "user-model", name: "User model" },
		]);
		expect(appliedConfig.gateway).toEqual({ mode: "local", port: 19_001 });
		expect(appliedConfig.logging).toEqual({ level: "debug" });
		expect(appliedConfig.auth).toEqual({
			profiles: {
				"clawdi:named-openai": { provider: "openai", mode: "oauth" },
				"openai:user": { provider: "openai", mode: "oauth" },
			},
			order: { openai: ["openai:user", "clawdi:named-openai"] },
		});
		expect(JSON.stringify(appliedConfig)).not.toContain("legacy-");
		for (const path of stores.keys()) {
			const store = JSON.parse(readFileSync(path, "utf8"));
			expect(
				Object.values(store.profiles).some(
					(credential) =>
						(credential as { provider?: string }).provider?.toLowerCase() === "clawdi",
				),
			).toBe(false);
			expect(store.order?.clawdi).toBeUndefined();
			expect(store.lastGood?.clawdi).toBeUndefined();
		}
		expect(JSON.parse(readFileSync(activeStore, "utf8"))).toMatchObject({
			profiles: {
				"clawdi:named-openai": { access: "preserve-by-provider" },
				"openai:user": { access: "preserve" },
			},
			order: { openai: ["openai:user", "clawdi:named-openai"] },
			lastGood: { openai: "openai:user" },
			usageStats: {
				"clawdi:named-openai": { lastUsed: 10 },
				"openai:user": { lastUsed: 3 },
			},
		});
		expect(JSON.parse(readFileSync(mainStore, "utf8")).profiles["anthropic:user"]).toEqual({
			type: "api_key",
			provider: "anthropic",
			key: "preserve",
		});
		expect(JSON.parse(readFileSync(secondaryStore, "utf8")).profiles["user:secondary"]).toEqual({
			type: "api_key",
			provider: "user-provider",
			key: "preserve",
		});
		expect(JSON.parse(readFileSync(customStore, "utf8")).profiles["custom-agent-openai"]).toEqual({
			type: "oauth",
			provider: "openai",
			access: "preserve",
		});

		const afterCleanup = new Map(
			[...stores.keys()].map((path) => [path, readFileSync(path, "utf8")]),
		);
		const configAfterCleanup = readFileSync(openclawConfig, "utf8");
		const idempotent = convergeRuntimeManifest(loaded, paths);
		expect(idempotent.installErrors).toEqual([]);
		for (const [path, content] of afterCleanup) expect(readFileSync(path, "utf8")).toBe(content);
		expect(readFileSync(openclawConfig, "utf8")).toBe(configAfterCleanup);
		expect(JSON.parse(readFileSync(mutationLog, "utf8"))).toEqual(mutations);

		writeTestRuntimeAppliedState(paths, loaded, convergence);
		const unmanagedCredential = JSON.parse(readFileSync(secondaryStore, "utf8"));
		unmanagedCredential.profiles["clawdi:unmanaged"] = {
			type: "api_key",
			provider: "clawdi",
			key: "preserve-without-managed-projection",
		};
		writeFileSync(secondaryStore, `${JSON.stringify(unmanagedCredential, null, 2)}\n`);
		const configBeforeUnmanaged = JSON.parse(readFileSync(openclawConfig, "utf8"));
		configBeforeUnmanaged.auth.profiles["clawdi:unmanaged"] = {
			provider: "clawdi",
			mode: "api_key",
		};
		configBeforeUnmanaged.auth.order.clawdi = ["clawdi:unmanaged"];
		writeFileSync(openclawConfig, `${JSON.stringify(configBeforeUnmanaged, null, 2)}\n`);
		const unmanagedLoad = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 3);
		unmanagedLoad.manifest.egressEngine = TEST_EGRESS_ENGINE_PIN;
		const unmanaged = convergeRuntimeManifest(unmanagedLoad, paths);
		expect(unmanaged.installErrors).toEqual([]);
		const deletionMutations = JSON.parse(readFileSync(mutationLog, "utf8"));
		const deletionMutation = deletionMutations.at(-1);
		expect(deletionMutation.unsetPaths).toContainEqual(["models", "providers", "clawdi"]);
		const unmanagedConfig = JSON.parse(readFileSync(openclawConfig, "utf8"));
		expect(unmanagedConfig.models.mode).toBe("merge");
		expect(unmanagedConfig.models.providers.clawdi).toBeUndefined();
		expect(unmanagedConfig.models.providers["user-owned"]).toEqual(
			appliedConfig.models.providers["user-owned"],
		);
		expect(unmanagedConfig.auth.profiles["clawdi:unmanaged"]).toEqual({
			provider: "clawdi",
			mode: "api_key",
		});
		expect(unmanagedConfig.auth.order.clawdi).toEqual(["clawdi:unmanaged"]);
		expect(
			JSON.parse(readFileSync(secondaryStore, "utf8")).profiles["clawdi:unmanaged"],
		).toMatchObject({ key: "preserve-without-managed-projection" });
	});

	it("preserves a healthy user-upgraded Hosted Codex package", () => {
		const home = join(root, "codex-user-upgraded", "home", "clawdi");
		const state = join(root, "codex-user-upgraded", "var", "lib", "clawdi");
		const run = join(root, "codex-user-upgraded", "run", "clawdi");
		const binDir = join(root, "codex-user-upgraded", "fake-bin");
		const installMarker = join(root, "codex-user-upgraded", "npm-install.txt");
		const previousPath = process.env.PATH;
		seedOpenClawBinary(home);
		const { packageJson } = seedHostedCodexPackage(home, "0.147.0");
		writeHostedCodexNpmInstaller(binDir, installMarker, "0.146.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");
		delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;

		try {
			const convergence = convergeRuntimeManifest(
				hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 1),
				getRuntimePaths(),
			);
			expect(convergence.installErrors).toEqual([]);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		}

		expect(existsSync(installMarker)).toBe(false);
		expect(JSON.parse(readFileSync(packageJson, "utf8")).version).toBe("0.147.0");
		expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
			'model_provider = "clawdi"',
		);
		expect(existsSync(join(getRuntimePaths().userNpmPrefix, "bin", "codex"))).toBe(true);
	});

	it("bootstraps missing or damaged Hosted Codex packages", () => {
		const previousPath = process.env.PATH;
		const cases = [
			{ name: "missing" },
			{ name: "damaged", version: "0.146.0", validPackageJson: false },
			{ name: "non-executable", version: "0.146.0", executable: false },
		] as const;

		try {
			for (const packageCase of cases) {
				const caseRoot = join(root, `codex-${packageCase.name}`);
				const home = join(caseRoot, "home", "clawdi");
				const state = join(caseRoot, "var", "lib", "clawdi");
				const run = join(caseRoot, "run", "clawdi");
				const binDir = join(caseRoot, "fake-bin");
				const installMarker = join(caseRoot, "npm-install.txt");
				seedOpenClawBinary(home);
				if ("version" in packageCase) {
					seedHostedCodexPackage(home, packageCase.version, {
						executable: "executable" in packageCase ? packageCase.executable : undefined,
						validPackageJson:
							"validPackageJson" in packageCase ? packageCase.validPackageJson : undefined,
					});
				}
				writeHostedCodexNpmInstaller(binDir, installMarker, "0.146.0");
				process.env.HOME = home;
				process.env.CLAWDI_RUNTIME_MODE = "hosted";
				process.env.CLAWDI_SERVICE_STATE_DIR = state;
				process.env.CLAWDI_RUN_DIR = run;
				process.env.CLAWDI_SYSTEMD_APPLY = "0";
				process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");
				delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;

				const convergence = convergeRuntimeManifest(
					hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 1),
					getRuntimePaths(),
				);
				expect(convergence.installErrors).toEqual([]);
				expect(readFileSync(installMarker, "utf8")).toBe("install\n");
				expect(
					JSON.parse(
						readFileSync(
							join(getRuntimePaths().userNpmPrefix, "lib/node_modules/@openai/codex/package.json"),
							"utf8",
						),
					).version,
				).toBe("0.146.0");
			}
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		}
	});

	it("fails closed when npm installs the wrong Codex bootstrap version", () => {
		const home = join(root, "codex-wrong-version", "home", "clawdi");
		const state = join(root, "codex-wrong-version", "var", "lib", "clawdi");
		const run = join(root, "codex-wrong-version", "run", "clawdi");
		const binDir = join(root, "codex-wrong-version", "fake-bin");
		const installMarker = join(root, "codex-wrong-version", "npm-install.txt");
		const previousPath = process.env.PATH;
		seedOpenClawBinary(home);
		writeHostedCodexNpmInstaller(binDir, installMarker, "0.145.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");
		delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;

		try {
			const convergence = convergeRuntimeManifest(
				hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 1),
				getRuntimePaths(),
			);
			expect(convergence.installErrors.join("\n")).toContain(
				"Codex bootstrap installed version 0.145.0; expected 0.146.0",
			);
			expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		}
	});

	it("does not mutate live config when Codex bootstrap fails", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const binDir = join(root, "fake-bin");
		const previousPath = process.env.PATH;
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "npm"), "#!/usr/bin/env bash\necho npm failed >&2\nexit 42\n");
		chmodSync(join(binDir, "npm"), 0o755);
		seedOpenClawBinary(home);
		writeHermesVersionBinary(home, "0.18.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");
		delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;
		const paths = getRuntimePaths();
		const liveFiles = [
			join(paths.runConfigRoot, "stale-runtime.json"),
			join(paths.systemdUserRoot, "openclaw-gateway.service"),
		];
		for (const path of liveFiles) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `generation-1:${path.split("/").at(-1)}\n`);
		}
		const previousLiveSnapshot = Object.fromEntries(
			liveFiles.map((path) => [path, readFileSync(path, "utf-8")]),
		);

		try {
			const convergence = convergeRuntimeManifest(
				hostedSingleProviderModeLoad(home, "openclaw", "configured", 2),
				paths,
			);

			expect(convergence.installErrors.join("\n")).toContain("runtime codex setup failed");
			expect(convergence.outputs.systemdSystemUnits).toEqual([]);
			expect(convergence.outputs.systemdUserUnits).toEqual([]);
			for (const [path, content] of Object.entries(previousLiveSnapshot)) {
				expect(readFileSync(path, "utf-8")).toBe(content);
			}
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it.each(["openclaw", "hermes"] as const)(
		"converges %s in unmanaged mode without touching user provider config",
		(runtimeName) => {
			const home = join(root, runtimeName, "home", "clawdi");
			const state = join(root, runtimeName, "var", "lib", "clawdi");
			const run = join(root, runtimeName, "run", "clawdi");
			const workspace = home;
			mkdirSync(workspace, { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;

			let userConfigPath: string;
			let userConfig: string;
			if (runtimeName === "openclaw") {
				seedOpenClawBinary(home);
				userConfigPath = join(home, ".openclaw", "openclaw.json");
				userConfig =
					'{"models":{"providers":{"user-local":{"baseUrl":"http://localhost:11434/v1"}}}}\n';
				writeFileSync(userConfigPath, userConfig);
			} else {
				writeHermesVersionBinary(home, "0.18.0");
				userConfigPath = join(home, ".hermes", "config.yaml");
				userConfig = 'providers:\n  user-local:\n    api: "http://localhost:11434/v1"\n';
				mkdirSync(dirname(userConfigPath), { recursive: true });
				writeFileSync(userConfigPath, userConfig);
			}
			const userCodexConfig = join(home, ".codex", "config.toml");
			mkdirSync(dirname(userCodexConfig), { recursive: true });
			writeFileSync(userCodexConfig, "# preserve me byte-for-byte\n");

			const paths = getRuntimePaths();
			const load = hostedSingleProviderModeLoad(home, runtimeName, "unmanaged", 1);
			const convergence = convergeRuntimeManifest(load, paths);
			writeTestRuntimeAppliedState(paths, load, convergence);

			expect(convergence.installErrors).toEqual([]);
			expect(convergence.projectedProviderIds[runtimeName]).toEqual([]);
			expect(convergence.projectedProviderIds.codex).toEqual(["clawdi"]);
			if (runtimeName === "openclaw") {
				expect(
					JSON.parse(readFileSync(userConfigPath, "utf-8")).models.providers["user-local"],
				).toEqual({ baseUrl: "http://localhost:11434/v1" });
			} else {
				expect(
					expectRecord(readHermesConfigYaml(home).providers, "Hermes providers")["user-local"],
				).toEqual({ api: "http://localhost:11434/v1" });
			}
			expect(readFileSync(userCodexConfig, "utf-8")).toContain('model_provider = "clawdi"');
			const runConfig = JSON.parse(
				readFileSync(join(getRuntimePaths().runConfigRoot, `${runtimeName}.json`), "utf-8"),
			);
			expect(runConfig.secretEnv).toEqual(
				runtimeName === "openclaw"
					? { OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token" }
					: {},
			);
			expect(JSON.stringify(runConfig)).not.toContain("OPENAI_API_KEY");
			expect(JSON.stringify(runConfig)).not.toContain("clawdi-egress-placeholder");
			expect(runConfig.secretFilePath).toBeNull();
			const runtimeUnit = runtimeName === "openclaw" ? "openclaw-gateway" : "hermes-gateway";
			const runtimeUnitEnv = readSystemdEnvFile(paths, runtimeUnit);
			for (const forbidden of [
				"OPENAI_API_KEY",
				"CLAWDI_AI_API_KEY",
				"provider.clawdi-managed",
				"egress-secrets.json",
			]) {
				expect(runtimeUnitEnv).not.toContain(forbidden);
			}
			const egressSecrets = readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8");
			expect(egressSecrets).toContain("secret://tool.codex.apiKey");
			expect(egressSecrets).toContain("sk-codex-tool");
			const applied = JSON.parse(readFileSync(paths.appliedState, "utf-8"));
			expect(applied.providerIds).toEqual([]);
			expect(applied.projectedProviderIds[runtimeName]).toEqual([]);
			expect(applied.projectedProviderIds.codex).toEqual(["clawdi"]);
		},
	);

	it("removes only the runtime provider projection on configured to unmanaged", () => {
		const home = join(root, "owned-cleanup", "home", "clawdi");
		const state = join(root, "owned-cleanup", "var", "lib", "clawdi");
		const run = join(root, "owned-cleanup", "run", "clawdi");
		mkdirSync(join(home, "clawdi"), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const userCodexConfig = join(home, ".codex", "config.toml");
		mkdirSync(dirname(userCodexConfig), { recursive: true });
		writeFileSync(userCodexConfig, '# user-owned bytes\nmodel = "user-model"\n');
		const paths = getRuntimePaths();
		const configuredLoad = hostedSingleProviderModeLoad(home, "openclaw", "configured", 1);
		const configured = convergeRuntimeManifest(configuredLoad, paths);
		expect(configured.installErrors).toEqual([]);
		writeTestRuntimeAppliedState(paths, configuredLoad, configured);
		const codexConfig = join(home, ".codex", "config.toml");
		expect(readFileSync(codexConfig, "utf-8")).toContain('env_key = "CLAWDI_AI_API_KEY"');
		const expectedCodexConfig = readFileSync(codexConfig, "utf-8");

		const unmanaged = convergeRuntimeManifest(
			hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 2),
			paths,
		);

		expect(unmanaged.installErrors).toEqual([]);
		expect(unmanaged.projectedProviderIds).toMatchObject({
			codex: ["clawdi"],
			openclaw: [],
		});
		expect(readFileSync(codexConfig, "utf-8")).toBe(expectedCodexConfig);
		const runConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		expect(runConfig.secretEnv).toEqual({
			OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
		});
		expect(JSON.stringify(runConfig)).not.toContain("OPENAI_API_KEY");
		expect(runConfig.secretFilePath).toBeNull();
		expect(readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8")).toContain(
			"sk-codex-tool",
		);
	});

	it("keeps BYOK provider secrets sidecar-only across configured to unmanaged", () => {
		const home = join(root, "byok-cleanup", "home", "clawdi");
		const state = join(root, "byok-cleanup", "var", "lib", "clawdi");
		const run = join(root, "byok-cleanup", "run", "clawdi");
		mkdirSync(join(home, "clawdi"), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const configuredLoad = hostedSingleProviderModeLoad(home, "openclaw", "configured", 1);
		const byokProviders = {
			"user-byok": {
				kind: "openai-compatible",
				baseUrl: "https://byok.provider.example.test/v1",
				model: "user-model",
				models: [{ id: "user-model" }],
				apiMode: "openai_responses",
				managed_by: "user",
				runtimeEnvName: "OPENAI_API_KEY",
				apiKeySecretRef: "secret://provider.user-byok.apiKey",
			},
		};
		const terminalTooling = configuredLoad.manifest.projection?.terminalTooling;
		configuredLoad.manifest = {
			...configuredLoad.manifest,
			runtimes: {
				openclaw: {
					...configuredLoad.manifest.runtimes.openclaw,
					provider_ids: ["user-byok"],
					primary_model: { provider_id: "user-byok", model: "user-model" },
				},
			},
			projection: {
				...configuredLoad.manifest.projection,
				providers: byokProviders,
			},
			egressProfiles: hostedManifestEgressProfiles({ providers: byokProviders, terminalTooling }),
		};
		configuredLoad.secretValues = {
			...configuredLoad.secretValues,
			"secret://provider.user-byok.apiKey": "sk-user-byok",
		};
		const configured = convergeRuntimeManifest(configuredLoad, paths);
		expect(configured.installErrors).toEqual([]);
		writeTestRuntimeAppliedState(paths, configuredLoad, configured);
		const configuredRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		expect(configuredRunConfig.secretFilePath).toBeNull();

		const unmanagedLoad = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 2);
		const unmanaged = convergeRuntimeManifest(unmanagedLoad, paths);

		expect(unmanaged.installErrors).toEqual([]);
		expect(
			JSON.parse(readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"))
				.secretFilePath,
		).toBeNull();
		expect(readSystemdEnvFile(paths, "openclaw-gateway")).not.toContain("OPENAI_API_KEY");
		expect(readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8")).toContain(
			"sk-codex-tool",
		);
		expect(existsSync(join(home, ".codex", "config.toml"))).toBe(true);
	});

	it("projects complete OpenClaw gateway config before the official service installer", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawCommand = join(root, "openclaw-command.log");
		const openclawConfig = join(home, ".openclaw", "openclaw.json");
		const installerToken = join(root, "openclaw-installer-token");
		const configPatchFailure = join(root, "fail-openclaw-config-patch");
		const patchCount = join(root, "openclaw-patch-count");
		const unitPath = join(home, ".config", "systemd", "user", "openclaw-gateway.service");
		const gatewayEnvPath = join(run, "systemd", "env", "openclaw-gateway.service.env");
		writeOpenClawConfigMutationFixture(home);
		mkdirSync(dirname(openclawBin), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then printf "OpenClaw test-version\\n"; exit 0; fi',
				`printf '%s\\n' "$*" >> '${openclawCommand}'`,
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then',
				`  [ ! -e '${configPatchFailure}' ] || exit 73`,
				`  count=$(cat '${patchCount}' 2>/dev/null || printf '0')`,
				"  count=$((count + 1))",
				`  printf '%s' "$count" > '${patchCount}'`,
				`  cat > '${root}'/openclaw-patch-"$count".json`,
				`  if grep -F '"gateway"' '${root}'/openclaw-patch-"$count".json >/dev/null; then`,
				`    mkdir -p '${dirname(openclawConfig)}'`,
				`    cp '${root}'/openclaw-patch-"$count".json '${openclawConfig}'`,
				"  fi",
				"  exit 0",
				"fi",
				'if [ "$1 $2 $3 $4" = "gateway install --force --json" ]; then',
				`  [ "\${OPENCLAW_GATEWAY_TOKEN:-}" = 'gateway-token' ] || exit 71`,
				`  grep -F '"token": "gateway-token"' '${openclawConfig}' >/dev/null || exit 72`,
				`  printf '%s\\n' "\${OPENCLAW_GATEWAY_TOKEN}" > '${installerToken}'`,
				`  mkdir -p '${dirname(unitPath)}'`,
				`  printf '%s\\n' '[Unit]' '[Service]' 'ExecStart=${openclawBin} gateway run' > '${unitPath}'`,
				"  printf '{\"ok\":true}\\n'",
				"  exit 0",
				"fi",
				"printf 'unexpected openclaw command: %s\\n' \"$*\" >&2",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);
		// Prior-generation state: a stale persisted gateway token in the official
		// config location, exactly as a previous boot would have left it.
		mkdirSync(dirname(openclawConfig), { recursive: true });
		writeFileSync(
			openclawConfig,
			`${JSON.stringify({
				gateway: {
					mode: "local",
					auth: { mode: "token", token: "stale-installer-token" },
				},
			})}\n`,
		);

		const loaded: RuntimeManifestLoad = {
			source: "remote-datasource",
			sourcePath: "https://runtime-source.test/desired-state",
			offline: false,
			secretValues: {
				"secret://provider.default.apiKey": "sk-runtime-provider",
				"secret://runtime/openclaw/gateway-token": "gateway-token",
			},
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_openclaw_gateway_repatch",
				environmentId: "env_openclaw_gateway_repatch",
				instanceId: "iid_openclaw_gateway_repatch",
				generation: 1,
				issuedAt: "2026-06-22T00:00:00Z",
				workspaceRoot: join(home, "clawdi"),
				controlPlane: { apiUrl: "https://cloud-api.test" },
				openclawGatewayAuth: {
					mode: "token",
					tokenRef: "secret://runtime/openclaw/gateway-token",
					deviceAuthRequired: false,
					activation: { enabled: true, capability: "openclaw-native-auth-v1" },
				},
				runtimes: {
					openclaw: {
						enabled: true,
						run: {
							command: openclawBin,
							args: ["gateway", "run"],
							env: {},
							secretEnv: {
								OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
							},
							prependPath: [],
						},
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-5.4-mini" },
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: ["--json", "--no-onboard"],
						},
					},
				},
				projection: {
					system: {
						...hostedSystemFixture(home),
						home,
						openclawControlUiAllowedOrigins: ["https://app-v2-18789.k3s.example.test"],
					},
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://ai-gateway.example.test/v1",
							model: "gpt-5.4-mini",
							apiMode: "openai_chat",
							runtimeEnvName: "OPENAI_API_KEY",
							apiKeySecretRef: "secret://provider.default.apiKey",
						},
					},
				},
				egressProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			},
		};

		writeFileSync(configPatchFailure, "fail\n");
		const failedConfigPatch = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(failedConfigPatch.installErrors).toContainEqual(
			expect.stringContaining("runtime openclaw provider projection failed"),
		);
		expect(failedConfigPatch.outputs.systemdUserUnits).toEqual([]);
		expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
			"stale-installer-token",
		);
		expect(readFileSync(openclawCommand, "utf8").trim()).toBe("config patch --stdin");
		expect(existsSync(installerToken)).toBe(false);
		expect(existsSync(unitPath)).toBe(false);
		expect(existsSync(gatewayEnvPath)).toBe(false);
		rmSync(configPatchFailure);

		const convergence = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf-8").trim().split("\n")).toEqual([
			"config patch --stdin",
			"config patch --stdin",
			"gateway install --force --json",
		]);
		expect(JSON.parse(readFileSync(join(root, "openclaw-patch-1.json"), "utf-8"))).toEqual({
			gateway: {
				mode: "local",
				port: 18789,
				bind: "lan",
				auth: {
					mode: "token",
					token: "gateway-token",
				},
				controlUi: {
					basePath: "/",
					allowedOrigins: ["https://app-v2-18789.k3s.example.test"],
					dangerouslyAllowHostHeaderOriginFallback: false,
					dangerouslyDisableDeviceAuth: true,
				},
			},
		});
		expect(readFileSync(installerToken, "utf8")).toBe("gateway-token\n");
		expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
			"gateway-token",
		);
		expect(readFileSync(openclawCommand, "utf8")).not.toContain("gateway-token");
		expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
			"OPENCLAW_GATEWAY_TOKEN",
		);
		const openclawDropIn = readFileSync(
			join(
				getRuntimePaths().systemdUserRoot,
				"openclaw-gateway.service.d",
				"10-clawdi-hosted.conf",
			),
			"utf8",
		);
		expect(openclawDropIn).not.toContain("\nExecStart=");
		expect(openclawDropIn).not.toContain("\nWorkingDirectory=");

		const fixedCredentialTime = new Date("2026-08-11T00:00:00.000Z");
		utimesSync(openclawConfig, fixedCredentialTime, fixedCredentialTime);
		utimesSync(gatewayEnvPath, fixedCredentialTime, fixedCredentialTime);
		const configMtime = statSync(openclawConfig).mtimeMs;
		const envMtime = statSync(gatewayEnvPath).mtimeMs;
		const commandsAfterConvergence = readFileSync(openclawCommand, "utf8");
		const idempotent = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(idempotent.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf8")).toBe(commandsAfterConvergence);
		expect(statSync(openclawConfig).mtimeMs).toBe(configMtime);
		expect(statSync(gatewayEnvPath).mtimeMs).toBe(envMtime);

		rmSync(unitPath, { force: true });
		const reinstalled = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(reinstalled.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf8").trim().split("\n").slice(-1)).toEqual([
			"gateway install --force --json",
		]);
		expect(readFileSync(installerToken, "utf8")).toBe("gateway-token\n");
		expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
			"gateway-token",
		);
		expect(statSync(openclawConfig).mtimeMs).toBe(configMtime);
		expect(statSync(gatewayEnvPath).mtimeMs).toBe(envMtime);

		if (!loaded.secretValues) throw new Error("expected runtime secret fixture");
		loaded.secretValues["secret://runtime/openclaw/gateway-token"] = "rotated-gateway-token";
		const rotated = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(rotated.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf8").trim().split("\n").slice(-1)).toEqual([
			"config patch --stdin",
		]);
		expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
			"rotated-gateway-token",
		);
		expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
			"OPENCLAW_GATEWAY_TOKEN",
		);
		expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
			"rotated-gateway-token",
		);
		expect(readFileSync(openclawCommand, "utf8")).not.toContain("rotated-gateway-token");
	});

	it("owns one hosted Hermes OAuth family across rotation, logout, reconnect, and removal", () => {
		const home = join(root, "oauth-hermes", "home", "clawdi");
		const state = join(root, "oauth-hermes", "var", "lib", "clawdi");
		const run = join(root, "oauth-hermes", "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		writeHermesVersionBinary(home, "0.19.0");
		const paths = getRuntimePaths();
		const authPath = join(home, ".hermes", "auth.json");
		const nativeProfileId = nativeOAuthProfileId("hermes", "openai-codex");
		const ledgerKey = createHash("sha256").update("openai-codex").digest("hex");
		const ledgerPath = join(paths.oauthCredentialRoot, "hermes", `${ledgerKey}.json`);
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(
			authPath,
			`${JSON.stringify({
				version: 1,
				providers: {
					"openai-codex": {
						tokens: { access_token: "user-access", refresh_token: "user-refresh" },
					},
				},
				credential_pool: {
					"openai-codex": [
						{
							id: "user-independent",
							label: "user-independent",
							auth_type: "oauth",
							priority: 0,
							source: "manual:device_code",
							access_token: "user-independent-access",
							refresh_token: "user-independent-refresh",
						},
					],
				},
			})}\n`,
		);
		const firstLoad = hostedOAuthRuntimeLoad({
			home,
			runtime: "hermes",
			generation: 1,
			credentialRevision: "hermes-revision-1",
			accessToken: "hermes-seed-access",
			refreshToken: "hermes-seed-refresh",
		});
		mkdirSync(dirname(ledgerPath), { recursive: true });
		writeFileSync(
			ledgerPath,
			`${JSON.stringify({
				schemaVersion: "clawdi.oauthCredentialOwnership.v2",
				runtime: "hermes",
				providerId: "openai-codex",
				nativeProfileId,
				credentialRevision: "hermes-revision-1",
				state: "intent",
				operation: "seed",
				targetCredentialFingerprint: oauthCredentialFingerprint(
					"hermes-revision-1",
					"hermes-seed-access",
					"hermes-seed-refresh",
				),
			})}\n`,
		);

		const first = convergeRuntimeManifest(firstLoad, paths);
		expect(first.installErrors).toEqual([]);
		let auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.providers["openai-codex"].tokens.access_token).toBe("user-access");
		expect(auth.credential_pool["openai-codex"][0]).toMatchObject({
			id: nativeProfileId,
			label: "Clawdi managed connection",
			source: "manual:device_code",
			access_token: "hermes-seed-access",
			refresh_token: "hermes-seed-refresh",
		});
		expect(auth.credential_pool["openai-codex"][1].id).toBe("user-independent");
		expect(existsSync(join(home, ".hermes", "auth.lock"))).toBe(true);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("seeded");

		auth.credential_pool["openai-codex"][0].access_token = "hermes-runtime-rotated";
		auth.credential_pool["openai-codex"][0].refresh_token = "hermes-runtime-rotated-refresh";
		writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.credential_pool["openai-codex"][0].access_token).toBe("hermes-runtime-rotated");
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("seeded");

		auth.credential_pool["openai-codex"] = auth.credential_pool["openai-codex"].filter(
			(entry: { id?: string }) => entry.id !== nativeProfileId,
		);
		writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
			nativeProfileId,
			credentialRevision: "hermes-revision-1",
			state: "revoked",
		});
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.credential_pool["openai-codex"][0].id).toBe("user-independent");
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("revoked");

		const nativeReauthenticatedLoad = hostedOAuthRuntimeLoad({
			home,
			runtime: "hermes",
			generation: 2,
			credentialRevision: "hermes-revision-2",
			accessToken: "explicit-reconnect-access",
			refreshToken: "explicit-reconnect-refresh",
		});
		convergeRuntimeManifest(nativeReauthenticatedLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.providers["openai-codex"].tokens.access_token).toBe("user-access");
		expect(auth.credential_pool["openai-codex"][0]).toMatchObject({
			id: nativeProfileId,
			access_token: "explicit-reconnect-access",
			refresh_token: "explicit-reconnect-refresh",
		});
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
			credentialRevision: "hermes-revision-2",
			state: "seeded",
		});

		auth.credential_pool["openai-codex"][0].access_token = "post-reconnect-rotated-access";
		auth.credential_pool["openai-codex"][0].refresh_token = "post-reconnect-rotated-refresh";
		writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
		convergeRuntimeManifest(nativeReauthenticatedLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.credential_pool["openai-codex"][0].access_token).toBe(
			"post-reconnect-rotated-access",
		);

		const removedLoad = hostedSingleProviderModeLoad(home, "hermes", "unmanaged", 3);
		convergeRuntimeManifest(removedLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.providers["openai-codex"].tokens.access_token).toBe("user-access");
		expect(auth.credential_pool?.["openai-codex"]).toEqual([
			expect.objectContaining({
				id: "user-independent",
				access_token: "user-independent-access",
				refresh_token: "user-independent-refresh",
			}),
		]);
		expect(existsSync(ledgerPath)).toBe(false);
	}, 30_000);

	it("uses OpenClaw provider-auth SQLite ownership without reviving logout", () => {
		const home = join(root, "oauth-openclaw", "home", "clawdi");
		const state = join(root, "oauth-openclaw", "var", "lib", "clawdi");
		const run = join(root, "oauth-openclaw", "run", "clawdi");
		const sdkCalls = join(root, "oauth-openclaw", "provider-auth-calls.log");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "oauth-openclaw"),
			sdkCalls,
		);
		seedOpenClawBinary(home);
		const paths = getRuntimePaths();
		const nativeProfileId = nativeOAuthProfileId("openclaw", "openai-codex");
		const ledgerKey = createHash("sha256").update("openai-codex").digest("hex");
		const ledgerPath = join(paths.oauthCredentialRoot, "openclaw", `${ledgerKey}.json`);
		const storePath = join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(
			storePath,
			`${JSON.stringify({
				profiles: {
					"openai:default": {
						type: "oauth",
						provider: "openai",
						access: "user-access",
						refresh: "user-refresh",
					},
				},
				order: { openai: ["openai:default"] },
				lastGood: {},
				usageStats: {},
			})}\n`,
		);
		const firstLoad = hostedOAuthRuntimeLoad({
			home,
			runtime: "openclaw",
			generation: 1,
			credentialRevision: "openclaw-revision-1",
			accessToken: "openclaw-seed-access",
			refreshToken: "openclaw-seed-refresh",
		});
		mkdirSync(dirname(ledgerPath), { recursive: true });
		writeFileSync(
			ledgerPath,
			`${JSON.stringify({
				schemaVersion: "clawdi.oauthCredentialOwnership.v2",
				runtime: "openclaw",
				providerId: "openai-codex",
				nativeProfileId,
				credentialRevision: "openclaw-revision-1",
				state: "intent",
				operation: "seed",
				targetCredentialFingerprint: oauthCredentialFingerprint(
					"openclaw-revision-1",
					"openclaw-seed-access",
					"openclaw-seed-refresh",
				),
			})}\n`,
		);

		const first = convergeRuntimeManifest(firstLoad, paths);
		expect(first.installErrors).toEqual([]);
		let store = JSON.parse(readFileSync(storePath, "utf8"));
		expect(store.profiles[nativeProfileId]).toMatchObject({
			type: "oauth",
			provider: "openai",
			access: "openclaw-seed-access",
			refresh: "openclaw-seed-refresh",
			copyToAgents: false,
		});
		expect(store.profiles["openai:default"]).toMatchObject({
			access: "user-access",
			refresh: "user-refresh",
		});
		expect(store.order.openai).toEqual([nativeProfileId, "openai:default"]);
		expect(existsSync(join(dirname(storePath), "auth-profiles.json"))).toBe(false);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("seeded");

		store.profiles[nativeProfileId].access = "openclaw-runtime-rotated";
		store.profiles[nativeProfileId].refresh = "openclaw-runtime-rotated-refresh";
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(storePath, "utf8")).profiles[nativeProfileId].access).toBe(
			"openclaw-runtime-rotated",
		);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("seeded");

		store = JSON.parse(readFileSync(storePath, "utf8"));
		delete store.profiles[nativeProfileId];
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(storePath, "utf8")).profiles[nativeProfileId]).toBeUndefined();
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
			nativeProfileId,
			credentialRevision: "openclaw-revision-1",
			state: "revoked",
		});

		store = JSON.parse(readFileSync(storePath, "utf8"));
		store.profiles["openai:default"].access = "native-reauth-access";
		store.profiles["openai:default"].refresh = "native-reauth-refresh";
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("revoked");

		const nativeReauthenticatedLoad = hostedOAuthRuntimeLoad({
			home,
			runtime: "openclaw",
			generation: 2,
			credentialRevision: "openclaw-revision-2",
			accessToken: "explicit-reconnect-access",
			refreshToken: "explicit-reconnect-refresh",
		});
		convergeRuntimeManifest(nativeReauthenticatedLoad, paths);
		store = JSON.parse(readFileSync(storePath, "utf8"));
		expect(store.profiles["openai:default"].access).toBe("native-reauth-access");
		expect(store.profiles[nativeProfileId]).toMatchObject({
			access: "explicit-reconnect-access",
			refresh: "explicit-reconnect-refresh",
		});
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
			credentialRevision: "openclaw-revision-2",
			state: "seeded",
		});

		store.profiles[nativeProfileId].access = "post-reconnect-rotated-access";
		store.profiles[nativeProfileId].refresh = "post-reconnect-rotated-refresh";
		store.lastGood = { openai: nativeProfileId };
		store.usageStats = { [nativeProfileId]: { lastUsed: 123 } };
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		convergeRuntimeManifest(nativeReauthenticatedLoad, paths);
		expect(JSON.parse(readFileSync(storePath, "utf8")).profiles[nativeProfileId].access).toBe(
			"post-reconnect-rotated-access",
		);

		const removedLoad = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 3);
		convergeRuntimeManifest(removedLoad, paths);
		store = JSON.parse(readFileSync(storePath, "utf8"));
		expect(store.profiles[nativeProfileId]).toBeUndefined();
		expect(store.profiles["openai:default"]).toMatchObject({
			access: "native-reauth-access",
			refresh: "native-reauth-refresh",
		});
		expect(store.order?.openai ?? []).not.toContain(nativeProfileId);
		expect(store.order?.openai ?? []).toEqual(["openai:default"]);
		expect(store.lastGood?.openai).toBeUndefined();
		expect(store.usageStats?.[nativeProfileId]).toBeUndefined();
		expect(existsSync(ledgerPath)).toBe(false);
		const calls = readFileSync(sdkCalls, "utf8");
		expect(calls).toContain("ensure ");
		expect(calls).toContain("update ");
	});

	it("does not reinstall an installed OpenClaw missing provider-auth capability", () => {
		const testRoot = join(root, "oauth-openclaw-capability-repair");
		const home = join(testRoot, "home", "clawdi");
		const state = join(testRoot, "var", "lib", "clawdi");
		const run = join(testRoot, "run", "clawdi");
		const installer = join(testRoot, "install-openclaw.sh");
		const installerLog = join(testRoot, "installer.log");
		const sdkTarget = join(testRoot, "installed-provider-auth.mjs");
		const sdkSource = writeFakeOpenClawProviderAuthSdk(
			join(testRoot, "repair-source"),
			join(testRoot, "provider-auth-calls.log"),
		);
		mkdirSync(testRoot, { recursive: true });
		writeFileSync(
			installer,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${installerLog}'
cp '${sdkSource}' '${sdkTarget}'
`,
		);
		chmodSync(installer, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = `file://${installer}`;
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = sdkTarget;
		seedOpenClawBinary(home);

		const loaded = hostedOAuthRuntimeLoad({
			home,
			runtime: "openclaw",
			generation: 1,
			credentialRevision: "repair-revision-1",
			accessToken: "repair-access",
			refreshToken: "repair-refresh",
		});
		const result = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(result.installErrors.join("\n")).toContain(
			"OpenClaw OAuth requires the public OpenClaw SDK; automatic runtime reinstall is disabled",
		);
		expect(existsSync(installerLog)).toBe(false);
		const storePath = join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
		expect(existsSync(storePath)).toBe(false);
	});

	it("fails closed before config or credential mutation when OpenClaw capability is unavailable", () => {
		const testRoot = join(root, "oauth-openclaw-capability-repair-failure");
		const home = join(testRoot, "home", "clawdi");
		const state = join(testRoot, "var", "lib", "clawdi");
		const run = join(testRoot, "run", "clawdi");
		const installer = join(testRoot, "install-openclaw-fail.sh");
		const sdkTarget = join(testRoot, "missing-provider-auth.mjs");
		mkdirSync(testRoot, { recursive: true });
		writeFileSync(installer, "#!/usr/bin/env bash\nexit 42\n");
		chmodSync(installer, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = `file://${installer}`;
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = sdkTarget;
		seedOpenClawBinary(home);
		const configPath = join(home, ".openclaw", "openclaw.json");
		const storePath = join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(configPath, '{"original":true}\n');
		writeFileSync(
			storePath,
			'{"profiles":{"openai:default":{"type":"oauth","provider":"openai","access":"user-access","refresh":"user-refresh"}},"order":{"openai":["openai:default"]}}\n',
		);
		const originalConfig = readFileSync(configPath, "utf8");
		const originalStore = readFileSync(storePath, "utf8");
		const loaded = hostedOAuthRuntimeLoad({
			home,
			runtime: "openclaw",
			generation: 1,
			credentialRevision: "repair-failure-revision",
			accessToken: "must-not-write-access",
			refreshToken: "must-not-write-refresh",
		});

		const result = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(result.installErrors.join("\n")).toContain("automatic runtime reinstall is disabled");
		expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
		expect(readFileSync(storePath, "utf8")).toBe(originalStore);
		expect(existsSync(join(getRuntimePaths().oauthCredentialRoot, "openclaw"))).toBe(false);
	});

	it("reconverges the native Hermes provider projection idempotently", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.18.0");
		const loaded = hostedHermesProviderLoad(home);
		const paths = getRuntimePaths();

		convergeRuntimeManifest(loaded, paths);
		const firstConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		const firstRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));

		convergeRuntimeManifest(loaded, paths);

		expect(readFileSync(join(home, ".hermes", "config.yaml"), "utf-8")).toBe(firstConfig);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).toBe(firstRevision);
	});

	it("ignores a retired Hermes plugin while removing the native provider", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.18.0");
		mkdirSync(hermesModelProviderPluginDir(home), { recursive: true });
		writeFileSync(join(hermesModelProviderPluginDir(home), "__init__.py"), "# stale\n");
		const withProvider = hostedHermesProviderLoad(home);
		const withoutProvider: RuntimeManifestLoad = {
			...withProvider,
			manifest: {
				...withProvider.manifest,
				runtimes: {
					hermes: {
						...withProvider.manifest.runtimes.hermes,
						providerMode: "unmanaged",
						provider_ids: [],
						primary_model: undefined,
					},
				},
				projection: {
					system: { home },
				},
			},
		};
		const paths = getRuntimePaths();

		const first = convergeRuntimeManifest(withProvider, paths);
		writeTestRuntimeAppliedState(paths, withProvider, first);
		const firstRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);
		expect(
			expectRecord(readHermesConfigYaml(home).providers, "Hermes providers").hermes,
		).toBeDefined();

		convergeRuntimeManifest(withoutProvider, paths);

		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);
		const unmanagedConfig = readHermesConfigYaml(home);
		expect(unmanagedConfig.providers).toBeUndefined();
		expect(unmanagedConfig.model).toBeUndefined();
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).not.toBe(firstRevision);
	});

	it("replaces the frozen Hermes model catalog on each manifest generation", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.18.0");
		const withCapabilities = hostedSingleProviderModeLoad(home, "hermes", "configured", 1);
		const managedProvider = expectRecord(
			expectRecord(withCapabilities.manifest.projection?.providers, "managed providers")[
				"clawdi-managed"
			],
			"managed Hermes provider",
		);
		managedProvider.models = [
			{
				id: "gpt-5.5",
				context_window: 262144,
				max_tokens: 32768,
				input_modalities: ["text", "image"],
				supports_vision: true,
				supports_tools: true,
				supports_reasoning: true,
			},
			{ id: "stale-generation-model" },
		];
		const withoutCapabilities: RuntimeManifestLoad = {
			...withCapabilities,
			manifest: {
				...withCapabilities.manifest,
				projection: {
					...withCapabilities.manifest.projection,
					providers: {
						...withCapabilities.manifest.projection?.providers,
						"clawdi-managed": {
							...withCapabilities.manifest.projection?.providers?.["clawdi-managed"],
							models: [{ id: "gpt-5.5" }],
						},
					},
				},
			},
		};

		convergeRuntimeManifest(withCapabilities, getRuntimePaths());
		const initialConfig = readHermesConfigYaml(home);
		const initialModelConfig = expectRecord(initialConfig.model, "initial Hermes model config");
		expect(initialModelConfig.context_length).toBeUndefined();
		expect(initialModelConfig.supports_vision).toBeUndefined();
		const initialProviderModels = expectRecord(
			expectRecord(
				expectRecord(initialConfig.providers, "initial Hermes providers")["clawdi-managed"],
				"initial Hermes provider",
			).models,
			"initial Hermes provider models",
		);
		expect(
			expectRecord(
				expectRecord(initialConfig.providers, "initial Hermes providers")["clawdi-managed"],
				"initial Hermes provider",
			).discover_models,
		).toBe(false);
		expect(initialProviderModels["stale-generation-model"]).toEqual({});
		expect(
			expectRecord(initialProviderModels["gpt-5.5"], "initial Hermes provider model")
				.supports_vision,
		).toBe(true);

		const convergence = convergeRuntimeManifest(withoutCapabilities, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const hermesConfig = readHermesConfigYaml(home);
		const hermesModel = expectRecord(hermesConfig.model, "Hermes model config");
		expect(hermesModel.context_length).toBeUndefined();
		expect(hermesModel.max_tokens).toBeUndefined();
		expect(hermesModel.supports_vision).toBeUndefined();
		const hermesProvider = expectRecord(
			expectRecord(hermesConfig.providers, "Hermes providers config")["clawdi-managed"],
			"Hermes provider config",
		);
		expect(hermesProvider.api).toBe("https://managed.provider.example.test/v1");
		expect(hermesProvider.discover_models).toBe(false);
		expect(hermesProvider.models).toEqual({ "gpt-5.5": {} });
	});

	it.each(["openclaw", "hermes"] as const)(
		"replaces the managed %s model catalog without restarting its active runtime",
		(runtimeName) => {
			const caseRoot = join(root, runtimeName);
			const home = join(caseRoot, "home", "clawdi");
			const state = join(caseRoot, "var", "lib", "clawdi");
			const run = join(caseRoot, "run", "clawdi");
			const systemctlLog = join(caseRoot, "systemctl.log");
			const systemctlStateRoot = join(caseRoot, "systemctl-state");
			let openclawConfig: string | null = null;
			mkdirSync(home, { recursive: true });
			if (runtimeName === "openclaw") {
				openclawConfig = writeOpenClawConfigMutationFixture(home).configPath;
			} else {
				writeHermesVersionBinary(home, "0.19.1");
			}
			writeFakeSystemdManager({
				path: join(caseRoot, "bin", "systemctl"),
				logPath: systemctlLog,
				stateRoot: systemctlStateRoot,
			});
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			process.env.CLAWDI_SYSTEMCTL_PATH = join(caseRoot, "bin", "systemctl");
			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;

			const previous = hostedSingleProviderModeLoad(home, runtimeName, "configured", 1);
			const next = hostedSingleProviderModeLoad(home, runtimeName, "configured", 1);
			const previousProvider = expectRecord(
				previous.manifest.projection?.providers?.["clawdi-managed"],
				"previous managed provider",
			);
			const nextProvider = expectRecord(
				next.manifest.projection?.providers?.["clawdi-managed"],
				"next managed provider",
			);
			previousProvider.models = [
				{ id: "gpt-5.5", label: "GPT-5.5 old", context_window: 128_000 },
				{ id: "stale-model", label: "Stale model" },
			];
			nextProvider.models = [
				{
					id: "gpt-5.5",
					label: "GPT-5.5 refreshed",
					context_window: 512_000,
					max_tokens: 64_000,
					supports_vision: true,
				},
				{ id: "new-model", label: "New model" },
			];

			const paths = getRuntimePaths();
			const first = convergeRuntimeManifest(previous, paths);
			expect(first.installErrors).toEqual([]);
			writeTestRuntimeAppliedState(paths, previous, first);
			const before = readSystemdUnitSnapshot(paths);
			seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, before);
			for (const unit of before.user.keys()) {
				writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
			}
			const runtimeUnit = runtimeName === "openclaw" ? "openclaw-gateway" : "hermes-gateway";
			const initialRevision = systemdEnvDigest(readSystemdEnvFile(paths, runtimeUnit));
			writeFileSync(systemctlLog, "");

			const second = convergeRuntimeManifest(next, paths);
			expect(second.installErrors).toEqual([]);
			const activation = applySystemdRuntimeUpdate(
				paths,
				before,
				readSystemdUnitSnapshot(paths),
				{},
			);

			expect(activation).toMatchObject({
				applied: true,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			});
			expect(systemdEnvDigest(readSystemdEnvFile(paths, runtimeUnit))).toBe(initialRevision);
			const systemctlCalls = readFileSync(systemctlLog, "utf-8");
			const managerReads = systemctlCalls.trim().split("\n");
			expect(managerReads.find((call) => call.startsWith("--user show "))).toContain(
				`${runtimeUnit}.service`,
			);
			expect(managerReads.filter((call) => /^(?:--user )?show /.test(call))).toHaveLength(2);
			expect(managerReads.filter((call) => /^(?:--user )?is-enabled /.test(call))).toHaveLength(2);
			expect(systemctlCalls).not.toMatch(
				/(?:^|\s)(?:start|restart|stop|enable|disable|reset-failed)(?:\s|$)/m,
			);

			if (runtimeName === "openclaw") {
				if (!openclawConfig) throw new Error("OpenClaw config fixture is missing");
				const config = expectRecord(
					JSON.parse(readFileSync(openclawConfig, "utf-8")),
					"OpenClaw config",
				);
				const models = expectRecord(config.models, "OpenClaw models");
				const providers = expectRecord(models.providers, "OpenClaw providers");
				const provider = expectRecord(providers["clawdi-managed"], "OpenClaw managed provider");
				expect(provider.models).toEqual([
					expect.objectContaining({
						id: "gpt-5.5",
						name: "GPT-5.5 refreshed",
						contextWindow: 512_000,
						maxTokens: 64_000,
						input: ["text", "image"],
					}),
					expect.objectContaining({ id: "new-model", name: "New model" }),
				]);
				expect(JSON.stringify(provider)).not.toContain("stale-model");
			} else {
				const provider = expectRecord(
					expectRecord(readHermesConfigYaml(home).providers, "Hermes providers")["clawdi-managed"],
					"Hermes managed provider",
				);
				expect(provider.models).toEqual({
					"gpt-5.5": {
						context_length: 512_000,
						max_tokens: 64_000,
						supports_vision: true,
					},
					"new-model": {},
				});
			}

			const beforeBaseUrlChange = readSystemdUnitSnapshot(paths);
			nextProvider.baseUrl = "https://replacement.provider.example.test/v1";
			writeFileSync(systemctlLog, "");
			const third = convergeRuntimeManifest(next, paths);
			expect(third.installErrors).toEqual([]);
			const baseUrlActivation = applySystemdRuntimeUpdate(
				paths,
				beforeBaseUrlChange,
				readSystemdUnitSnapshot(paths),
				{},
			);
			expect(baseUrlActivation.userUnitsChanged).toEqual([`${runtimeUnit}.service`]);
			expect(readFileSync(systemctlLog, "utf-8")).toContain(
				`--user restart ${runtimeUnit}.service`,
			);
		},
	);

	it("uses the same native Hermes projection before and after 0.18.0", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.17.0");
		mkdirSync(hermesModelProviderPluginDir(home), { recursive: true });
		writeFileSync(join(hermesModelProviderPluginDir(home), "__init__.py"), "# stale\n");
		const loaded = hostedHermesProviderLoad(home);
		const paths = getRuntimePaths();

		convergeRuntimeManifest(loaded, paths);

		const yamlRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));
		const initialConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(initialConfig).toContain("provider: custom:hermes");
		expect(initialConfig).toMatch(/api: "?https:\/\/hermes-provider\.example\.test\/v1"?/);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);

		writeHermesVersionBinary(home, "0.18.0");
		convergeRuntimeManifest(loaded, paths);

		const currentRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));
		const currentConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(currentConfig).toBe(initialConfig);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);
		expect(currentRevision).toBe(yamlRevision);
	});

	it("preserves non-OpenAI hosted provider protocols in direct agent projection", () => {
		for (const providerCase of [
			{
				id: "anthropic",
				type: "anthropic",
				baseUrl: "https://api.anthropic.com",
				model: "claude-opus-4-6",
				apiMode: "anthropic_messages",
				expectedOpenClawApi: "anthropic-messages",
			},
			{
				id: "gemini",
				type: "gemini",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				model: "gemini-2.5-pro",
				apiMode: "google_generate_content",
				expectedOpenClawApi: "google-generative-ai",
			},
		]) {
			const caseRoot = join(root, `provider-${providerCase.id}`);
			const home = join(caseRoot, "home", "clawdi");
			const state = join(caseRoot, "var", "lib", "clawdi");
			const run = join(caseRoot, "run", "clawdi");
			const openclawBin = join(home, ".local", "bin", "openclaw");
			const { configPath } = writeOpenClawConfigMutationFixture(home);
			mkdirSync(dirname(openclawBin), { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			writeFileSync(openclawBin, "#!/bin/sh\nexit 0\n");
			chmodSync(openclawBin, 0o700);

			const loaded = hostedSingleProviderModeLoad(home, "openclaw", "configured", 1);
			const providers = {
				openclaw: {
					kind: "openai-compatible" as const,
					type: providerCase.type,
					baseUrl: providerCase.baseUrl,
					model: providerCase.model,
					apiMode: providerCase.apiMode,
					runtimeEnvName: `${providerCase.id.toUpperCase()}_API_KEY`,
					apiKeySecretRef: "secret://provider.openclaw.apiKey",
				},
			};
			loaded.manifest.runtimes.openclaw.provider_ids = ["openclaw"];
			loaded.manifest.runtimes.openclaw.primary_model = {
				provider_id: "openclaw",
				model: providerCase.model,
			};
			loaded.manifest.projection = { ...loaded.manifest.projection, providers };
			loaded.manifest.egressProfiles = hostedManifestEgressProfiles({ providers });
			loaded.secretValues = {
				"secret://provider.openclaw.apiKey": `sk-${providerCase.id}`,
			};

			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			expect(convergence.installErrors).toEqual([]);
			const patch = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(patch.models.providers.openclaw.api).toBe(providerCase.expectedOpenClawApi);
			expect(patch.models.providers.openclaw.api).not.toBeUndefined();
		}
	});

	it("keeps provider secrets sidecar-only for hosted runtime manifest responses", async () => {
		setRuntimeApplyGeneration(5, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-runtime-response.json");
		writeOpenClawConfigMutationFixture(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "provider-secret-auth"),
			join(root, "provider-secret-auth", "calls.log"),
		);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_hosted_provider_secret",
					environmentId: "env_hosted_provider_secret",
					...hostedRequiredState(),
					instanceId: "iid_hosted_provider_secret",
					generation: 5,
					issuedAt: "2026-06-15T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime({
							provider_ids: ["clawdi-managed-v2"],
							primary_model: {
								provider_id: "clawdi-managed-v2",
								model: "gpt-5.5",
							},
						}),
					},
					providers: {
						"clawdi-managed-v2": {
							kind: "openai-compatible",
							type: "custom_openai_compatible",
							baseUrl: "https://ai-gateway.example.test/v1",
							models: [{ id: "gpt-5.5" }],
							apiMode: "openai_chat",
							managed_by: "clawdi",
							runtimeEnvName: "CLAWDI_AI_API_KEY",
							apiKeySecretRef: "secret://tool.codex.apiKey",
						},
					},
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
				secretValues: {
					"secret://tool.codex.apiKey": "sk-runtime-provider",
				},
			}),
		);
		setRuntimeApplyGeneration(5, CANONICAL_TEST_CONTEXT);

		const loaded = await loadCanonicalBundleFixture(manifestPath);
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected hosted manifest load success");

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const runConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		expect(runConfig.env.CLAWDI_AI_API_KEY).toBe("clawdi-egress-placeholder");
		expect(runConfig.env.OPENAI_API_KEY).toBeUndefined();
		expect(runConfig.secretEnv).toEqual({
			OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
		});
		expect(runConfig.secretFilePath).toBeNull();
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
		expectExistingFileNotToContain(
			join(run, "secrets", "runtime-secrets.json"),
			"sk-runtime-provider",
		);
		const paths = getRuntimePaths();
		expectEgressProfileBundleUsesSecretRef(
			convergence.outputs.egressProfileBundle,
			"secret://tool.codex.apiKey",
			"sk-runtime-provider",
		);
		expectMitmSecretFileIsSidecarOnly(
			paths,
			convergence.outputs.egressSecretFile,
			"secret://tool.codex.apiKey",
			"sk-runtime-provider",
		);
		expect(existsSync(join(run, "secrets", "runtimes", "openclaw.json"))).toBe(false);
	});

	it("does not project a key-required hosted provider without a secret ref as no-auth", () => {
		delete process.env.OPENCLAW_GATEWAY_TOKEN;
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-provider-patch.json");
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then',
				`  cat > '${openclawPatch}'`,
				"  exit 0",
				"fi",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const fixture = hostedCliManifestResponse(home, TEST_RUNNING_CLI_SPEC);
		fixture.manifest.runtimes = {
			openclaw: hostedOpenClawRuntime({
				provider_ids: ["openclaw"],
				primary_model: { provider_id: "openclaw", model: "claude-opus-4-6" },
			}),
		};
		fixture.manifest.providers = {
			openclaw: {
				kind: "openai-compatible",
				type: "anthropic",
				baseUrl: "https://api.anthropic.com",
				apiMode: "anthropic_messages",
				apiKeyRequired: true,
				status: "error",
				error: {
					code: "provider_secret_unavailable",
					message: "provider secret is unavailable",
				},
			},
		};
		const loaded = parseHostedRuntimeBundleV2(
			{
				schemaVersion: "clawdi.hosted-runtime.bundle.v2",
				sourceRevision: "f".repeat(64),
				manifest: fixture.manifest,
				channelBindings: [],
				secretValues: {
					...TEST_HOSTED_CODEX_SECRET_VALUES,
					...TEST_RUNTIME_SERVICE_SECRET_VALUES,
				},
			},
			"https://runtime-source.test/desired-state",
		);

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const providerHealth = readHostedRuntimeObserved(getRuntimePaths())?.providers?.openclaw;
		expect(providerHealth?.status).toBe("error");
		expect(providerHealth?.reasons).toContain("provider_error");
		expect(providerHealth?.reasons).toContain("provider_secret_unavailable");
		expect(providerHealth?.reasons).toContain("api_key_secret_ref_missing");
	});

	it("loads only the selected hosted runtime entry", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-runtime-selected-entry.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_selected_runtime",
					environmentId: "env_selected_runtime",
					...hostedRequiredState(),
					instanceId: "iid_selected_runtime",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
					},
				},
				secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
			}),
		);
		setRuntimeApplyGeneration(1, CANONICAL_TEST_CONTEXT);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		expect(loaded.manifest.runtimes.openclaw.enabled).toBe(true);
		expect(loaded.manifest.runtimes).not.toHaveProperty("hermes");
	});

	it("rejects hosted-runtime manifests that declare a disabled sibling runtime", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-runtime-disabled-sibling.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_disabled_sibling",
					environmentId: "env_disabled_sibling",
					...hostedRequiredState(),
					instanceId: "iid_disabled_sibling",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
						hermes: hostedHermesRuntime({ enabled: false }),
					},
				},
				secretValues: {},
			}),
		);
		setRuntimeApplyGeneration(1, CANONICAL_TEST_CONTEXT);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain(
			"hosted runtime manifests must declare exactly one selected runtime",
		);
	});

	it("uses the canonical context bearer without mutating the durable token file", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(run, "secrets"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		// Legacy ambient selectors and tokens are deliberately stale. Hosted v2
		// fetch authority comes only from the canonical context.
		process.env.CLAWDI_AUTH_TOKEN = "stale-default-token";
		process.env.CUSTOM_RUNTIME_TOKEN = "stale-selected-token";
		setRuntimeApplyGeneration(1, {
			...CANONICAL_TEST_CONTEXT,
			bootstrapBearer: "context-runtime-token",
		});
		const paths = getRuntimePaths();
		writeFileSync(paths.daemonAuthToken, "stale-file-token\n");
		const fixedTokenTime = new Date("2026-07-30T00:00:00.000Z");
		utimesSync(paths.daemonAuthToken, fixedTokenTime, fixedTokenTime);
		const tokenMtimeBeforeFetch = statSync(paths.daemonAuthToken).mtimeMs;
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "hermes",
							deploymentId: "dep_custom_auth",
							environmentId: "env_custom_auth",
							...hostedRequiredState(),
							instanceId: "iid_custom_auth",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedHermesSystemFixture(home),
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: { hermes: hostedHermesRuntime() },
						},
						secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(paths);
			if (!("manifest" in loaded)) throw new Error(loaded.errors.join("\n"));
			expect(captured[0].headers.authorization).toBe("Bearer context-runtime-token");
			expect(readFileSync(paths.daemonAuthToken, "utf-8")).toBe("stale-file-token\n");
			expect(statSync(paths.daemonAuthToken).mtimeMs).toBe(tokenMtimeBeforeFetch);
		} finally {
			restore();
		}
	});

	it("reuses manifest-managed MCP auth across watch generations and offline rebuild", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const bootstrapToken = "bootstrap-transport-token";
		const runtimeAuthToken = "runtime-business-token";
		mkdirSync(dirname(openclawBin), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "stale-process-token";
		const paths = getRuntimePaths();
		const egressEngine = seedMitmproxyCache(paths);
		const payload = (generation: number): HostedRuntimeResponseFixture => ({
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				runtime: "openclaw",
				deploymentId: "dep_same_token",
				environmentId: "env_same_token",
				...hostedRequiredState(),
				instanceId: "iid_same_token",
				generation,
				issuedAt: `2026-06-06T00:0${generation - 1}:00Z`,
				locale: TEST_HOSTED_LOCALE,
				system: hostedSystemFixture(home),
				controlPlane: { cloudApiUrl: "https://cloud-api.test" },
				egressEngine,
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: TEST_RUNNING_CLI_SPEC,
					registry: "https://registry.npmjs.org",
				},
				runtimes: { openclaw: hostedOpenClawRuntime() },
				mcp: {
					servers: {
						clawdi: {
							url: "https://cloud-api.test/v1/mcp/clawdi",
							transport: "streamable-http",
							headers: {
								Authorization: {
									secretRef: "secret://clawdi/auth-token",
									prefix: "Bearer ",
								},
							},
						},
					},
				},
				liveSync: {
					enabled: true,
					agents: [{ agentType: "openclaw", environmentId: "env_same_token" }],
				},
			},
			secretValues: { "secret://clawdi/auth-token": runtimeAuthToken },
		});
		let manifestFetches = 0;
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => {
					manifestFetches++;
					if (manifestFetches === 1) return hostedRuntimeBundleResponse(payload(1));
					if (manifestFetches === 2) return hostedRuntimeBundleResponse(payload(2));
					throw new Error("control plane unavailable");
				},
			},
		]);

		try {
			setRuntimeApplyGeneration(1, {
				...CANONICAL_TEST_CONTEXT,
				bootstrapBearer: bootstrapToken,
			});
			const initial = await loadRuntimeManifest(paths);
			if (!("manifest" in initial)) throw new Error("expected initial manifest load success");
			const apply = (load: RuntimeManifestLoad) =>
				convergeRuntimeManifest(load, paths, {
					systemdApply: {
						activateEgressPrerequisite: () => ({
							applied: true,
							systemUnitsChanged: [],
							userUnitsChanged: [],
						}),
						activate: () => ({
							applied: true,
							systemUnitsChanged: [],
							userUnitsChanged: [],
						}),
					},
					commitAuthority: (convergence, authority) => {
						if (!load.sourceRevision) throw new Error("expected runtime source revision");
						commitRuntimeAppliedState({
							load,
							paths,
							etag: load.etag ?? `"managed-mcp-${load.manifest.generation}"`,
							sourceRevision: load.sourceRevision,
							convergence,
							applyIdentity: load.applyContext?.identity ?? null,
							activated: authority.activated,
							officialServiceCommandRevisions: authority.officialServiceCommandRevisions,
						});
					},
				});
			const convergence = apply(initial);
			expect(convergence.installErrors).toEqual([]);
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			for (const line of watchEnv.split("\n")) {
				const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(".*")$/);
				if (!match) continue;
				const [, name, encodedValue] = match;
				if (!name || !encodedValue) throw new Error("invalid generated watcher environment");
				const value = JSON.parse(encodedValue) as unknown;
				if (typeof value !== "string")
					throw new Error("invalid generated watcher environment value");
				process.env[name] = value;
			}
			process.env.CLAWDI_RUNTIME_UID = String(process.geteuid?.() ?? process.getuid?.() ?? 0);
			setRuntimeApplyGeneration(2, {
				...CANONICAL_TEST_CONTEXT,
				bootstrapBearer: bootstrapToken,
			});
			const watched = await loadRemoteRuntimeManifest(paths);
			if (!("manifest" in watched) || "notModified" in watched) {
				throw new Error("expected next watcher generation");
			}
			const watchedConvergence = apply(watched);
			expect(watchedConvergence.installErrors).toEqual([]);
			const egressSecretFile = watchedConvergence.outputs.egressSecretFile;
			if (!egressSecretFile) throw new Error("expected managed MCP egress secret file");
			const onlineEgressSecrets = readFileSync(egressSecretFile, "utf-8");

			process.env.CLAWDI_AUTH_TOKEN = "";
			rmSync(egressSecretFile);
			const offline = await loadRuntimeManifest(paths);
			if (!("manifest" in offline)) throw new Error(offline.errors.join("\n"));
			const offlineConvergence = convergeRuntimeManifest(offline, paths, {
				cacheLastGood: false,
			});

			expect(watched.manifest.generation).toBe(2);
			expect(offline.source).toBe("last-good-cache");
			expect(offlineConvergence.mode).toBe("degraded-offline");
			expect(offlineConvergence.installErrors).toEqual([]);
			expect(readFileSync(egressSecretFile, "utf-8")).toBe(onlineEgressSecrets);
			expect(onlineEgressSecrets).toContain(runtimeAuthToken);
			expect(captured.map((entry) => entry.url)).toEqual([
				"https://runtime.test/v1/runtime/manifest",
				"https://runtime.test/v1/runtime/manifest",
				"https://runtime.test/v1/runtime/manifest",
			]);
			expect(captured.map((entry) => entry.headers.authorization)).toEqual([
				`Bearer ${bootstrapToken}`,
				`Bearer ${bootstrapToken}`,
				`Bearer ${bootstrapToken}`,
			]);
			expect(convergence.outputs.daemonAuthTokenFile).toBe(join(run, "secrets", "auth-token"));
			expect(readFileSync(join(run, "secrets", "auth-token"), "utf-8")).toBe(
				`${runtimeAuthToken}\n`,
			);
			expect(statSync(join(run, "secrets", "auth-token")).mode & 0o777).toBe(0o600);
			expect(statSync(egressSecretFile).mode & 0o777).toBe(0o600);
			if (typeof process.getuid === "function" && process.getuid() === 0) {
				expect(statSync(join(run, "secrets", "auth-token")).uid).toBe(0);
				expect(statSync(join(run, "secrets", "auth-token")).gid).toBe(0);
			}
			expect(watchEnv).toContain('CLAWDI_AUTH_TOKEN=""');
			expect(process.env.CLAWDI_AUTH_TOKEN).toBe("");
			expect(watchEnv).not.toContain("CLAWDI_HOST_POLICY_PATH");
			expect(watchEnv).not.toContain("CLAWDI_RUNTIME_SOURCE_PATH");
			expect(watchEnv).not.toContain(runtimeAuthToken);
			for (const unitPath of convergence.outputs.systemdSystemUnits) {
				expect(readFileSync(unitPath, "utf-8")).not.toContain(runtimeAuthToken);
			}
			for (const entry of readdirSync(paths.systemdEnvRoot)) {
				expect(readFileSync(join(paths.systemdEnvRoot, entry), "utf-8")).not.toContain(
					runtimeAuthToken,
				);
			}
			expect(readFileSync(paths.appliedState, "utf-8")).not.toContain(runtimeAuthToken);
			expect(JSON.stringify(convergence)).not.toContain(runtimeAuthToken);
			expect(JSON.stringify(watchedConvergence)).not.toContain(runtimeAuthToken);
		} finally {
			restore();
		}
	});

	it("loads remote manifests with If-None-Match and the canonical context bearer", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "";
		const currentEtag = testBundleEtag("etag-current");
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					new Response(null, {
						status: 304,
						headers: { etag: currentEtag },
					}),
			},
		]);

		try {
			const loaded = await loadRemoteRuntimeManifest(getRuntimePaths(), {
				ifNoneMatch: currentEtag,
			});

			expect("notModified" in loaded).toBe(true);
			if (!("notModified" in loaded)) throw new Error("expected 304 manifest load");
			expect(loaded.etag).toBe(currentEtag);
			expect(captured).toHaveLength(1);
			expect(captured[0].headers.authorization).toBe("Bearer test-runtime-bootstrap-token");
			expect(captured[0].headers["if-none-match"]).toBe(currentEtag);
		} finally {
			restore();
		}
	});

	it("fails closed instead of selecting a historical duplicate runtime account", () => {
		for (const runtime of ["openclaw", "hermes"] as const) {
			for (const provider of ["telegram", "discord"] as const) {
				const firstAccount = "clawdi_00000000000000000000000000000001";
				const secondAccount = "clawdi_00000000000000000000000000000002";
				const agentRef = (account: string) =>
					`secret://channels/${provider}/${account}/agent-token`;
				const placeholderRef = (account: string) =>
					`secret://channels/${provider}/${account}/placeholder-token`;
				const bindings: RuntimeBundleChannelBinding[] = [firstAccount, secondAccount].map(
					(accountKey) => ({
						provider,
						accountKey,
						agentTokenSecretRef: agentRef(accountKey),
						placeholderTokenSecretRef: placeholderRef(accountKey),
					}),
				);
				const loaded: RuntimeManifestLoad = {
					manifest: {
						schemaVersion: "clawdi.runtimeDesiredState.v1",
						deploymentId: `dep_duplicate_${runtime}_${provider}`,
						environmentId: `env_duplicate_${runtime}_${provider}`,
						instanceId: `iid_duplicate_${runtime}_${provider}`,
						generation: 1,
						issuedAt: "2026-07-30T00:00:00Z",
						controlPlane: { apiUrl: "https://cloud-api.test" },
						runtimes: { [runtime]: { enabled: true } },
					},
					source: "remote-datasource",
					sourcePath: "https://cloud-api.test/v1/runtime/manifest",
					channelBindings: bindings,
					secretValues: Object.fromEntries(
						bindings.flatMap((binding, index) => [
							[binding.agentTokenSecretRef, `agent-token-${index}`],
							[binding.placeholderTokenSecretRef, `99999999${index}:${"a".repeat(32)}`],
						]),
					),
				};
				const label = provider === "telegram" ? "Telegram" : "Discord";

				expect(() => applyRuntimeBundleChannelsToManifestLoad(loaded)).toThrow(
					`This Agent has multiple active ${label} bots. Unlink the extras until only one remains.`,
				);
			}
		}
	});

	it("reconciles environment-scoped hosted bundle channel create, rotation, and removal", () => {
		const accountKey = "clawdi_00000000000000000000000000000001";
		const agentRef = `secret://channels/telegram/${accountKey}/agent-token`;
		const placeholderRef = `secret://channels/telegram/${accountKey}/placeholder-token`;
		const placeholder = "999999999:0123456789abcdef0123456789abcdef";
		const base: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_bundle_channel",
				environmentId: "env_bundle_channel",
				instanceId: "iid_bundle_channel",
				generation: 1,
				issuedAt: "2026-07-30T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: { openclaw: { enabled: true }, hermes: { enabled: false } },
			},
			source: "remote-datasource",
			sourcePath: "https://cloud-api.test/v1/runtime/manifest",
			offline: false,
		};
		const binding: RuntimeBundleChannelBinding = {
			provider: "telegram",
			accountKey,
			agentTokenSecretRef: agentRef,
			placeholderTokenSecretRef: placeholderRef,
		};
		const active = applyRuntimeBundleChannelsToManifestLoad({
			...base,
			channelBindings: [binding],
			secretValues: { [agentRef]: "agent-token-v1", [placeholderRef]: placeholder },
			sourceRevision: "a".repeat(64),
		});
		const rotated = applyRuntimeBundleChannelsToManifestLoad({
			...base,
			channelBindings: [binding],
			secretValues: { [agentRef]: "agent-token-v2", [placeholderRef]: placeholder },
			sourceRevision: "b".repeat(64),
		});
		const removed = applyRuntimeBundleChannelsToManifestLoad({
			...base,
			channelBindings: [],
			secretValues: {},
			sourceRevision: "c".repeat(64),
		});

		expect(active.manifest.projection?.channels).toMatchObject({
			telegram: { defaultAccount: accountKey, accounts: { [accountKey]: { enabled: true } } },
		});
		expect(active.manifest.egressProfiles?.profiles).toHaveLength(2);
		expect(JSON.stringify(active.manifest)).not.toContain("agent-token-v1");
		expect(JSON.stringify(active)).not.toContain("provider-token");
		expect(rotated.sourceRevision).toBe("b".repeat(64));
		expect(rotated.secretValues?.[agentRef]).toBe("agent-token-v2");
		expect(removed.manifest.projection?.channels).toEqual({});
		expect(removed.manifest.egressProfiles?.profiles).toEqual([]);
		expect(removed.manifest.runtimes.openclaw?.run?.secretEnv ?? {}).toEqual({});
		expect(removed.secretValues).toEqual({});
	});

	it("removes stale channel-driven egress profiles when runtime channels are disabled", () => {
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "openclaw",
				deploymentId: "dep_stale_channels",
				environmentId: "env_stale_channels",
				instanceId: "iid_stale_channels",
				generation: 4,
				issuedAt: "2026-06-14T00:00:00Z",
				system: { home: "/home/clawdi", workspace: "/home/clawdi" },
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: { enabled: true },
				},
				egressProfiles: {
					profiles: [
						{
							id: "native-discord-clawdi_acct1-gateway-passthrough",
							enabled: true,
							kind: "passthrough",
							match: {
								scheme: "wss",
								host: "gateway.discord.gg",
								pathPrefix: "/",
								headers: {},
								query: {},
							},
							logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
							priority: 201,
							owner: "clawdi-native-channels",
						},
						{
							id: "explicit-provider-profile",
							enabled: true,
							kind: "passthrough",
							match: {
								scheme: "https",
								host: "api.openai.com",
								pathPrefix: "/",
								headers: {},
								query: {},
							},
							logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
							priority: 250,
						},
					],
				},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
			secretValues: { "secret://provider.default.apiKey": "sk-provider" },
			channelBindings: [],
		};

		const projected = applyRuntimeBundleChannelsToManifestLoad(loaded);

		expect(projected.manifest.egressProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"explicit-provider-profile",
		]);
	});

	it("keeps managed channels separate from provider projection profiles", () => {
		const accountKey = "clawdi_accttelegram";
		const agentTokenSecretRef = `secret://channels/telegram/${accountKey}/agent-token`;
		const placeholderTokenSecretRef = `secret://channels/telegram/${accountKey}/placeholder-token`;
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_channel_provider",
				environmentId: "env_channel_provider",
				instanceId: "iid_channel_provider",
				generation: 3,
				issuedAt: "2026-06-14T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: { enabled: true },
					hermes: { enabled: false },
				},
				projection: {
					providers: {
						openclaw: {
							baseUrl: "https://openclaw-provider.example.test/v1",
							apiMode: "openai_chat",
							apiKeySecretRef: "secret://provider.openclaw.apiKey",
						},
						hermes: {
							baseUrl: "https://hermes-provider.example.test/v1",
							apiMode: "openai_responses",
							apiKeySecretRef: "secret://provider.hermes.apiKey",
						},
					},
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
			secretValues: {
				"secret://provider.openclaw.apiKey": "sk-openclaw-provider",
				"secret://provider.hermes.apiKey": "sk-hermes-provider",
				[agentTokenSecretRef]: "agent-token-runtime",
				[placeholderTokenSecretRef]: "999999999:0123456789abcdef0123456789abcdef",
			},
			channelBindings: [
				{
					provider: "telegram",
					accountKey,
					agentTokenSecretRef,
					placeholderTokenSecretRef,
				},
			],
		};

		const projected = applyRuntimeBundleChannelsToManifestLoad(loaded);

		expect(projected.manifest.egressProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"native-telegram-clawdi_accttelegram-managed",
			"native-telegram-clawdi_accttelegram-file-managed",
		]);
	});

	it("runtime watch reconciles changed runtime and egress units without restarting itself", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl-locale.log");
		const systemctlStateRoot = join(root, "systemctl-locale-state");
		const sidecarReadyPath = join(run, "egress", "systemd", "ca.pem");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			sidecarReadyPath,
		});
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
		const baselineUnits = readSystemdUnitSnapshot(paths);
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, baselineUnits);
		for (const unit of baselineUnits.user.keys()) {
			writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
		}
		let resolveInitialWatchEvent: (() => void) | null = null;
		const initialWatchEvent = new Promise<void>((resolveEvent) => {
			resolveInitialWatchEvent = resolveEvent;
		});
		console.log = (value?: unknown) => {
			logs.push(String(value));
			if (logs.length === 1) resolveInitialWatchEvent?.();
		};
		let manifestCalls = 0;
		let manifestRequestsBeforeOwnSignal = 0;
		let resolveInitialManifestRequest: (() => void) | null = null;
		const initialManifestRequest = new Promise<void>((resolveRequest) => {
			resolveInitialManifestRequest = resolveRequest;
		});
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => {
					manifestCalls += 1;
					if (manifestCalls === 1) {
						resolveInitialManifestRequest?.();
						return new Response(null, {
							status: 304,
							headers: { etag: testBundleEtag("manifest-locale-1") },
						});
					}
					setTimeout(() => abort.abort(), 25);
					const payload = hostedRuntimeWatchLocalePayload(home, 2);
					payload.manifest.egressProfiles = hostedManifestEgressProfiles({
						providers: {},
						terminalTooling: TEST_HOSTED_CODEX_TERMINAL_TOOLING,
					});
					payload.secretValues = { [TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool-rotated" };
					return hostedRuntimeBundleResponse(payload, {
						etag: testBundleEtag("manifest-locale-2"),
					});
				},
			},
		]);

		try {
			await runtimeWatch({
				intervalMs: 20,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					await options.onEvent({
						type: "runtime_manifest_changed",
						environment_id: "env_other",
					});
					await initialManifestRequest;
					await initialWatchEvent;
					manifestRequestsBeforeOwnSignal = captured.filter(
						(request) => request.path === "/v1/runtime/manifest",
					).length;
					setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
					await options.onEvent({
						type: "runtime_manifest_changed",
						environment_id: "env_watch_locale",
					});
					await new Promise<void>((resolveDone) => {
						if (options.abort.aborted) return resolveDone();
						options.abort.addEventListener("abort", () => resolveDone(), { once: true });
					});
				},
			});

			expect(manifestRequestsBeforeOwnSignal).toBe(1);
			expect(manifestCalls).toBe(2);
			const events = logs.map((line) => JSON.parse(line));
			expect(events[0]).toMatchObject({ status: "not_modified" });
			expect(events[1]).toMatchObject({ status: "applied" });
			expect(events[0].generation).toBe(1);
			expect(events[0].instanceId).toBe("iid_watch_locale");
			expect(events[1].etag).toBe(testBundleEtag("manifest-locale-2"));
			expect(
				captured.filter((request) => request.path === "/v1/runtime/manifest")[1].headers[
					"if-none-match"
				],
			).toBe(testBundleEtag("manifest-locale-1"));
			const systemctlCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			expect(systemctlCalls).toContain("--user restart openclaw-gateway.service");
			expect(systemctlCalls.some((call) => call.includes("enable --now"))).toBe(false);
			expect(systemctlCalls).toContain("restart clawdi-runtime-sidecar.service");
			expect(systemctlCalls).not.toContain("restart clawdi-daemon.service");
			expect(systemctlCalls.some((call) => call.includes("restart clawdi-runtime-watch"))).toBe(
				false,
			);
			expect(systemctlCalls.some((call) => call.includes("stop clawdi-runtime-watch"))).toBe(false);
			const watchStatus = JSON.parse(readFileSync(getRuntimePaths().runtimeWatchStatus, "utf-8"));
			expect(watchStatus.event.generation).toBe(2);
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it("reapplies an invalidated user unit when its rendered snapshot is unchanged", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl-invalidation.log");
		const systemctlStateRoot = join(root, "systemctl-invalidation-state");
		const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
		const snapshot = readSystemdUnitSnapshot(paths);
		const unit = "openclaw-gateway.service";

		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
		});
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, snapshot);
		writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "failed"), "\n");
		writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "reload"), "\n");
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");

		const activation = applySystemdRuntimeUpdate(paths, snapshot, snapshot, {
			recoverFailedUnits: false,
			invalidatedUserUnits: [unit],
		});

		expect(activation).toMatchObject({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: [unit],
		});
		const calls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
		expect(calls).toContain("--user daemon-reload");
		expect(calls).toContain(`--user reset-failed ${unit}`);
		expect(calls).toContain(`--user start ${unit}`);
	});

	it("reloads manager state changed before the apply snapshot without restarting active services", () => {
		const paths = seedRuntimeWatchLocaleBaseline(
			join(root, "home", "clawdi"),
			join(root, "var", "lib", "clawdi"),
			join(root, "run", "clawdi"),
		);
		const snapshot = readSystemdUnitSnapshot(paths);
		const logPath = join(root, "systemctl-reload.log");
		const stateRoot = join(root, "systemctl-reload-state");
		const command = join(root, "bin", "systemctl");
		writeFakeSystemdManager({ path: command, logPath, stateRoot });
		seedFakeSystemdSnapshotProcesses(paths, stateRoot, snapshot);
		for (const [scope, unit] of [
			["system", "clawdi-runtime-sidecar.service"],
			["user", "openclaw-gateway.service"],
		] as const) {
			writeFileSync(fakeSystemdStatePath(stateRoot, scope, unit, "reload"), "\n");
		}
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = command;

		expect(applySystemdRuntimeUpdate(paths, snapshot, snapshot, {})).toMatchObject({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: [],
		});
		const calls = readFileSync(logPath, "utf8").trim().split("\n");
		expect(calls).toContain("daemon-reload");
		expect(calls).toContain("--user daemon-reload");
		expect(calls.some((call) => /\b(?:start|restart|stop)\b/.test(call))).toBe(false);
	});

	it("runtime watch keeps polling after SSE authentication failure", async () => {
		installSuccessfulSystemctlFixture();
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		seedRuntimeWatchLocaleBaseline(home, state, run);
		let resolveInitialWatchEvent: (() => void) | null = null;
		const initialWatchEvent = new Promise<void>((resolveEvent) => {
			resolveInitialWatchEvent = resolveEvent;
		});
		console.log = (value?: unknown) => {
			logs.push(String(value));
			if (logs.length === 1) resolveInitialWatchEvent?.();
		};
		let manifestCalls = 0;
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => {
					manifestCalls += 1;
					if (manifestCalls === 1) return new Response(null, { status: 304 });
					setTimeout(() => abort.abort(), 0);
					return hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, 2), {
						etag: testBundleEtag("manifest-locale-2"),
					});
				},
			},
		]);

		try {
			await runtimeWatch({
				intervalMs: 20,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					await initialWatchEvent;
					setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
					options.onAuthFailure?.();
				},
			});

			expect(manifestCalls).toBe(2);
			const events = logs.map((line) => JSON.parse(line));
			expect(events[0]).toMatchObject({ status: "not_modified" });
			expect(events[1]).toMatchObject({ status: "applied" });
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it.each(["authentication failure", "task completion"])(
		"runtime watch re-subscribes after SSE %s with unchanged connection identity",
		async (completionMode) => {
			installSuccessfulSystemctlFixture();
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			const run = join(root, "run", "clawdi");
			const abort = new AbortController();
			const previousLog = console.log;
			const logs: string[] = [];
			seedRuntimeWatchLocaleBaseline(home, state, run);
			let resolveInitialWatchEvent: (() => void) | null = null;
			const initialWatchEvent = new Promise<void>((resolveEvent) => {
				resolveInitialWatchEvent = resolveEvent;
			});
			console.log = (value?: unknown) => {
				logs.push(String(value));
				if (logs.length === 1) resolveInitialWatchEvent?.();
			};
			let manifestCalls = 0;
			let subscriptionCalls = 0;
			let resolveInitialManifestRequest: (() => void) | null = null;
			const initialManifestRequest = new Promise<void>((resolveRequest) => {
				resolveInitialManifestRequest = resolveRequest;
			});
			const { restore } = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () => {
						manifestCalls += 1;
						if (manifestCalls === 1) {
							resolveInitialManifestRequest?.();
							return new Response(null, { status: 304 });
						}
						setTimeout(() => abort.abort(), 0);
						return hostedRuntimeBundleResponse(
							{
								...hostedRuntimeWatchLocalePayload(home, 2),
								secretValues: { [TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool-rotated" },
							},
							{ etag: testBundleEtag("manifest-locale-2") },
						);
					},
				},
			]);
			const timeout = setTimeout(() => abort.abort(), 500);

			try {
				await runtimeWatch({
					intervalMs: 20,
					selfHealMs: 300_000,
					json: true,
					abort: abort.signal,
					notificationConsumer: async (options) => {
						subscriptionCalls += 1;
						if (subscriptionCalls === 1) {
							await initialWatchEvent;
							setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
							if (completionMode === "authentication failure") options.onAuthFailure?.();
							return;
						}
						await initialManifestRequest;
						await initialWatchEvent;
						await options.onEvent({
							type: "runtime_manifest_changed",
							environment_id: "env_watch_locale",
						});
						await new Promise<void>((resolveDone) => {
							if (options.abort.aborted) return resolveDone();
							options.abort.addEventListener("abort", () => resolveDone(), { once: true });
						});
					},
				});

				expect(subscriptionCalls).toBe(2);
				expect(manifestCalls).toBe(3);
				expect(logs.map((line) => JSON.parse(line).status)).toEqual([
					"not_modified",
					"applied",
					"applied",
				]);
			} finally {
				clearTimeout(timeout);
				restore();
				console.log = previousLog;
			}
		},
	);

	it("runtime watch probes a failed ETag without reconverging and applies a new ETag", async () => {
		installSuccessfulSystemctlFixture();
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
		setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
		const badEtag = testBundleEtag("manifest-locale-bad-2");
		const goodEtag = testBundleEtag("manifest-locale-good-2");
		const badPayload = hostedRuntimeWatchLocalePayload(home, 2);
		let manifestCalls = 0;
		let deferredEvent: unknown = null;
		const sameEtagProbeStarted = Promise.withResolvers<void>();
		const releaseSameEtagProbe = Promise.withResolvers<void>();
		const recoveryProbeStarted = Promise.withResolvers<void>();
		const releaseRecoveryProbe = Promise.withResolvers<void>();
		console.log = (value?: unknown) => {
			const line = String(value);
			logs.push(line);
			const event = JSON.parse(line);
			if (event.status === "applied") abort.abort();
		};
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: async () => {
					manifestCalls += 1;
					if (manifestCalls === 1) {
						return hostedRuntimeBundleResponse(badPayload, {
							etag: badEtag,
							includeRuntimeServiceSecrets: false,
						});
					}
					if (manifestCalls === 2) {
						sameEtagProbeStarted.resolve();
						await releaseSameEtagProbe.promise;
						return hostedRuntimeBundleResponse(badPayload, {
							etag: badEtag,
							includeRuntimeServiceSecrets: false,
						});
					}
					recoveryProbeStarted.resolve();
					await releaseRecoveryProbe.promise;
					return hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, 2), {
						etag: goodEtag,
					});
				},
			},
		]);

		try {
			await runtimeWatch({
				intervalMs: 20,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					await sameEtagProbeStarted.promise;
					await options.onEvent({
						type: "runtime_manifest_changed",
						environment_id: "env_watch_locale",
					});
					releaseSameEtagProbe.resolve();
					await recoveryProbeStarted.promise;
					deferredEvent = JSON.parse(readFileSync(paths.runtimeWatchStatus, "utf-8")).event;
					releaseRecoveryProbe.resolve();
					await new Promise<void>((resolveDone) => {
						if (options.abort.aborted) return resolveDone();
						options.abort.addEventListener("abort", () => resolveDone(), { once: true });
					});
				},
			});

			expect(captured.map((request) => request.headers["if-none-match"] ?? null)).toEqual([
				testBundleEtag("manifest-locale-1"),
				badEtag,
				badEtag,
			]);
			const events = logs.map((line) => JSON.parse(line));
			expect(events).toHaveLength(2);
			expect(events[0].error).toContain(
				"Runtime secret secret://runtime/openclaw/gateway-token is unavailable.",
			);
			expect(events[1]).toMatchObject({ status: "applied", etag: goodEtag });
			expect(deferredEvent).toEqual(events[0]);
			expect(readRuntimeAppliedState(paths)).toMatchObject({ generation: 2, etag: goodEtag });
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it("runtime watch keeps no-ETag failures deferred across SSE notifications", async () => {
		installSuccessfulSystemctlFixture();
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
		setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
		const failure = Promise.withResolvers<void>();
		let subscriptionCalls = 0;
		console.log = (value?: unknown) => {
			const line = String(value);
			logs.push(line);
			failure.resolve();
		};
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => new Response("temporary failure", { status: 503 }),
			},
		]);

		try {
			await runtimeWatch({
				intervalMs: 20,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					subscriptionCalls += 1;
					if (subscriptionCalls === 2) {
						abort.abort();
						return;
					}
					await failure.promise;
					await options.onEvent({
						type: "runtime_manifest_changed",
						environment_id: "env_watch_locale",
					});
				},
			});

			expect(subscriptionCalls).toBe(2);
			expect(captured).toHaveLength(1);
			expect(logs).toHaveLength(1);
			const originalError = JSON.parse(logs[0]);
			expect(originalError).toMatchObject({ status: "error", stage: "network" });
			expect(JSON.parse(readFileSync(paths.runtimeWatchStatus, "utf-8")).event).toEqual(
				originalError,
			);
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it("runtime watch receives the gateway token and applies a live channel binding", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawUnit = join(home, ".config", "systemd", "user", "openclaw-gateway.service");
		const openclawPatch = join(root, "openclaw-watch-channel-patch.jsonl");
		const sidecarReadyPath = join(run, "egress", "systemd", "ca.pem");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		writeOpenClawConfigMutationFixture(home);
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
  printf '[{"id":"main","workspace":"${join(home, ".openclaw", "workspace")}"}]\\n'
  exit 0
fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >> '${openclawPatch}'
  printf '\\n' >> '${openclawPatch}'
  exit 0
fi
if [ "$*" = "gateway install --force --json" ]; then
  mkdir -p '${dirname(openclawUnit)}'
  printf '%s\\n' '[Unit]' '[Service]' 'ExecStart=${openclawBin} gateway run' > '${openclawUnit}'
  printf '{"ok":true}\\n'
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
		);
		chmodSync(openclawBin, 0o700);
		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: join(root, "systemctl-watch-channel.log"),
			stateRoot: join(root, "systemctl-watch-channel-state"),
			sidecarReadyPath,
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		setRuntimeApplyContextFixture(
			{
				generation: 12,
				manifestETag: '"etag-watch-12"',
				applyReceiptId: "apply-receipt-0012",
				bootNonce: "boot-nonce-000012",
			},
			CANONICAL_TEST_CONTEXT,
		);
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		seedMitmproxyCache();
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					new Response(
						JSON.stringify({
							schemaVersion: "clawdi.hosted-runtime.bundle.v2",
							sourceRevision: "a".repeat(64),
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_watch",
								environmentId: "env_watch",
								...hostedRequiredState(),
								instanceId: "iid_watch",
								generation: 12,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: TEST_RUNNING_CLI_SPEC,
									registry: "https://registry.npmjs.org",
								},
								egressProfiles: { profiles: [] },
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
								providers: {
									default: {
										kind: "openai-compatible",
										type: "custom_openai_compatible",
										baseUrl: "https://provider.test/v1",
										models: [{ id: "gpt-test" }],
										apiMode: "openai_chat",
										apiKeySecretRef: "secret://provider.default.apiKey",
										apiKeyRequired: true,
									},
								},
							},
							channelBindings: [
								{
									provider: "telegram",
									accountKey: "clawdi_accttelegram",
									agentTokenSecretRef: "secret://channels/telegram/clawdi_accttelegram/agent-token",
									placeholderTokenSecretRef:
										"secret://channels/telegram/clawdi_accttelegram/placeholder-token",
								},
							],
							secretValues: {
								"secret://clawdi/auth-token": "file-runtime-token",
								"secret://runtime/openclaw/gateway-token": "gateway-token-watch",
								[TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool",
								"secret://provider.default.apiKey": "sk-provider-watch",
								"secret://channels/telegram/clawdi_accttelegram/agent-token":
									"telegram-agent-token-watch",
								"secret://channels/telegram/clawdi_accttelegram/placeholder-token":
									"999999999:00000000000000000000000000000000",
							},
						}),
						{
							status: 200,
							headers: {
								"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
								etag: `"sha256:${"a".repeat(64)}"`,
							},
						},
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });
			expect(process.exitCode).toBe(1);
			expect(readRuntimeAppliedState(getRuntimePaths())).toBeNull();
			const rejected = JSON.parse(logs.at(-1) ?? "{}");
			expect(rejected.status).toBe("error");
			expect(rejected.error).toContain(
				"transparent-egress system prerequisites did not reach readiness",
			);

			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(captured).toHaveLength(2);
			expect(captured[0].headers.authorization).toBe("Bearer file-runtime-token");
			expect(captured[0].headers.accept).toBe(HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE);
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
			const appliedState = readRuntimeAppliedState(getRuntimePaths());
			expect(appliedState).toMatchObject({
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				instanceId: "iid_watch",
				etag: `"sha256:${"a".repeat(64)}"`,
				sourceRevision: "a".repeat(64),
				generation: 12,
				manifestETag: '"etag-watch-12"',
				applyReceiptId: "apply-receipt-0012",
				bootNonce: "boot-nonce-000012",
				providerIds: ["default"],
			});
			const event = JSON.parse(logs.at(-1) ?? "{}");
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(12);
			expect(event.etag).toBe(`"sha256:${"a".repeat(64)}"`);
			expect(event.convergence.appliedState).toBe(getRuntimePaths().appliedState);
			expect(event.systemdUnitsChanged).toBe(true);
			expect(event.systemdApply).toEqual({
				applied: true,
				systemUnitsChanged: ["clawdi-daemon.service", "clawdi-runtime-sidecar.service"],
				userUnitsChanged: ["openclaw-gateway.service"],
			});
			const watchStatus = JSON.parse(readFileSync(getRuntimePaths().runtimeWatchStatus, "utf-8"));
			expect(watchStatus.event.status).toBe("applied");
			const observed = readHostedRuntimeObserved(getRuntimePaths());
			expect(observed?.status).toBe("ok");
			expect(observed?.applied).toMatchObject({
				etag: `"sha256:${"a".repeat(64)}"`,
				sourceRevision: "a".repeat(64),
				generation: 12,
				appliedProviderIds: ["default"],
			});
			const paths = getRuntimePaths();
			expect(readSystemdSystemUnit(paths, "clawdi-runtime-watch")).toContain(
				`ExecStart="${paths.cliManagedBin}" "runtime" "watch"`,
			);
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			const daemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			const gatewayEnv = readSystemdEnvFile(paths, "openclaw-gateway");
			expect(watchEnv).not.toContain("gateway-token-watch");
			expect(watchEnv).not.toContain("OPENCLAW_GATEWAY_TOKEN");
			expect(gatewayEnv).not.toContain("OPENCLAW_GATEWAY_TOKEN");
			expect(gatewayEnv).not.toContain("gateway-token-watch");
			expect(watchEnv).not.toContain("file-runtime-token");
			const patchText = readFileSync(openclawPatch, "utf-8");
			expect(patchText).toContain('"telegram"');
			expect(patchText).toContain('"botToken"');
			expect(patchText).toContain(
				'"id": "CLAWDI_CHANNEL_TELEGRAM_CLAWDI_ACCTTELEGRAM_AGENT_TOKEN"',
			);
			expect(patchText).not.toContain("telegram-agent-token-watch");
			for (const unitEnv of [watchEnv, daemonEnv]) {
				expect(unitEnv).not.toContain("CLAWDI_RUNTIME_APPLY_IDENTITY_FILE");
				expect(unitEnv).not.toContain("CLAWDI_RUNTIME_GENERATION");
				expect(unitEnv).not.toContain("CLAWDI_RUNTIME_APPLY_RECEIPT_ID");
			}
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("runtime watch advances applied generation on a generation-only manifest update", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const systemctlPath = join(root, "bin", "systemctl");
		const systemctlLog = join(root, "systemctl.log");
		const openclawConfig = join(home, ".openclaw", "openclaw.json");
		const sidecarReadyPath = join(run, "egress", "systemd", "ca.pem");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousUmask = process.umask(0o022);
		const logs: string[] = [];
		let generation = 30;
		let manifestEtag = testBundleEtag("manifest-generation-30");
		let daemonToken = "file-runtime-token";
		let gatewayToken: string | undefined = "test-openclaw-gateway-token";
		mkdirSync(join(run, "secrets"), { recursive: true });
		writeFakeSystemdManager({
			path: systemctlPath,
			logPath: systemctlLog,
			stateRoot: join(root, "systemctl-generation-state"),
			sidecarReadyPath,
		});
		seedOfficialOpenClawServiceInstaller(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		setRuntimeApplyContextFixture(
			{
				generation,
				manifestETag: manifestEtag,
				applyReceiptId: "apply-receipt-generation-0030",
				bootNonce: "boot-nonce-generation-0001",
			},
			CANONICAL_TEST_CONTEXT,
		);
		const watchFetch = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: (request) => {
					if (request.headers["if-none-match"]) {
						return new Response(null, { status: 304, headers: { etag: manifestEtag } });
					}
					const payload = hostedRuntimeWatchLocalePayload(home, generation);
					return hostedRuntimeBundleResponse(
						{
							...payload,
							secretValues: {
								...payload.secretValues,
								"secret://clawdi/auth-token": daemonToken,
								...(gatewayToken
									? { "secret://runtime/openclaw/gateway-token": gatewayToken }
									: {}),
							},
						},
						{ etag: manifestEtag, includeRuntimeServiceSecrets: false },
					);
				},
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });
			const paths = getRuntimePaths();
			const initialAppliedState = readRuntimeAppliedState(paths);
			if (!initialAppliedState) throw new Error(logs.join("\n"));
			expect(initialAppliedState).toMatchObject({
				etag: testBundleEtag("manifest-generation-30"),
				generation: 30,
			});
			const initialDaemonActivation = initialAppliedState.activated["clawdi-daemon.service"];
			expect(initialDaemonActivation).toMatch(/^[a-f0-9]{64}$/);
			expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
				gatewayToken,
			);
			const initialDaemonUnit = readSystemdSystemUnit(paths, "clawdi-daemon");
			const initialDaemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			const requestsBeforeMatchingTuple = watchFetch.captured.length;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(watchFetch.captured.slice(requestsBeforeMatchingTuple)).toHaveLength(1);
			expect(watchFetch.captured.at(-1)?.headers["if-none-match"]).toBe(manifestEtag);
			expect(JSON.parse(logs.at(-1) ?? "{}").status).toBe("not_modified");
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");

			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0030-refreshed",
					bootNonce: "boot-nonce-generation-0002",
				},
				CANONICAL_TEST_CONTEXT,
			);
			const requestsBeforeTupleRefresh = watchFetch.captured.length;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(watchFetch.captured.slice(requestsBeforeTupleRefresh)).toHaveLength(2);
			expect(
				watchFetch.captured
					.slice(requestsBeforeTupleRefresh)
					.map((request) => request.headers["if-none-match"] ?? null),
			).toEqual([manifestEtag, null]);
			expect(readRuntimeAppliedState(paths)).toMatchObject({
				generation: 30,
				manifestETag: manifestEtag,
				applyReceiptId: "apply-receipt-generation-0030-refreshed",
				bootNonce: "boot-nonce-generation-0002",
			});
			expect(readFileSync(systemctlLog, "utf-8")).not.toMatch(
				/(?:^|\s)(?:daemon-reload|start|restart|stop|enable|disable|reset-failed)(?:\s|$)/m,
			);

			const committedBeforeMismatchedGeneration = readFileSync(paths.appliedState, "utf-8");
			writeFileSync(systemctlLog, "");
			setRuntimeApplyContextFixture(
				{
					generation: 31,
					manifestETag: '"hosted-control-plane-generation-31"',
					applyReceiptId: "apply-receipt-generation-0031",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({
				status: "error",
				mode: "manifest-rejected",
			});
			expect(JSON.parse(logs.at(-1) ?? "{}").error).toContain(
				"runtime apply identity generation 31 does not match resolved manifest apply generation 30",
			);
			expect(readFileSync(paths.appliedState, "utf-8")).toBe(committedBeforeMismatchedGeneration);
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");

			generation = 31;
			manifestEtag = testBundleEtag("manifest-generation-31");
			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: '"hosted-control-plane-generation-31"',
					applyReceiptId: "apply-receipt-generation-0031",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });
			expect(process.exitCode ?? 0).toBe(0);
			expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({
				status: "applied",
				generation: 31,
				etag: testBundleEtag("manifest-generation-31"),
			});
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				etag: testBundleEtag("manifest-generation-31"),
				generation: 31,
				manifestETag: '"hosted-control-plane-generation-31"',
				applyReceiptId: "apply-receipt-generation-0031",
				bootNonce: "boot-nonce-generation-0001",
			});

			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0031",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			const event = JSON.parse(logs.at(-1) ?? "{}");
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(31);
			expect(event.etag).toBe(manifestEtag);
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				etag: testBundleEtag("manifest-generation-31"),
				generation: 31,
				manifestETag: manifestEtag,
				applyReceiptId: "apply-receipt-generation-0031",
				bootNonce: "boot-nonce-generation-0001",
			});
			expect(watchFetch.captured).toHaveLength(10);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"--user restart openclaw-gateway.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain("restart clawdi-daemon.service");
			const committedBeforeTokenRotation = readFileSync(paths.appliedState, "utf-8");

			writeFileSync(systemctlLog, "");
			process.env.CLAWDI_AUTH_TOKEN = "stale-process-auth-token";
			process.env.STALE_RUNTIME_AUTH_TOKEN = "stale-selected-auth-token";
			process.env.OPENCLAW_GATEWAY_TOKEN = "stale-process-gateway-token";
			generation = 32;
			manifestEtag = testBundleEtag("manifest-generation-32");
			daemonToken = "rotated-runtime-auth-token";
			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0032",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			const rotatedAppliedState = readRuntimeAppliedState(paths);
			expect(rotatedAppliedState).toMatchObject({
				generation: 32,
				manifestETag: manifestEtag,
				bootNonce: "boot-nonce-generation-0001",
			});
			const rotatedDaemonActivation = rotatedAppliedState?.activated["clawdi-daemon.service"];
			expect(rotatedDaemonActivation).toMatch(/^[a-f0-9]{64}$/);
			expect(rotatedDaemonActivation).not.toBe(initialDaemonActivation);
			expect(watchFetch.captured.at(-1)?.headers.authorization).toBe("Bearer file-runtime-token");
			expect(readFileSync(join(run, "secrets", "auth-token"), "utf-8")).toBe(
				"rotated-runtime-auth-token\n",
			);
			expect(readFileSync(systemctlLog, "utf-8")).toContain("restart clawdi-daemon.service");
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"--user restart openclaw-gateway.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"restart clawdi-runtime-sidecar.service",
			);
			expect(readSystemdSystemUnit(paths, "clawdi-daemon")).toBe(initialDaemonUnit);
			const rotatedDaemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			expect(rotatedDaemonEnv).not.toBe(initialDaemonEnv);
			expect(rotatedDaemonEnv).not.toContain("rotated-runtime-auth-token");
			expect(rotatedDaemonEnv).toMatch(/^CLAWDI_MANAGED_CONTENT_DIGEST="[a-f0-9]{32}"$/m);

			// Simulate a crash after the desired token file and rendered environment were
			// written but before the activated hash advanced.
			writeFileSync(paths.appliedState, committedBeforeTokenRotation);
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });
			expect(process.exitCode ?? 0).toBe(0);
			expect(
				readFileSync(systemctlLog, "utf-8")
					.trim()
					.split("\n")
					.filter((call) => call === "restart clawdi-daemon.service"),
			).toHaveLength(1);
			expect(readSystemdSystemUnit(paths, "clawdi-daemon")).toBe(initialDaemonUnit);
			expect(readRuntimeAppliedState(paths)?.activated["clawdi-daemon.service"]).toBe(
				rotatedDaemonActivation,
			);

			writeFileSync(systemctlLog, "");
			generation = 33;
			manifestEtag = testBundleEtag("manifest-generation-33");
			gatewayToken = "rotated-projected-gateway-token";
			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0033",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				generation: 33,
				manifestETag: manifestEtag,
				bootNonce: "boot-nonce-generation-0001",
			});
			expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
				"OPENCLAW_GATEWAY_TOKEN",
			);
			expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
				"rotated-projected-gateway-token",
			);
			expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
				"rotated-projected-gateway-token",
			);
			expect(readFileSync(systemctlLog, "utf-8")).toContain(
				"--user restart openclaw-gateway.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain("restart clawdi-daemon.service");

			writeFileSync(systemctlLog, "");
			generation = 34;
			manifestEtag = testBundleEtag("manifest-generation-34");
			gatewayToken = undefined;
			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0034",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			const tokenPath = join(run, "secrets", "auth-token");
			const fixedTokenTime = new Date("2026-07-30T00:00:00.000Z");
			utimesSync(tokenPath, fixedTokenTime, fixedTokenTime);
			const tokenBeforeRejection = readFileSync(tokenPath, "utf-8");
			const tokenMtimeBeforeRejection = statSync(tokenPath).mtimeMs;
			const appliedStateBeforeRejection = readFileSync(paths.appliedState, "utf-8");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({
				status: "error",
				stage: "final",
			});
			expect(JSON.parse(logs.at(-1) ?? "{}").error).toContain(
				"Runtime secret secret://runtime/openclaw/gateway-token is unavailable.",
			);
			expect(readRuntimeAppliedState(getRuntimePaths())?.generation).toBe(33);
			expect(readFileSync(tokenPath, "utf-8")).toBe(tokenBeforeRejection);
			expect(statSync(tokenPath).mtimeMs).toBe(tokenMtimeBeforeRejection);
			expect(readFileSync(paths.appliedState, "utf-8")).toBe(appliedStateBeforeRejection);
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");
		} finally {
			watchFetch.restore();
			console.log = previousLog;
			process.umask(previousUmask);
			process.exitCode = previousExitCode;
		}
	});

	it("runtime watch trusts the committed v2 authority after a manifest 304", async () => {
		installSuccessfulSystemctlFixture();
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		const providerSecretRef = "secret://provider.default.apiKey";
		const channelSecretRef = "secret://channels/telegram/clawdi_accttelegram/agent-token";
		const channelPlaceholderSecretRef =
			"secret://channels/telegram/clawdi_accttelegram/placeholder-token";
		const hostedPayload = {
			schemaVersion: "clawdi.hosted-runtime.bundle.v2",
			sourceRevision: "d".repeat(64),
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				runtime: "openclaw",
				deploymentId: "dep_watch_secret",
				environmentId: "env_watch_secret",
				...hostedRequiredState(),
				instanceId: "iid_watch_secret",
				generation: 22,
				issuedAt: "2026-06-06T00:00:00Z",
				locale: TEST_HOSTED_LOCALE,
				system: hostedSystemFixture(home),
				controlPlane: { cloudApiUrl: "https://cloud-api.test" },
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: TEST_RUNNING_CLI_SPEC,
					registry: "https://registry.npmjs.org",
				},
				runtimes: {
					openclaw: hostedOpenClawRuntime({
						provider_ids: ["clawdi-managed-v2"],
						primary_model: {
							provider_id: "clawdi-managed-v2",
							model: "gpt-5.5",
						},
					}),
				},
				providers: {
					"clawdi-managed-v2": {
						kind: "openai-compatible",
						type: "custom_openai_compatible",
						baseUrl: "https://sub2api.test/v1",
						models: [{ id: "gpt-5.5" }],
						apiMode: "openai_chat",
						managed_by: "clawdi",
						runtimeEnvName: "CLAWDI_AI_API_KEY",
						apiKeySecretRef: providerSecretRef,
					},
				},
			},
			channelBindings: [
				{
					provider: "telegram",
					accountKey: "clawdi_accttelegram",
					agentTokenSecretRef: channelSecretRef,
					placeholderTokenSecretRef: channelPlaceholderSecretRef,
				},
			],
			secretValues: {
				...TEST_RUNTIME_SERVICE_SECRET_VALUES,
				...TEST_HOSTED_CODEX_SECRET_VALUES,
				[providerSecretRef]: "sk-provider-watch",
				[channelSecretRef]: "agent-token-watch",
				[channelPlaceholderSecretRef]: "999999999:54db03c2296520629c70cfb6e3b15f8e",
			},
		};
		const stableBundleEtag = `"sha256:${hostedPayload.sourceRevision}"`;
		const manifestResponse = () =>
			new Response(JSON.stringify(hostedPayload), {
				status: 200,
				headers: {
					"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
					etag: stableBundleEtag,
				},
			});

		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeOpenClawConfigMutationFixture(home);
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
${fakeOpenClawConfigSchemaCommand()}
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >/dev/null
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "watch-provider-auth"),
			join(root, "watch-provider-auth", "calls.log"),
		);
		process.exitCode = undefined;
		writeCanonicalApplyContext(
			{
				generation: 22,
				manifestETag: stableBundleEtag,
				applyReceiptId: "test-apply-receipt-0022",
				bootNonce: "test-boot-nonce-000022",
			},
			CANONICAL_TEST_CONTEXT,
		);
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		const paths = getRuntimePaths();
		seedMitmproxyCache(paths);
		const initial = mockFetch([
			{ method: "GET", path: "/v1/runtime/manifest", response: () => manifestResponse() },
		]);
		try {
			const manifestLoad = await loadRemoteRuntimeManifest(paths);
			if (!("manifest" in manifestLoad) || "notModified" in manifestLoad) {
				throw new Error("expected initial manifest load success");
			}
			const initialConvergence = convergeRuntimeManifest(
				applyRuntimeBundleChannelsToManifestLoad(manifestLoad as RuntimeManifestLoad),
				paths,
			);
			expect(initialConvergence.installErrors).toEqual([]);
			expectEgressProfileBundleUsesSecretRef(
				initialConvergence.outputs.egressProfileBundle,
				"secret://provider.default.apiKey",
				"sk-provider-watch",
			);
			mkdirSync(dirname(paths.appliedState), { recursive: true });
			writeFileSync(
				paths.appliedState,
				JSON.stringify({
					schemaVersion: "clawdi.runtimeAppliedState.v2",
					appliedAt: "2026-07-13T00:00:00.000Z",
					instanceId: "iid_watch_secret",
					etag: stableBundleEtag,
					sourceRevision: "d".repeat(64),
					generation: 22,
					applyGeneration: 22,
					manifestETag: stableBundleEtag,
					applyReceiptId: "test-apply-receipt-0022",
					bootNonce: "test-boot-nonce-000022",
					contentIdentity: {
						sourcePath: "https://runtime.test/v1/runtime/manifest",
						sha256: "a".repeat(64),
					},
					activated: {},
					providerIds: ["clawdi-managed-v2"],
					projectedProviderIds: { openclaw: ["clawdi-managed-v2"] },
				}),
			);
		} finally {
			initial.restore();
		}
		const baselineRevision = systemdEnvDigest(readSystemdEnvFile(paths, "openclaw-gateway"));
		const baselineMitmSecrets = JSON.parse(
			readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8"),
		);
		expect(baselineMitmSecrets["secret://provider.default.apiKey"]).toBe("sk-provider-watch");
		expect(baselineMitmSecrets[channelSecretRef]).toBe("agent-token-watch");

		const watchFetch = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: (request) =>
					request.headers["if-none-match"]
						? new Response(null, {
								status: 304,
								headers: { etag: stableBundleEtag },
							})
						: manifestResponse(),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(watchFetch.captured.map((request) => request.path)).toEqual(["/v1/runtime/manifest"]);
			expect(watchFetch.captured[0].headers["if-none-match"]).toBe(stableBundleEtag);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("not_modified");
			expect(event.generation).toBe(22);
			expect(event.etag).toBe(stableBundleEtag);
			expect(readRuntimeAppliedState(paths)).toMatchObject({
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				etag: stableBundleEtag,
				sourceRevision: "d".repeat(64),
				generation: 22,
				providerIds: ["clawdi-managed-v2"],
			});
			expect(event.systemdUnitsChanged).toBeUndefined();
			expect(event.systemdApply).toBeUndefined();
			const egressSecrets = JSON.parse(
				readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8"),
			);
			expect(egressSecrets["secret://provider.default.apiKey"]).toBe("sk-provider-watch");
			expect(egressSecrets[channelSecretRef]).toBe("agent-token-watch");
			expect(systemdEnvDigest(readSystemdEnvFile(paths, "openclaw-gateway"))).toBe(
				baselineRevision,
			);
		} finally {
			watchFetch.restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("runtime watch retries datasource failures and applies after recovery", async () => {
		installSuccessfulSystemctlFixture();
		setRuntimeApplyGeneration(18, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		const runOnce = async (
			manifestResponse: () => Response | Promise<Response>,
			expectedStatus: "error" | "applied",
		) => {
			process.exitCode = undefined;
			logs.length = 0;
			const { restore } = mockFetch([
				{ method: "GET", path: "/v1/runtime/manifest", response: manifestResponse },
			]);
			try {
				setRuntimeApplyGeneration(18, CANONICAL_TEST_CONTEXT);
				await runtimeWatch({ once: true, json: true });
			} finally {
				restore();
			}
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe(expectedStatus);
			return event;
		};

		try {
			await runOnce(() => {
				throw new Error("network down");
			}, "error");
			await runOnce(() => new Response("upstream unavailable", { status: 503 }), "error");
			await runOnce(
				() =>
					new Response("{", {
						status: 200,
						headers: {
							"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
							etag: testBundleEtag("malformed-bundle"),
						},
					}),
				"error",
			);
			const recovered = await runOnce(
				() =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_watch_recovery",
								environmentId: "env_watch_recovery",
								...hostedRequiredState(),
								instanceId: "iid_watch_recovery",
								generation: 18,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: TEST_RUNNING_CLI_SPEC,
									registry: "https://registry.npmjs.org",
								},
								runtimes: { openclaw: hostedOpenClawRuntime() },
							},
							secretValues: {},
						},
						{ etag: testBundleEtag("etag-recovered") },
					),
				"applied",
			);

			expect(recovered.generation).toBe(18);
			expect(readRuntimeAppliedState(getRuntimePaths())?.etag).toBe(
				testBundleEtag("etag-recovered"),
			);
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
		} finally {
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("runtime watch reports deploy-key authentication failures in observed state", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(join(run, "secrets", "auth-token"), "revoked-runtime-token\n");
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => new Response("revoked", { status: 401 }),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.stage).toBe("auth");
			expect(event.error).toContain("authentication failed: HTTP 401");
			const observed = readHostedRuntimeObserved(getRuntimePaths());
			expect(observed?.status).toBe("error");
			expect(observed?.convergeError).toContain("authentication failed: HTTP 401");
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("runtime observed samples systemd unit health", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		const longJournalLine = `Gateway startup failed: ${"x".repeat(600)}`;
		writeFileSync(
			join(bin, "systemctl"),
			`#!/usr/bin/env bash
unit=""
if [ "\${1:-}" = "--user" ]; then
  unit="\${3:-}"
else
  unit="\${2:-}"
fi
case "$unit" in
  clawdi-runtime-watch.service|clawdi-daemon.service)
    printf 'ActiveState=active\\nSubState=running\\n'
    ;;
  clawdi-files.service)
    printf 'ActiveState=failed\\nSubState=failed\\nResult=exit-code\\nExecMainCode=exited\\nExecMainStatus=78\\n'
    ;;
  openclaw-gateway.service)
    printf 'ActiveState=failed\\nSubState=failed\\nResult=exit-code\\nExecMainCode=exited\\nExecMainStatus=1\\n'
    ;;
  *)
    printf 'ActiveState=inactive\\nSubState=dead\\n'
    ;;
esac
`,
		);
		chmodSync(join(bin, "systemctl"), 0o700);
		writeFileSync(
			join(bin, "journalctl"),
			`#!/usr/bin/env bash
case "$*" in
  *clawdi-files.service*) printf 'OPENAI_API_KEY=sk-must-not-leak\\n' ;;
  *openclaw-gateway.service*) printf '\\033[31m%s\\033[0m\\nignored second line\\n' '${longJournalLine}' ;;
esac
		`,
		);
		chmodSync(join(bin, "journalctl"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		mkdirSync(getRuntimePaths().cacheRoot, { recursive: true });
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"), "[Service]\n");
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-daemon.service"), "[Service]\n");
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-files.service"), "[Service]\n");
		writeFileSync(
			join(paths.systemdUserRoot, "openclaw-gateway.service"),
			`${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\n`,
		);
		writeRuntimeBootStatus(
			buildRuntimeBootStatus(
				{
					mode: "normal",
					status: "ok",
					stage: "final",
					bootId: "boot-systemd",
					runtimeMode: "hosted",
					activeGeneration: 9,
					instanceId: "iid-systemd",
					enabledRuntimes: ["openclaw"],
					errors: [],
					exitCode: 0,
					datasource: "RuntimeSource",
					hostPolicy: {
						path: paths.hostPolicy,
						exists: true,
						valid: true,
						mode: "hosted",
					},
				},
				paths,
			),
			paths,
		);
		writeRuntimeWatchStatus({ status: "applied", generation: 9, instanceId: "iid-systemd" }, paths);

		try {
			const observed = readHostedRuntimeObserved(paths);

			expect(observed?.status).toBe("error");
			expect(observed?.systemd).toEqual({
				status: "error",
				unitCount: 4,
				units: [
					{
						scope: "system",
						name: "clawdi-daemon.service",
						activeState: "active",
						subState: "running",
						status: "ok",
						error: null,
					},
					{
						scope: "system",
						name: "clawdi-files.service",
						activeState: "failed",
						subState: "failed",
						status: "error",
						error: "Result=exit-code; ExecMainCode=exited; ExecMainStatus=78",
					},
					{
						scope: "system",
						name: "clawdi-runtime-watch.service",
						activeState: "active",
						subState: "running",
						status: "ok",
						error: null,
					},
					{
						scope: "user",
						name: "openclaw-gateway.service",
						activeState: "failed",
						subState: "failed",
						status: "error",
						error: longJournalLine.slice(0, 500),
					},
				],
			});
			expect(JSON.stringify(observed)).not.toContain("sk-must-not-leak");
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime observed keeps runtime-watch auto-restart outside data-plane readiness", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const watchFailed = join(root, "watch-failed");
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		const systemctl = join(bin, "systemctl");
		writeFileSync(
			systemctl,
			`#!/usr/bin/env bash
if [ -f '${watchFailed}' ]; then
  printf 'ActiveState=failed\\nSubState=failed\\n'
else
  printf 'ActiveState=activating\\nSubState=auto-restart\\n'
fi
`,
		);
		chmodSync(systemctl, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"), "[Service]\n");
		writeRuntimeWatchStatus(
			{ status: "applied", generation: 5, instanceId: "iid-watch-restart" },
			paths,
		);
		const appliedState = {
			schemaVersion: "clawdi.runtimeAppliedState.v2" as const,
			appliedAt: "2026-08-12T04:21:24.000Z",
			instanceId: "iid-watch-restart",
			etag: '"watch-restart"',
			sourceRevision: "a".repeat(64),
			generation: 5,
			contentIdentity: {
				sourcePath: "https://runtime.test/v1/runtime/manifest",
				sha256: "b".repeat(64),
			},
			providerIds: [],
			projectedProviderIds: {},
		};

		const restarting = readHostedRuntimeObserved(paths, { appliedState });

		expect(restarting?.status).toBe("ok");
		expect(restarting?.systemd).toEqual({
			status: "unknown",
			unitCount: 1,
			units: [
				{
					scope: "system",
					name: "clawdi-runtime-watch.service",
					activeState: "activating",
					subState: "auto-restart",
					status: "unknown",
					error: null,
				},
			],
		});

		writeFileSync(watchFailed, "");
		const failed = readHostedRuntimeObserved(paths, { appliedState });
		expect(failed?.status).toBe("error");
		expect(failed?.systemd).toMatchObject({
			status: "error",
			units: [{ name: "clawdi-runtime-watch.service", status: "error" }],
		});
	});

	it("runtime observed does not report ok when managed systemd units are inactive", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		const systemctl = join(bin, "systemctl");
		writeFileSync(
			systemctl,
			`#!/usr/bin/env bash
printf 'ActiveState=inactive\\nSubState=dead\\n'
`,
		);
		chmodSync(systemctl, 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		mkdirSync(getRuntimePaths().cacheRoot, { recursive: true });
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"), "[Service]\n");
		writeRuntimeBootStatus(
			buildRuntimeBootStatus(
				{
					mode: "normal",
					status: "ok",
					stage: "final",
					bootId: "boot-systemd-inactive",
					runtimeMode: "hosted",
					activeGeneration: 9,
					instanceId: "iid-systemd-inactive",
					enabledRuntimes: ["openclaw"],
					errors: [],
					exitCode: 0,
					datasource: "RuntimeSource",
					hostPolicy: {
						path: paths.hostPolicy,
						exists: true,
						valid: true,
						mode: "hosted",
					},
				},
				paths,
			),
			paths,
		);
		writeRuntimeWatchStatus(
			{ status: "applied", generation: 9, instanceId: "iid-systemd-inactive" },
			paths,
		);

		try {
			const observed = readHostedRuntimeObserved(paths);

			expect(observed?.status).toBe("unknown");
			expect(observed?.systemd).toMatchObject({
				status: "unknown",
				unitCount: 1,
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime observed ignores volatile watch timestamps and running uptimes", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		const systemctl = join(bin, "systemctl");
		writeFileSync(
			systemctl,
			`#!/usr/bin/env bash
printf 'ActiveState=active\\nSubState=running\\n'
`,
		);
		chmodSync(systemctl, 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		mkdirSync(getRuntimePaths().cacheRoot, { recursive: true });
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"), "[Service]\n");
		writeRuntimeWatchStatus(
			{ status: "applied", generation: 9, instanceId: "iid-observed-stable" },
			paths,
		);

		try {
			const first = readHostedRuntimeObserved(paths);
			writeRuntimeWatchStatus(
				{ status: "applied", generation: 9, instanceId: "iid-observed-stable" },
				paths,
			);
			const second = readHostedRuntimeObserved(paths);
			const stable = (value: Record<string, unknown> | null) => {
				if (!value) return value;
				const copy = { ...value };
				delete copy.reportedAt;
				return copy;
			};

			expect(stable(second)).toEqual(stable(first));
			expect(second?.watch).not.toHaveProperty("timestamp");
			expect(second?.systemd).toEqual({
				status: "ok",
				unitCount: 1,
				units: [
					{
						scope: "system",
						name: "clawdi-runtime-watch.service",
						activeState: "active",
						subState: "running",
						status: "ok",
						error: null,
					},
				],
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime observed reports provider secret health without leaking secret values", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(join(run, "secrets"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.cacheRoot, { recursive: true });
		const cached = hostedCliManifestResponse(home, TEST_RUNNING_CLI_SPEC);
		Object.assign(cached.manifest, {
			deploymentId: "dep-provider-observed",
			environmentId: "env-provider-observed",
			instanceId: "iid-provider-observed",
			generation: 9,
			providers: {
				default: {
					kind: "openai-compatible",
					type: "custom_openai_compatible",
					baseUrl: "https://sub2api.test/v1",
					models: [{ id: "gpt-5.5" }],
					apiMode: "openai_responses",
					managed_by: "user",
					runtimeEnvName: "OPENAI_API_KEY",
					apiKeySecretRef: "secret://provider.default.apiKey",
				},
			},
		});
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({
				schemaVersion: "clawdi.hosted-runtime.bundle.v2",
				sourceRevision: "a".repeat(64),
				manifest: cached.manifest,
				channelBindings: [],
				secretValues: {},
			}),
		);
		writeFileSync(
			join(run, "secrets", "egress-secrets.json"),
			JSON.stringify({ "secret://provider.default.apiKey": "sk-observed-provider" }),
		);
		writeRuntimeBootStatus(
			buildRuntimeBootStatus(
				{
					mode: "normal",
					status: "ok",
					stage: "final",
					bootId: "boot-provider",
					runtimeMode: "hosted",
					activeGeneration: 9,
					instanceId: "iid-provider-observed",
					enabledRuntimes: ["openclaw"],
					errors: [],
					exitCode: 0,
					datasource: "RuntimeSource",
					hostPolicy: {
						path: paths.hostPolicy,
						exists: true,
						valid: true,
						mode: "hosted",
					},
				},
				paths,
			),
			paths,
		);
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T06:00:00.000Z",
				instanceId: "iid-provider-observed",
				etag: testBundleEtag("provider-observed"),
				sourceRevision: "a".repeat(64),
				generation: 9,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				activated: {},
				providerIds: ["default"],
				projectedProviderIds: {},
			},
			paths,
		);

		const observed = readHostedRuntimeObserved(paths);

		expect(observed?.status).toBe("ok");
		expect(observed?.providers).toEqual({
			default: {
				status: "ok",
				configured: true,
				kind: "openai-compatible",
				baseUrl: "https://sub2api.test/v1",
				model: null,
				models: [{ id: "gpt-5.5" }],
				apiKeySecretRef: "secret://provider.default.apiKey",
				secretAvailable: true,
				reasons: [],
			},
		});
		expect(JSON.stringify(observed)).not.toContain("sk-observed-provider");
	});

	it("runtime observed marks provider health error when its secret ref is unavailable", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(run, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.cacheRoot, { recursive: true });
		const cached = hostedCliManifestResponse(home, TEST_RUNNING_CLI_SPEC);
		Object.assign(cached.manifest, {
			deploymentId: "dep-provider-missing-secret",
			environmentId: "env-provider-missing-secret",
			instanceId: "iid-provider-missing-secret",
			generation: 10,
			providers: {
				default: {
					kind: "openai-compatible",
					type: "custom_openai_compatible",
					baseUrl: "https://sub2api.test/v1",
					apiMode: "openai_responses",
					managed_by: "user",
					runtimeEnvName: "OPENAI_API_KEY",
					apiKeySecretRef: "secret://provider.default.apiKey",
				},
			},
		});
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({
				schemaVersion: "clawdi.hosted-runtime.bundle.v2",
				sourceRevision: "c".repeat(64),
				manifest: cached.manifest,
				channelBindings: [],
				secretValues: {},
			}),
		);
		writeRuntimeBootStatus(
			buildRuntimeBootStatus(
				{
					mode: "normal",
					status: "ok",
					stage: "final",
					bootId: "boot-provider-missing-secret",
					runtimeMode: "hosted",
					activeGeneration: 10,
					instanceId: "iid-provider-missing-secret",
					enabledRuntimes: ["openclaw"],
					errors: [],
					exitCode: 0,
					datasource: "RuntimeSource",
					hostPolicy: {
						path: paths.hostPolicy,
						exists: true,
						valid: true,
						mode: "hosted",
					},
				},
				paths,
			),
			paths,
		);

		const observed = readHostedRuntimeObserved(paths);

		expect(observed?.status).toBe("error");
		expect(observed?.providers).toEqual({
			default: {
				status: "error",
				configured: true,
				kind: "openai-compatible",
				baseUrl: "https://sub2api.test/v1",
				model: null,
				apiKeySecretRef: "secret://provider.default.apiKey",
				secretAvailable: false,
				reasons: ["model_missing", "secret_missing"],
			},
		});
	});
	it("hands off a CLI update and restarts changed daemon and tenant unit bytes", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const npmLog = join(root, "npm.log");
		const systemctlLog = join(root, "systemctl-cli-update.log");
		installSuccessfulSystemctlFixture(join(run, "egress", "systemd", "ca.pem"), systemctlLog);
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const currentVersion = getCliVersion();
		setRuntimeApplyGeneration(13);
		const runtimeContextBefore = JSON.stringify(currentTestApplyContext);
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
		writeFileSync(
			join(bin, "npm"),
			`#!/usr/bin/env bash
set -euo pipefail
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
if [ -z "$prefix" ]; then
  echo "missing --prefix" >&2
  exit 64
fi
printf '%s\\n' "$*" > '${npmLog}'
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${currentVersion}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"ok"}'
  exit 0
fi
echo "fake clawdi"
SH
chmod +x "$prefix/bin/clawdi"
`,
		);
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, "1.2.3-test");
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		let runtimeGeneration = 13;
		let desiredCliPackageSpec = "clawdi@1.2.3-test";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: (request) => {
					const etag = testBundleEtag(`${runtimeGeneration}:${desiredCliPackageSpec}`);
					if (request.headers["if-none-match"] === etag) {
						return new Response(null, { status: 304, headers: { etag } });
					}
					return hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_cli_update",
								environmentId: "env_cli_update",
								...hostedRequiredState(),
								instanceId: "iid_cli_update",
								generation: runtimeGeneration,
								issuedAt: `2026-06-06T00:00:${runtimeGeneration}Z`,
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: desiredCliPackageSpec,
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						},
						{
							applyGeneration: 13,
							etag,
						},
					);
				},
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });
			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			const paths = getRuntimePaths();
			expect(JSON.parse(logs[0])).toMatchObject({ status: "applied" });
			expect(existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"))).toBe(true);
			expect(existsSync(join(paths.systemdSystemRoot, "clawdi-daemon.service"))).toBe(true);
			expect(existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"))).toBe(
				true,
			);
			expect(existsSync(join(paths.systemdUserRoot, "openclaw-gateway.service"))).toBe(true);
			expect(existsSync(paths.daemonAuthToken)).toBe(true);
			const initialAppliedState = readRuntimeAppliedState(paths);
			const initialDaemonActivation = initialAppliedState?.activated["clawdi-daemon.service"];
			expect(initialDaemonActivation).toMatch(/^[a-f0-9]{64}$/);
			const legacyUnitPaths = [
				...readdirSync(paths.systemdSystemRoot)
					.filter((entry) => entry.endsWith(".service"))
					.map((entry) => join(paths.systemdSystemRoot, entry)),
				...readdirSync(paths.systemdUserRoot).flatMap((entry) => {
					if (entry.endsWith(".service")) {
						const unitPath = join(paths.systemdUserRoot, entry);
						return readFileSync(unitPath, "utf-8").includes(GENERATED_RUNTIME_SYSTEMD_FILE_HEADER)
							? [unitPath]
							: [];
					}
					const dropIn = join(paths.systemdUserRoot, entry, "10-clawdi-hosted.conf");
					return entry.endsWith(".service.d") && existsSync(dropIn) ? [dropIn] : [];
				}),
			];
			for (const unitPath of legacyUnitPaths) {
				writeFileSync(unitPath, `${readFileSync(unitPath, "utf-8")}# legacy renderer drift\n`);
			}
			logs.length = 0;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			runtimeGeneration = 14;
			desiredCliPackageSpec = `clawdi@${currentVersion}`;
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(process.exitCode ?? 0).toBe(0);
			expect(captured).toHaveLength(2);
			const active = paths.cliManagedBin;
			const sharedPrefixTarget = join(paths.cliNpmPrefix, "bin", "clawdi");
			const activeTarget = readlinkSync(active);
			expect(readlinkSync(active)).toBe(activeTarget);
			const status = JSON.parse(readFileSync(getRuntimePaths().cliBootstrapStatus, "utf-8"));
			expect(status.packageSpec).toBe(`clawdi@${currentVersion}`);
			expect(status.activePath).toBe(active);
			expect(status.activeTarget).toBe(activeTarget);
			expect(status.npmPrefix.startsWith(join(getRuntimePaths().cliNpmPrefix, "packages"))).toBe(
				true,
			);
			expect(activeTarget).toBe(join(status.npmPrefix, "bin", "clawdi"));
			expect(activeTarget).not.toBe(sharedPrefixTarget);
			expect(status.version).toBe(currentVersion);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("cli_handoff");
			expect(event.handoff).toBe("cli_reexec");
			expect(event.selfReexec).toBe(true);
			expect(event.cliUpdate.status).toBe("installed");
			expect(event.cliUpdate.packageSpec).toBe(`clawdi@${currentVersion}`);
			expect(event.systemdUnitsChanged).toBe(false);
			expect(JSON.stringify(currentTestApplyContext)).toBe(runtimeContextBefore);
			expect(event.systemdApply).toEqual({
				applied: false,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			});
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");
			expect(readRuntimeAppliedState(paths)).toMatchObject({
				generation: 13,
				applyGeneration: 13,
			});
			const appliedBeforeDaemonHandoff = readFileSync(paths.appliedState, "utf-8");
			expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"))).toMatchObject({
				status: "installed",
				previous: { version: "1.2.3-test" },
				bad: null,
			});

			logs.length = 0;
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(captured).toHaveLength(3);
			const completedEvent = JSON.parse(logs[0]);
			expect(completedEvent.status).toBe("applied");
			expect(completedEvent.selfReexec).toBe(false);
			expect(completedEvent.cliUpdate.status).toBe("current");
			expect(completedEvent.systemdUnitsChanged).toBe(true);
			expect(completedEvent.systemdApply).toEqual({
				applied: true,
				systemUnitsChanged: ["clawdi-daemon.service"],
				userUnitsChanged: ["openclaw-gateway.service"],
			});
			const completedAppliedState = readRuntimeAppliedState(paths);
			expect(completedAppliedState).toMatchObject({
				generation: 14,
				applyGeneration: 13,
			});
			const completedDaemonActivation = completedAppliedState?.activated["clawdi-daemon.service"];
			expect(completedDaemonActivation).toMatch(/^[a-f0-9]{64}$/);
			expect(completedDaemonActivation).not.toBe(initialDaemonActivation);
			expect(JSON.stringify(currentTestApplyContext)).toBe(runtimeContextBefore);
			const activationCalls = readFileSync(systemctlLog, "utf-8")
				.trim()
				.split("\n")
				.filter((call) =>
					/(?:^|\s)(?:daemon-reload|start|restart|stop|enable|disable|reset-failed)(?:\s|$)/.test(
						call,
					),
				);
			expect(activationCalls).toEqual([
				"daemon-reload",
				"--user daemon-reload",
				"restart clawdi-daemon.service",
				"--user restart openclaw-gateway.service",
			]);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"restart clawdi-runtime-watch.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"restart clawdi-runtime-sidecar.service",
			);
			expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"))).toMatchObject({
				previous: null,
				bad: null,
			});

			// Model a crash after the cache write but before the applied-state commit.
			writeFileSync(paths.appliedState, appliedBeforeDaemonHandoff);
			logs.length = 0;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(captured).toHaveLength(4);
			expect(JSON.parse(logs[0]).systemdApply).toEqual({
				applied: true,
				systemUnitsChanged: ["clawdi-daemon.service"],
				userUnitsChanged: [],
			});
			const retryCalls = readFileSync(systemctlLog, "utf-8");
			expect(retryCalls.match(/^restart clawdi-daemon\.service$/gm)).toHaveLength(1);
			expect(retryCalls).not.toContain("restart clawdi-runtime-watch.service");
			expect(retryCalls).not.toContain("restart clawdi-runtime-sidecar.service");
			expect(retryCalls).not.toContain("--user restart openclaw-gateway.service");
			expect(readRuntimeAppliedState(paths)?.activated["clawdi-daemon.service"]).toBe(
				completedDaemonActivation,
			);

			const committedAfterRetry = readFileSync(paths.appliedState, "utf-8");
			logs.length = 0;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(captured).toHaveLength(5);
			expect(JSON.parse(logs[0])).toMatchObject({ status: "not_modified" });
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");
			expect(readFileSync(paths.appliedState, "utf-8")).toBe(committedAfterRetry);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it.each([
		{ runtime: "openclaw" as const, publishCa: true },
		{ runtime: "hermes" as const, publishCa: true },
		{ runtime: "openclaw" as const, publishCa: false },
	])(
		"orders the cold $runtime installer after egress (publishCa=$publishCa)",
		async ({ runtime, publishCa }) => {
			setRuntimeApplyGeneration(41, CANONICAL_TEST_CONTEXT);
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			const run = join(root, "run", "clawdi");
			const bin = join(root, "bin");
			const systemctlLog = join(root, "systemctl-cold-openclaw.log");
			const systemctlStateRoot = join(root, "systemctl-cold-openclaw-state");
			const installerLog = join(root, `${runtime}-installer-order.log`);
			const runtimeBin =
				runtime === "openclaw"
					? join(home, ".local", "bin", "openclaw")
					: join(home, ".local", "bin", "hermes");
			const serviceName = `${runtime}-gateway`;
			const runtimeUnit = join(home, ".config", "systemd", "user", `${serviceName}.service`);
			const installArgs =
				runtime === "openclaw"
					? "gateway install --force --json"
					: "gateway install --force --no-start-now";
			const previousLog = console.log;
			const previousUmask = process.umask(0o022);
			const previousExitCode = process.exitCode;
			const previousPath = process.env.PATH;
			let runtimeExitCode: number | undefined;
			const logs: string[] = [];
			mkdirSync(join(run, "secrets"), { recursive: true });
			if (runtime === "openclaw") writeOpenClawConfigMutationFixture(home);
			mkdirSync(dirname(runtimeBin), { recursive: true });
			mkdirSync(bin, { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
			process.env.CLAWDI_RUNTIME_USER = String(process.getuid?.() ?? 0);
			process.env.PATH = `${bin}:${previousPath ?? ""}`;
			const paths = getRuntimePaths();
			writeFakeSystemdManager({
				path: join(bin, "systemctl"),
				logPath: systemctlLog,
				stateRoot: systemctlStateRoot,
				sidecarReadyPath: publishCa ? paths.egressSystemCaFile : undefined,
			});
			writeFileSync(
				runtimeBin,
				`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> '${installerLog}'
if [ "$*" = "--version" ]; then
  printf '%s\n' '${runtime}-test-version'
elif [ "${runtime}" = "openclaw" ] && [ "$*" = "config schema" ]; then
  printf '%s\n' '{"type":"object","properties":{"memory":{"type":"object","properties":{"search":{"type":"object"}}}}}'
elif [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"${join(home, ".openclaw", "workspace")}"}]\n'
elif [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ]; then
  cat >/dev/null
elif [ "${runtime}" = "hermes" ] && [ "\${1:-}" = "config" ]; then
  exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
elif [ "$*" = "${installArgs}" ]; then
  printf '%s\n' 'official ${runtime} installer' >> '${systemctlLog}'
  test -r '${paths.egressSystemCaFile}'
  test ${runtime === "hermes" ? "-r" : "! -e"} '${join(paths.systemdUserRoot, `${serviceName}.service.d`, "10-clawdi-hosted.conf")}'
  mkdir -p '${dirname(runtimeUnit)}' '${systemctlStateRoot}'
  printf '[Service]\\nExecStart=${runtime} gateway run\\n' > '${runtimeUnit}'
	  systemctl --user enable ${runtime === "hermes" ? "" : "--now"} '${serviceName}.service'
fi
exit 0
`,
			);
			chmodSync(runtimeBin, 0o700);
			if (runtime === "hermes") {
				writeHermesDashboardPython(home, true);
				const appRoot = join(home, ".hermes", "hermes-agent");
				const npm = join(bin, "npm");
				mkdirSync(join(appRoot, "web"), { recursive: true });
				writeFileSync(join(appRoot, "web", "package.json"), '{"scripts":{"build":"true"}}\n');
				writeFileSync(
					npm,
					`#!/usr/bin/env bash
set -euo pipefail
printf 'official hermes dashboard prerequisite %s\n' "$*" >> '${systemctlLog}'
test -r '${paths.egressSystemCaFile}'
case "$*" in
  "ci --include=dev --workspace web")
    mkdir -p '${join(appRoot, "node_modules", ".bin")}'
    ;;
  "run build")
    mkdir -p '${join(appRoot, "hermes_cli", "web_dist")}'
    printf '%s\n' '<html>Hermes dashboard</html>' > '${join(appRoot, "hermes_cli", "web_dist", "index.html")}'
    ;;
  *) exit 64 ;;
esac
`,
				);
				chmodSync(npm, 0o700);
			}
			seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
			writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
			const mitmproxy = seedMitmproxyCache(paths);
			console.log = (value?: unknown) => logs.push(String(value));
			const runtimeFetch = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () =>
						hostedRuntimeBundleResponse(
							hostedEgressSecretRotationPayload(home, mitmproxy, "cold-home-secret", runtime),
							{ etag: testBundleEtag("cold-home-egress") },
						),
				},
			]);

			try {
				await runtimeWatch({ once: true, json: true });
				runtimeExitCode = process.exitCode;
			} finally {
				runtimeFetch.restore();
				console.log = previousLog;
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				process.umask(previousUmask);
				process.exitCode = previousExitCode;
			}

			if (!publishCa) {
				const event = JSON.parse(logs.at(-1) ?? "{}");
				expect(event.status).toBe("error");
				expect(event.error).toContain("prerequisite activation failed");
				expect(readRuntimeAppliedState(paths)).toBeNull();
				expect(existsSync(installerLog) ? readFileSync(installerLog, "utf8") : "").not.toContain(
					installArgs,
				);
				const failedManagerCalls = readFileSync(systemctlLog, "utf8").trim().split("\n");
				expect(
					failedManagerCalls.some((call) => /^(start|restart) .*clawdi-daemon\.service/.test(call)),
				).toBe(false);
				return;
			}
			if (runtimeExitCode !== undefined && runtimeExitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(JSON.parse(logs.at(-1) ?? "{}").status).toBe("applied");
			expect(existsSync(paths.egressSystemCaFile)).toBe(true);
			const calls = readFileSync(systemctlLog, "utf8").trim().split("\n");
			const sidecarActivation = calls.findIndex((call) =>
				/^(start|restart) .*clawdi-runtime-sidecar\.service/.test(call),
			);
			const officialInstaller = calls.indexOf(`official ${runtime} installer`);
			const finalSystemActivation = calls.findIndex(
				(call) => call.startsWith("start") && call.includes("clawdi-daemon.service"),
			);
			expect(sidecarActivation).toBeGreaterThanOrEqual(0);
			if (runtime === "hermes") {
				const dependencyInstall = calls.indexOf(
					"official hermes dashboard prerequisite ci --include=dev --workspace web",
				);
				const dashboardBuild = calls.indexOf("official hermes dashboard prerequisite run build");
				expect(dependencyInstall).toBeGreaterThan(sidecarActivation);
				expect(dashboardBuild).toBeGreaterThan(dependencyInstall);
				expect(officialInstaller).toBeGreaterThan(dashboardBuild);
			}
			expect(officialInstaller).toBeGreaterThan(sidecarActivation);
			expect(finalSystemActivation).toBeGreaterThan(officialInstaller);
			if (runtime === "hermes") {
				const gatewayStart = calls.findIndex(
					(call) => call.startsWith("--user start ") && call.includes(`${serviceName}.service`),
				);
				expect(gatewayStart).toBeGreaterThan(officialInstaller);
				expect(calls).not.toContain(`--user restart ${serviceName}.service`);
			} else {
				expect(calls).toContain(`--user restart ${serviceName}.service`);
			}
			const installerCalls = readFileSync(installerLog, "utf8").trim().split("\n");
			const installIndex = installerCalls.indexOf(installArgs);
			if (runtime === "openclaw") {
				expect(installIndex).toBeGreaterThan(0);
				expect(installerCalls.slice(installIndex + 1)).not.toContain("config patch --stdin");
			} else {
				expect(installIndex).toBeGreaterThanOrEqual(0);
				expect(installerCalls).toContain("config path");
				expect(installerCalls.some((call) => call.startsWith("npm "))).toBe(false);
				expect(existsSync(join(home, ".hermes", "config.yaml"))).toBe(true);
			}
			expect(readRuntimeAppliedState(paths)).toMatchObject({
				generation: 41,
				etag: testBundleEtag("cold-home-egress"),
			});
		},
		30_000,
	);

	it("runtime watch reapplies transparent egress across CLI self-upgrade", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl.log");
		const systemctlStateRoot = join(root, "systemctl-self-upgrade-state");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const currentVersion = getCliVersion();
		setRuntimeApplyGeneration(1);
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
		writeFileSync(
			join(bin, "npm"),
			`#!/usr/bin/env bash
set -euo pipefail
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
if [ -z "$prefix" ]; then
  echo "missing --prefix" >&2
  exit 64
fi
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${currentVersion}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"ok"}'
  exit 0
fi
echo "fake upgraded clawdi"
SH
chmod +x "$prefix/bin/clawdi"
`,
		);
		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			sidecarReadyPath: join(run, "egress", "systemd", "ca.pem"),
		});
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		const paths = getRuntimePaths();
		seedCurrentCliInstall(state, "1.2.1-test.1");
		const mitmproxy = seedMitmproxyCache(paths);
		const baseline = normalizeHostedManifestFixture(
			hostedEgressSecretRotationPayload(home, mitmproxy, "sk-before-upgrade"),
		);
		baseline.manifest = {
			...baseline.manifest,
			deploymentId: "dep_cli_mitm",
			environmentId: "env_cli_mitm",
			instanceId: "iid_cli_mitm",
			generation: 1,
		};
		convergeRuntimeManifest(
			{
				...baseline,
				source: "remote-datasource",
				sourcePath: "test://self-upgrade-egress-before",
				offline: false,
			},
			paths,
		);
		const activeUnits = readSystemdUnitSnapshot(paths);
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, activeUnits);
		for (const unit of activeUnits.user.keys()) {
			writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
		}
		writeFileSync(systemctlLog, "");
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_cli_mitm",
								environmentId: "env_cli_mitm",
								...hostedRequiredState(),
								instanceId: "iid_cli_mitm",
								generation: 2,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								egressEngine: mitmproxy,
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: `clawdi@${currentVersion}`,
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
								providers: {
									default: {
										kind: "openai-compatible",
										type: "custom_openai_compatible",
										baseUrl: "https://ai-gateway.example.test/v1",
										models: [{ id: "gpt-5.5" }],
										apiMode: "openai_responses",
										runtimeEnvName: "CLAWDI_AI_API_KEY",
										apiKeySecretRef: "secret://provider.default.apiKey",
									},
								},
							},
							secretValues: {
								"secret://provider.default.apiKey": "sk-after-upgrade",
							},
						},
						{ etag: testBundleEtag("etag-cli-egress-2") },
					),
			},
		]);

		try {
			setRuntimeApplyGeneration(2);
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			const handoff = JSON.parse(logs[0]);
			expect(handoff.status).toBe("cli_handoff");
			expect(handoff.selfReexec).toBe(true);
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");

			logs.length = 0;
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(0);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.selfReexec).toBe(false);
			expect(event.systemdApply.applied).toBe(true);
			expect(event.systemdApply.systemUnitsChanged).toContain("clawdi-runtime-sidecar.service");
			const systemctlCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			expect(systemctlCalls).not.toContain("restart clawdi-daemon.service");
			const sidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
			const sidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
			const transparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
			expect(sidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
			expect(sidecarEnv).toContain('CLAWDI_MANAGED_CONTENT_DIGEST="');
			expect(sidecarUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "sidecar"`);
			expect(sidecarUnit).toContain(
				`BindReadOnlyPaths=${cachedMitmproxyBinary(paths, mitmproxy)}:${paths.egressServiceBinary}:norbind`,
			);
			expect(transparentEgressEnv).toContain(
				'CLAWDI_EGRESS_TRANSPORT_VERSION="clawdi-transparent-egress-v1"',
			);
			expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_ADDON_PATH="${paths.egressAddon}"`);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it.each([
		["upgrades", "1.2.3-test.1", "1.2.3-test.2"],
		["downgrades", "2.0.0-test.1", "1.2.3-test.2"],
	])(
		"hosted exact CLI desired state %s without npm view",
		(action, currentVersion, desiredVersion) => {
			const home = join(root, `home-${currentVersion}`, "clawdi");
			const state = join(root, `state-${currentVersion}`);
			const run = join(root, `run-${currentVersion}`);
			const bin = join(root, `bin-${currentVersion}`);
			const npmLog = join(root, `npm-exact-${currentVersion}.log`);
			const previousPath = process.env.PATH;
			mkdirSync(bin, { recursive: true });
			writeFileSync(
				join(bin, "npm"),
				`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${npmLog}'
if [ "\${1:-}" = "view" ]; then
  echo "exact hosted CLI updates must not call npm view" >&2
  exit 96
fi
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
test -n "$prefix"
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${desiredVersion}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  test "\${CLAWDI_SERVICE_STATE_DIR:-}" != "${state}"
  test "\${CLAWDI_RUN_DIR:-}" != "${run}"
  echo '{"status":"ok"}'
  exit 0
fi
exit 64
SH
chmod +x "$prefix/bin/clawdi"
`,
			);
			chmodSync(join(bin, "npm"), 0o700);
			process.env.PATH = `${bin}:${previousPath ?? ""}`;
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			const desiredSpec = `clawdi@${desiredVersion}`;
			seedCurrentCliInstall(state, currentVersion);
			const previousUmask = process.umask(0o002);

			try {
				const desired = normalizeHostedManifestFixture(
					hostedCliManifestResponse(home, desiredSpec),
				);
				const paths = getRuntimePaths();
				const result = applyRuntimeCliDesiredState(desired.manifest, paths);
				expect(process.umask()).toBe(0o002);

				expect(result.status).toBe("installed");
				expect(result.selfReexec).toBe(true);
				expect(result.packageSpec).toBe(desiredSpec);
				expect(result.version).toBe(desiredVersion);
				expect(result.activePath).toBe(paths.cliManagedBin);
				expect(readlinkSync(result.activePath)).toBe(result.activeTarget);
				expect(existsSync(join(state, "bin", "clawdi"))).toBe(false);
				expect(statSync(paths.managedCliRoot).mode & 0o777).toBe(0o755);
				expect(statSync(dirname(result.activePath)).mode & 0o777).toBe(0o755);
				expect(statSync(paths.cliNpmPrefix).mode & 0o777).toBe(0o755);
				expect(statSync(result.npmPrefix).mode & 0o777).toBe(0o755);
				if (!result.activeTarget) throw new Error("CLI update did not return an active target");
				expect(statSync(result.activeTarget).mode & 0o777).toBe(0o700);
				expect(statSync(paths.cliBootstrapStatus).mode & 0o777).toBe(0o600);
				const pending = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
				expect(pending).toMatchObject({
					status: "installed",
					packageSpec: desiredSpec,
					activeTarget: result.activeTarget,
					version: desiredVersion,
					previous: { version: currentVersion },
					bad: null,
				});
				expect(pending.verification).toBeDefined();
				const npmCalls = readFileSync(npmLog, "utf-8").trim().split("\n");
				expect(npmCalls.some((call) => call.startsWith("view "))).toBe(false);
				expect(npmCalls.some((call) => call.includes(desiredSpec))).toBe(true);

				if (action === "upgrades") {
					expect(completePendingRuntimeCliUpgrade(paths, desiredVersion)).toEqual({
						status: "unchanged",
						selfReexec: false,
					});
					expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8")).previous).toBeNull();
				} else {
					expect(rollbackPendingRuntimeCliUpgrade(paths, "first converge failed").status).toBe(
						"rolled_back",
					);
					const rolledBack = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
					expect(rolledBack).toMatchObject({
						version: currentVersion,
						previous: null,
						bad: { version: desiredVersion, attempts: 1 },
					});
					expect(applyRuntimeCliDesiredState(desired.manifest, paths).status).toBe("deferred");
				}
			} finally {
				process.umask(previousUmask);
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
			}
		},
	);

	it("adopts a released image bootstrap receipt and re-verifies stale CLI metadata", () => {
		const state = join(root, "state-cli-verification-cache");
		const run = join(root, "run-cli-verification-cache");
		const commandLog = join(root, "cli-verification-cache.log");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const identity = createVersionedCliFixture(
			paths,
			"1.2.3",
			join(paths.cliNpmPrefix, "installs", "install-bootstrap"),
		);
		pointManagedCliAt(paths, identity);
		const { activeTarget } = identity;
		writeFileSync(
			activeTarget,
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${commandLog}'
if [ "\${1:-}" = "--version" ]; then echo '1.2.3'; exit 0; fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then echo '{"status":"ok"}'; exit 0; fi
exit 64
`,
		);
		chmodSync(activeTarget, 0o700);
		const manifest = cliManifest("1.2.3");
		const bootstrap = {
			schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
			generatedAt: "2026-09-06T00:00:00Z",
			status: "installed",
			source: "npm",
			...identity,
			npmCache: paths.cliNpmCache,
			activePath: paths.cliManagedBin,
			error: null,
		};
		mkdirSync(paths.statusRoot, { recursive: true });
		writeFileSync(paths.cliBootstrapStatus, JSON.stringify(bootstrap));
		const warn = spyOn(log, "warn");
		try {
			expect(readRuntimeCliBootstrapStatus(paths, { strict: true })).toEqual(bootstrap);
			expect(applyRuntimeCliDesiredState(manifest, paths).status).toBe("current");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}

		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(2);
		const adopted = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		expect(adopted).toMatchObject({
			...identity,
			previous: null,
			bad: null,
		});
		expect(adopted.verification.inode).toBe(statSync(activeTarget).ino);
		applyRuntimeCliDesiredState(manifest, paths);
		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(2);

		adopted.verification.device += 1;
		adopted.verification.inode += 1;
		writeFileSync(paths.cliBootstrapStatus, JSON.stringify(adopted));
		expect(applyRuntimeCliDesiredState(manifest, paths).status).toBe("current");
		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(4);
		expect(readlinkSync(paths.cliManagedBin)).toBe(activeTarget);
		expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8")).verification).toMatchObject({
			device: statSync(activeTarget).dev,
			inode: statSync(activeTarget).ino,
		});
	});

	it.each(["partial", "mismatch", "permissions", "symlink", "probe"] as const)(
		"does not adopt or overwrite an invalid CLI receipt/target: %s",
		(failure) => {
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state-cli-invalid");
			const paths = getRuntimePaths();
			const identity = createVersionedCliFixture(paths, "1.2.3");
			pointManagedCliAt(paths, identity);
			reconcilePendingRuntimeCliUpgrade(paths);
			const receipt = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			switch (failure) {
				case "partial":
					delete receipt.verification;
					break;
				case "mismatch":
					receipt.version = "1.2.4";
					break;
				case "permissions":
					chmodSync(identity.activeTarget, 0o777);
					break;
				case "symlink":
					rmSync(identity.activeTarget);
					symlinkSync("/bin/true", identity.activeTarget);
					break;
				case "probe":
					writeFileSync(identity.activeTarget, "#!/bin/sh\nexit 42\n");
					break;
			}
			writeFileSync(paths.cliBootstrapStatus, JSON.stringify(receipt));
			const before = readFileSync(paths.cliBootstrapStatus, "utf-8");
			expect(() => applyRuntimeCliDesiredState(cliManifest("1.2.3"), paths)).toThrow();
			expect(readFileSync(paths.cliBootstrapStatus, "utf-8")).toBe(before);
			expect(readlinkSync(paths.cliManagedBin)).toBe(identity.activeTarget);
			if (failure === "permissions") {
				expect(statSync(identity.activeTarget).mode & 0o777).toBe(0o777);
			}
		},
	);

	it("rejects an unreadable CLI receipt instead of recovering it as missing", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state-cli-unreadable");
		const paths = getRuntimePaths();
		mkdirSync(paths.statusRoot, { recursive: true });
		writeFileSync(paths.cliBootstrapStatus, "{}", { mode: 0o000 });
		expect(() => applyRuntimeCliDesiredState(cliManifest("1.2.3"), paths)).toThrow("EACCES");
		expect(statSync(paths.cliBootstrapStatus).mode & 0o777).toBe(0);
	});

	it("rolls back when the active symlink disagrees with state", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state-cli-crash-recovery");
		process.env.CLAWDI_RUN_DIR = join(root, "run-cli-crash-recovery");
		const paths = getRuntimePaths();
		const candidate = createVersionedCliFixture(paths, "1.2.8-test.1");
		pointManagedCliAt(paths, candidate);
		reconcilePendingRuntimeCliUpgrade(paths, candidate.version);
		const previous = createVersionedCliFixture(paths, "1.2.7-test.1");
		const state = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		state.previous = { activeTarget: previous.activeTarget, version: previous.version };
		writeFileSync(paths.cliBootstrapStatus, `${JSON.stringify(state)}\n`);
		pointManagedCliAt(paths, previous);

		expect(reconcilePendingRuntimeCliUpgrade(paths, candidate.version)).toEqual({
			status: "rolled_back",
			selfReexec: true,
		});
		const recovered = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		expect(recovered).toMatchObject({
			activeTarget: previous.activeTarget,
			version: previous.version,
			previous: null,
			bad: { version: candidate.version, attempts: 1 },
		});
		expect(readlinkSync(paths.cliManagedBin)).toBe(previous.activeTarget);
		expect(existsSync(candidate.npmPrefix)).toBe(false);
	});

	it("keeps the active CLI and backs off when the candidate fails verification", () => {
		const stateRoot = join(root, "state-cli-verification-failure");
		const runRoot = join(root, "run-cli-verification-failure");
		const bin = join(root, "bin-cli-verification-failure");
		const npmLog = join(root, "npm-cli-verification-failure.log");
		const previousPath = process.env.PATH;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = stateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "npm"),
			`#!/usr/bin/env bash
	set -euo pipefail
	printf '%s\\n' "$*" >> '${npmLog}'
	prefix=""
	while [ "$#" -gt 0 ]; do
	  if [ "$1" = "--prefix" ]; then prefix="$2"; shift 2; else shift; fi
	done
	install -d "$prefix/bin"
	cat > "$prefix/bin/clawdi" <<'SH'
	#!/usr/bin/env bash
	if [ "\${1:-}" = "--version" ]; then echo "9.9.9-test.1"; exit 0; fi
	if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then echo '{"status":"ok"}'; exit 0; fi
	exit 64
	SH
	chmod +x "$prefix/bin/clawdi"
	`,
		);
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		seedCurrentCliInstall(stateRoot, "1.2.9-test.1");
		const paths = getRuntimePaths();
		const previousTarget = readlinkSync(paths.cliManagedBin);

		try {
			const failed = applyRuntimeCliDesiredState(cliManifest("1.2.10-test.1"), paths);
			expect(failed.status).toBe("error");
			expect(failed.retryAt).toBeString();
			expect(readlinkSync(paths.cliManagedBin)).toBe(previousTarget);
			expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"))).toMatchObject({
				activeTarget: previousTarget,
				version: "1.2.9-test.1",
				bad: { version: "1.2.10-test.1", attempts: 1, retryAt: failed.retryAt },
			});
			expect(applyRuntimeCliDesiredState(cliManifest("1.2.10-test.1"), paths).status).toBe(
				"deferred",
			);
			expect(readFileSync(npmLog, "utf-8").trim().split("\n")).toHaveLength(1);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime init applies remote channels and caches canonical state", async () => {
		installSuccessfulSystemctlFixture();
		setRuntimeApplyGeneration(7, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "host-policy.json");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawUnit = join(home, ".config", "systemd", "user", "openclaw-gateway.service");
		const openclawPatch = join(root, "openclaw-channel-patch.json");
		const openclawPatchArgs = join(root, "openclaw-channel-patch-args.txt");
		const openclawPluginInstalls = join(root, "openclaw-plugin-installs.txt");
		const openclawPluginSource = join(home, ".openclaw", "extensions", "discord", "index.js");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		mkdirSync(join(home, ".openclaw"), { recursive: true });
		mkdirSync(join(root, "etc", "clawdi"), { recursive: true });
		writeFileSync(
			join(home, ".openclaw", "openclaw.json"),
			`${JSON.stringify(
				{
					channels: {
						discord: {
							accounts: {
								clawdi_acctdiscord1: {
									enabled: false,
									token: "user-token",
									dmPolicy: "allowlist",
									allowFrom: ["discord-user"],
									guilds: { "discord-guild": { requireMention: true } },
								},
								stale: { enabled: true, token: "stale-token" },
							},
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"${join(home, ".openclaw", "workspace")}"}]\\n'
  exit 0
fi
if [ "$*" = "plugins install --help" ]; then
  printf '%s\\n' '--accept-capabilities'
  exit 0
fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  printf '%s\n' "$*" >> '${openclawPatchArgs}'
  cat >> '${openclawPatch}'
  printf '\\n---\\n' >> '${openclawPatch}'
  exit 0
fi
if [ "$*" = "plugins install @openclaw/discord --force --accept-capabilities" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  mkdir -p '${dirname(openclawPluginSource)}'
  printf '%s\\n' 'export const discordPlugin = true;' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect discord --json" ]; then
  printf '%s\\n' '${JSON.stringify(openClawDiscordPluginInspectFixture(openclawPluginSource))}'
  exit 0
fi
if [ "$*" = "gateway install --force --json" ]; then
  mkdir -p '${dirname(openclawUnit)}'
  printf '%s\\n' '[Unit]' '[Service]' 'ExecStart=${openclawBin} gateway run' > '${openclawUnit}'
  printf '{"ok":true}\\n'
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
		);
		chmodSync(openclawBin, 0o700);
		writeFileSync(
			policyPath,
			JSON.stringify({
				schemaVersion: "clawdi.hostPolicy.v1",
				mode: "hosted-runtime",
				cliUpdateMode: "system-managed-npm",
				deniedCommands: ["setup", "teardown", "update"],
			}),
		);
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_HOST_POLICY_PATH = policyPath;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		const paths = getRuntimePaths();
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_init",
								environmentId: "env_init",
								...hostedRequiredState(),
								instanceId: "iid_init",
								generation: 7,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: TEST_RUNNING_CLI_SPEC,
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							channelBindings: [
								{
									provider: "telegram",
									accountKey: "clawdi_accttelegram",
									agentTokenSecretRef: "secret://channels/telegram/clawdi_accttelegram/agent-token",
									placeholderTokenSecretRef:
										"secret://channels/telegram/clawdi_accttelegram/placeholder-token",
								},
								{
									provider: "discord",
									accountKey: "clawdi_acctdiscord1",
									agentTokenSecretRef: "secret://channels/discord/clawdi_acctdiscord1/agent-token",
									placeholderTokenSecretRef:
										"secret://channels/discord/clawdi_acctdiscord1/placeholder-token",
								},
							],
							secretValues: {
								"secret://channels/telegram/clawdi_accttelegram/agent-token": "agent-token-init",
								"secret://channels/telegram/clawdi_accttelegram/placeholder-token":
									"999999999:00000000000000000000000000000000",
								"secret://channels/discord/clawdi_acctdiscord1/agent-token":
									"discord-agent-token-init",
								"secret://channels/discord/clawdi_acctdiscord1/placeholder-token":
									"clawdi_00000000000000000000000000000000",
							},
						},
						{ etag: testBundleEtag("manifest-etag-init-7") },
					),
			},
		]);

		try {
			await runtimeInit({ nonInteractive: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(process.exitCode).toBe(0);
			expect(captured).toHaveLength(1);
			expect(captured[0].path).toBe("/v1/runtime/manifest");
			expect(readRuntimeAppliedState(paths)).toMatchObject({
				etag: testBundleEtag("manifest-etag-init-7"),
				generation: 7,
			});
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
			const patchText = readFileSync(openclawPatch, "utf-8");
			expect(patchText).not.toContain('"$patch"');
			expect(patchText).toContain('"telegram"');
			expect(patchText).toContain('"botToken": {');
			expect(patchText).toContain(
				'"id": "CLAWDI_CHANNEL_TELEGRAM_CLAWDI_ACCTTELEGRAM_AGENT_TOKEN"',
			);
			expect(patchText).not.toContain("agent-token-init");
			expect(patchText).toContain('"discord"');
			expect(patchText).toContain('"token": {');
			expect(patchText).toContain('"id": "CLAWDI_CHANNEL_DISCORD_CLAWDI_ACCTDISCORD1_AGENT_TOKEN"');
			expect(patchText).not.toContain("discord-agent-token-init");
			expect(patchText).toContain('"default": {');
			expect(patchText).toContain('"source": "env"');
			expect(patchText).toContain('"plugins"');
			expect(patchText).toContain('"dmScope": "per-account-channel-peer"');
			expect(patchText).not.toContain('"streaming"');
			expect(readFileSync(openclawPatchArgs, "utf-8")).toContain(
				"config patch --stdin --replace-path channels.telegram.accounts --replace-path channels.discord.accounts",
			);
			const isolationPatch = patchText
				.split("\n---\n")
				.filter((entry) => entry.trim().length > 0)
				.map((entry): unknown => JSON.parse(entry))
				.map((entry) => expectRecord(entry, "OpenClaw config patch"))
				.find((entry) => entry.session !== undefined);
			if (!isolationPatch) throw new Error("OpenClaw session isolation patch was not rendered");
			const sessionPatch = expectRecord(isolationPatch.session, "OpenClaw session patch");
			expect(sessionPatch).toEqual({ dmScope: "per-account-channel-peer" });
			const channelPatch = patchText
				.split("\n---\n")
				.filter((entry) => entry.trim().length > 0)
				.map((entry): unknown => JSON.parse(entry))
				.map((entry) => expectRecord(entry, "OpenClaw config patch"))
				.find((entry) => recordValue(entry.channels)?.telegram !== undefined);
			if (!channelPatch) throw new Error("OpenClaw channel patch was not rendered");
			const patchedChannels = expectRecord(channelPatch.channels, "OpenClaw channel patch");
			const discordAccounts = expectRecord(
				expectRecord(patchedChannels.discord, "OpenClaw Discord patch").accounts,
				"OpenClaw Discord accounts",
			);
			const discordAccount = expectRecord(
				discordAccounts.clawdi_acctdiscord1,
				"OpenClaw Discord account",
			);
			expect(discordAccount).toMatchObject({
				enabled: true,
				token: {
					source: "env",
					provider: "default",
					id: "CLAWDI_CHANNEL_DISCORD_CLAWDI_ACCTDISCORD1_AGENT_TOKEN",
				},
				dmPolicy: "allowlist",
				allowFrom: ["discord-user"],
				guilds: { "discord-guild": { requireMention: true } },
			});
			expect(Object.keys(discordAccounts)).toEqual(["clawdi_acctdiscord1"]);
			for (const current of ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"]) {
				expect({ dmScope: current, resetTriggers: ["/new"], ...sessionPatch }).toEqual({
					dmScope: "per-account-channel-peer",
					resetTriggers: ["/new"],
				});
			}
			expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe(
				"plugins install @openclaw/discord --force --accept-capabilities\n",
			);
			const openclawRunConfig = JSON.parse(
				readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
			);
			expect(openclawRunConfig.secretEnv).toMatchObject({
				CLAWDI_CHANNEL_TELEGRAM_CLAWDI_ACCTTELEGRAM_AGENT_TOKEN:
					"secret://channels/telegram/clawdi_accttelegram/placeholder-token",
				CLAWDI_CHANNEL_DISCORD_CLAWDI_ACCTDISCORD1_AGENT_TOKEN:
					"secret://channels/discord/clawdi_acctdiscord1/placeholder-token",
			});
			expect(existsSync(join(run, "secrets", "runtime-secrets.json"))).toBe(false);
			const gatewayEnv = readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway");
			expect(gatewayEnv).toContain("999999999:00000000000000000000000000000000");
			expect(gatewayEnv).toContain("clawdi_00000000000000000000000000000000");
			expect(gatewayEnv).not.toContain("agent-token-init");
			expect(gatewayEnv).not.toContain("discord-agent-token-init");
			const egressSecretsText = readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8");
			expect(egressSecretsText).toContain("agent-token-init");
			expect(egressSecretsText).toContain("discord-agent-token-init");
			const cachedManifestText = readFileSync(paths.manifestLastGood, "utf-8");
			const cachedManifest = JSON.parse(cachedManifestText);
			expect(cachedManifest).toMatchObject({
				schemaVersion: "clawdi.hosted-runtime.bundle.v2",
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					generation: 7,
				},
				channelBindings: [{ provider: "telegram" }, { provider: "discord" }],
				secretValues: {},
			});
			expect(cachedManifestText).not.toContain("agent-token-init");
			expect(cachedManifestText).not.toContain("discord-agent-token-init");
			expect(statSync(paths.manifestLastGood).mode & 0o777).toBe(0o600);
			const cachedSecretsText = readFileSync(paths.managedSecretCacheFile, "utf-8");
			expect(cachedSecretsText).toContain("placeholder-token");
			expect(cachedSecretsText).toContain("999999999:");
			expect(cachedSecretsText).toContain("clawdi_");
			expect(cachedSecretsText).toContain("agent-token-init");
			expect(cachedSecretsText).toContain("discord-agent-token-init");
			expect(statSync(paths.managedSecretCacheFile).mode & 0o777).toBe(0o600);
			const profileBundleText = readFileSync(getRuntimePaths().egressProfileBundle, "utf-8");
			const profileBundle = JSON.parse(profileBundleText) as {
				profiles: Array<Record<string, unknown>>;
			};
			const telegramProfiles = profileBundle.profiles.filter((profile) =>
				String(profile.id).startsWith("native-telegram-"),
			);
			expect(telegramProfiles).toHaveLength(2);
			expect(telegramProfiles.map((profile) => profile.match)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ pathPrefix: "/bot" }),
					expect.objectContaining({ pathPrefix: "/file/bot" }),
				]),
			);
			for (const profile of telegramProfiles) {
				const rewrite = profile.rewrite as Record<string, unknown>;
				expect(rewrite.pathReplace).toBeUndefined();
				expect(rewrite.setHeaders).toEqual({
					authorization: {
						type: "secretRef",
						secretRef: "secret://channels/telegram/clawdi_accttelegram/agent-token",
						prefix: "Bearer ",
					},
				});
			}
			expect(profileBundleText).not.toContain("agent-token-init");
			expect(profileBundleText).not.toContain("replacementSecretRef");
			expect(profileBundleText).toContain("placeholder-token");
			const status = JSON.parse(logs[0] ?? "{}");
			expect(status.status).toBe("ok");
			expect(status.activeGeneration).toBe(7);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("runtime init records malformed bundle channel references as a boot error", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "host-policy.json");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		const bundle = JSON.parse(
			readFileSync(
				join(import.meta.dir, "../../../test-fixtures/runtime-bundle-v2.golden.json"),
				"utf-8",
			),
		) as {
			applyGeneration: number;
			sourceRevision: string;
			manifest: {
				clawdiCli: { packageSpec: string };
				runtime: string;
				system: Record<string, unknown>;
				runtimes: Record<string, unknown>;
			};
			channelBindings: Array<{ agentTokenSecretRef: string }>;
			secretValues: Record<string, string>;
		};
		const missingSecretRef = bundle.channelBindings[0]?.agentTokenSecretRef;
		if (!missingSecretRef) throw new Error("golden bundle has no channel binding");
		delete bundle.secretValues[missingSecretRef];
		bundle.sourceRevision = runtimeContentSha256({
			manifest: bundle.manifest,
			channelBindings: bundle.channelBindings,
			secretValues: bundle.secretValues,
		});
		setRuntimeApplyGeneration(bundle.applyGeneration);

		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(dirname(policyPath), { recursive: true });
		writeFileSync(
			policyPath,
			JSON.stringify({
				schemaVersion: "clawdi.hostPolicy.v1",
				mode: "hosted-runtime",
				cliUpdateMode: "system-managed-npm",
				deniedCommands: ["setup", "teardown", "update"],
			}),
		);
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_HOME = home;
		process.env.CLAWDI_HOST_POLICY_PATH = policyPath;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					new Response(JSON.stringify(bundle), {
						status: 200,
						headers: {
							"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
							etag: `"sha256:${bundle.sourceRevision}"`,
						},
					}),
			},
		]);

		try {
			await runtimeInit({ nonInteractive: true, json: true });

			const paths = getRuntimePaths();
			const status = JSON.parse(logs[0] ?? "{}");
			expect(status.status).toBe("error");
			expect(status.error).toContain(`runtime bundle is missing ${missingSecretRef}`);
			expect(status.stage).toBe("final");
			expect(process.exitCode).toBe(23);
			expect(JSON.parse(readFileSync(paths.bootStatus, "utf-8"))).toEqual(status);
			expect(existsSync(paths.appliedState)).toBe(false);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("keeps hosted Hermes channel projection under runtime HOME", () => {
		const home = join(root, "home", "clawdi");
		const ambientHome = join(root, "ambient-home");
		const ambientHermesConfig = join(ambientHome, ".hermes", "config.yaml");
		const ambientSentinel = "ambient-sentinel: unchanged\n";
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const hermesBin = join(home, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesBin), { recursive: true });
		mkdirSync(join(home, ".hermes"), { recursive: true });
		mkdirSync(dirname(ambientHermesConfig), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeHermesVersionBinary(home, "0.20.1");
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"custom_root: keep",
				"group_sessions_per_user: false",
				"thread_sessions_per_user: true",
				"streaming:",
				"  enabled: false",
				"telegram:",
				"  dm_policy: allowlist",
				"  group_policy: allowlist",
				'  allow_from: ["telegram-user"]',
				'  group_allow_from: ["telegram-group-user"]',
				'  group_allowed_chats: ["telegram-chat"]',
				"  require_mention: true",
				"  extra:",
				"    base_url: https://telegram.example.test/bot",
				"    base_file_url: https://telegram.example.test/file/bot",
				"discord:",
				"  dm_policy: pairing",
				"  group_policy: allowlist",
				'  allow_from: ["discord-user"]',
				'  group_allow_from: ["discord-group-user"]',
				"  require_mention: true",
				"  thread_require_mention: true",
				"  bots_require_inline_mention: true",
				'  free_response_channels: "123456789"',
				"  auto_thread: true",
				"display:",
				"  theme: user-theme",
				"  platforms:",
				"    discord:",
				"      streaming: false",
				"    telegram:",
				"      compact: true",
				"      streaming: false",
				"platforms:",
				"  telegram:",
				"    custom: keep-telegram",
				"    extra:",
				"      custom_extra: keep-extra",
				"      group_sessions_per_user: true",
				"      thread_sessions_per_user: true",
				"  discord:",
				"    custom: keep-discord",
				"",
			].join("\n"),
		);
		writeFileSync(ambientHermesConfig, ambientSentinel);
		process.env.HOME = ambientHome;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = home;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		const paths = getRuntimePaths();
		const telegramAccountKey = "clawdi_accttelegram";
		const telegramAgentRef = `secret://channels/telegram/${telegramAccountKey}/agent-token`;
		const telegramPlaceholderRef = `secret://channels/telegram/${telegramAccountKey}/placeholder-token`;
		const discordAccountKey = "clawdi_acctdiscordh";
		const discordAgentRef = `secret://channels/discord/${discordAccountKey}/agent-token`;
		const discordPlaceholderRef = `secret://channels/discord/${discordAccountKey}/placeholder-token`;
		const telegramBinding: RuntimeBundleChannelBinding = {
			provider: "telegram",
			accountKey: telegramAccountKey,
			agentTokenSecretRef: telegramAgentRef,
			placeholderTokenSecretRef: telegramPlaceholderRef,
		};
		const discordBinding: RuntimeBundleChannelBinding = {
			provider: "discord",
			accountKey: discordAccountKey,
			agentTokenSecretRef: discordAgentRef,
			placeholderTokenSecretRef: discordPlaceholderRef,
		};

		const load: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "hermes",
				deploymentId: "dep_hermes_channels",
				environmentId: "env_hermes_channels",
				instanceId: "iid_hermes_channels",
				generation: 12,
				issuedAt: "2026-07-07T00:00:00Z",
				workspaceRoot: workspace,
				controlPlane: { apiUrl: "https://cloud-api.test/" },
				egressEngine: seedMitmproxyCache(paths),
				runtimes: {
					hermes: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://hermes-agent.nousresearch.com/install.sh",
							home,
							args: [],
						},
						run: {
							args: ["gateway", "run"],
							env: {
								HERMES_EXISTING_ENV: "kept",
								WHATSAPP_ENABLED: "stale",
							},
							prependPath: [],
						},
						services: {},
					},
				},
				projection: {
					system: {},
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://hermes-channels",
			offline: false,
			secretValues: {
				[telegramAgentRef]: "123456789:telegram-agent-token",
				[telegramPlaceholderRef]: `999999999:${"a".repeat(32)}`,
				[discordAgentRef]: "discord-agent-token",
				[discordPlaceholderRef]: `clawdi_${"b".repeat(32)}`,
			},
			channelBindings: [telegramBinding, discordBinding],
		};

		const projected = applyRuntimeBundleChannelsToManifestLoad(load, paths);
		const convergence = convergeRuntimeManifest(projected, paths);

		expect(convergence.installErrors).toEqual([]);
		expect(paths.userHome).toBe(home);
		expect(readFileSync(ambientHermesConfig, "utf-8")).toBe(ambientSentinel);
		const hermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(hermesConfig).toContain("telegram:");
		expect(hermesConfig).toContain("enabled: true");
		expect(hermesConfig).toContain("discord:");
		expect(hermesConfig).toContain("thread_require_mention: true");
		expect(hermesConfig).not.toContain("telegram-agent-token");
		expect(hermesConfig).not.toContain("discord-agent-token");
		const parsedHermesConfig = readHermesConfigYaml(home);
		expect(parsedHermesConfig.streaming).toEqual({ enabled: false });
		expect(parsedHermesConfig.group_sessions_per_user).toBe(false);
		expect(parsedHermesConfig.thread_sessions_per_user).toBe(true);
		expect(parsedHermesConfig.telegram).toMatchObject({
			enabled: true,
			dm_policy: "allowlist",
			group_policy: "allowlist",
			allow_from: ["telegram-user"],
			group_allow_from: ["telegram-group-user"],
			group_allowed_chats: ["telegram-chat"],
			require_mention: true,
			extra: {
				base_url: "https://telegram.example.test/bot",
				base_file_url: "https://telegram.example.test/file/bot",
			},
		});
		expect(parsedHermesConfig.discord).toMatchObject({
			dm_policy: "pairing",
			group_policy: "allowlist",
			allow_from: ["discord-user"],
			group_allow_from: ["discord-group-user"],
			require_mention: true,
			thread_require_mention: true,
			bots_require_inline_mention: true,
			free_response_channels: "123456789",
			auto_thread: true,
		});
		expect(parsedHermesConfig).not.toHaveProperty("streaming.transport");
		expect(parsedHermesConfig).toMatchObject({
			custom_root: "keep",
			display: {
				theme: "user-theme",
				platforms: {
					discord: { streaming: false },
					telegram: { compact: true, streaming: false },
				},
			},
			platforms: {
				telegram: {
					custom: "keep-telegram",
					extra: {
						custom_extra: "keep-extra",
						group_sessions_per_user: true,
						thread_sessions_per_user: true,
					},
				},
				discord: { custom: "keep-discord" },
			},
		});

		const runConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "hermes.json"), "utf-8"),
		);
		expect(runConfig.env.HERMES_EXISTING_ENV).toBe("kept");
		expect(runConfig.env.TELEGRAM_ALLOW_ALL_USERS).toBe("true");
		expect(runConfig.env.DISCORD_ALLOW_ALL_USERS).toBe("true");
		expect(runConfig.env.HERMES_TELEGRAM_DISABLE_FALLBACK_IPS).toBe("true");
		expect(runConfig.secretEnv.TELEGRAM_BOT_TOKEN).toMatch(
			/^secret:\/\/channels\/telegram\/clawdi_accttelegram\/placeholder-token$/,
		);
		expect(runConfig.secretEnv.DISCORD_BOT_TOKEN).toMatch(
			/^secret:\/\/channels\/discord\/clawdi_acctdiscordh\/placeholder-token$/,
		);
		const hermesEnv = readSystemdEnvFile(getRuntimePaths(), "hermes-gateway");
		expect(hermesEnv).toMatch(/TELEGRAM_BOT_TOKEN="999999999:[a-f0-9]{32}"/);
		expect(hermesEnv).toMatch(/DISCORD_BOT_TOKEN="clawdi_[a-f0-9]{32}"/);
		expect(hermesEnv).not.toContain("telegram-agent-token");
		expect(hermesEnv).not.toContain("discord-agent-token");
		expect(hermesEnv).toContain('TELEGRAM_ALLOW_ALL_USERS="true"');
		expect(hermesEnv).toContain('DISCORD_ALLOW_ALL_USERS="true"');
		expect(hermesEnv).toContain('HERMES_TELEGRAM_DISABLE_FALLBACK_IPS="true"');
		const profileBundle = readFileSync(getRuntimePaths().egressProfileBundle, "utf-8");
		expect(profileBundle).toContain("/v1/channels/telegram");
		expect(profileBundle).toContain("/v1/channels/discord");

		const discordOnly = convergeRuntimeManifest(
			applyRuntimeBundleChannelsToManifestLoad(
				{ ...load, channelBindings: [discordBinding] },
				paths,
			),
			paths,
		);
		expect(discordOnly.installErrors).toEqual([]);
		const discordOnlyHermesConfig = readHermesConfigYaml(home);
		expect(discordOnlyHermesConfig.group_sessions_per_user).toBe(false);
		expect(discordOnlyHermesConfig.thread_sessions_per_user).toBe(true);
		expect(discordOnlyHermesConfig.telegram).toMatchObject({
			enabled: false,
			dm_policy: "allowlist",
			group_policy: "allowlist",
			allow_from: ["telegram-user"],
			group_allow_from: ["telegram-group-user"],
			group_allowed_chats: ["telegram-chat"],
			require_mention: true,
		});
		expect(discordOnlyHermesConfig).toHaveProperty(
			"platforms.telegram.extra.group_sessions_per_user",
			true,
		);
		expect(discordOnlyHermesConfig).toHaveProperty(
			"platforms.telegram.extra.thread_sessions_per_user",
			true,
		);

		const removed = convergeRuntimeManifest(
			applyRuntimeBundleChannelsToManifestLoad({ ...load, channelBindings: [] }, paths),
			paths,
		);
		expect(removed.installErrors).toEqual([]);
		const clearedHermesConfig = readHermesConfigYaml(home);
		expect(clearedHermesConfig.streaming).toEqual({ enabled: false });
		expect(clearedHermesConfig.discord).toMatchObject({
			dm_policy: "pairing",
			group_policy: "allowlist",
			allow_from: ["discord-user"],
			group_allow_from: ["discord-group-user"],
			require_mention: true,
			thread_require_mention: true,
			bots_require_inline_mention: true,
			free_response_channels: "123456789",
			auto_thread: true,
		});
		expect(clearedHermesConfig.group_sessions_per_user).toBe(false);
		expect(clearedHermesConfig.thread_sessions_per_user).toBe(true);
		expect(clearedHermesConfig).not.toHaveProperty("streaming.transport");
		expect(clearedHermesConfig).toMatchObject({
			custom_root: "keep",
			display: {
				theme: "user-theme",
				platforms: {
					discord: { streaming: false },
					telegram: { compact: true, streaming: false },
				},
			},
			platforms: {
				telegram: {
					custom: "keep-telegram",
					extra: {
						custom_extra: "keep-extra",
						group_sessions_per_user: true,
						thread_sessions_per_user: true,
					},
				},
				discord: { custom: "keep-discord" },
			},
		});
	}, 30_000);

	it("projects and removes Hermes native WhatsApp through the stock adapter config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const hermesBin = join(home, ".local", "bin", "hermes");
		const accountId = "00000000-0000-0000-0000-000000000001";
		const accountKey = "clawdi_000000000000";
		const linkId = "60000000-0000-4000-8000-000000000006";
		const credentialId = "80000000-0000-4000-8000-000000000011";
		const agentTokenSecretRef = `secret://channels/whatsapp/${accountKey}/links/${linkId}/agent-token`;
		const capabilitySecretRef = `secret://channels/whatsapp/${accountKey}/links/${linkId}/egress-capability`;
		const credentialSecretRef = `secret://channels/whatsapp/${accountKey}/credentials/${credentialId}/creds-json`;
		const capability = `clawdi_${"0".repeat(32)}`;
		const sessionDir = join(home, ".hermes", "platforms", "whatsapp", "session");
		const baileysSocket = join(hermesManagedBaileysRoot(home), "lib", "Socket", "socket.js");
		const legacySessionDir = join(home, ".hermes", "whatsapp", "session");
		const legacySentinel = join(legacySessionDir, "unmanaged-session-sentinel");
		const systemctlPath = join(root, "bin", "systemctl");
		const systemctlLog = join(root, "whatsapp-systemctl.log");
		const systemctlStateRoot = join(root, "whatsapp-systemctl-state");
		const creds = {
			advSecretKey: "wa-hermes-secret",
			me: { id: "15551234567:1@s.whatsapp.net" },
		};
		mkdirSync(dirname(hermesBin), { recursive: true });
		mkdirSync(join(home, ".hermes"), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeHermesVersionBinary(home, "0.20.1");
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"custom_root: keep",
				"whatsapp:",
				"  user_owned: keep-whatsapp",
				"  dm_policy: allowlist",
				'  allow_from: ["15550000001"]',
				"  group_policy: allowlist",
				'  group_allow_from: ["120363000000000000@g.us"]',
				"platforms:",
				"  matrix:",
				"    custom: keep-matrix",
				"  whatsapp:",
				"    custom: keep-platform",
				"    extra:",
				"      custom_extra: keep-extra",
				"      dm_policy: allowlist",
				'      allow_from: ["15550000001"]',
				"      group_policy: allowlist",
				'      group_allow_from: ["120363000000000000@g.us"]',
				"      group_sessions_per_user: true",
				"      thread_sessions_per_user: true",
				"",
			].join("\n"),
		);
		seedHermesManagedBaileys(home);
		writeFakeSystemdManager({
			path: systemctlPath,
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		const paths = getRuntimePaths();
		const retiredWhatsAppReceipt = join(paths.managedResourceRoot, "hermes-whatsapp.json");
		const retiredWhatsAppReceiptContent = '{"schemaVersion":"clawdi.managedHermesWhatsApp.v1"}\n';
		mkdirSync(dirname(retiredWhatsAppReceipt), { recursive: true });
		writeFileSync(retiredWhatsAppReceipt, retiredWhatsAppReceiptContent);
		mkdirSync(legacySessionDir, { recursive: true });
		writeFileSync(legacySentinel, "preserved\n");

		const load: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "hermes",
				deploymentId: "dep_hermes_whatsapp",
				environmentId: "env_hermes_whatsapp",
				instanceId: "iid_hermes_whatsapp",
				generation: 14,
				issuedAt: "2026-07-07T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test/" },
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@0.13.66",
					registry: "https://registry.npmjs.org",
				},
				egressEngine: seedMitmproxyCache(paths),
				runtimes: {
					hermes: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://hermes-agent.nousresearch.com/install.sh",
							home,
							args: [],
						},
						run: {
							args: ["gateway", "run"],
							env: { HERMES_EXISTING_ENV: "kept" },
							prependPath: [],
						},
						services: {},
					},
				},
				projection: {
					system: { home, workspace },
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://hermes-whatsapp",
			offline: false,
			secretValues: {
				[agentTokenSecretRef]: "wa-hermes-agent-token",
				[capabilitySecretRef]: capability,
				[credentialSecretRef]: JSON.stringify(creds),
			},
			channelBindings: [
				{
					provider: "whatsapp",
					accountId,
					accountKey,
					linkId,
					agentTokenSecretRef,
					placeholderTokenSecretRef: capabilitySecretRef,
					credential: {
						id: credentialId,
						credsSecretRef: credentialSecretRef,
						authCert: {
							SERIAL: 7,
							ISSUER: "clawdi",
							PUBLIC_KEY: {
								type: "Buffer",
								data: Buffer.alloc(32, 7).toString("base64"),
							},
						},
					},
				},
			],
		};

		const projected = applyRuntimeBundleChannelsToManifestLoad(load, paths);
		const credentialProjection = projected.manifest.projection?.channelCredentials as unknown[];
		expect(credentialProjection).toEqual([
			expect.objectContaining({
				provider: "whatsapp",
				kind: "whatsapp_baileys_auth_state",
				accountId,
				accountKey,
				linkId,
				credentialId,
				targets: { hermes: { authDir: sessionDir } },
			}),
		]);
		expect(JSON.stringify(projected.manifest)).not.toContain("wa-hermes-secret");
		expect(JSON.stringify(projected.manifest)).not.toContain("x-clawdi-whatsapp-link-capability");
		expect(projected.secretValues?.[capabilitySecretRef]).toBeUndefined();
		expect(projected.secretValues?.[credentialSecretRef]).toContain("wa-hermes-secret");
		expect(projected.manifest.projection?.channels).toMatchObject({
			whatsapp: {
				accounts: {
					[accountKey]: {
						dmPolicy: "allowlist",
						allowFrom: ["*"],
					},
				},
			},
		});
		expect(projected.manifest.runtimes.hermes?.run?.env).toMatchObject({
			HERMES_EXISTING_ENV: "kept",
			WHATSAPP_MODE: "bot",
			WHATSAPP_ALLOWED_USERS: "*",
			WHATSAPP_ALLOW_ALL_USERS: "true",
			WHATSAPP_DM_POLICY: "open",
			WHATSAPP_GROUP_POLICY: "open",
		});
		const convergence = convergeRuntimeManifest(projected, paths);
		expect(convergence.installErrors).toEqual([]);
		const egressSecrets = readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8");
		expect(egressSecrets).toContain(agentTokenSecretRef);
		expect(egressSecrets).not.toContain(capabilitySecretRef);
		expect(readFileSync(retiredWhatsAppReceipt, "utf8")).toBe(retiredWhatsAppReceiptContent);
		expect(projected.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ENABLED).toBeUndefined();
		expect(readSystemdEnvFile(paths, "hermes-gateway")).not.toContain("WHATSAPP_ENABLED");
		expect(existsSync(sessionDir)).toBe(true);
		expect(readFileSync(legacySentinel, "utf-8")).toBe("preserved\n");
		expect(readHermesConfigYaml(home)).toMatchObject({
			whatsapp: {
				dm_policy: "allowlist",
				allow_from: ["15550000001"],
				group_policy: "allowlist",
				group_allow_from: ["120363000000000000@g.us"],
			},
			platforms: {
				whatsapp: {
					extra: {
						session_path: sessionDir,
						dm_policy: "allowlist",
						allow_from: ["15550000001"],
						group_policy: "allowlist",
						group_allow_from: ["120363000000000000@g.us"],
						group_sessions_per_user: true,
						thread_sessions_per_user: true,
					},
				},
			},
		});
		const initialHermesRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));
		const hermesDropIn = join(
			paths.systemdUserRoot,
			"hermes-gateway.service.d",
			"10-clawdi-hosted.conf",
		);
		const initialHermesDropInInode = statSync(hermesDropIn).ino;
		const initialUnits = readSystemdUnitSnapshot(paths);
		writeTestRuntimeAppliedState(paths, projected, convergence);
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, initialUnits);
		for (const unit of initialUnits.user.keys()) {
			writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
		}

		const unrelatedSecret = convergeRuntimeManifest(
			{
				...projected,
				secretValues: { ...projected.secretValues, "secret://unrelated": "changed" },
			},
			paths,
		);
		expect(unrelatedSecret.installErrors).toEqual([]);
		expect(statSync(hermesDropIn).ino).toBe(initialHermesDropInInode);
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		expect(
			applySystemdRuntimeUpdate(paths, initialUnits, readSystemdUnitSnapshot(paths), {}),
		).toMatchObject({ applied: true, systemUnitsChanged: [], userUnitsChanged: [] });
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).toBe(
			initialHermesRevision,
		);

		const projectedCreds = JSON.parse(
			projected.secretValues?.[credentialSecretRef] ?? "null",
		) as Record<string, unknown>;
		const beforeCredentialChange = readSystemdUnitSnapshot(paths);
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		const changedCheckpoint: RuntimeManifestLoad = {
			...projected,
			manifest: {
				...projected.manifest,
				clawdiCli: {
					...projected.manifest.clawdiCli,
					packageSpec: "clawdi@0.13.67",
				},
			},
			secretValues: {
				...projected.secretValues,
				[credentialSecretRef]: JSON.stringify({
					...projectedCreds,
					advSecretKey: "wa-hermes-secret-rotated",
				}),
			},
		};
		const changedCredential = convergeRuntimeManifest(changedCheckpoint, paths);
		expect(changedCredential.installErrors).toEqual([]);
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).not.toBe(
			initialHermesRevision,
		);
		writeFileSync(systemctlLog, "");
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		expect(
			applySystemdRuntimeUpdate(paths, beforeCredentialChange, readSystemdUnitSnapshot(paths), {}),
		).toMatchObject({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: ["hermes-gateway.service"],
		});
		const systemctlCalls = readFileSync(systemctlLog, "utf-8");
		expect(systemctlCalls).toContain("--user restart hermes-gateway.service");

		const removed = applyRuntimeBundleChannelsToManifestLoad(
			{ ...load, channelBindings: [], secretValues: {} },
			paths,
		);
		const patchedSocket = readFileSync(baileysSocket, "utf8");
		writeFileSync(
			baileysSocket,
			patchedSocket.replace(
				"DEFAULT_CONNECTION_CONFIG.waWebSocketUrl",
				"DRIFTED_CONNECTION_CONFIG.waWebSocketUrl",
			),
		);
		const blockedRemoval = convergeRuntimeManifest(removed, paths);
		expect(blockedRemoval.installErrors.join("\n")).toContain(
			"runtime managed WhatsApp compatibility cleanup failed",
		);
		expect(readFileSync(paths.egressProfileBundle, "utf8")).toContain(
			"native-whatsapp-baileys-managed",
		);

		writeFileSync(baileysSocket, patchedSocket);
		const removedConvergence = convergeRuntimeManifest(removed, paths);
		expect(removedConvergence.installErrors).toEqual([]);
		expect(existsSync(paths.egressProfileBundle)).toBe(false);
		expect(existsSync(sessionDir)).toBe(false);
		const removedHermesConfig = readHermesConfigYaml(home);
		expect(removedHermesConfig).toHaveProperty("whatsapp", {
			user_owned: "keep-whatsapp",
			dm_policy: "allowlist",
			allow_from: ["15550000001"],
			group_policy: "allowlist",
			group_allow_from: ["120363000000000000@g.us"],
			enabled: false,
		});
		expect(removedHermesConfig).toHaveProperty("platforms.whatsapp", {
			custom: "keep-platform",
			enabled: false,
			extra: {
				custom_extra: "keep-extra",
				dm_policy: "allowlist",
				allow_from: ["15550000001"],
				group_policy: "allowlist",
				group_allow_from: ["120363000000000000@g.us"],
				group_sessions_per_user: true,
				thread_sessions_per_user: true,
			},
		});
		expect(removedHermesConfig).toMatchObject({
			custom_root: "keep",
			platforms: { matrix: { custom: "keep-matrix" } },
		});
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_MODE).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ENABLED).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ALLOWED_USERS).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ALLOW_ALL_USERS).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_DM_POLICY).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_GROUP_POLICY).toBeUndefined();
		expect(readSystemdEnvFile(paths, "hermes-gateway")).not.toContain("WHATSAPP_ENABLED");
		const removedHermesRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));

		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"whatsapp:",
				"  enabled: true",
				"  user_owned: manual",
				"platforms:",
				"  whatsapp:",
				"    enabled: true",
				"    extra:",
				"      session_path: /user/session",
				"",
			].join("\n"),
		);
		const driftRepair = convergeRuntimeManifest(removed, paths);
		expect(driftRepair.installErrors).toEqual([]);
		expect(readHermesConfigYaml(home)).toMatchObject({
			whatsapp: { enabled: false, user_owned: "manual" },
			platforms: { whatsapp: { enabled: false } },
		});
		expect(readHermesConfigYaml(home)).not.toHaveProperty("platforms.whatsapp.extra.session_path");
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).toBe(
			removedHermesRevision,
		);
		const repairedConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
		expect(convergeRuntimeManifest(removed, paths).installErrors).toEqual([]);
		expect(readFileSync(join(home, ".hermes", "config.yaml"), "utf8")).toBe(repairedConfig);
	}, 60_000);

	it("isolates OpenClaw WhatsApp DMs with the legacy plugin CLI", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-channel-delete-patch.jsonl");
		const openclawPluginInstalls = join(root, "openclaw-whatsapp-plugin-installs.txt");
		const openclawPluginSource = join(
			home,
			".openclaw",
			"extensions",
			"whatsapp",
			"dist",
			"index.js",
		);
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >> '${openclawPatch}'
  printf '\\n---\\n' >> '${openclawPatch}'
  exit 0
fi
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw 2026.7.1-2\\n'
  exit 0
fi
if [ "$*" = "plugins install clawhub:@openclaw/whatsapp@2026.7.1 --force" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  mkdir -p '${dirname(openclawPluginSource)}'
  printf 'export const whatsappPlugin = true;\\n' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect whatsapp --json" ]; then
  printf '%s\\n' '${JSON.stringify(openClawWhatsAppPluginInspectFixture(openclawPluginSource))}'
  exit 0
fi
exit 0
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 8);
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			channels: {
				whatsapp: {
					enabled: true,
					defaultAccount: "clawdi_whatsapp",
					accounts: {
						clawdi_whatsapp: {
							enabled: true,
							authDir: join(home, ".openclaw", "credentials", "whatsapp"),
						},
					},
				},
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
		const unchangedConvergence = convergeRuntimeManifest(loaded, getRuntimePaths());
		const removed: RuntimeManifestLoad = {
			...loaded,
			manifest: {
				...loaded.manifest,
				generation: 9,
				projection: { ...loaded.manifest.projection, channels: {} },
			},
		};
		const removedConvergence = convergeRuntimeManifest(removed, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(unchangedConvergence.installErrors).toEqual([]);
		expect(removedConvergence.installErrors).toEqual([]);
		expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe(
			"plugins install clawhub:@openclaw/whatsapp@2026.7.1 --force\n",
		);
		const patches = readFileSync(openclawPatch, "utf-8")
			.split("\n---\n")
			.filter((entry) => entry.trim().length > 0)
			.map((entry) => JSON.parse(entry))
			.filter((patch) => Object.hasOwn(patch, "channels"));
		expect(patches).toHaveLength(3);
		expect(patches[0].channels.whatsapp.accounts).toHaveProperty("clawdi_whatsapp");
		expect(patches[0].channels.whatsapp.accounts.clawdi_whatsapp.authDir).toBe(
			join(home, ".openclaw", "credentials", "whatsapp"),
		);
		expect(patches[0].session).toEqual({ dmScope: "per-account-channel-peer" });
		expect(patches[2].channels.whatsapp).toBeNull();
		expect(patches[2].session).toEqual({ dmScope: null });
	});

	it("reinstalls OpenClaw WhatsApp when the installed version differs", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPluginSource = join(
			home,
			".openclaw",
			"extensions",
			"whatsapp",
			"dist",
			"index.js",
		);
		const openclawPluginInstalls = join(root, "openclaw-whatsapp-plugin-installs.txt");
		const installedMarker = join(root, "whatsapp-plugin-reinstalled");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(dirname(openclawPluginSource), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(openclawPluginSource, "export const whatsappPlugin = true;\n");
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw 2026.7.1-2\\n'
  exit 0
fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >/dev/null
  exit 0
fi
if [ "$*" = "plugins install clawhub:@openclaw/whatsapp@2026.7.1 --force" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  touch '${installedMarker}'
  exit 0
fi
if [ "$*" = "plugins inspect whatsapp --json" ]; then
  if [ -f '${installedMarker}' ]; then
    printf '%s\\n' '${JSON.stringify(openClawWhatsAppPluginInspectFixture(openclawPluginSource))}'
  else
    printf '%s\\n' '${JSON.stringify(openClawWhatsAppPluginInspectFixture(openclawPluginSource, "2026.8.2"))}'
  fi
  exit 0
fi
exit 0
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 10);
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			channels: {
				whatsapp: {
					enabled: true,
					defaultAccount: "clawdi_whatsapp",
					accounts: {
						clawdi_whatsapp: {
							enabled: true,
							authDir: join(home, ".openclaw", "credentials", "whatsapp"),
						},
					},
				},
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe(
			"plugins install clawhub:@openclaw/whatsapp@2026.7.1 --force\n",
		);
	});

	it("does not mutate live config when an OpenClaw channel plugin install fails", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "$*" = "plugins install --help" ]; then
  printf '%s\\n' '--accept-capabilities'
  exit 0
fi
if [ "$*" = "plugins install @openclaw/discord --force --accept-capabilities" ]; then
  echo "plugin install failed" >&2
  exit 73
fi
exit 0
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		const paths = getRuntimePaths();
		const liveFiles = [
			join(paths.runConfigRoot, "openclaw.json"),
			join(paths.runConfigRoot, "stale-runtime.json"),
			join(paths.systemdUserRoot, "openclaw-gateway.service"),
		];
		for (const path of liveFiles) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `generation-1:${path.split("/").at(-1)}\n`);
		}
		const previousLiveSnapshot = Object.fromEntries(
			liveFiles.map((path) => [path, readFileSync(path, "utf-8")]),
		);
		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 2);
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			channels: {
				discord: {
					enabled: true,
					accounts: { default: { enabled: true } },
				},
			},
		};

		const convergence = convergeRuntimeManifest(loaded, paths);

		expect(convergence.installErrors.join("\n")).toContain(
			"runtime openclaw channel plugin install failed",
		);
		expect(convergence.outputs.systemdSystemUnits).toEqual([]);
		expect(convergence.outputs.systemdUserUnits).toEqual([]);
		for (const [path, content] of Object.entries(previousLiveSnapshot)) {
			expect(readFileSync(path, "utf-8")).toBe(content);
		}
	});

	it("materializes, rotates, and removes OpenClaw managed WhatsApp auth", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const workspace = join(home, "clawdi");
		const accountKey = "clawdi_whatsapp_runtime";
		const accountId = "00000000-0000-0000-0000-000000000001";
		const authDir = join(home, ".openclaw", "credentials", "whatsapp", accountKey);
		mkdirSync(workspace, { recursive: true });
		mkdirSync(state, { recursive: true });
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		const managedMetadata = {
			schemaVersion: "clawdi.managedWhatsAppSocket.v1",
			authCert: {
				SERIAL: 7,
				ISSUER: "clawdi",
				PUBLIC_KEY: {
					type: "Buffer",
					data: Buffer.alloc(32, 7).toString("base64"),
				},
			},
		};

		const credentialSecretRef = (credentialId: string) =>
			`secret://channels/whatsapp/${accountKey}/credentials/${credentialId}/creds-json`;
		const manifestWithCredential = (
			credentialId: string,
			creds: Record<string, unknown>,
			generation: number,
		): RuntimeManifestLoad => {
			const secretRef = credentialSecretRef(credentialId);
			return {
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_whatsapp_auth_state",
					environmentId: "env_whatsapp_auth_state",
					instanceId: "iid_whatsapp_auth_state",
					generation,
					issuedAt: "2026-07-07T00:00:00Z",
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: {
							enabled: true,
							install: {
								authority: "official",
								method: "official-installer",
								url: "https://openclaw.ai/install-cli.sh",
								home,
								args: [],
							},
						},
					},
					projection: {
						system: { home, workspace },
						channels: {
							whatsapp: {
								enabled: true,
								defaultAccount: accountKey,
								accounts: {
									[accountKey]: {
										enabled: true,
										authDir,
									},
								},
							},
						},
						channelCredentials: [
							{
								provider: "whatsapp",
								kind: "whatsapp_baileys_auth_state",
								accountId,
								accountKey,
								linkId: "link-whatsapp-runtime",
								credentialId,
								files: [{ path: "creds.json", secretRef }],
								targets: { openclaw: { authDir } },
							},
						],
					},
					recovery: {},
				},
				source: "remote-datasource",
				sourcePath: `test://whatsapp-auth-state-${generation}`,
				offline: false,
				secretValues: { [secretRef]: JSON.stringify(creds) },
			};
		};
		const unlinkedManifest: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_whatsapp_auth_state",
				environmentId: "env_whatsapp_auth_state",
				instanceId: "iid_whatsapp_auth_state",
				generation: 12,
				issuedAt: "2026-07-07T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: [],
						},
					},
				},
				projection: {
					system: { home, workspace },
					channels: {},
					channelCredentials: [],
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://whatsapp-auth-state-unlinked",
			offline: false,
			secretValues: {},
		};

		const initialCreds = {
			advSecretKey: "wa-materialized-secret",
			me: { id: "15551234567:1@s.whatsapp.net" },
			noiseKey: { private: { type: "Buffer", data: "AQID" } },
			additionalData: {
				"clawdi.managedWhatsAppSocket": managedMetadata,
				"clawdi.managedWhatsAppCredential": {
					schemaVersion: "clawdi.managedWhatsAppCredential.v1",
					credentialId: "credential-whatsapp-1",
				},
			},
		};
		const rotatedCreds = {
			advSecretKey: "wa-rotated-secret",
			me: { id: "15557654321:1@s.whatsapp.net" },
			noiseKey: { private: { type: "Buffer", data: "BAUG" } },
			additionalData: {
				"clawdi.managedWhatsAppSocket": managedMetadata,
				"clawdi.managedWhatsAppCredential": {
					schemaVersion: "clawdi.managedWhatsAppCredential.v1",
					credentialId: "credential-whatsapp-2",
				},
			},
		};

		const initial = manifestWithCredential("credential-whatsapp-1", initialCreds, 10);
		materializeHostedChannelCredentials(initial.manifest, initial.secretValues, home);
		expect(readFileSync(join(authDir, "creds.json"), "utf8")).toContain("wa-materialized-secret");
		writeFileSync(join(authDir, "session-key.json"), '{"stale":true}\n');

		const rotated = manifestWithCredential("credential-whatsapp-2", rotatedCreds, 11);
		materializeHostedChannelCredentials(rotated.manifest, rotated.secretValues, home);
		const rotatedFile = readFileSync(join(authDir, "creds.json"), "utf8");
		expect(rotatedFile).toContain("wa-rotated-secret");
		expect(rotatedFile).not.toContain("wa-materialized-secret");
		expect(readdirSync(authDir)).toEqual(["creds.json"]);

		materializeHostedChannelCredentials(
			unlinkedManifest.manifest,
			unlinkedManifest.secretValues,
			home,
		);
		expect(existsSync(authDir)).toBe(false);
	});

	it("preserves the last good OpenClaw WhatsApp auth when the next secret is missing", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const accountKey = "clawdi_missing_whatsapp";
		const authDir = join(home, ".openclaw", "credentials", "whatsapp", accountKey);
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-whatsapp-missing-secret-patch.jsonl");
		const openclawPluginInstalls = join(root, "openclaw-whatsapp-missing-secret-installs.txt");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		mkdirSync(authDir, { recursive: true });
		writeFileSync(
			join(authDir, "creds.json"),
			`${JSON.stringify({ advSecretKey: "stale-whatsapp-secret" })}\n`,
		);
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >> '${openclawPatch}'
  printf '\\n---\\n' >> '${openclawPatch}'
  exit 0
fi
if [ "$*" = "plugins install clawhub:@openclaw/whatsapp --force --accept-capabilities" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const missingSecretRef = `secret://channels/whatsapp/${accountKey}/credentials/credential-missing/creds-json`;
		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 9);
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			channels: {
				whatsapp: {
					enabled: true,
					defaultAccount: accountKey,
					accounts: { [accountKey]: { enabled: true, authDir } },
				},
			},
			channelCredentials: [
				{
					provider: "whatsapp",
					kind: "whatsapp_baileys_auth_state",
					accountKey,
					credentialId: "credential-missing",
					files: [{ path: "creds.json", secretRef: missingSecretRef }],
					targets: { openclaw: { authDir } },
				},
			],
		};

		expect(() => convergeRuntimeManifest(loaded, getRuntimePaths())).toThrow(
			`missing WhatsApp auth state secret for ${accountKey}/credential-missing`,
		);
		expect(existsSync(authDir)).toBe(true);
		expect(readFileSync(join(authDir, "creds.json"), "utf8")).toContain("stale-whatsapp-secret");
		expect(existsSync(openclawPatch)).toBe(false);
		expect(existsSync(openclawPluginInstalls)).toBe(false);
	});

	it("removes stale native channels when a later projection omits them", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-channel-remove-patch.jsonl");
		const openclawPluginInstalls = join(root, "openclaw-plugin-installs.txt");
		const openclawPluginSource = join(home, ".openclaw", "extensions", "discord", "index.js");
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
if [ "$*" = "plugins install --help" ]; then
  printf '%s\\n' '--accept-capabilities'
  exit 0
fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >> '${openclawPatch}'
  printf '\\n---\\n' >> '${openclawPatch}'
  exit 0
fi
if [ "$*" = "plugins install @openclaw/discord --force --accept-capabilities" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  mkdir -p '${dirname(openclawPluginSource)}'
  printf '%s\\n' 'export const discordPlugin = true;' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect discord --json" ]; then
  printf '%s\\n' '${JSON.stringify(openClawDiscordPluginInspectFixture(openclawPluginSource))}'
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const manifestWithChannels = (
			channels: Record<string, unknown>,
			generation: number,
		): RuntimeManifestLoad => {
			const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", generation);
			loaded.manifest.projection = { ...loaded.manifest.projection, channels };
			return loaded;
		};
		const telegramChannel = {
			enabled: true,
			defaultAccount: "default",
			accounts: { default: { enabled: true, botToken: "telegram-token" } },
		};

		const initial = convergeRuntimeManifest(
			manifestWithChannels(
				{
					telegram: telegramChannel,
					discord: { enabled: true, token: "discord-token" },
				},
				1,
			),
			getRuntimePaths(),
		);
		const removed = convergeRuntimeManifest(
			manifestWithChannels({ telegram: telegramChannel }, 2),
			getRuntimePaths(),
		);
		const unlinked = convergeRuntimeManifest(manifestWithChannels({}, 3), getRuntimePaths());

		expect(initial.installErrors).toEqual([]);
		expect(removed.installErrors).toEqual([]);
		expect(unlinked.installErrors).toEqual([]);
		const patches = readFileSync(openclawPatch, "utf-8")
			.split("\n---\n")
			.filter((entry) => entry.trim().length > 0)
			.map((entry) => JSON.parse(entry))
			.filter((patch) => Object.hasOwn(patch, "channels"));
		expect(patches).toHaveLength(3);
		expect(patches[0].channels.discord).toEqual({ enabled: true, token: "discord-token" });
		expect(patches[0].session).toEqual({ dmScope: "per-account-channel-peer" });
		expect(patches[1].channels.discord).toBeNull();
		expect(patches[1].plugins.entries.discord).toBeNull();
		expect(patches[1].channels.telegram).toEqual(telegramChannel);
		expect(patches[2].session).toEqual({ dmScope: null });
		expect(patches[2].channels.telegram).toBeNull();
		expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe(
			"plugins install @openclaw/discord --force --accept-capabilities\n",
		);
	});

	it("keeps an already-installed OpenClaw channel plugin with verified provenance", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-channel-patch.json");
		const openclawPluginInstalls = join(root, "openclaw-plugin-installs.txt");
		const openclawPluginSource = join(home, ".openclaw", "extensions", "discord", "index.js");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(dirname(openclawPluginSource), { recursive: true });
		writeFileSync(openclawPluginSource, "export const discordPlugin = true;\n");
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
if [ "$*" = "plugins install --help" ]; then
  printf '%s\\n' '--accept-capabilities'
  exit 0
fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat > '${openclawPatch}'
  exit 0
fi
if [ "$*" = "plugins install @openclaw/discord --force --accept-capabilities" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  printf '%s\\n' 'export const discordPlugin = true;' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect discord --json" ]; then
  printf '%s\\n' '${JSON.stringify(openClawDiscordPluginInspectFixture(openclawPluginSource))}'
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 2);
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			channels: {
				discord: { token: "secret://channels/discord/acct-discord-1" },
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(existsSync(openclawPluginInstalls)).toBe(false);
		const patchText = readFileSync(openclawPatch, "utf-8");
		expect(patchText).toContain('"discord"');
		expect(patchText).toContain('"plugins"');
	});

	it("derives hosted workspace and explicit process cwd from HOME", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = home;
		writeHermesVersionBinary(home, "0.18.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "hermes",
							deploymentId: "dep_workspace",
							environmentId: "env_workspace",
							...hostedRequiredState(),
							instanceId: "iid_workspace",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedHermesSystemFixture(home, workspace),
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								hermes: hostedHermesRuntime({}),
							},
						},
						secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			const hermesRunConfig = JSON.parse(
				readFileSync(join(getRuntimePaths().runConfigRoot, "hermes.json"), "utf-8"),
			);

			expect(convergence.outputs.workspaceRoot).toBe(workspace);
			expect(existsSync(workspace)).toBe(true);
			expect(hermesRunConfig.cwd).toBe(workspace);
			expect(expectRecord(readHermesConfigYaml(home).terminal, "Hermes terminal config").cwd).toBe(
				workspace,
			);
			expect(convergence.outputs.processManager).toBe("systemd");
			expect(readSystemdSystemUnit(getRuntimePaths(), "clawdi-runtime-watch")).toContain(
				`WorkingDirectory=${workspace}`,
			);
		} finally {
			restore();
		}
	});

	it("rejects legacy hosted controlPlane apiUrl", async () => {
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "hosted-legacy-api-url.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "hermes",
					deploymentId: "dep_legacy_api_url",
					environmentId: "env_legacy_api_url",
					...hostedRequiredState(),
					instanceId: "iid_legacy_api_url",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { apiUrl: "https://api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						hermes: hostedHermesRuntime(),
					},
				},
				secretValues: {},
			}),
		);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		if (loaded.mode !== "manifest-rejected") throw new Error(loaded.errors.join("\n"));
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain("apiUrl");
	});

	it.each(["liveSync", "recovery"] as const)(
		"rejects hosted manifests without required %s state",
		async (field) => {
			const home = join(root, "home", "clawdi");
			const manifestPath = join(root, `hosted-missing-${field}.json`);
			mkdirSync(home, { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			const payload = hostedRuntimeWatchLocalePayload(home, 1) as {
				manifest: Record<string, unknown>;
			};
			delete payload.manifest[field];
			writeFileSync(manifestPath, JSON.stringify(payload));

			const loaded = await loadCanonicalBundleFixture(manifestPath);

			expect("errors" in loaded).toBe(true);
			if (!("errors" in loaded)) throw new Error("expected manifest load failure");
			expect(loaded.mode).toBe("manifest-rejected");
			expect(loaded.errors.join("\n")).toContain(`manifest.${field}`);
		},
	);

	it("uses derived hosted HOME as cwd without explicit run settings", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "runtime-workspace.json");
		writeHermesVersionBinary(home, "0.18.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD = "test-hermes-dashboard-password";
		process.env.HERMES_DASHBOARD_BASIC_AUTH_SECRET = "test-hermes-dashboard-session-secret";
		seedMitmproxyCache();
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "hermes",
					deploymentId: "dep_runtime_workspace",
					environmentId: "env_runtime_workspace",
					...hostedRequiredState(),
					instanceId: "iid_runtime_workspace",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedHermesSystemFixture(home, join(home, "system-workspace")),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						hermes: hostedHermesRuntime({}),
					},
				},
				secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
			}),
		);

		const loaded = await loadCanonicalBundleFixture(manifestPath);
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths(), {});
		const hermesRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "hermes.json"), "utf-8"),
		);
		const hermesDashboardRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "hermes+dashboard.json"), "utf-8"),
		);

		expect(convergence.outputs.workspaceRoot).toBe(home);
		expect(hermesRunConfig.cwd).toBe(home);
		expect(hermesRunConfig.defaultArgs).toEqual(["gateway", "run"]);
		expect(hermesDashboardRunConfig.cwd).toBe(home);
		expect(hermesDashboardRunConfig.defaultArgs).toEqual([
			"dashboard",
			"--host",
			"0.0.0.0",
			"--port",
			"9119",
			"--no-open",
		]);
	});

	it("installs OpenClaw before applying hosted MCP projections and fails closed without it", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const installer = join(root, "openclaw-installer.sh");
		const installerLog = join(root, "openclaw-installer.log");
		const { commandPath } = writeFakeOpenClawMcpBinary(home);
		const fixtureBinary = join(root, "openclaw-fixture");
		writeFileSync(fixtureBinary, readFileSync(commandPath));
		chmodSync(fixtureBinary, 0o700);
		rmSync(commandPath);
		writeFileSync(
			installer,
			`#!/usr/bin/env bash
set -euo pipefail
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
test "$prefix" = "$HOME/.local"
printf 'installed\n' > '${installerLog}'
install -D -m 700 '${fixtureBinary}' "$prefix/bin/openclaw"
`,
		);
		chmodSync(installer, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = installer;

		const load = (
			generation: number,
			revision: string,
			install: RuntimeManifest["runtimes"][string]["install"],
		): RuntimeManifestLoad => {
			const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", generation);
			loaded.manifest.workspaceRoot = workspace;
			loaded.manifest.runtimes.openclaw.install = install;
			loaded.manifest.projection = {
				...loaded.manifest.projection,
				mcp: { servers: { clawdi: managedRemoteMcpServer("clawdi", revision) } },
			};
			loaded.secretValues = {
				...loaded.secretValues,
				"secret://mcp/clawdi": "deploy-key-secret",
			};
			return loaded;
		};
		const officialInstall = {
			authority: "official" as const,
			method: "official-installer" as const,
			url: "https://openclaw.ai/install-cli.sh",
			home,
			args: officialInstallArgs("openclaw", home),
		};

		const installed = convergeAndCommitTestRuntimeManifest(
			load(1, "v1", officialInstall),
			getRuntimePaths(),
		);

		expect(installed.installErrors).toEqual([]);
		expect(readFileSync(installerLog, "utf-8")).toBe("installed\n");
		expect(readOpenClawMcpServers(home).clawdi).toEqual(
			nativeManagedRemoteMcpServer("clawdi", "v1"),
		);

		rmSync(commandPath);
		const unavailable = convergeAndCommitTestRuntimeManifest(
			load(2, "v2", undefined),
			getRuntimePaths(),
		);

		expect(unavailable.installErrors.join("\n")).toContain(
			"could not mutate managed OpenClaw MCP servers: runtime is unavailable",
		);
		expect(readOpenClawMcpServers(home).clawdi).toEqual(
			nativeManagedRemoteMcpServer("clawdi", "v1"),
		);
	});

	it("reconciles generic MCP maps and cleans the previously managed runtime on switch", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const hermesBin = join(home, ".local", "bin", "hermes");
		const openclawCalls = join(root, "openclaw-mcp-calls.log");
		const { configPath: openclawConfigPath } = writeFakeOpenClawMcpBinary(home, {
			callsPath: openclawCalls,
		});
		const openclawUserSkill = join(
			home,
			".openclaw",
			"agents",
			"main",
			"skills",
			"user-skill",
			"SKILL.md",
		);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(dirname(hermesBin), { recursive: true });
		mkdirSync(dirname(openclawUserSkill), { recursive: true });
		writeFileSync(
			openclawConfigPath,
			`${JSON.stringify(
				{
					custom: "keep",
					mcp: { servers: { "user-entry": { command: "user-owned", args: ["keep"] } } },
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(openclawUserSkill, "user-owned skill\n");
		writeHermesVersionBinary(home, "0.20.1");
		mkdirSync(join(home, ".hermes"), { recursive: true });
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			"mcp_servers:\n  user-entry:\n    command: user-owned\n    args:\n      - keep\n",
		);
		process.env.CLAWDI_AUTH_TOKEN = "deploy-key-secret";

		const load = (
			generation: number,
			selectedRuntime: "openclaw" | "hermes",
			servers: Record<string, ReturnType<typeof managedRemoteMcpServer>>,
			skillEnabled = true,
		): RuntimeManifestLoad => {
			const loaded = hostedSingleProviderModeLoad(home, selectedRuntime, "unmanaged", generation);
			loaded.manifest.workspaceRoot = workspace;
			loaded.manifest.projection = {
				...loaded.manifest.projection,
				mcp: { servers },
				skills: { entries: { clawdi: { enabled: skillEnabled, version: 1 } } },
			};
			loaded.secretValues = {
				...loaded.secretValues,
				...Object.fromEntries(
					Object.keys(servers).map((serverName) => [
						`secret://mcp/${serverName}`,
						`${serverName}-secret`,
					]),
				),
			};
			return loaded;
		};
		const initialServers = {
			clawdi: managedRemoteMcpServer("clawdi", "v1"),
			"search.proxy": managedRemoteMcpServer("search.proxy", "v1"),
		};
		const updatedServers = {
			...initialServers,
			"search.proxy": managedRemoteMcpServer("search.proxy", "v2"),
		};
		const loadWithSkillEntry = (
			skillId: string,
			entry: { enabled: boolean; version: number },
		): RuntimeManifestLoad => {
			const candidate = load(0, "openclaw", initialServers);
			return {
				...candidate,
				manifest: {
					...candidate.manifest,
					projection: {
						...candidate.manifest.projection,
						skills: { entries: { [skillId]: entry } },
					},
				},
			};
		};

		const unknownSkill = convergeAndCommitTestRuntimeManifest(
			loadWithSkillEntry("unknown", { enabled: true, version: 1 }),
			getRuntimePaths(),
		);
		expect(unknownSkill.installErrors).toEqual([]);
		expect(unknownSkill.resourceProjectionErrors.join("\n")).toContain(
			"no bundled hosted skill is registered for unknown",
		);
		const unknownSkillVersion = convergeAndCommitTestRuntimeManifest(
			loadWithSkillEntry("clawdi", { enabled: true, version: 2 }),
			getRuntimePaths(),
		);
		expect(unknownSkillVersion.installErrors).toEqual([]);
		expect(unknownSkillVersion.resourceProjectionErrors.join("\n")).toContain(
			"no bundled hosted skill clawdi version 2 is registered",
		);

		const openclawSkill = join(home, ".openclaw", "workspace", "skills", "clawdi");
		mkdirSync(openclawSkill, { recursive: true });
		writeFileSync(join(openclawSkill, "SKILL.md"), "local setup skill\n");
		reserveManagedSkill({
			targetDir: openclawSkill,
			id: "clawdi",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		const collision = convergeAndCommitTestRuntimeManifest(
			load(1, "openclaw", initialServers),
			getRuntimePaths(),
		);
		expect(collision.installErrors).toEqual([]);
		expect(collision.resourceProjectionErrors.join("\n")).toContain(
			`refusing to replace unmanaged clawdi skill at ${openclawSkill}`,
		);
		expect(readFileSync(join(openclawSkill, "SKILL.md"), "utf-8")).toBe("local setup skill\n");
		releaseManagedSkill({
			targetDir: openclawSkill,
			id: "clawdi",
			manager: "local-setup",
			removeTarget: () => rmSync(openclawSkill, { recursive: true, force: true }),
		});

		const initial = convergeAndCommitTestRuntimeManifest(
			load(1, "openclaw", initialServers),
			getRuntimePaths(),
		);
		expect(initial.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home).clawdi).toEqual(
			nativeManagedRemoteMcpServer("clawdi", "v1"),
		);
		expect(readOpenClawMcpServers(home)["search.proxy"]).toEqual(
			nativeManagedRemoteMcpServer("search.proxy", "v1"),
		);
		expect(readOpenClawMcpServers(home)["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(
			JSON.parse(readFileSync(managedSkillReservationLedgerPath(), "utf-8")).reservations[
				openclawSkill
			],
		).toMatchObject({ id: "clawdi", manager: "hosted-manifest" });

		const installedSkill = readFileSync(join(openclawSkill, "SKILL.md"), "utf-8");
		writeFileSync(join(openclawSkill, "SKILL.md"), "tenant mutation before restart\n");
		rmSync(paths.configurationRoot, { recursive: true, force: true });
		const restarted = convergeAndCommitTestRuntimeManifest(
			load(1, "openclaw", initialServers),
			paths,
		);
		expect(restarted.installErrors).toEqual([]);
		expect(readFileSync(join(openclawSkill, "SKILL.md"), "utf-8")).toBe(installedSkill);
		expect(readOpenClawMcpServers(home).clawdi).toEqual(
			nativeManagedRemoteMcpServer("clawdi", "v1"),
		);

		const updated = convergeAndCommitTestRuntimeManifest(
			load(2, "openclaw", updatedServers),
			getRuntimePaths(),
		);
		expect(updated.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home)["search.proxy"]).toEqual(
			nativeManagedRemoteMcpServer("search.proxy", "v2"),
		);
		const updatedConfig = readFileSync(openclawConfigPath, "utf-8");
		const callsBeforeIdempotent = readFileSync(openclawCalls, "utf-8");
		const idempotent = convergeAndCommitTestRuntimeManifest(
			load(2, "openclaw", updatedServers),
			getRuntimePaths(),
		);
		expect(idempotent.installErrors).toEqual([]);
		expect(readFileSync(openclawConfigPath, "utf-8")).toBe(updatedConfig);
		expect(readFileSync(openclawCalls, "utf-8")).toBe(callsBeforeIdempotent);

		const switched = convergeAndCommitTestRuntimeManifest(
			load(3, "hermes", updatedServers),
			getRuntimePaths(),
		);
		expect(switched.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home).clawdi).toBeUndefined();
		expect(readOpenClawMcpServers(home)["search.proxy"]).toBeUndefined();
		expect(readOpenClawMcpServers(home)["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(existsSync(openclawSkill)).toBe(false);
		expect(readFileSync(openclawUserSkill, "utf-8")).toBe("user-owned skill\n");
		const hermesAfterSwitch = expectRecord(
			readHermesConfigYaml(home).mcp_servers,
			"Hermes MCP servers",
		);
		expect(hermesAfterSwitch["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(hermesAfterSwitch.clawdi).toEqual(nativeManagedRemoteMcpServer("clawdi", "v1"));
		expect(hermesAfterSwitch["search.proxy"]).toEqual(
			nativeManagedRemoteMcpServer("search.proxy", "v2"),
		);
		const hermesSkill = join(home, ".hermes", "skills", "clawdi");
		const hermesSkillReservation = JSON.parse(
			readFileSync(managedSkillReservationLedgerPath(), "utf-8"),
		).reservations[hermesSkill];
		expect(hermesSkillReservation).toMatchObject({
			id: "clawdi",
			manager: "hosted-manifest",
			digest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		process.env.CLAWDI_RUNTIME_MODE = "local";
		expect(() =>
			convergeAndCommitTestRuntimeManifest(
				load(4, "hermes", updatedServers, true),
				getRuntimePaths(),
			),
		).toThrow("hosted convergence requires CLAWDI_RUNTIME_MODE=hosted explicitly");
		expect(existsSync(hermesSkill)).toBe(true);
		expect(readFileSync(openclawUserSkill, "utf-8")).toBe("user-owned skill\n");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";

		const removedGeneric = convergeAndCommitTestRuntimeManifest(
			load(5, "hermes", { clawdi: initialServers.clawdi }, false),
			getRuntimePaths(),
		);
		expect(removedGeneric.installErrors).toEqual([]);
		const hermesAfterRemoval = expectRecord(
			readHermesConfigYaml(home).mcp_servers,
			"Hermes MCP servers",
		);
		expect(hermesAfterRemoval["search.proxy"]).toBeUndefined();
		expect(hermesAfterRemoval.clawdi).toEqual(nativeManagedRemoteMcpServer("clawdi", "v1"));
		expect(hermesAfterRemoval["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(existsSync(hermesSkill)).toBe(false);
		mkdirSync(hermesSkill, { recursive: true });
		writeFileSync(join(hermesSkill, "SKILL.md"), "user-owned canonical skill\n");

		const disabled = convergeAndCommitTestRuntimeManifest(
			load(6, "hermes", {}, false),
			getRuntimePaths(),
		);
		expect(disabled.installErrors).toEqual([]);
		const hermesAfterDisable = expectRecord(
			readHermesConfigYaml(home).mcp_servers,
			"Hermes MCP servers",
		);
		expect(hermesAfterDisable.clawdi).toBeUndefined();
		expect(hermesAfterDisable["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(readFileSync(join(hermesSkill, "SKILL.md"), "utf-8")).toBe(
			"user-owned canonical skill\n",
		);
		expect(readFileSync(openclawCalls, "utf-8")).toContain("unset search.proxy");
	});

	it("upgrades header-owned MCP state without a ledger and rejects an unmarked collision", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const { configPath: openclawConfigPath } = writeFakeOpenClawMcpBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const desiredServer = managedRemoteMcpServer("clawdi", "v2");
		writeFileSync(
			openclawConfigPath,
			`${JSON.stringify({ mcp: { servers: { clawdi: nativeManagedRemoteMcpServer("clawdi", "v1") } } }, null, 2)}\n`,
		);
		ensureRuntimeStateDirs(paths);
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-28T00:00:00.000Z",
				instanceId: "iid_mcp_ownership",
				etag: '"legacy-applied"',
				sourceRevision: "a".repeat(64),
				generation: 0,
				contentIdentity: { sourcePath: "legacy://0.13.x", sha256: "b".repeat(64) },
				activated: {},
				providerIds: [],
				projectedProviderIds: {},
			},
			paths,
		);
		const load = (generation: number): RuntimeManifestLoad => {
			const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", generation);
			loaded.manifest.instanceId = "iid_mcp_ownership";
			loaded.manifest.workspaceRoot = workspace;
			loaded.manifest.projection = {
				...loaded.manifest.projection,
				mcp: { servers: { clawdi: desiredServer } },
			};
			loaded.secretValues = {
				...loaded.secretValues,
				"secret://mcp/clawdi": "deploy-key-secret",
			};
			return loaded;
		};

		const upgraded = convergeAndCommitTestRuntimeManifest(load(1), paths);
		expect(upgraded.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home).clawdi).toMatchObject({
			url: desiredServer.url,
		});

		writeFileSync(
			openclawConfigPath,
			'{"mcp":{"servers":{"clawdi":{"url":"https://user.test","transport":"streamable-http","headers":{"Authorization":"user-token"}}}}}\n',
		);
		expect(() => convergeRuntimeManifest(load(2), paths)).toThrow(
			/refusing to replace unmanaged openclaw MCP server clawdi/,
		);
	});

	it("claims MCP ownership only after successful mutations and retries failed cleanup", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const calls = join(root, "openclaw-mcp-failure-calls.log");
		const failSet = join(root, "fail-set");
		const failUnset = join(root, "fail-unset");
		const { configPath: openclawConfigPath } = writeFakeOpenClawMcpBinary(home, {
			callsPath: calls,
			failSetFile: failSet,
			failUnsetFile: failUnset,
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			openclawConfigPath,
			`${JSON.stringify(
				{
					custom: "keep",
					mcp: { servers: { "user-owned": { command: "user", args: ["keep"] } } },
				},
				null,
				2,
			)}\n`,
		);

		const load = (
			generation: number,
			servers: Record<string, ReturnType<typeof managedRemoteMcpServer>>,
		): RuntimeManifestLoad => {
			const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", generation);
			loaded.manifest.workspaceRoot = workspace;
			loaded.manifest.projection = { ...loaded.manifest.projection, mcp: { servers } };
			loaded.secretValues = {
				...loaded.secretValues,
				...Object.fromEntries(
					Object.keys(servers).map((serverName) => [
						`secret://mcp/${serverName}`,
						`${serverName}-secret`,
					]),
				),
			};
			return loaded;
		};

		const beforeCollision = readFileSync(openclawConfigPath, "utf-8");
		expect(() =>
			convergeRuntimeManifest(
				load(1, { "user-owned": managedRemoteMcpServer("user-owned", "v1") }),
				getRuntimePaths(),
			),
		).toThrow(/refusing to replace unmanaged openclaw MCP server user-owned/);
		expect(readFileSync(openclawConfigPath, "utf-8")).toBe(beforeCollision);
		expect(existsSync(calls)).toBe(false);

		writeFileSync(failSet, "fail\n");
		const failedSet = convergeRuntimeManifest(
			load(2, { "failed-new": managedRemoteMcpServer("failed-new", "v1") }),
			getRuntimePaths(),
		);
		expect(failedSet.installErrors.join("\n")).toContain("runtime MCP projection failed");
		expect(readFileSync(openclawConfigPath, "utf-8")).toBe(beforeCollision);
		rmSync(failSet);

		const omittedAfterFailure = convergeRuntimeManifest(load(3, {}), getRuntimePaths());
		expect(omittedAfterFailure.installErrors).toEqual([]);
		expect(readFileSync(calls, "utf-8")).not.toContain("unset failed-new");

		const managed = convergeRuntimeManifest(
			load(4, { "owned-server": managedRemoteMcpServer("owned-server", "v1") }),
			getRuntimePaths(),
		);
		expect(managed.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home)["owned-server"]).toEqual(
			nativeManagedRemoteMcpServer("owned-server", "v1"),
		);

		writeFileSync(failUnset, "fail\n");
		const failedRemoval = convergeRuntimeManifest(load(5, {}), getRuntimePaths());
		expect(failedRemoval.installErrors.join("\n")).toContain("runtime MCP projection failed");
		expect(readOpenClawMcpServers(home)["owned-server"]).toEqual(
			nativeManagedRemoteMcpServer("owned-server", "v1"),
		);

		rmSync(failUnset);
		const retriedRemoval = convergeRuntimeManifest(load(6, {}), getRuntimePaths());
		expect(retriedRemoval.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home)["owned-server"]).toBeUndefined();
		expect(readOpenClawMcpServers(home)["user-owned"]).toEqual({
			command: "user",
			args: ["keep"],
		});
		expect(readFileSync(calls, "utf-8").match(/unset owned-server/g)).toHaveLength(2);
	});

	it("keeps provider secrets sidecar-only in the ephemeral run-dir config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "configured", 1);
		loaded.manifest.runtimes.openclaw.install = undefined;
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		const paths = getRuntimePaths();
		const userUnitNames = convergence.outputs.systemdUserUnits.map((path) =>
			path.split("/").at(-1),
		);
		const systemUnitNames = convergence.outputs.systemdSystemUnits.map((path) =>
			path.split("/").at(-1),
		);
		const egressSecretPath = join(run, "secrets", "egress-secrets.json");
		const runtimeSidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
		const runtimeSidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
		const transparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
		const openclawUnit = readSystemdUserServiceConfig(paths, "openclaw-gateway");
		const openclawEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(convergence.outputs.processManager).toBe("systemd");
		expect(convergence.outputs.systemdUserUnitRoot).toBe(join(home, ".config", "systemd", "user"));
		expect(convergence.outputs.systemdSystemUnitRoot).toBe(paths.systemdSystemRoot);
		expect(existsSync(join(state, "supervisor", "supervisord.conf"))).toBe(false);
		expect(userUnitNames).not.toContain("clawdi-runtime-sidecar.service");
		expect(systemUnitNames).toContain("clawdi-runtime-sidecar.service");
		expect(runtimeSidecarUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "sidecar"`);
		expect(runtimeSidecarUnit).toContain(`Before=user@${TEST_PROCESS_UID}.service`);
		expect(runtimeSidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_USER="${TEST_PROCESS_USER}"`);
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_UID="${TEST_PROCESS_UID}"`);
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_GID="${TEST_PROCESS_GID}"`);
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_UID="10002"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_GID="10002"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_NFT_TABLE="clawdi_transparent_egress"');
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_PROFILE_BUNDLE="${getRuntimePaths().egressProfileBundle}"`,
		);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_SECRET_FILE="${egressSecretPath}"`);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_ENGINE_BINARY_PATH="${paths.egressServiceBinary}"`,
		);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_ADDON_PATH="${paths.egressAddon}"`);
		expect(runtimeSidecarUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "sidecar"`);
		expect(runtimeSidecarUnit).not.toContain("user=clawdi");
		expect(openclawUnit).not.toContain("\nExecStart=");
		expect(openclawUnit).not.toContain("\nWorkingDirectory=");
		expect(openclawUnit).not.toContain("user=clawdi");
		expect(openclawUnit).not.toContain("sk-managed-provider");
		expect(openclawEnv).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
		expect(openclawEnv).not.toMatch(/^OPENAI_API_KEY=/m);
		expect(openclawEnv).not.toContain("sk-managed-provider");
		expect(openclawEnv).not.toContain(dirname(paths.cliManagedBin));
		expect(statSync(join(run, "secrets")).mode & 0o777).toBe(0o711);
		expect(existsSync(join(run, "secrets", "runtime-secrets.json"))).toBe(false);
		expect(existsSync(join(run, "secrets", "runtimes", "openclaw.json"))).toBe(false);
		expect(statSync(egressSecretPath).mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			const openclawUnitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
			expect(statSync(openclawUnitPath).uid).toBe(10_001);
			expect(statSync(openclawUnitPath).gid).toBe(10_001);
			expect(statSync(egressSecretPath).uid).toBe(10002);
			expect(statSync(egressSecretPath).gid).toBe(10002);
		}
		const egressSecrets = JSON.parse(readFileSync(egressSecretPath, "utf-8"));
		expect(egressSecrets["secret://provider.clawdi-managed.apiKey"]).toBe("sk-managed-provider");
	});

	it("runs the egress-only sidecar with a lifecycle nft redirect", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const load = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 1);
		load.manifest.runtimes.openclaw.install = undefined;
		load.manifest.egressProfiles?.profiles.push({
			id: "deny-metadata",
			enabled: true,
			kind: "deny",
			match: {
				scheme: "https",
				host: "169.254.169.254",
				pathPrefix: "/",
			},
			priority: 1,
		});
		convergeRuntimeManifest(load, getRuntimePaths());

		const paths = getRuntimePaths();
		const sidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
		const sidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
		const initialSidecarRevision = systemdEnvDigest(sidecarEnv);
		const transparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
		const openclawUnit = readSystemdUserServiceConfig(paths, "openclaw-gateway");
		const openclawEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(sidecarUnit).toContain("Type=notify");
		expect(sidecarUnit).toContain(`Before=user@${TEST_PROCESS_UID}.service`);
		expect(sidecarUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "sidecar"`);
		expect(sidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
		expect(transparentEgressEnv).toContain(
			'CLAWDI_EGRESS_TRANSPORT_VERSION="clawdi-transparent-egress-v1"',
		);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_TRANSPARENT_PORT="${TRANSPARENT_EGRESS_PORT}"`,
		);
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_NFT_TABLE="clawdi_transparent_egress"');
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_UID="${TEST_PROCESS_UID}"`);
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_GID="${TEST_PROCESS_GID}"`);
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_UID="10002"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_GID="10002"');
		expect(sidecarEnv).toContain(
			`CLAWDI_EGRESS_ENV_FILE="${join(run, "egress", "transparent-egress.env")}"`,
		);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_PROFILE_BUNDLE="${getRuntimePaths().egressProfileBundle}"`,
		);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_SYSTEM_CA_BUNDLE="${join(run, "egress", "systemd", "ca.pem")}"`,
		);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_ADDON_PATH="${paths.egressAddon}"`);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_ENGINE_BINARY_PATH="${paths.egressServiceBinary}"`,
		);
		expect(statSync(paths.egressProfileRoot).mode & 0o777).toBe(0o711);
		expect(statSync(paths.egressProfileBundle).mode & 0o777).toBe(0o640);
		expect(statSync(paths.egressRoot).mode & 0o777).toBe(0o711);
		expect(statSync(paths.egressAddon).mode & 0o777).toBe(0o640);
		expect(statSync(paths.egressTransparentEnv).mode & 0o777).toBe(0o640);
		expect(statSync(paths.egressCaDir).mode & 0o777).toBe(0o700);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(statSync(paths.egressProfileBundle).uid).toBe(0);
			expect(statSync(paths.egressProfileBundle).gid).toBe(10002);
			expect(statSync(paths.egressCaDir).uid).toBe(10002);
			expect(statSync(paths.egressCaDir).gid).toBe(10002);
			expect(statSync(paths.egressAddon).uid).toBe(0);
			expect(statSync(paths.egressAddon).gid).toBe(10002);
			expect(statSync(paths.egressTransparentEnv).uid).toBe(0);
			expect(statSync(paths.egressTransparentEnv).gid).toBe(10002);
		}
		expect(openclawUnit).not.toContain("\nExecStart=");
		expect(openclawUnit).not.toContain("\nWorkingDirectory=");
		expect(openclawEnv).not.toContain("CLAWDI_EGRESS_PROFILE_BUNDLE");
		expect(openclawEnv).not.toContain("CLAWDI_EGRESS_SECRET_FILE");
		expect(openclawEnv).not.toContain("HTTPS_PROXY=");
		expect(openclawEnv).not.toContain("OPENCLAW_PROXY_URL=");
		expect(openclawEnv).not.toContain("NODE_USE_ENV_PROXY=");
		expect(openclawEnv).toContain(
			`NODE_EXTRA_CA_CERTS="${join(run, "egress", "systemd", "ca.pem")}"`,
		);
		expect(openclawUnit).not.toContain("clawdi run -- openclaw");

		process.env.CLAWDI_EGRESS_UID = "10012";
		process.env.CLAWDI_EGRESS_GID = "10013";
		convergeRuntimeManifest(load, paths);
		const updatedSidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
		const updatedTransparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
		expect(systemdEnvDigest(updatedSidecarEnv)).not.toBe(initialSidecarRevision);
		expect(updatedTransparentEgressEnv).toContain('CLAWDI_EGRESS_UID="10012"');
		expect(updatedTransparentEgressEnv).toContain('CLAWDI_EGRESS_GID="10013"');
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(statSync(paths.egressCaDir).uid).toBe(10012);
			expect(statSync(paths.egressCaDir).gid).toBe(10013);
		}
	});

	it("keeps the previous live generation unchanged when runtime install fails", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const failingInstaller = join(root, "install-openclaw.sh");
		mkdirSync(home, { recursive: true });
		writeFileSync(failingInstaller, "#!/usr/bin/env bash\nexit 42\n");
		chmodSync(failingInstaller, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = failingInstaller;
		const paths = getRuntimePaths();
		const cachePath = paths.manifestLastGood;
		mkdirSync(dirname(cachePath), { recursive: true });
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		const previousManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_last_good_floor",
			environmentId: "env_last_good_floor",
			instanceId: "iid_last_good_floor",
			generation: 1,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		};
		writeFileSync(cachePath, JSON.stringify(previousManifest));
		const liveFiles = [
			join(paths.runConfigRoot, "openclaw.json"),
			join(paths.runConfigRoot, "stale-runtime.json"),
			join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
			join(paths.systemdUserRoot, "openclaw-gateway.service"),
		];
		for (const path of liveFiles) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `generation-1:${path.split("/").at(-1)}\n`);
		}
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: previousManifest.instanceId,
				etag: testBundleEtag("manifest-generation-1"),
				sourceRevision: "a".repeat(64),
				generation: 1,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				activated: {},
				providerIds: [],
				projectedProviderIds: { openclaw: ["generation-1-provider"] },
			},
			paths,
		);
		const previousLiveSnapshot = Object.fromEntries(
			[...liveFiles, paths.appliedState].map((path) => [path, readFileSync(path, "utf-8")]),
		);
		const loaded: RuntimeManifestLoad = {
			manifest: {
				...previousManifest,
				generation: 2,
				runtimes: {
					openclaw: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: [],
						},
					},
					hermes: { enabled: false },
				},
			} as RuntimeManifest,
			source: "remote-datasource",
			sourcePath: "test://install-error",
			offline: false,
			secretValues: {},
		};

		const convergence = convergeRuntimeManifest(loaded, paths);

		expect(convergence.installErrors.join("\n")).toContain(
			`runtime openclaw installer failed or did not create ${join(home, ".local", "bin", "openclaw")}; see ${join(paths.statusRoot, "installer-logs", "openclaw.log")}`,
		);
		expect(convergence.outputs.manifestLastGood).toBeNull();
		expect(JSON.parse(readFileSync(cachePath, "utf-8")).generation).toBe(1);
		expect(convergence.outputs.systemdSystemUnits).toEqual([]);
		expect(convergence.outputs.systemdUserUnits).toEqual([]);
		for (const [path, content] of Object.entries(previousLiveSnapshot)) {
			expect(readFileSync(path, "utf-8")).toBe(content);
		}
	});

	it("updates the OpenClaw locale block without changing user-authored workspace content", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const soulPath = join(home, ".openclaw", "workspace", "SOUL.md");
		const userPath = join(workspace, "USER.md");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(dirname(soulPath), { recursive: true });
		seedOpenClawBinary(home);
		writeFileSync(soulPath, "User preface.\n\nUser epilogue.\n");
		writeFileSync(userPath, "User profile stays untouched.\n");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const paths = getRuntimePaths();
		const converge = (language: "en" | "fr", timezone: string) => {
			const load = hostedSingleProviderModeLoad(
				home,
				"openclaw",
				"unmanaged",
				language === "en" ? 1 : 2,
			);
			load.manifest.locale = { language, timezone };
			return convergeRuntimeManifest(load, paths);
		};

		converge("en", "UTC");
		const initialRevision = systemdEnvDigest(readSystemdEnvFile(paths, "openclaw-gateway"));

		converge("fr", "Europe/Paris");
		const soul = readFileSync(soulPath, "utf-8");
		expect(soul.startsWith("User preface.\n\nUser epilogue.\n")).toBe(true);
		expect(soul.match(/clawdi managed locale/g)).toHaveLength(2);
		expect(soul).toContain("`fr`");
		expect(soul).toContain("`Europe/Paris`");
		expect(readFileSync(userPath, "utf-8")).toBe("User profile stays untouched.\n");
		const updatedEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(systemdEnvDigest(updatedEnv)).not.toBe(initialRevision);
		converge("fr", "Europe/Paris");
		expect(readFileSync(soulPath, "utf-8")).toBe(soul);
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "openclaw-gateway"))).toBe(
			systemdEnvDigest(updatedEnv),
		);
	});

	it("projects Hermes locale into its managed SOUL block and timezone config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const hermesHome = join(home, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "SOUL.md"), "User Hermes identity.\n");
		writeFileSync(join(hermesHome, "config.yaml"), "custom_setting: keep\n");
		const hermesCommand = writeHermesVersionBinary(home, "0.20.1");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_locale_hermes",
			environmentId: "env_locale_hermes",
			instanceId: "iid_locale_hermes",
			generation: 1,
			issuedAt: "2026-07-11T00:00:00Z",
			locale: { language: "zh-TW", timezone: "Asia/Taipei" },
			workspaceRoot: join(home, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: {
				hermes: {
					enabled: true,
					run: { command: hermesCommand, args: ["gateway", "run"], env: {}, prependPath: [] },
				},
			},
			recovery: {},
		};
		const paths = getRuntimePaths();
		convergeRuntimeManifest(
			{
				manifest,
				source: "remote-datasource",
				sourcePath: "test://locale-hermes",
				offline: false,
				secretValues: {},
			},
			paths,
		);

		const soul = readFileSync(join(hermesHome, "SOUL.md"), "utf-8");
		expect(soul.startsWith("User Hermes identity.\n")).toBe(true);
		expect(soul).toContain("`zh-TW`");
		const config = readHermesConfigYaml(home);
		expect(config.custom_setting).toBe("keep");
		expect(config.timezone).toBe("Asia/Taipei");
	});

	it("rejects a desired generation below the durable applied generation", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "runtime-reset.json");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.cacheRoot, { recursive: true });
		const desiredPayload = hostedRuntimeWatchLocalePayload(home, 1);
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: "iid_watch_locale",
				etag: testBundleEtag("generation-reset-previous"),
				sourceRevision: "a".repeat(64),
				generation: 42,
				contentIdentity: {
					sourcePath: "test://generation-reset-previous",
					sha256: "b".repeat(64),
				},
				activated: {},
				providerIds: [],
				projectedProviderIds: {},
			},
			paths,
		);
		writeFileSync(manifestPath, JSON.stringify(desiredPayload));

		const loaded = await loadCanonicalBundleFixture(manifestPath, paths);

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest rejection");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.rejectedGeneration).toBe(1);
		expect(loaded.activeGeneration).toBe(42);
		expect(loaded.errors).toContain("manifest generation 1 is older than applied generation 42");
	});

	it("rejects hosted manifests without cloudApiUrl instead of deriving it from the source URL", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_manifest_only",
							environmentId: "env_manifest_only",
							...hostedRequiredState(),
							instanceId: "iid_manifest_only",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
						},
						secretValues: {},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("errors" in loaded).toBe(true);
			if (!("errors" in loaded)) throw new Error("expected manifest load failure");
			expect(loaded.mode).toBe("manifest-rejected");
			expect(loaded.errors.join("\n")).toContain("cloudApiUrl");
		} finally {
			restore();
		}
	});

	it("converges remote manifests and starts the observation daemon with liveSync agents=[]", async () => {
		setRuntimeApplyGeneration(4, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "remote-provider-auth"),
			join(root, "remote-provider-auth", "calls.log"),
		);
		const mitmproxy = seedMitmproxyCache();
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_test",
							environmentId: "env_test",
							...hostedRequiredState(),
							instanceId: "iid_remote",
							generation: 4,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							egressEngine: mitmproxy,
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime({
									provider_ids: ["clawdi-managed-v2"],
									primary_model: {
										provider_id: "clawdi-managed-v2",
										model: "gpt-test",
									},
								}),
							},
							providers: {
								"clawdi-managed-v2": {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://sub2api.test/v1",
									models: [{ id: "gpt-test" }],
									apiMode: "openai_chat",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://tool.codex.apiKey",
								},
							},
						},
						secretValues: {
							"secret://tool.codex.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			if (!("manifest" in loaded))
				throw new Error(`expected manifest load success: ${JSON.stringify(loaded)}`);
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

			expect(convergence.mode).toBe("normal");
			expect(convergence.installErrors).toEqual([]);
			const paths = getRuntimePaths();
			expectEgressProfileBundleUsesSecretRef(
				convergence.outputs.egressProfileBundle,
				"secret://tool.codex.apiKey",
				"sk-runtime",
			);
			expectMitmSecretFileIsSidecarOnly(
				paths,
				convergence.outputs.egressSecretFile,
				"secret://tool.codex.apiKey",
				"sk-runtime",
			);
			expectExistingFileNotToContain(join(run, "secrets", "runtime-secrets.json"), "sk-runtime");
			const secretCache = readFileSync(getRuntimePaths().managedSecretCacheFile, "utf-8");
			expect(secretCache).toContain("secret://runtime/openclaw/gateway-token");
			expect(secretCache).not.toContain("sk-runtime");
			expect(convergence.outputs.processManager).toBe("systemd");
			expect(convergence.outputs.systemdSystemUnits).toEqual([
				join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
				join(paths.systemdSystemRoot, "clawdi-daemon.service"),
				join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"),
			]);
			expect(convergence.outputs.systemdUserUnits).toEqual([
				join(paths.systemdUserRoot, "openclaw-gateway.service"),
			]);
			const watchUnit = readSystemdSystemUnit(paths, "clawdi-runtime-watch");
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			const daemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			expect(watchUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "watch"`);
			expect(daemonEnv).toContain('CLAWDI_ENVIRONMENT_ID="env_test"');
			expect(daemonEnv).toContain('CLAWDI_SERVE_MODE="container"');
			expect(watchUnit).not.toContain("sk-runtime");
			expect(watchEnv).not.toContain("sk-runtime");
			expect(readFileSync(getRuntimePaths().manifestLastGood, "utf-8")).not.toContain("sk-runtime");
			const providerHealth = readHostedRuntimeObserved(paths)?.providers;
			expect(providerHealth?.["clawdi-managed-v2"]).toEqual({
				status: "ok",
				configured: true,
				kind: "openai-compatible",
				baseUrl: "https://sub2api.test/v1",
				model: null,
				models: [{ id: "gpt-test" }],
				apiKeySecretRef: "secret://tool.codex.apiKey",
				secretAvailable: true,
				reasons: [],
			});
			expect(JSON.stringify(providerHealth)).not.toContain("sk-runtime");
		} finally {
			restore();
		}
	});

	it("registers live-sync environments and starts one hosted daemon", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "runtime-auth-token";
		const retiredEnvironment = join(home, ".clawdi", "environments", "openclaw.json");
		const retiredEnvironmentContent = `${JSON.stringify({
			id: "env-retired",
			agentType: "openclaw",
			managedBy: "clawdi runtime init",
		})}\n`;
		mkdirSync(dirname(retiredEnvironment), { recursive: true });
		writeFileSync(retiredEnvironment, retiredEnvironmentContent);
		setRuntimeApplyGeneration(9, {
			...CANONICAL_TEST_CONTEXT,
			bootstrapBearer: "runtime-auth-token",
			manifestSourceUrl: "https://runtime-source.test/v1/runtime/manifest",
		});
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_sync",
							environmentId: "env_sync",
							...hostedRequiredState(),
							instanceId: "iid_sync",
							generation: 9,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
							liveSync: {
								enabled: true,
								agents: [
									{ agentType: "openclaw", environmentId: "env-openclaw" },
									{ agentType: "codex", environmentId: "env-codex" },
								],
							},
						},
						secretValues: { "secret://clawdi/auth-token": "runtime-auth-token" },
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			const paths = getRuntimePaths();
			const systemUnitNames = convergence.outputs.systemdSystemUnits.map((path) =>
				path.split("/").at(-1),
			);
			const watchUnit = readSystemdSystemUnit(paths, "clawdi-runtime-watch");
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			const daemonUnit = readSystemdSystemUnit(paths, "clawdi-daemon");
			const daemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			const openclawEnv = JSON.parse(
				readFileSync(join(paths.localEnvironments, "openclaw.json"), "utf-8"),
			);
			const codexEnv = JSON.parse(
				readFileSync(join(paths.localEnvironments, "codex.json"), "utf-8"),
			);

			expect(convergence.outputs.liveSyncEnvironments.sort()).toEqual([
				join(paths.localEnvironments, "codex.json"),
				join(paths.localEnvironments, "openclaw.json"),
			]);
			expect(readFileSync(retiredEnvironment, "utf-8")).toBe(retiredEnvironmentContent);
			expect(convergence.outputs.daemonAuthTokenFile).toBe(join(run, "secrets", "auth-token"));
			expect(readFileSync(join(run, "secrets", "auth-token"), "utf-8")).toBe(
				"runtime-auth-token\n",
			);
			expect(openclawEnv.id).toBe("env-openclaw");
			expect(codexEnv.id).toBe("env-codex");
			expect(systemUnitNames).toContain("clawdi-runtime-watch.service");
			expect(systemUnitNames).toContain("clawdi-daemon.service");
			expect(watchUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "watch"`);
			expect(watchEnv).not.toContain("CLAWDI_RUNTIME_MANIFEST_URL");
			expect(watchEnv).not.toContain("runtime-auth-token");
			expect(daemonUnit).toContain(
				`ExecStart="${paths.cliManagedBin}" "daemon" "run" "--auth-token-file" "${join(
					run,
					"secrets",
					"auth-token",
				)}"`,
			);
			expect(daemonUnit).not.toContain("ExecStart=/bin/sh -lc");
			expect(daemonEnv).toContain('CLAWDI_SERVE_MODE="container"');
			const daemonStateDir = join(state, "daemon");
			expect(daemonEnv).toContain(`CLAWDI_STATE_DIR="${daemonStateDir}"`);
			process.env.CLAWDI_STATE_DIR = daemonStateDir;
			const controlTokenPath = getDaemonControlTokenPath();
			expect(controlTokenPath).toBe(join(state, "daemon", "control", "control-token"));
			expect(controlTokenPath.startsWith(home)).toBe(false);
			delete process.env.CLAWDI_STATE_DIR;
			expect(daemonEnv).toContain('CLAWDI_MANAGED_CONTENT_DIGEST="');
			expect(daemonEnv).toContain("https://cloud-api.test");
			expect(watchEnv).not.toContain("CLAWDI_RUNTIME_AUTH_ENV");
			expect(watchEnv).toContain('CLAWDI_AUTH_TOKEN=""');
			expect(watchUnit).not.toContain("runtime-auth-token");
			expect(watchEnv).not.toContain("runtime-auth-token");
			expect(daemonUnit).not.toContain("runtime-auth-token");
			expect(daemonEnv).not.toContain("runtime-auth-token");
		} finally {
			restore();
		}
	});

	it("skips a runtime provider egress profile without disturbing the Codex tool profile", async () => {
		setRuntimeApplyGeneration(1, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "hosted-no-provider-secret.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_no_secret_ref",
					environmentId: "env_no_secret_ref",
					...hostedRequiredState(),
					instanceId: "iid_no_secret_ref",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
					},
					providers: {
						default: {
							kind: "openai-compatible",
							type: "custom_openai_compatible",
							baseUrl: "https://sub2api.test/v1",
						},
					},
				},
				secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
			}),
		);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const profiles = loaded.manifest.egressProfiles?.profiles ?? [];
		const providerProfiles = profiles.filter((profile) => profile.kind === "provider");
		expect(providerProfiles).toHaveLength(1);
		expect(JSON.stringify(providerProfiles[0])).toContain(TEST_HOSTED_CODEX_SECRET_REF);
		expect(JSON.stringify(providerProfiles[0])).not.toContain("secret://provider.default.apiKey");
	});

	it("rejects invalid explicit hosted egress profiles instead of falling back", async () => {
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "hosted-bad-egress.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "hermes",
					deploymentId: "dep_bad_mitm",
					environmentId: "env_bad_mitm",
					...hostedRequiredState(),
					instanceId: "iid_bad_mitm",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						hermes: hostedHermesRuntime(),
					},
					egressProfiles: {
						profiles: [
							{
								id: "bad-prefix",
								enabled: true,
								kind: "http",
								match: { scheme: "https", host: "example.com", pathPrefix: "api/" },
								rewrite: { upstreamBaseUrl: "https://router.test" },
							},
						],
					},
				},
				secretValues: {},
			}),
		);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain("pathPrefix must start with /");
	});
});
