import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
import { parse as parseYaml } from "yaml";
import {
	applySystemdRuntimeUpdate,
	commitRuntimeAppliedState,
	readSystemdUnitSnapshot,
	runtimeAppliedContentIdentity,
	runtimeInit as runtimeInitWithContext,
	runtimeOnlyChangesCliPackage,
	runtimePublicContentRevision,
	runtimeWatch as runtimeWatchWithContext,
	SystemdRuntimeTransaction,
} from "../src/commands/runtime";
import {
	nativeOAuthProfileId,
	oauthCredentialFingerprint,
} from "../src/lib/codex-oauth-native-store";
import { getCliVersion } from "../src/lib/version";
import {
	type RuntimeUserProcessRevisionAliases,
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
	reconcilePendingRuntimeCliUpgrade,
	rollbackPendingRuntimeCliUpgrade,
} from "../src/runtime/cli-update";
import { withRuntimeConvergeLock } from "../src/runtime/converge-lock";
import {
	deniedCommandReason,
	evaluateHostPolicyForCommand,
	readHostPolicy,
} from "../src/runtime/host-policy";
import { hostedManifestEgressProfiles } from "../src/runtime/hosted-egress-profiles";
import { hostedOpenClawSkillDriver } from "../src/runtime/hosted-openclaw-skill";
import { hostedAiProviderCatalog } from "../src/runtime/hosted-provider-resolution";
import { MANAGED_BAILEYS_STATIC_PATCH_TARGETS } from "../src/runtime/managed-baileys-compat";
import { releaseManagedSkill, reserveManagedSkill } from "../src/runtime/managed-skill-reservation";
import {
	buildOpenClawHostedProviderPatch,
	convergeRuntimeManifest as convergeRuntimeManifestWithContext,
	loadRuntimeManifest as loadRuntimeManifestFromContext,
	materializeHostedChannelCredentials,
	type RuntimeConvergenceResult,
	type RuntimeManifest,
} from "../src/runtime/manifest";
import {
	hostedRuntimeManifestResponseSchema,
	manifestSchema,
	officialInstallArgs,
} from "../src/runtime/manifest-contract";
import {
	HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
	hostedManifestToRuntimeManifest,
	loadRemoteRuntimeManifest as loadRemoteRuntimeManifestWithContext,
	manifestSecretRefs,
	type RuntimeBundleChannelBinding,
	type RuntimeManifestLoad,
} from "../src/runtime/manifest-source";
import { readHostedRuntimeObserved } from "../src/runtime/observed";
import { detectRuntimeMode, getRuntimePaths, type RuntimePaths } from "../src/runtime/paths";
import { buildRuntimeRunConfig } from "../src/runtime/run-config";
import { normalizeSecretValues } from "../src/runtime/secret-values";
import {
	buildRuntimeBootStatus,
	ensureRuntimeStateDirs,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../src/runtime/state";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "../src/runtime/systemd-user";
import { TRANSPARENT_EGRESS_PORT } from "../src/runtime/transparent-egress";
import { getDaemonControlTokenPath } from "../src/serve/paths";
import {
	type TestConvergeOptions,
	withTestSystemdTransaction,
} from "../src/test-support/systemd-apply";
import { mockFetch } from "./commands/helpers";

const TEST_PROCESS_USER = String(process.getuid?.() ?? 0);
const TEST_PROCESS_UID = process.getuid?.() ?? 1_000;
const TEST_PROCESS_GID = process.getgid?.() ?? 1_000;

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

function normalizeHostedManifestFixture(value: unknown): {
	manifest: RuntimeManifest;
	secretValues: Record<string, string>;
} {
	const parsed = hostedRuntimeManifestResponseSchema.parse(value);
	return {
		manifest: hostedManifestToRuntimeManifest(parsed.manifest),
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
	opts: TestConvergeOptions = {},
) {
	if (!process.env.CLAWDI_RUNTIME_MODE) process.env.CLAWDI_RUNTIME_MODE = "hosted";
	if (!process.env.CLAWDI_RUNTIME_USER) process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
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
			systemdApply: opts.systemdApply ? withTestSystemdTransaction(opts.systemdApply) : undefined,
			hostedOpenClawSkillDriver: opts?.hostedOpenClawSkillDriver ?? {
				...hostedOpenClawSkillDriver,
				resolveWorkspace: () => join(paths.userHome, ".openclaw", "workspace"),
			},
			hostedRuntimeContract: opts?.hostedRuntimeContract ?? testHostedRuntimeContract(paths),
		},
	);
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

function seedFakeSystemdProcess(
	stateRoot: string,
	scope: "system" | "user",
	unit: string,
	revision: string,
): number {
	const pidPath = fakeSystemdStatePath(stateRoot, scope, unit, "pid");
	if (existsSync(pidPath)) {
		const existingPid = Number(readFileSync(pidPath, "utf8").trim());
		if (Number.isSafeInteger(existingPid) && existingPid > 0) {
			try {
				process.kill(existingPid, "SIGTERM");
			} catch {}
		}
	}
	const child = spawn("sleep", ["300"], {
		env: { ...process.env, CLAWDI_RUNTIME_REV: revision },
		stdio: "ignore",
	});
	if (!child.pid) throw new Error(`failed to start fake process for ${unit}`);
	child.unref();
	writeFileSync(fakeSystemdStatePath(stateRoot, scope, unit, "active"), "\n");
	writeFileSync(pidPath, `${child.pid}\n`);
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			if (
				readFileSync(`/proc/${child.pid}/environ`)
					.toString("utf8")
					.split("\0")
					.includes(`CLAWDI_RUNTIME_REV=${revision}`)
			) {
				return child.pid;
			}
		} catch {}
		spawnSync("sleep", ["0.01"]);
	}
	throw new Error(`fake process for ${unit} did not publish its runtime revision`);
}

function seedFakeSystemdSnapshotProcesses(
	paths: RuntimePaths,
	stateRoot: string,
	snapshot: Parameters<typeof applySystemdRuntimeUpdate>[1],
): void {
	for (const [scope, units] of [
		["system", snapshot.system],
		["user", snapshot.user],
	] as const) {
		for (const unit of units.keys()) {
			if (unit === "clawdi-runtime-watch.service") {
				writeFileSync(fakeSystemdStatePath(stateRoot, scope, unit, "active"), "\n");
				continue;
			}
			const revision = systemdEnvRevision(
				readFileSync(join(paths.systemdEnvRoot, `${unit}.env`), "utf8"),
			);
			seedFakeSystemdProcess(stateRoot, scope, unit, revision);
		}
	}
}

function writeFakeSystemdManager(input: {
	path: string;
	logPath: string;
	stateRoot: string;
	environmentRoot: string;
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
desired_revision() {
  env_file='${input.environmentRoot}'/$1.env
  [ "$(grep -c '^CLAWDI_RUNTIME_REV=' "$env_file" || true)" -eq 1 ]
  revision="$(grep -E '^CLAWDI_RUNTIME_REV="[a-f0-9]{32}"$' "$env_file" | cut -d '"' -f 2)"
  printf '%s' "$revision"
}
start_process() {
  unit="$1"
  pid_path="$(state_path "$unit" pid)"
  if [ -f "$pid_path" ]; then kill "$(cat "$pid_path")" 2>/dev/null || true; fi
  revision="$(desired_revision "$unit")"
  env CLAWDI_RUNTIME_REV="$revision" sleep 300 >/dev/null 2>&1 &
  printf '%s\n' "$!" > "$pid_path"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    tr '\0' '\n' < "/proc/$!/environ" | grep -Fxq "CLAWDI_RUNTIME_REV=$revision" && return
    sleep 0.01
  done
  return 1
}
case "$command" in
  show)
    unit="\${1:-}"
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
    ;;
  is-enabled)
    unit="\${1:-}"
    if [ -f "$(state_path "$unit" enabled)" ]; then
      printf 'enabled\\n'
    else
      printf 'disabled\\n'
      exit 1
    fi
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

function seedCurrentCliInstall(
	state: string,
	packageSpec: string,
	version = "1.2.3-test",
	registry: string | null = null,
): void {
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
	writeFileSync(
		paths.cliBootstrapStatus,
		JSON.stringify({
			schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
			generatedAt: "2026-06-06T00:00:00Z",
			status: "installed",
			source: "npm",
			packageSpec,
			registry,
			npmPrefix: paths.cliNpmPrefix,
			npmCache: paths.cliNpmCache,
			activePath: active,
			activeTarget: target,
			version,
			error: null,
		}),
	);
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

function currentCliFixtureIdentity(
	paths: RuntimePaths,
	version: string,
): RuntimeCliFixtureIdentity {
	return {
		packageSpec: `clawdi@${version}`,
		registry: null,
		npmPrefix: paths.cliNpmPrefix,
		activeTarget: join(paths.cliNpmPrefix, "bin", "clawdi"),
		version,
	};
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
		registry: null,
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

function writeCliBootstrapFixture(paths: RuntimePaths, identity: RuntimeCliFixtureIdentity): void {
	mkdirSync(dirname(paths.cliBootstrapStatus), { recursive: true });
	writeFileSync(
		paths.cliBootstrapStatus,
		`${JSON.stringify({
			schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
			generatedAt: "2026-07-29T00:00:00.000Z",
			status: "installed",
			source: "npm",
			packageSpec: identity.packageSpec,
			registry: identity.registry,
			npmPrefix: identity.npmPrefix,
			npmCache: paths.cliNpmCache,
			activePath: paths.cliManagedBin,
			activeTarget: identity.activeTarget,
			version: identity.version,
			error: null,
		})}\n`,
		{ mode: 0o600 },
	);
}

function writeCliTransactionFixture(
	paths: RuntimePaths,
	input: {
		phase: "prepared" | "activated";
		previousIdentity: RuntimeCliFixtureIdentity;
		newIdentity: RuntimeCliFixtureIdentity;
		rollbackReason?: string;
		badVersions?: Array<{ version: string; reason: string }>;
	},
): void {
	mkdirSync(dirname(paths.cliUpgradeState), { recursive: true });
	writeFileSync(
		paths.cliUpgradeState,
		`${JSON.stringify({
			schemaVersion: "clawdi.cliUpgradeState.v2",
			transaction: {
				phase: input.phase,
				previousIdentity: input.previousIdentity,
				newIdentity: input.newIdentity,
				rollbackEligible: true,
				installedAt: "2026-07-29T00:00:00.000Z",
				rollback: input.rollbackReason
					? {
							reason: input.rollbackReason,
							markedAt: "2026-07-29T00:01:00.000Z",
						}
					: null,
			},
			badVersions: (input.badVersions ?? []).map((entry) => ({
				packageSpec: input.newIdentity.packageSpec,
				registry: input.newIdentity.registry,
				version: entry.version,
				reason: entry.reason,
				markedAt: "2026-07-29T00:02:00.000Z",
			})),
		})}\n`,
		{ mode: 0o600 },
	);
}

function seedCliRecoveryFixture(state: string, run: string) {
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_SERVICE_STATE_DIR = state;
	process.env.CLAWDI_RUN_DIR = run;
	seedCurrentCliInstall(state, "clawdi@1.2.3", "1.2.3");
	const paths = getRuntimePaths();
	return {
		paths,
		previousIdentity: currentCliFixtureIdentity(paths, "1.2.3"),
		newIdentity: createVersionedCliFixture(paths, "1.2.4"),
	};
}

function seedExternalCliBootstrapRecoveryFixture(
	state: string,
	run: string,
	bootstrapVersion = "1.2.6",
) {
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_SERVICE_STATE_DIR = state;
	process.env.CLAWDI_RUN_DIR = run;
	const paths = getRuntimePaths();
	const previousIdentity = createVersionedCliFixture(paths, "1.2.1");
	const newIdentity = createVersionedCliFixture(paths, "1.2.5");
	const bootstrapIdentity = createVersionedCliFixture(
		paths,
		bootstrapVersion,
		join(paths.cliNpmPrefix, "installs", "install-external-bootstrap"),
	);
	pointManagedCliAt(paths, bootstrapIdentity);
	writeCliBootstrapFixture(paths, bootstrapIdentity);
	writeCliTransactionFixture(paths, {
		phase: "activated",
		previousIdentity,
		newIdentity,
		badVersions: [{ version: "1.2.0", reason: "existing rollback" }],
	});
	rmSync(previousIdentity.npmPrefix, { recursive: true, force: true });
	return { paths, previousIdentity, newIdentity, bootstrapIdentity };
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
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "dep_watch_locale",
		environmentId: "env_watch_locale",
		instanceId: "iid_watch_locale",
		generation,
		issuedAt: "2026-07-11T00:00:00Z",
		locale: { language, timezone },
		workspaceRoot: join(home, "clawdi"),
		controlPlane: { apiUrl: "https://cloud-api.test" },
		clawdiCli: {
			source: "npm:clawdi",
			packageSpec: "clawdi@1.2.3-test",
			registry: "https://registry.npmjs.org",
		},
		runtimes: {
			openclaw: {
				enabled: true,
				run: hostedOpenClawRuntime().run,
				services: {},
			},
		},
		recovery: { cacheManifest: true, allowOfflineBoot: true },
	};
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
				packageSpec: "clawdi@1.2.3-test",
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
				packageSpec: "clawdi@1.2.3-test",
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

function genericCliDesiredState(packageSpec: string): RuntimeManifest {
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "dep_generic_cli_update",
		environmentId: "env_generic_cli_update",
		instanceId: "iid_generic_cli_update",
		generation: 1,
		issuedAt: "2026-07-12T00:00:00Z",
		controlPlane: { apiUrl: "https://cloud-api.test" },
		clawdiCli: {
			source: "npm:clawdi",
			packageSpec,
			registry: "https://registry.npmjs.org",
		},
		runtimes: { openclaw: { enabled: true } },
		recovery: {},
	};
}

function cachedHostedCliDesiredState(home: string, packageSpec: string): RuntimeManifest {
	return {
		...genericCliDesiredState(packageSpec),
		workspaceRoot: join(home, "clawdi"),
		runtimes: { openclaw: { enabled: false } },
		recovery: { cacheManifest: true, allowOfflineBoot: true },
	};
}

function seedOpenClawBinary(home: string): void {
	const openclawBin = join(home, ".local", "bin", "openclaw");
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
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >/dev/null
fi
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
	writeFileSync(
		commandPath,
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> '${commandLog}'
if [ "\${1:-}" = "--version" ]; then printf 'openclaw test-version\n'; exit 0; fi
if [ "$*" = "agents list --json" ]; then printf '[{"id":"main","workspace":"${home}/.openclaw/workspace"}]\n'; exit 0; fi
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
  await options.mutate(draft, { snapshot: {}, previousHash: null, attempt: 1 });
  const next = JSON.stringify(draft, null, 2) + "\\n";
  const beforeBytes = Buffer.byteLength(JSON.stringify(before, null, 2) + "\\n");
  const nextBytes = Buffer.byteLength(next);
  if (nextBytes < Math.floor(beforeBytes * 0.5) && options.writeOptions?.allowConfigSizeDrop !== true) {
    throw new Error(\`size-drop:\${beforeBytes}->\${nextBytes}\`);
  }
  writeFileSync(${JSON.stringify(configPath)}, next);
  writeFileSync(${JSON.stringify(mutationLog)}, JSON.stringify({
    base: options.base,
    afterWrite: options.afterWrite,
    allowConfigSizeDrop: options.writeOptions?.allowConfigSizeDrop,
    explicitSetPaths: options.writeOptions?.explicitSetPaths,
    unsetPaths: options.writeOptions?.unsetPaths,
    beforeBytes,
    nextBytes,
  }));
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

function openClawWhatsAppPluginInspectFixture(pluginSource: string): Record<string, unknown> {
	return {
		plugin: {
			id: "whatsapp",
			source: pluginSource,
			origin: "global",
			status: "loaded",
			version: "2026.7.1",
			enabled: true,
		},
		install: {
			source: "clawhub",
			spec: "clawhub:@openclaw/whatsapp",
			installPath: dirname(pluginSource),
			version: "2026.7.1",
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
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
	patch="$(cat)"
	case "$patch" in
	  *'"gateway"'*) printf '%s\n' "$patch" > '${openclawConfig}' ;;
	esac
	exit 0
fi
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
	const npmPrefix = join(home, ".local", "share", "clawdi", "codex");
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
	seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
	writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
	const paths = getRuntimePaths();
	const load: RuntimeManifestLoad = {
		manifest: runtimeWatchLocaleManifest(home, 1),
		source: "remote-datasource",
		sourcePath: "https://runtime.test/v1/runtime/manifest",
		offline: false,
		secretValues: {
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
		environmentRoot: join(dirname(dirname(dirname(sidecarReadyPath))), "systemd", "env"),
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
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	secretEnv?: Record<string, string>;
	cwd?: string;
	prependPath?: string[];
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
			args: [
				"gateway",
				"run",
				"--allow-unconfigured",
				"--port",
				"18789",
				"--bind",
				"lan",
				"--force",
			],
			env: {},
			secretEnv: {
				OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
			},
			prependPath: [],
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
			args: ["gateway", "run", "--replace"],
			env: {},
			prependPath: [],
		},
		services: {
			dashboard: {
				args: ["dashboard", "--host", "0.0.0.0", "--port", "9119", "--no-open"],
				env: {},
				prependPath: [],
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
			? {
					...hostedHermesRuntime({
						provider_ids: [providerId],
						primary_model: { provider_id: providerId, model: "gpt-5.2-codex" },
					}),
					install: {
						authority: "official" as const,
						method: "official-installer" as const,
						url: "https://hermes-agent.nousresearch.com/install.sh",
						home: input.home,
						args: ["--skip-setup", "--skip-browser", "--non-interactive"],
					},
				}
			: {
					...hostedOpenClawRuntime({
						provider_ids: [providerId],
						primary_model: { provider_id: providerId, model: "gpt-5.2-codex" },
					}),
					install: {
						authority: "official" as const,
						method: "official-installer" as const,
						url: "https://openclaw.ai/install-cli.sh",
						home: input.home,
						args: ["--json", "--no-onboard"],
					},
				};
	return {
		source: "remote-datasource",
		sourcePath: "https://runtime-source.test/desired-state",
		offline: false,
		secretValues: {
			[secretRef]: hostedOAuthEnvelope(input.accessToken, input.refreshToken),
		},
		manifest: {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_hosted_oauth",
			environmentId: "env_hosted_oauth",
			instanceId: "iid_hosted_oauth",
			generation: input.generation,
			issuedAt: "2026-07-31T00:00:00Z",
			workspaceRoot: join(input.home, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: { [input.runtime]: runtime },
			projection: {
				sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
				system:
					input.runtime === "hermes"
						? hostedHermesSystemFixture(input.home)
						: hostedSystemFixture(input.home),
				providers: {
					[providerId]: {
						kind: "openai-compatible",
						type: "openai",
						baseUrl: "https://api.openai.com/v1",
						model: "gpt-5.2-codex",
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
				terminalTooling: TEST_HOSTED_CODEX_TERMINAL_TOOLING,
			},
			egressProfiles: { profiles: [] },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		},
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

function systemdEnvRevision(envFile: string): string {
	const match = envFile.match(/^CLAWDI_RUNTIME_REV="([^"]+)"$/m);
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
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(hermesBin, 0o700);
	return hermesBin;
}

function writeFakeOpenClawProviderAuthSdk(directory: string, callsPath: string): string {
	const sdkPath = join(directory, "fake-openclaw-provider-auth.mjs");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		sdkPath,
		`import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const callsPath = ${JSON.stringify(callsPath)};
const storePath = (agentDir) => join(agentDir, "openclaw-agent.sqlite");
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
  return Object.entries(store.profiles)
    .filter(([, credential]) => credential?.provider === provider)
    .map(([profileId]) => profileId);
}
export async function updateAuthProfileStoreWithLock({ agentDir, updater }) {
  appendFileSync(callsPath, "update " + agentDir + "\\n");
  const store = readStore(agentDir);
  const changed = await updater(store);
  if (changed) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(storePath(agentDir), JSON.stringify(store, null, 2) + "\\n", { mode: 0o600 });
  }
  return store;
}
`,
	);
	return sdkPath;
}

function hostedHermesProviderLoad(home: string): RuntimeManifestLoad {
	return {
		source: "remote-datasource",
		sourcePath: "https://runtime-source.test/desired-state",
		offline: false,
		secretValues: {
			"secret://provider.hermes.apiKey": "sk-hermes-provider",
		},
		manifest: {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_hermes_provider",
			environmentId: "env_hermes_provider",
			instanceId: "iid_hermes_provider",
			generation: 1,
			issuedAt: "2026-06-22T00:00:00Z",
			workspaceRoot: join(home, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: {
				hermes: {
					enabled: true,
					providerMode: "configured",
					provider_ids: ["hermes"],
					primary_model: { provider_id: "hermes", model: "kimi/kimi-for-coding" },
					install: {
						authority: "official",
						method: "official-installer",
						url: "https://hermes-agent.nousresearch.com/install.sh",
						home,
						args: ["--skip-setup", "--skip-browser", "--non-interactive"],
					},
				},
			},
			projection: {
				sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
				system: { home },
				providers: {
					hermes: {
						kind: "openai-compatible",
						baseUrl: "https://hermes-provider.example.test/v1",
						model: "kimi/kimi-for-coding",
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
						runtimeEnvName: "HERMES_PROVIDER_API_KEY",
						apiKeySecretRef: "secret://provider.hermes.apiKey",
					},
				},
			},
			egressProfiles: { profiles: [] },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		},
	};
}

const HOSTED_PROVIDER_SWITCH_PROVIDERS: Record<string, Record<string, unknown>> = {
	"clawdi-managed": hostedProviderSwitchProvider("clawdi-managed", "clawdi"),
	"clawdi-managed-v2": hostedProviderSwitchProvider("clawdi-managed-v2", "clawdi"),
	"byok-a": hostedProviderSwitchProvider("byok-a", "user"),
	"byok-b": hostedProviderSwitchProvider("byok-b", "user"),
};

function hostedProviderSwitchProvider(
	providerId: string,
	managedBy: "clawdi" | "user",
): Record<string, unknown> {
	const envPrefix = providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	return {
		kind: "openai-compatible",
		type: "custom_openai_compatible",
		baseUrl: `https://${providerId}.provider.example.test/v1`,
		model: hostedProviderSwitchModel(providerId),
		models: [
			{
				id: hostedProviderSwitchModel(providerId),
				context_window: 128000,
				max_tokens: 8192,
				supports_tools: true,
			},
		],
		apiMode: providerId === "clawdi-managed" ? "openai_responses" : "openai_chat",
		managed_by: managedBy,
		runtimeEnvName: managedBy === "clawdi" ? "CLAWDI_AI_API_KEY" : `BYOK_${envPrefix}_API_KEY`,
		apiKeySecretRef: `secret://provider.${providerId}.apiKey`,
	};
}

function hostedProviderSwitchModel(providerId: string): string {
	return `${providerId}-model`;
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

function hostedProviderSwitchLoad(
	home: string,
	selectedProviderId: string,
	generation: number,
): RuntimeManifestLoad {
	const codexProvider = hostedCodexTerminalProvider(
		"https://clawdi-managed.provider.example.test/v1",
	);
	const terminalTooling = {
		codex: {
			enabled: true,
			provider_id: "clawdi-managed",
			primary_model: {
				provider_id: "clawdi-managed",
				model: hostedProviderSwitchModel("clawdi-managed"),
			},
			provider: codexProvider,
		},
	};
	return {
		source: "remote-datasource",
		sourcePath: "https://runtime-source.test/desired-state",
		offline: false,
		secretValues: {
			...Object.fromEntries(
				Object.keys(HOSTED_PROVIDER_SWITCH_PROVIDERS).map((providerId) => [
					`secret://provider.${providerId}.apiKey`,
					`sk-${providerId}`,
				]),
			),
			...TEST_HOSTED_CODEX_SECRET_VALUES,
		},
		manifest: {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_provider_switch",
			environmentId: "env_provider_switch",
			instanceId: "iid_provider_switch",
			generation,
			issuedAt: "2026-07-08T00:00:00Z",
			workspaceRoot: join(home, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: {
				openclaw: {
					...hostedOpenClawRuntime({
						provider_ids: [selectedProviderId],
						primary_model: {
							provider_id: selectedProviderId,
							model: hostedProviderSwitchModel(selectedProviderId),
						},
					}),
					install: {
						authority: "official",
						method: "official-installer",
						url: "https://openclaw.ai/install-cli.sh",
						home,
						args: ["--json", "--no-onboard"],
					},
				},
				hermes: {
					...hostedHermesRuntime({
						provider_ids: [selectedProviderId],
						primary_model: {
							provider_id: selectedProviderId,
							model: hostedProviderSwitchModel(selectedProviderId),
						},
					}),
					install: {
						authority: "official",
						method: "official-installer",
						url: "https://hermes-agent.nousresearch.com/install.sh",
						home,
						args: ["--skip-setup", "--skip-browser", "--non-interactive"],
					},
				},
			},
			projection: {
				sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
				system: { home, workspace: join(home, "clawdi") },
				providers: HOSTED_PROVIDER_SWITCH_PROVIDERS,
				terminalTooling,
			},
			egressProfiles: { profiles: [] },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		},
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
	const install =
		runtimeName === "openclaw"
			? {
					authority: "official" as const,
					method: "official-installer" as const,
					url: "https://openclaw.ai/install-cli.sh",
					home,
					args: ["--json", "--no-onboard"],
				}
			: {
					authority: "official" as const,
					method: "official-installer" as const,
					url: "https://hermes-agent.nousresearch.com/install.sh",
					home,
					args: ["--skip-setup", "--skip-browser", "--non-interactive"],
				};
	const providers =
		providerMode === "configured"
			? {
					"clawdi-managed": {
						kind: "openai-compatible",
						baseUrl: "https://managed.provider.example.test/v1",
						model: "gpt-5.5",
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
	return {
		source: "remote-datasource",
		sourcePath: "https://runtime-source.test/desired-state",
		offline: false,
		secretValues: {
			...(providerMode === "configured"
				? { "secret://provider.clawdi-managed.apiKey": "sk-managed-provider" }
				: {}),
			...TEST_HOSTED_CODEX_SECRET_VALUES,
		},
		manifest: {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_provider_mode",
			environmentId: "env_provider_mode",
			instanceId: "iid_provider_mode",
			generation,
			issuedAt: "2026-07-14T00:00:00Z",
			workspaceRoot: join(home, "clawdi"),
			runtime: runtimeName,
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: { [runtimeName]: { ...runtime, install } },
			projection: {
				sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
				system: { home, workspace: join(home, "clawdi") },
				providers,
				terminalTooling,
			},
			egressProfiles: hostedManifestEgressProfiles({ providers, terminalTooling }),
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		},
	};
}

function writeTestRuntimeAppliedState(
	paths: RuntimePaths,
	load: RuntimeManifestLoad,
	convergence: RuntimeConvergenceResult,
	input: {
		etag?: string;
		sourceRevision?: string;
		egressSidecarSecretRevision?: string;
	} = {},
): void {
	const applyContext = load.applyContext;
	if (applyContext) currentTestApplyContext = applyContext;
	const sourceRevision =
		input.sourceRevision ??
		load.sourceRevision ??
		runtimeContentSha256({
			manifest: load.sourceManifest ?? load.manifest,
			channelBindings: load.channelBindings ?? [],
			secretValues: load.secretValues ?? {},
		});
	const selectedRuntime = load.manifest.runtime;
	const providerIds = selectedRuntime
		? [...new Set(load.manifest.runtimes[selectedRuntime]?.provider_ids ?? [])].sort()
		: [];
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
					manifest: load.manifest,
					secretValues: load.secretValues ?? {},
				}),
			},
			...(input.egressSidecarSecretRevision
				? { egressSidecarSecretRevision: input.egressSidecarSecretRevision }
				: {}),
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

function writeOfflineStrictAppliedState(
	paths: RuntimePaths,
	manifest: RuntimeManifest,
	contentSha256: string,
): void {
	mkdirSync(paths.serviceStateRoot, { recursive: true });
	writeRuntimeAppliedState(
		{
			schemaVersion: "clawdi.runtimeAppliedState.v2",
			appliedAt: "2026-07-16T00:01:00.000Z",
			instanceId: manifest.instanceId,
			etag: testBundleEtag("transport-etag-offline"),
			sourceRevision: "a".repeat(64),
			generation: manifest.generation,
			manifestETag: OFFLINE_RUNTIME_APPLY_IDENTITY.manifestETag,
			applyReceiptId: OFFLINE_RUNTIME_APPLY_IDENTITY.applyReceiptId,
			bootNonce: OFFLINE_RUNTIME_APPLY_IDENTITY.bootNonce,
			contentIdentity: {
				sourcePath: "https://runtime.test/v1/runtime/manifest",
				sha256: contentSha256,
			},
			providerIds: [],
			projectedProviderIds: {},
		},
		paths,
	);
}

function applyOpenClawProviderPatchLog(
	patchLog: string,
	initialProviders: Record<string, unknown>,
): Record<string, unknown> {
	const providers = { ...initialProviders };
	const patchText = existsSync(patchLog) ? readFileSync(patchLog, "utf-8") : "";
	for (const rawPatch of patchText.split("\n---\n")) {
		const trimmed = rawPatch.trim();
		if (!trimmed) continue;
		const patch = JSON.parse(trimmed);
		if (!isRecord(patch)) continue;
		const models = isRecord(patch.models) ? patch.models : {};
		const patchProviders = isRecord(models.providers) ? models.providers : {};
		for (const [providerId, providerPatch] of Object.entries(patchProviders)) {
			if (providerPatch === null) delete providers[providerId];
			else providers[providerId] = providerPatch;
		}
	}
	return providers;
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
		expect(paths.managedConfig).toBe(join(root, "etc", "clawdi", "clawdi.json"));
		expect(paths.syncState).toBe(join(state, "sync", "runtimes.json"));
		expect(paths.cliManagedBin).toBe(join(state, "maintained", "clawdi", "bin", "clawdi"));
		expect(paths.cliNpmPrefix).toBe(join(state, "maintained", "clawdi", "npm"));
		expect(paths.cliNpmCache).toBe(join(root, "var", "cache", "clawdi", "npm"));
		expect(paths.egressProfileRoot).toBe(join(run, "egress"));
		expect(paths.egressProfileBundle).toBe(join(run, "egress", "profiles.json"));
		expect(paths.instanceData).toBe(join(run, "instance-data.json"));
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
	it("keeps generic Hermes dashboard defaults on loopback", () => {
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

		expect(config.defaultArgs).toEqual(["dashboard", "--host", "127.0.0.1", "--no-open"]);
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

		expect(config.defaultArgs).toEqual([
			"gateway",
			"run",
			"--allow-unconfigured",
			"--bind",
			"loopback",
			"--force",
		]);
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
			sourceManifest: manifest,
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

	it("does not load cached secrets for a disabled runtime", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.cacheRoot, { recursive: true });
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_cached_secret",
				environmentId: "env_cached_secret",
				instanceId: "iid_cached_secret",
				generation: 3,
				issuedAt: "2026-06-06T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@1.2.3-test",
					registry: "https://registry.npmjs.org",
				},
				runtimes: { openclaw: { enabled: false } },
				projection: {
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://sub2api.test/v1",
							apiKeySecretRef: "secret://provider.default.apiKey",
						},
					},
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);
		writeFileSync(
			paths.managedSecretCacheFile,
			JSON.stringify({ "secret://provider.default.apiKey": "sk-cached-provider" }),
		);

		const loaded = await loadRuntimeManifest(paths);
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected offline manifest load success");
		expect(loaded.source).toBe("last-good-cache");
		expect(loaded.offline).toBe(true);
		expect(loaded.secretValues).toBeUndefined();
	});

	it("reports degraded-offline apply and boot state after remote fetch failure", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const paths = getRuntimePaths();
		mkdirSync(paths.cacheRoot, { recursive: true });
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify(cachedHostedCliDesiredState(home, "clawdi@1.2.3-test")),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => {
					throw new Error("control plane unavailable");
				},
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(paths);
			if (!("manifest" in loaded)) {
				throw new Error(`expected last-good manifest: ${loaded.errors.join("; ")}`);
			}
			const convergence = convergeRuntimeManifest(loaded, paths, { cacheLastGood: false });
			const boot = buildRuntimeBootStatus(
				{
					mode: convergence.mode,
					status: "ok",
					stage: "final",
					bootId: "boot-degraded-offline",
					runtimeMode: "hosted",
					activeGeneration: convergence.manifest.generation,
					instanceId: convergence.manifest.instanceId,
					enabledRuntimes: convergence.enabledRuntimes,
					errors: [],
					exitCode: 0,
					datasource: "RuntimeSource",
					hostPolicy: { source: "builtin", exists: true, valid: true },
				},
				paths,
			);

			expect(loaded.source).toBe("last-good-cache");
			expect(loaded.offline).toBe(true);
			expect(convergence.mode).toBe("degraded-offline");
			expect(boot.mode).toBe("degraded-offline");
		} finally {
			restore();
		}
	});

	it("gates strict-v2 offline cache on the current, durable, and migration identity states", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.cacheRoot, { recursive: true });
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_offline_identity",
			environmentId: "env_offline_identity",
			instanceId: "iid_offline_identity",
			generation: 3,
			issuedAt: "2026-07-16T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@1.2.3-test",
				registry: "https://registry.npmjs.org",
			},
			runtimes: { openclaw: { enabled: false } },
			projection: { sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2" },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		};
		writeFileSync(paths.manifestLastGood, JSON.stringify(manifest));
		writeOfflineStrictAppliedState(
			paths,
			manifest,
			runtimeContentSha256({
				manifest: manifestSchema.parse(manifest),
				secretValues: {},
			}),
		);
		writeCanonicalApplyContext(OFFLINE_RUNTIME_APPLY_IDENTITY, CANONICAL_TEST_CONTEXT);
		const loaded = await loadRuntimeManifest(paths);
		if (!("manifest" in loaded)) {
			throw new Error(`expected offline manifest load success: ${loaded.errors.join("; ")}`);
		}
		expect(loaded.applyContext?.identity).toEqual(OFFLINE_RUNTIME_APPLY_IDENTITY);

		writeCanonicalApplyContext(
			{
				...OFFLINE_RUNTIME_APPLY_IDENTITY,
				applyReceiptId: "apply-receipt-offline-0002",
			},
			CANONICAL_TEST_CONTEXT,
		);
		const mismatched = await loadRuntimeManifest(paths);
		expect("errors" in mismatched).toBe(true);
		if (!("errors" in mismatched)) throw new Error("expected offline identity mismatch");
		expect(mismatched.errors).toContain(
			"cached strict-v2 apply identity does not match the current runtime apply identity; refusing offline boot",
		);

		const applied = readRuntimeAppliedState(paths);
		if (!applied) throw new Error("expected durable offline applied state");
		const {
			manifestETag: _manifestETag,
			applyReceiptId: _applyReceiptId,
			bootNonce: _bootNonce,
			...legacyApplied
		} = applied;
		writeRuntimeAppliedState(legacyApplied, paths);
		writeCanonicalApplyContext(OFFLINE_RUNTIME_APPLY_IDENTITY);
		const firstIdentityFileMigration = await loadRuntimeManifest(paths);
		expect("errors" in firstIdentityFileMigration).toBe(true);
		if (!("errors" in firstIdentityFileMigration)) {
			throw new Error("expected first identity-file migration to fail closed");
		}
		expect(firstIdentityFileMigration.errors).toContain(
			"cached strict-v2 apply identity does not match the current runtime apply identity; refusing offline boot",
		);
	});

	it("refuses strict-v2 offline identity restoration when cached manifest content changed", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.cacheRoot, { recursive: true });
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_offline_content_mismatch",
			environmentId: "env_offline_content_mismatch",
			instanceId: "iid_offline_content_mismatch",
			generation: 3,
			issuedAt: "2026-07-16T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@1.2.3-test",
				registry: "https://registry.npmjs.org",
			},
			runtimes: { openclaw: { enabled: false } },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		};
		writeFileSync(paths.manifestLastGood, JSON.stringify(manifest));
		writeOfflineStrictAppliedState(
			paths,
			manifest,
			runtimeContentSha256({
				manifest: manifestSchema.parse({
					...manifest,
					issuedAt: "2026-07-15T00:00:00Z",
				}),
				secretValues: {},
			}),
		);
		writeCanonicalApplyContext(OFFLINE_RUNTIME_APPLY_IDENTITY, CANONICAL_TEST_CONTEXT);

		const loaded = await loadRuntimeManifest(paths);
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected offline manifest mismatch failure");
		expect(loaded.mode).toBe("repair");
		expect(loaded.errors).toContain(
			"cached manifest does not match the durable strict-v2 apply identity; refusing offline boot",
		);
	});

	it("refuses strict-v2 offline identity restoration when cached secret content changed", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.cacheRoot, { recursive: true });
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_offline_secret_mismatch",
			environmentId: "env_offline_secret_mismatch",
			instanceId: "iid_offline_secret_mismatch",
			generation: 3,
			issuedAt: "2026-07-16T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@1.2.3-test",
				registry: "https://registry.npmjs.org",
			},
			runtimes: { openclaw: { enabled: false } },
			projection: {
				providers: {
					default: {
						kind: "openai-compatible",
						baseUrl: "https://sub2api.test/v1",
						apiKeySecretRef: "secret://provider.default.apiKey",
					},
				},
			},
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		};
		writeFileSync(paths.manifestLastGood, JSON.stringify(manifest));
		writeFileSync(
			paths.managedSecretCacheFile,
			JSON.stringify({ "secret://provider.default.apiKey": "sk-new-cached-value" }),
		);
		writeOfflineStrictAppliedState(
			paths,
			manifest,
			runtimeContentSha256({
				manifest: manifestSchema.parse(manifest),
				secretValues: normalizeSecretValues({
					"secret://provider.default.apiKey": "sk-original-applied-value",
				}),
			}),
		);
		writeCanonicalApplyContext(OFFLINE_RUNTIME_APPLY_IDENTITY, CANONICAL_TEST_CONTEXT);

		const loaded = await loadRuntimeManifest(paths);
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected offline secret mismatch failure");
		expect(loaded.mode).toBe("repair");
		expect(loaded.errors).toContain(
			"cached manifest does not match the durable strict-v2 apply identity; refusing offline boot",
		);
	});

	it("does not require an unselected provider secret for offline boot", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.cacheRoot, { recursive: true });
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_cached_secret_missing",
				environmentId: "env_cached_secret_missing",
				instanceId: "iid_cached_secret_missing",
				generation: 3,
				issuedAt: "2026-06-06T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@1.2.3-test",
					registry: "https://registry.npmjs.org",
				},
				runtimes: { openclaw: { enabled: false } },
				projection: {
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://sub2api.test/v1",
							apiKeySecretRef: "secret://provider.default.apiKey",
						},
					},
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		const loaded = await loadRuntimeManifest(paths);
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected offline manifest load success");
		expect(loaded.source).toBe("last-good-cache");
		expect(loaded.offline).toBe(true);
		expect(loaded.secretValues).toBeUndefined();
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
								packageSpec: "clawdi@1.2.3-test",
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
							mcp: {
								servers: { clawdi: { command: "clawdi", args: ["mcp"] } },
							},
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
			expect(loaded.manifest.clawdiCli?.packageSpec).toBe("clawdi@1.2.3-test");
			expect(loaded.manifest.projection?.mcp).toEqual({
				servers: { clawdi: { command: "clawdi", args: ["mcp"] } },
			});
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

	for (const packageSpec of [
		"clawdi@latest",
		"clawdi@agent-v2",
		"clawdi@1.2.3+build.1",
		"clawdi",
	]) {
		it(`rejects cached hosted state with ${packageSpec} and no hosted marker`, async () => {
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = join(root, "run", "clawdi");
			const paths = getRuntimePaths();
			mkdirSync(paths.cacheRoot, { recursive: true });
			writeFileSync(
				paths.manifestLastGood,
				JSON.stringify(cachedHostedCliDesiredState(home, packageSpec)),
			);

			const loaded = await loadRuntimeManifest(paths);
			expect("errors" in loaded).toBe(true);
			if (!("errors" in loaded)) throw new Error("expected cached manifest rejection");
			expect(loaded.errors.join("\n")).toContain("must be clawdi@<exact-semver>");
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
exit 0
SH
chmod +x "$HOME/.local/bin/hermes"
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
								packageSpec: "clawdi@1.2.3-test",
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
								packageSpec: "clawdi@1.2.3-test",
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
								packageSpec: "clawdi@1.2.3-test",
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
		const openclawOriginsPatch = join(root, "openclaw-origins-patch.json");
		const openclawCommand = join(root, "openclaw-provider-command.txt");
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
				`  if [ ! -f '${openclawPatch}' ]; then`,
				`    cat > '${openclawPatch}'`,
				"  else",
				`    cat > '${openclawOriginsPatch}'`,
				"  fi",
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
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
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
		expect(readFileSync(openclawCommand, "utf-8").trim().split("\n")).toEqual([
			"config patch --stdin",
			'config patch --stdin --replace-path models.providers["default"]',
		]);
		expect(JSON.parse(readFileSync(openclawPatch, "utf-8"))).toEqual({
			agents: {
				defaults: {
					userTimezone: "Europe/Paris",
				},
			},
			gateway: {
				mode: "local",
				auth: {
					mode: "token",
					token: "gateway-token",
				},
				controlUi: {
					allowedOrigins: ["https://app-v2-18789.k3s.example.test"],
					dangerouslyDisableDeviceAuth: true,
				},
			},
		});
		const patch = JSON.parse(readFileSync(openclawOriginsPatch, "utf-8"));
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
		expect(runConfig.defaultArgs).toEqual([
			"gateway",
			"run",
			"--allow-unconfigured",
			"--bind",
			"loopback",
			"--force",
		]);
		expect(runConfig.defaultArgs).not.toContain("--auth");
		expect(runConfig.env.CLAWDI_AI_API_KEY).toBeUndefined();
		expect(runConfig.env.OPENAI_API_KEY).toBeUndefined();
		expect(runConfig.secretEnv).toEqual({ OPENAI_API_KEY: "secret://provider.default.apiKey" });
		expect(runConfig.secretFilePath).toBeNull();
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
	});

	it("canonicalizes legacy managed v2 Chat input to Responses while replacing models", () => {
		const home = join(root, "model-switch", "home", "clawdi");
		const state = join(root, "model-switch", "var", "lib", "clawdi");
		const run = join(root, "model-switch", "run", "clawdi");
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

		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "configured", 2);
		const providerId = "clawdi-v2-deployment-42";
		const providers = {
			[providerId]: {
				...loaded.manifest.projection?.providers?.["clawdi-managed"],
				model: "sol",
				models: [{ id: "sol" }],
				apiMode: "openai_chat",
			},
		};
		loaded.manifest = {
			...loaded.manifest,
			runtimes: {
				openclaw: {
					...loaded.manifest.runtimes.openclaw,
					provider_ids: [providerId],
					primary_model: { provider_id: providerId, model: "sol" },
				},
			},
			projection: {
				...loaded.manifest.projection,
				providers,
			},
			egressProfiles: hostedManifestEgressProfiles({
				providers,
				terminalTooling: loaded.manifest.projection?.terminalTooling,
			}),
		};

		const paths = getRuntimePaths();
		const convergence = convergeRuntimeManifest(loaded, paths);

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(commandLog, "utf-8")).not.toContain("config patch --stdin");
		const mutation = JSON.parse(readFileSync(mutationLog, "utf8"));
		expect(mutation).toMatchObject({
			base: "source",
			afterWrite: { mode: "none" },
			allowConfigSizeDrop: true,
		});
		expect(mutation.nextBytes).toBeLessThan(Math.floor(mutation.beforeBytes * 0.5));
		expect(mutation.explicitSetPaths).toContainEqual(["models", "providers", "clawdi"]);
		const appliedConfig = JSON.parse(readFileSync(openclawConfig, "utf-8"));
		expect(appliedConfig.agents.defaults.model.primary).toBe("clawdi/sol");
		expect(appliedConfig.models.mode).toBe("replace");
		expect(appliedConfig.models.providers.clawdi.models).toEqual([
			expect.objectContaining({ id: "sol" }),
		]);
		expect(appliedConfig.models.providers.clawdi.api).toBe("openai-responses");
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
		expect(JSON.stringify(appliedConfig)).not.toContain("legacy-");

		writeTestRuntimeAppliedState(paths, loaded, convergence);
		const unmanaged = convergeRuntimeManifest(
			hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 3),
			paths,
		);
		expect(unmanaged.installErrors).toEqual([]);
		const deletionMutation = JSON.parse(readFileSync(mutationLog, "utf8"));
		expect(deletionMutation.unsetPaths).toContainEqual(["models", "providers", "clawdi"]);
		const unmanagedConfig = JSON.parse(readFileSync(openclawConfig, "utf8"));
		expect(unmanagedConfig.models.mode).toBe("merge");
		expect(unmanagedConfig.models.providers.clawdi).toBeUndefined();
		expect(unmanagedConfig.models.providers["user-owned"]).toEqual(
			appliedConfig.models.providers["user-owned"],
		);
	});

	it("writes Codex managed provider config from hosted runtime converge", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const codexHome = join(home, ".codex");
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(join(codexHome, "config.toml"), '# stale Hosted config\nmodel = "stale"\n');
		chmodSync(codexHome, 0o755);
		chmodSync(join(codexHome, "config.toml"), 0o644);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const legacyWireResponse = hostedCliManifestResponse(home, "clawdi@1.2.3-test");
		const terminalTooling = expectRecord(
			legacyWireResponse.manifest.terminalTooling,
			"legacy terminal tooling",
		);
		const codex = expectRecord(terminalTooling.codex, "legacy terminal Codex");
		const wireProvider = expectRecord(codex.provider, "legacy terminal Codex provider");
		wireProvider.baseUrl = "https://codex-provider.example.test/v1";
		wireProvider.runtimeEnvName = "OPENAI_API_KEY";
		wireProvider.models = [{ id: "legacy-codex-model" }];
		const normalized = normalizeHostedManifestFixture(legacyWireResponse);
		const normalizedTerminalTooling = expectRecord(
			normalized.manifest.projection?.terminalTooling,
			"normalized terminal tooling",
		);
		const normalizedCodex = expectRecord(normalizedTerminalTooling.codex, "normalized Codex");
		const normalizedProvider = expectRecord(normalizedCodex.provider, "normalized Codex provider");
		expect(normalizedProvider.models).toBeUndefined();
		const legacyWireLoad: RuntimeManifestLoad = {
			...normalized,
			source: "remote-datasource",
			sourcePath: "https://runtime-source.test/desired-state",
			offline: false,
			manifest: {
				...normalized.manifest,
				locale: undefined,
				openclawGatewayAuth: undefined,
				projection: { terminalTooling: normalized.manifest.projection?.terminalTooling },
				runtimes: {
					openclaw: { enabled: false },
					hermes: { enabled: false },
				},
			},
		};
		const convergence = convergeRuntimeManifest(legacyWireLoad, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(statSync(codexHome).mode & 0o777).toBe(0o700);
		const configPath = join(codexHome, "config.toml");
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(configPath, "utf-8")).toBe(
			[
				"# Generated by Clawdi hosted runtime. Do not put API keys in this file.",
				'model_provider = "clawdi"',
				"",
				"[model_providers.clawdi]",
				'name = "clawdi"',
				'base_url = "https://codex-provider.example.test/v1"',
				'env_key = "CLAWDI_AI_API_KEY"',
				'wire_api = "responses"',
				"",
			].join("\n"),
		);
		expect(readFileSync(configPath, "utf-8")).not.toMatch(/^model\s*=|model_catalog_json|models/m);
		expect(readFileSync(configPath, "utf-8")).not.toMatch(/managed/i);
	});

	it("installs the Codex runtime add-on through npm when managed config is projected", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const binDir = join(root, "fake-bin");
		const npmArgsPath = join(root, "npm-args.txt");
		const userCodexConfig = join(home, ".codex", "config.toml");
		const userConfigBytes = Buffer.from('# user config\nmodel = "user-model"\n');
		const previousPath = process.env.PATH;
		const previousUmask = process.umask(0o077);
		mkdirSync(binDir, { recursive: true });
		mkdirSync(dirname(userCodexConfig), { recursive: true });
		writeFileSync(userCodexConfig, userConfigBytes);
		writeFileSync(
			join(binDir, "npm"),
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				`printf '%s\\n' "$@" > '${npmArgsPath}'`,
				"prefix=''",
				'while [ "$#" -gt 0 ]; do',
				'  case "$1" in',
				"    --prefix)",
				'      prefix="$2"',
				"      shift 2",
				"      ;;",
				"    *)",
				"      shift",
				"      ;;",
				"  esac",
				"done",
				'mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@openai/codex"',
				`printf '%s\\n' '{"version":"0.146.0"}' > "$prefix/lib/node_modules/@openai/codex/package.json"`,
				"cat > \"$prefix/bin/codex\" <<'SH'",
				"#!/usr/bin/env sh",
				"printf 'env=<%s>\\n' \"$" + '{CLAWDI_AI_API_KEY-unset}"',
				'for arg in "$@"; do printf \'arg=<%s>\\n\' "$arg"; done',
				"SH",
				'chmod 755 "$prefix/bin/codex"',
				"",
			].join("\n"),
		);
		chmodSync(join(binDir, "npm"), 0o755);
		delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");
		const paths = getRuntimePaths();

		try {
			const convergence = convergeRuntimeManifest(
				{
					source: "remote-datasource",
					sourcePath: "https://runtime-source.test/desired-state",
					offline: false,
					manifest: {
						schemaVersion: "clawdi.runtimeDesiredState.v1",
						deploymentId: "dep_codex_addon",
						environmentId: "env_codex_addon",
						instanceId: "iid_codex_addon",
						generation: 1,
						issuedAt: "2026-07-10T00:00:00Z",
						workspaceRoot: join(home, "clawdi"),
						controlPlane: { apiUrl: "https://cloud-api.test" },
						runtimes: {
							openclaw: { enabled: false },
						},
						projection: {
							system: { home },
							providers: {},
							terminalTooling: {
								codex: {
									enabled: true,
									provider_id: "codex-managed",
									primary_model: { provider_id: "codex-managed", model: "gpt-5.5" },
									provider: {
										kind: "openai-compatible",
										baseUrl: "https://managed-provider.example.test/v1",
										apiMode: "openai_responses",
										managed_by: "clawdi",
										runtimeEnvName: "OPENAI_API_KEY",
										apiKeySecretRef: "secret://tool.codex.apiKey",
									},
								},
							},
						},
						egressProfiles: { profiles: [] },
						recovery: { cacheManifest: true, allowOfflineBoot: true },
					},
				},
				paths,
			);

			expect(convergence.installErrors).toEqual([]);
		} finally {
			process.umask(previousUmask);
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		}

		const npmArgs = readFileSync(npmArgsPath, "utf-8");
		expect(npmArgs).toContain("@openai/codex@0.146.0");
		expect(npmArgs).toContain(`${paths.codexInstallRoot}\n`);
		expect(npmArgs).not.toContain("--cache\n");
		const realBin = join(paths.codexInstallRoot, "bin", "codex");
		const packageJson = join(paths.codexInstallRoot, "lib/node_modules/@openai/codex/package.json");
		const commandShim = paths.codexCommand;
		expect(statSync(paths.codexInstallRoot).mode & 0o777).toBe(0o700);
		expect(statSync(dirname(realBin)).mode & 0o777).toBe(0o700);
		expect(statSync(realBin).mode & 0o777).toBe(0o755);
		expect(statSync(packageJson).mode & 0o777).toBe(0o600);
		expect(statSync(commandShim).mode & 0o777).toBe(0o755);
		expect(readFileSync(commandShim, "utf8")).not.toContain("--profile");
		expect(readFileSync(userCodexConfig, "utf8")).toContain('model_provider = "clawdi"');

		const runShim = (args: string[]) => {
			const result = spawnSync(commandShim, args, {
				encoding: "utf8",
				env: { ...process.env, CLAWDI_AI_API_KEY: "user-existing-key" },
			});
			expect(result.status).toBe(0);
			return result.stdout.trimEnd().split("\n");
		};
		expect(runShim(["exec", "quoted arg", ""])).toEqual([
			"env=<clawdi-egress-placeholder>",
			"arg=<exec>",
			"arg=<quoted arg>",
			"arg=<>",
		]);
		for (const args of [
			["resume", "session id", "--flag=value"],
			["exec", "", "'quoted'", '"double quoted"'],
		]) {
			expect(runShim(args)).toEqual([
				"env=<clawdi-egress-placeholder>",
				...args.map((arg) => `arg=<${arg}>`),
			]);
		}
	});

	it("does not reinstall the exact executable Hosted Codex package", () => {
		const home = join(root, "codex-exact", "home", "clawdi");
		const state = join(root, "codex-exact", "var", "lib", "clawdi");
		const run = join(root, "codex-exact", "run", "clawdi");
		const binDir = join(root, "codex-exact", "fake-bin");
		const installMarker = join(root, "codex-exact", "npm-install.txt");
		const previousPath = process.env.PATH;
		seedOpenClawBinary(home);
		seedHostedCodexPackage(home, "0.146.0");
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
		expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
			'model_provider = "clawdi"',
		);
		expect(readFileSync(getRuntimePaths().codexCommand, "utf8")).not.toContain("--profile");
	});

	it("reinstalls missing, damaged, or old Hosted Codex packages to the exact version", () => {
		const previousPath = process.env.PATH;
		const cases = [
			{ name: "missing" },
			{ name: "old", version: "0.145.0" },
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
							join(
								getRuntimePaths().codexInstallRoot,
								"lib/node_modules/@openai/codex/package.json",
							),
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

	it("fails closed when npm installs the wrong Hosted Codex version", () => {
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
				"Codex npm install produced version 0.145.0; expected 0.146.0",
			);
			expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		}
	});

	it("does not mutate live config when the Codex runtime add-on install fails", () => {
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
			paths.managedConfig,
			paths.syncState,
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
				hostedProviderSwitchLoad(home, "clawdi-managed", 2),
				paths,
			);

			expect(convergence.installErrors.join("\n")).toContain("runtime codex add-on install failed");
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

	it("keeps the Codex tool profile configured when runtime providers are user-owned", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const convergence = convergeRuntimeManifest(
			{
				source: "remote-datasource",
				sourcePath: "https://runtime-source.test/desired-state",
				offline: false,
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_codex_byok_provider",
					environmentId: "env_codex_byok_provider",
					instanceId: "iid_codex_byok_provider",
					generation: 1,
					issuedAt: "2026-07-10T00:00:00Z",
					workspaceRoot: join(home, "clawdi"),
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: { enabled: false },
					},
					projection: {
						system: { home },
						providers: {
							default: {
								kind: "openai-compatible",
								baseUrl: "https://byok-provider.example.test/v1",
								model: "gpt-5.5",
								apiMode: "openai_responses",
								managed_by: "user",
								runtimeEnvName: "OPENAI_API_KEY",
								apiKeySecretRef: "secret://provider.byok.apiKey",
							},
						},
						terminalTooling: TEST_HOSTED_CODEX_TERMINAL_TOOLING,
					},
					egressProfiles: { profiles: [] },
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
			},
			getRuntimePaths(),
		);

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
			'model_provider = "clawdi"',
		);
	});

	it("reconciles hosted provider projections when the selected provider changes", () => {
		const cases = [
			{ id: "managed-to-byok", first: "clawdi-managed", second: "byok-a" },
			{ id: "byok-to-managed", first: "byok-a", second: "clawdi-managed" },
			{ id: "managed-to-managed", first: "clawdi-managed", second: "clawdi-managed-v2" },
			{ id: "byok-to-byok", first: "byok-a", second: "byok-b" },
		];
		for (const providerCase of cases) {
			const firstAgentProvider =
				providerCase.first === "clawdi-managed-v2" ? "clawdi" : providerCase.first;
			const secondAgentProvider =
				providerCase.second === "clawdi-managed-v2" ? "clawdi" : providerCase.second;
			const caseRoot = join(root, providerCase.id);
			const home = join(caseRoot, "home", "clawdi");
			const state = join(caseRoot, "var", "lib", "clawdi");
			const run = join(caseRoot, "run", "clawdi");
			const workspace = join(home, "clawdi");
			const openclawBin = join(home, ".local", "bin", "openclaw");
			const openclawPatchLog = join(caseRoot, "openclaw-provider-patches.jsonl");
			mkdirSync(dirname(openclawBin), { recursive: true });
			mkdirSync(join(home, ".hermes"), { recursive: true });
			mkdirSync(workspace, { recursive: true });
			writeFileSync(
				openclawBin,
				`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >> '${openclawPatchLog}'
  printf '\\n---\\n' >> '${openclawPatchLog}'
  exit 0
fi
exit 0
`,
			);
			chmodSync(openclawBin, 0o700);
			writeHermesVersionBinary(home, "0.18.0");
			writeFileSync(
				join(home, ".hermes", "config.yaml"),
				[
					"providers:",
					"  user-local:",
					'    api: "http://127.0.0.1:11434/v1"',
					'    custom_field: "keep-me"',
					"",
				].join("\n"),
			);
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;

			const paths = getRuntimePaths();
			const firstLoad = hostedProviderSwitchLoad(home, providerCase.first, 1);
			const first = convergeRuntimeManifest(firstLoad, paths);
			expect(first.installErrors).toEqual([]);
			writeTestRuntimeAppliedState(paths, firstLoad, first, {
				etag: `"${providerCase.id}-1"`,
			});

			const secondLoad = hostedProviderSwitchLoad(home, providerCase.second, 2);
			const second = convergeRuntimeManifest(secondLoad, paths);
			expect(second.installErrors).toEqual([]);
			if (providerCase.id === "byok-to-byok") {
				const projectionInput = hostedAiProviderCatalog(secondLoad.manifest, "openclaw");
				expect(projectionInput).not.toBeNull();
				if (!projectionInput) throw new Error("expected OpenClaw provider projection input");
				const sharedPatch = buildOpenClawHostedProviderPatch(projectionInput, [firstAgentProvider]);
				const appliedProviderPatches = readFileSync(openclawPatchLog, "utf-8")
					.split("\n---\n")
					.map((content) => content.trim())
					.filter(Boolean)
					.map((content) => JSON.parse(content) as unknown)
					.filter((patch): patch is Record<string, unknown> => {
						if (!isRecord(patch)) return false;
						const models = patch.models;
						return isRecord(models) && isRecord(models.providers);
					});
				expect(appliedProviderPatches.at(-1)).toEqual(JSON.parse(sharedPatch.content));
			}

			const openclawProviders = applyOpenClawProviderPatchLog(openclawPatchLog, {
				"user-local": {
					baseUrl: "http://127.0.0.1:11434/v1",
					models: [{ id: "local-model" }],
				},
			});
			expect(Object.keys(openclawProviders).sort()).toEqual(
				["user-local", secondAgentProvider].sort(),
			);
			expect(openclawProviders[firstAgentProvider]).toBeUndefined();
			expect(openclawProviders[secondAgentProvider]).toMatchObject({
				baseUrl: `https://${providerCase.second}.provider.example.test/v1`,
			});
			expect(openclawProviders["user-local"]).toMatchObject({
				baseUrl: "http://127.0.0.1:11434/v1",
			});

			const hermesConfig = readHermesConfigYaml(home);
			const hermesProviders = expectRecord(hermesConfig.providers, "Hermes providers config");
			expect(Object.keys(hermesProviders).sort()).toEqual(
				["user-local", secondAgentProvider].sort(),
			);
			expect(hermesProviders[firstAgentProvider]).toBeUndefined();
			expect(hermesProviders[secondAgentProvider]).toMatchObject({
				api: `https://${providerCase.second}.provider.example.test/v1`,
			});
			expect(hermesProviders["user-local"]).toMatchObject({
				custom_field: "keep-me",
			});
		}
	});

	it.each([
		"openclaw",
		"hermes",
	] as const)("converges %s in unmanaged mode without touching user provider config", (runtimeName) => {
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
		expect(readFileSync(userConfigPath, "utf-8")).toBe(userConfig);
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
			"clawdi-egress-placeholder",
			"provider.clawdi-managed",
			"egress-secrets.json",
		]) {
			expect(runtimeUnitEnv).not.toContain(forbidden);
		}
		const egressSecrets = readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8");
		expect(egressSecrets).toContain("secret://tool.codex.apiKey");
		expect(egressSecrets).toContain("sk-codex-tool");
		expect(existsSync(join(getRuntimePaths().projectionRoot, "clawdi-mcp.json"))).toBe(false);
		const applied = JSON.parse(readFileSync(paths.appliedState, "utf-8"));
		expect(applied.providerIds).toEqual([]);
		expect(applied.projectedProviderIds[runtimeName]).toEqual([]);
		expect(applied.projectedProviderIds.codex).toEqual(["clawdi"]);
	});

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

	it("does not delete unknown provider projections when applied state is missing", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatchLog = join(root, "openclaw-provider-patches.jsonl");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(join(home, ".hermes"), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >> '${openclawPatchLog}'
  printf '\\n---\\n' >> '${openclawPatchLog}'
  exit 0
fi
exit 0
`,
		);
		chmodSync(openclawBin, 0o700);
		writeHermesVersionBinary(home, "0.18.0");
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"providers:",
				"  clawdi-orphaned:",
				'    api: "https://orphaned.example.test/v1"',
				'    custom_field: "preserve-without-applied-state"',
				"",
			].join("\n"),
		);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const paths = getRuntimePaths();
		const convergence = convergeRuntimeManifest(hostedProviderSwitchLoad(home, "byok-b", 1), paths);

		expect(convergence.installErrors).toEqual([]);
		expect(existsSync(paths.appliedState)).toBe(false);
		const openclawProviders = applyOpenClawProviderPatchLog(openclawPatchLog, {
			orphaned: {
				baseUrl: "https://orphaned.example.test/v1",
				models: [{ id: "orphaned-model" }],
			},
		});
		expect(openclawProviders.orphaned).toBeDefined();
		expect(openclawProviders["byok-b"]).toBeDefined();
		const hermesProviders = expectRecord(
			readHermesConfigYaml(home).providers,
			"Hermes providers config",
		);
		expect(hermesProviders["clawdi-orphaned"]).toMatchObject({
			custom_field: "preserve-without-applied-state",
		});
		expect(hermesProviders["byok-b"]).toBeDefined();
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
							args: [
								"gateway",
								"run",
								"--allow-unconfigured",
								"--port",
								"18789",
								"--bind",
								"lan",
								"--force",
							],
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
					sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
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
		const failedConfigPatch = convergeRuntimeManifest(loaded, getRuntimePaths(), {
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

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf-8").trim().split("\n")).toEqual([
			"config patch --stdin",
			"config patch --stdin",
			'config patch --stdin --replace-path models.providers["default"]',
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
					allowInsecureAuth: false,
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
		const openclawUnit = readSystemdUserServiceConfig(getRuntimePaths(), "openclaw-gateway");
		expect(openclawUnit).toContain(
			'"gateway" "run" "--allow-unconfigured" "--port" "18789" "--bind" "lan" "--force"',
		);
		expect(openclawUnit).not.toContain('"--auth"');

		const fixedCredentialTime = new Date("2026-08-11T00:00:00.000Z");
		utimesSync(openclawConfig, fixedCredentialTime, fixedCredentialTime);
		utimesSync(gatewayEnvPath, fixedCredentialTime, fixedCredentialTime);
		const configMtime = statSync(openclawConfig).mtimeMs;
		const envMtime = statSync(gatewayEnvPath).mtimeMs;
		const idempotent = convergeRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(idempotent.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf8").trim().split("\n").slice(-1)).toEqual([
			'config patch --stdin --replace-path models.providers["default"]',
		]);
		expect(statSync(openclawConfig).mtimeMs).toBe(configMtime);
		expect(statSync(gatewayEnvPath).mtimeMs).toBe(envMtime);

		rmSync(unitPath, { force: true });
		const reinstalled = convergeRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(reinstalled.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf8").trim().split("\n").slice(-2)).toEqual([
			'config patch --stdin --replace-path models.providers["default"]',
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
		const rotated = convergeRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(rotated.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf8").trim().split("\n").slice(-2)).toEqual([
			"config patch --stdin",
			'config patch --stdin --replace-path models.providers["default"]',
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

	it("projects runtime-scoped hosted providers into each enabled agent config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-runtime-provider-patch.json");
		mkdirSync(dirname(openclawBin), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
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
		writeHermesVersionBinary(home, "0.18.0");

		const loaded: RuntimeManifestLoad = {
			source: "remote-datasource",
			sourcePath: "https://runtime-source.test/desired-state",
			offline: false,
			secretValues: {
				"secret://provider.openclaw.apiKey": "sk-openclaw-provider",
				"secret://provider.hermes.apiKey": "sk-hermes-provider",
			},
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_runtime_scoped_provider",
				environmentId: "env_runtime_scoped_provider",
				instanceId: "iid_runtime_scoped_provider",
				generation: 1,
				issuedAt: "2026-06-22T00:00:00Z",
				workspaceRoot: join(home, "clawdi"),
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: {
						enabled: true,
						provider_ids: ["openclaw"],
						primary_model: { provider_id: "openclaw", model: "gpt-5.5" },
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: ["--json", "--no-onboard"],
						},
					},
					hermes: {
						enabled: true,
						provider_ids: ["hermes"],
						primary_model: {
							provider_id: "hermes",
							model: "kimi/kimi-for-coding",
						},
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://hermes-agent.nousresearch.com/install.sh",
							home,
							args: ["--skip-setup", "--skip-browser", "--non-interactive"],
						},
					},
				},
				projection: {
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
					system: { home },
					providers: {
						openclaw: {
							kind: "openai-compatible",
							baseUrl: "https://openclaw-provider.example.test/v1",
							model: "gpt-5.5",
							models: [
								{
									id: "gpt-5.5",
									context_window: 272000,
									max_tokens: 128000,
									input_modalities: ["text", "image"],
									supports_vision: true,
									supports_tools: true,
									supports_reasoning: true,
								},
							],
							apiMode: "openai_responses",
							runtimeEnvName: "OPENCLAW_PROVIDER_API_KEY",
							apiKeySecretRef: "secret://provider.openclaw.apiKey",
						},
						hermes: {
							kind: "openai-compatible",
							baseUrl: "https://hermes-provider.example.test/v1",
							model: "kimi/kimi-for-coding",
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
							runtimeEnvName: "HERMES_PROVIDER_API_KEY",
							apiKeySecretRef: "secret://provider.hermes.apiKey",
						},
					},
				},
				egressProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const patch = JSON.parse(readFileSync(openclawPatch, "utf-8"));
		expect(patch.agents.defaults.model.primary).toBe("openclaw/gpt-5.5");
		expect(patch.models.providers.openclaw.baseUrl).toBe(
			"https://openclaw-provider.example.test/v1",
		);
		expect(patch.models.providers.openclaw.models[0]).toMatchObject({
			id: "gpt-5.5",
			contextWindow: 272000,
			maxTokens: 128000,
			input: ["text", "image"],
			reasoning: true,
			compat: { supportsTools: true },
		});
		expect(patch.models.providers.openclaw.models[0].api).toBeUndefined();
		expect(JSON.stringify(patch)).not.toContain("hermes-provider.example.test");
		const hermesConfig = readHermesConfigYaml(home);
		const hermesModel = expectRecord(hermesConfig.model, "Hermes model config");
		expect(hermesModel.provider).toBe("custom:hermes");
		expect(hermesModel.default).toBe("kimi/kimi-for-coding");
		expect(hermesModel.context_length).toBeUndefined();
		expect(hermesModel.max_tokens).toBeUndefined();
		expect(hermesModel.supports_vision).toBeUndefined();
		const hermesProviders = expectRecord(hermesConfig.providers, "Hermes providers config");
		const hermesProvider = expectRecord(hermesProviders.hermes, "Hermes provider config");
		expect(hermesProvider.api).toBe("https://hermes-provider.example.test/v1");
		expect(hermesProvider.transport).toBe("chat_completions");
		expect(hermesProvider.key_env).toBe("HERMES_PROVIDER_API_KEY");
		const hermesProviderModels = expectRecord(
			hermesProvider.models,
			"Hermes provider model metadata",
		);
		const kimiModel = expectRecord(
			hermesProviderModels["kimi/kimi-for-coding"],
			"Hermes provider kimi model metadata",
		);
		expect(kimiModel.context_length).toBe(262144);
		expect(kimiModel.supports_vision).toBe(true);
		expect(kimiModel.max_tokens).toBe(32768);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);
		const openclawRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		const hermesRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "hermes.json"), "utf-8"),
		);
		expect(openclawRunConfig.env.OPENCLAW_PROVIDER_API_KEY).toBeUndefined();
		expect(openclawRunConfig.secretEnv).toEqual({
			OPENCLAW_PROVIDER_API_KEY: "secret://provider.openclaw.apiKey",
		});
		expect(hermesRunConfig.env.HERMES_PROVIDER_API_KEY).toBeUndefined();
		expect(hermesRunConfig.secretEnv).toEqual({
			HERMES_PROVIDER_API_KEY: "secret://provider.hermes.apiKey",
		});
		expect(JSON.stringify(openclawRunConfig)).not.toContain("sk-openclaw-provider");
		expect(JSON.stringify(hermesRunConfig)).not.toContain("sk-hermes-provider");
		expect(JSON.stringify(openclawRunConfig)).not.toContain("secret://provider.hermes.apiKey");
		expect(JSON.stringify(hermesRunConfig)).not.toContain("secret://provider.openclaw.apiKey");
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

		const removedLoad: RuntimeManifestLoad = {
			...nativeReauthenticatedLoad,
			secretValues: {},
			manifest: {
				...nativeReauthenticatedLoad.manifest,
				generation: 3,
				runtimes: {},
				projection: {
					...nativeReauthenticatedLoad.manifest.projection,
					providers: {},
				},
			},
		};
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
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("retired");

		auth.credential_pool["openai-codex"].unshift({
			id: nativeProfileId,
			label: "User replacement",
			auth_type: "oauth",
			priority: 0,
			source: "manual:device_code",
			access_token: "foreign-namespaced-access",
			refresh_token: "foreign-namespaced-refresh",
		});
		writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
		writeFileSync(
			ledgerPath,
			`${JSON.stringify({
				schemaVersion: "clawdi.oauthCredentialOwnership.v2",
				runtime: "hermes",
				providerId: "openai-codex",
				nativeProfileId,
				credentialRevision: "hermes-revision-2",
				state: "adopted",
			})}\n`,
		);
		convergeRuntimeManifest(removedLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.credential_pool["openai-codex"]).toEqual([
			expect.objectContaining({
				id: nativeProfileId,
				access_token: "foreign-namespaced-access",
				refresh_token: "foreign-namespaced-refresh",
			}),
			expect.objectContaining({ id: "user-independent" }),
		]);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("retired");

		const readdedLoad: RuntimeManifestLoad = {
			...nativeReauthenticatedLoad,
			manifest: { ...nativeReauthenticatedLoad.manifest, generation: 4 },
		};
		convergeRuntimeManifest(readdedLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.credential_pool["openai-codex"][0]).toMatchObject({
			id: nativeProfileId,
			access_token: "foreign-namespaced-access",
			refresh_token: "foreign-namespaced-refresh",
		});
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("adopted");
	});

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

		const removedLoad: RuntimeManifestLoad = {
			...nativeReauthenticatedLoad,
			secretValues: {},
			manifest: {
				...nativeReauthenticatedLoad.manifest,
				generation: 3,
				runtimes: {},
				projection: {
					...nativeReauthenticatedLoad.manifest.projection,
					providers: {},
				},
			},
		};
		writeFileSync(
			ledgerPath,
			`${JSON.stringify({
				schemaVersion: "clawdi.runtimeOAuthCredential.v1",
				runtime: "openclaw",
				providerId: "openai-codex",
				nativeProfileId,
				credentialRevision: "openclaw-revision-2",
				state: "seeded",
			})}\n`,
		);
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
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
			schemaVersion: "clawdi.oauthCredentialOwnership.v2",
			state: "retired",
		});

		store.profiles[nativeProfileId] = {
			type: "oauth",
			provider: "openai",
			access: "foreign-namespaced-access",
			refresh: "foreign-namespaced-refresh",
		};
		store.order.openai = [nativeProfileId, "openai:default"];
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		writeFileSync(
			ledgerPath,
			`${JSON.stringify({
				schemaVersion: "clawdi.oauthCredentialOwnership.v2",
				runtime: "openclaw",
				providerId: "openai-codex",
				nativeProfileId,
				credentialRevision: "openclaw-revision-2",
				state: "adopted",
			})}\n`,
		);
		convergeRuntimeManifest(removedLoad, paths);
		store = JSON.parse(readFileSync(storePath, "utf8"));
		expect(store.profiles[nativeProfileId]).toMatchObject({
			access: "foreign-namespaced-access",
			refresh: "foreign-namespaced-refresh",
		});
		expect(store.profiles["openai:default"]).toMatchObject({
			access: "native-reauth-access",
			refresh: "native-reauth-refresh",
		});
		expect(store.order.openai).toEqual([nativeProfileId, "openai:default"]);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("retired");

		const readdedLoad: RuntimeManifestLoad = {
			...nativeReauthenticatedLoad,
			manifest: { ...nativeReauthenticatedLoad.manifest, generation: 4 },
		};
		convergeRuntimeManifest(readdedLoad, paths);
		store = JSON.parse(readFileSync(storePath, "utf8"));
		expect(store.profiles[nativeProfileId]).toMatchObject({
			access: "foreign-namespaced-access",
			refresh: "foreign-namespaced-refresh",
		});
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("adopted");
		const calls = readFileSync(sdkCalls, "utf8");
		expect(calls).toContain("ensure ");
		expect(calls).toContain("update ");
	});

	it("repairs an installed OpenClaw missing provider-auth capability before OAuth apply", () => {
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

		expect(result.installErrors).toEqual([]);
		expect(readFileSync(installerLog, "utf8").trim()).toBe("--json --no-onboard");
		expect(readFileSync(installerLog, "utf8")).not.toContain("--version");
		const profileId = nativeOAuthProfileId("openclaw", "openai-codex");
		const storePath = join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
		expect(JSON.parse(readFileSync(storePath, "utf8")).profiles[profileId]).toMatchObject({
			access: "repair-access",
			refresh: "repair-refresh",
		});
	});

	it("fails closed before config or credential mutation when OpenClaw capability repair fails", () => {
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

		expect(result.installErrors.join("\n")).toContain(
			"OpenClaw provider-auth capability repair failed",
		);
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
		const firstRevision = systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"));

		convergeRuntimeManifest(loaded, paths);

		expect(readFileSync(join(home, ".hermes", "config.yaml"), "utf-8")).toBe(firstConfig);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"))).toBe(firstRevision);
	});

	it("rejects multiple Hermes hosted providers at manifest admission", () => {
		const home = join(root, "home", "clawdi");
		const loaded = hostedHermesProviderLoad(home);
		loaded.manifest.runtimes.hermes = {
			...loaded.manifest.runtimes.hermes,
			provider_ids: ["hermes", "moonshot"],
		};

		expect(manifestSchema.safeParse(loaded.manifest).success).toBe(false);
	});

	it("removes the stale Hermes plugin and native provider when projection disappears", () => {
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
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
					system: { home },
				},
			},
		};
		const paths = getRuntimePaths();

		const first = convergeRuntimeManifest(withProvider, paths);
		writeTestRuntimeAppliedState(paths, withProvider, first);
		const firstRevision = systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"));
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);
		expect(
			expectRecord(readHermesConfigYaml(home).providers, "Hermes providers").hermes,
		).toBeDefined();

		convergeRuntimeManifest(withoutProvider, paths);

		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);
		expect(
			expectRecord(readHermesConfigYaml(home).providers, "Hermes providers").hermes,
		).toBeUndefined();
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"))).not.toBe(firstRevision);
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

	it.each([
		"openclaw",
		"hermes",
	] as const)("replaces the managed %s model catalog without restarting its active runtime", (runtimeName) => {
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
			environmentRoot: join(run, "systemd", "env"),
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
		const initialRevision = systemdEnvRevision(readSystemdEnvFile(paths, runtimeUnit));
		const transaction = new SystemdRuntimeTransaction();
		writeFileSync(systemctlLog, "");

		const second = convergeRuntimeManifest(next, paths);
		expect(second.installErrors).toEqual([]);
		const activation = applySystemdRuntimeUpdate(paths, before, readSystemdUnitSnapshot(paths), {
			transaction,
			stage: "final-activation",
		});

		expect(activation).toEqual({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: [],
		});
		expect(systemdEnvRevision(readSystemdEnvFile(paths, runtimeUnit))).toBe(initialRevision);
		const systemctlCalls = readFileSync(systemctlLog, "utf-8");
		expect(systemctlCalls).toContain(`--user show ${runtimeUnit}.service`);
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
			{ transaction, stage: "final-activation" },
		);
		expect(baseUrlActivation.userUnitsChanged).toEqual([`${runtimeUnit}.service`]);
		expect(readFileSync(systemctlLog, "utf-8")).toContain(`--user restart ${runtimeUnit}.service`);
	});

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

		const yamlRevision = systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"));
		const initialConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(initialConfig).toContain("provider: custom:hermes");
		expect(initialConfig).toMatch(/api: "?https:\/\/hermes-provider\.example\.test\/v1"?/);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);

		writeHermesVersionBinary(home, "0.18.0");
		convergeRuntimeManifest(loaded, paths);

		const currentRevision = systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"));
		const currentConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(currentConfig).toBe(initialConfig);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);
		expect(currentRevision).toBe(yamlRevision);
	});

	it("projects runtime-scoped Codex OAuth providers as native agent profiles", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-codex-oauth-patch.json");
		mkdirSync(dirname(openclawBin), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
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

		const loaded: RuntimeManifestLoad = {
			source: "remote-datasource",
			sourcePath: "https://runtime-source.test/desired-state",
			offline: false,
			secretValues: {},
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_runtime_codex_oauth",
				environmentId: "env_runtime_codex_oauth",
				instanceId: "iid_runtime_codex_oauth",
				generation: 1,
				issuedAt: "2026-06-22T00:00:00Z",
				workspaceRoot: join(home, "clawdi"),
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: {
						enabled: true,
						provider_ids: ["openclaw"],
						primary_model: { provider_id: "openclaw", model: "gpt-5.5" },
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
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
					system: { home },
					providers: {
						openclaw: {
							kind: "openai-compatible",
							type: "openai",
							baseUrl: "https://api.openai.com/v1",
							model: "gpt-5.5",
							apiMode: "openai_responses",
							auth: {
								type: "agent_profile",
								tool: "codex",
								profile: "default",
							},
						},
					},
				},
				egressProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const patch = JSON.parse(readFileSync(openclawPatch, "utf-8"));
		expect(patch.plugins.entries.codex.enabled).toBe(true);
		expect(patch.agents.defaults.model.primary).toBe("openai/gpt-5.5");
		expect(patch.models).toBeUndefined();
		const openclawRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		expect(openclawRunConfig.secretEnv).toEqual({});
		expect(JSON.stringify(openclawRunConfig)).not.toContain("apiKeySecretRef");
	});

	it("does not fall back to a different runtime-scoped hosted provider", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const hermesBin = join(home, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesBin), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(hermesBin, "#!/bin/sh\nexit 0\n");
		chmodSync(hermesBin, 0o700);

		const loaded: RuntimeManifestLoad = {
			source: "remote-datasource",
			sourcePath: "https://runtime-source.test/desired-state",
			offline: false,
			secretValues: {
				"secret://provider.openclaw.apiKey": "sk-openclaw-provider",
			},
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_runtime_provider_missing",
				environmentId: "env_runtime_provider_missing",
				instanceId: "iid_runtime_provider_missing",
				generation: 1,
				issuedAt: "2026-06-22T00:00:00Z",
				workspaceRoot: join(home, "clawdi"),
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					hermes: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://hermes-agent.nousresearch.com/install.sh",
							home,
							args: ["--skip-setup", "--skip-browser", "--non-interactive"],
						},
					},
				},
				projection: {
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
					system: { home },
					providers: {
						openclaw: {
							kind: "openai-compatible",
							baseUrl: "https://openclaw-provider.example.test/v1",
							model: "gpt-5.5",
							apiMode: "openai_responses",
							runtimeEnvName: "OPENCLAW_PROVIDER_API_KEY",
							apiKeySecretRef: "secret://provider.openclaw.apiKey",
						},
					},
				},
				egressProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const hermesRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "hermes.json"), "utf-8"),
		);
		expect(hermesRunConfig.secretEnv).toEqual({});
		expect(existsSync(join(home, ".hermes", "config.yaml"))).toBe(false);
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
			const openclawPatch = join(caseRoot, "openclaw-provider-patch.json");
			mkdirSync(dirname(openclawBin), { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
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

			const loaded: RuntimeManifestLoad = {
				source: "remote-datasource",
				sourcePath: "https://runtime-source.test/desired-state",
				offline: false,
				secretValues: {
					"secret://provider.openclaw.apiKey": `sk-${providerCase.id}`,
				},
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: `dep_${providerCase.id}_provider`,
					environmentId: `env_${providerCase.id}_provider`,
					instanceId: `iid_${providerCase.id}_provider`,
					generation: 1,
					issuedAt: "2026-06-22T00:00:00Z",
					workspaceRoot: join(home, "clawdi"),
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: {
							enabled: true,
							provider_ids: ["openclaw"],
							primary_model: {
								provider_id: "openclaw",
								model: providerCase.model,
							},
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
						sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
						system: { home },
						providers: {
							openclaw: {
								kind: "openai-compatible",
								type: providerCase.type,
								baseUrl: providerCase.baseUrl,
								model: providerCase.model,
								apiMode: providerCase.apiMode,
								runtimeEnvName: `${providerCase.id.toUpperCase()}_API_KEY`,
								apiKeySecretRef: "secret://provider.openclaw.apiKey",
							},
						},
					},
					egressProfiles: { profiles: [] },
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
			};

			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			expect(convergence.installErrors).toEqual([]);
			const patch = JSON.parse(readFileSync(openclawPatch, "utf-8"));
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
		const openclawBin = join(home, ".local", "bin", "openclaw");
		mkdirSync(home, { recursive: true });
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(openclawBin, "#!/bin/sh\nexit 0\n");
		chmodSync(openclawBin, 0o700);
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
						packageSpec: "clawdi@1.2.3-test",
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
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
printf 'provider projection should not run for unhealthy provider\\n' >&2
exit 64
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const convergence = convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_key_required_missing_ref",
					environmentId: "env_key_required_missing_ref",
					instanceId: "iid_key_required_missing_ref",
					generation: 1,
					issuedAt: "2026-06-26T00:00:00Z",
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: {
							enabled: true,
							run: {
								command: openclawBin,
								args: ["gateway", "run"],
								env: {},
								prependPath: [],
							},
						},
					},
					projection: {
						providers: {
							openclaw: {
								kind: "openai-compatible",
								type: "anthropic",
								baseUrl: "https://api.anthropic.com",
								model: "claude-opus-4-6",
								apiMode: "anthropic_messages",
								apiKeyRequired: true,
								status: "error",
								error: { code: "provider_secret_unavailable" },
							},
						},
					},
					recovery: {},
				},
				source: "remote-datasource",
				sourcePath: "test://key-required-missing-ref",
				offline: false,
				secretValues: {},
			},
			getRuntimePaths(),
		);

		expect(convergence.installErrors).toEqual([]);
		const providerHealth = JSON.parse(
			readFileSync(getRuntimePaths().providerHealthStatus, "utf-8"),
		);
		expect(providerHealth.providers.openclaw.status).toBe("error");
		expect(providerHealth.providers.openclaw.reasons).toContain("provider_error");
		expect(providerHealth.providers.openclaw.reasons).toContain("provider_secret_unavailable");
		expect(providerHealth.providers.openclaw.reasons).toContain("api_key_secret_ref_missing");
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
						packageSpec: "clawdi@1.2.3-test",
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
						packageSpec: "clawdi@1.2.3-test",
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
						hermes: {
							enabled: false,
							install: { source: "official" },
							providerMode: "configured",
							provider_ids: ["default"],
							primary_model: { provider_id: "default", model: "gpt-test" },
						},
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
								packageSpec: "clawdi@1.2.3-test",
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
					packageSpec: "clawdi@1.2.3-test",
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
						quiesce: () => {},
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
						rollback: () => {
							throw new Error("successful MCP auth apply must not roll back");
						},
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
							daemonAuthTokenRevision: authority.daemonAuthTokenRevision,
							daemonProgramRevision: authority.daemonProgramRevision,
							egressSidecarSecretRevision: authority.egressSidecarSecretRevision,
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
			expectExistingFileNotToContain(paths.providerHealthStatus, runtimeAuthToken);
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
							id: "direct-provider-passthrough-openclaw",
							enabled: true,
							kind: "passthrough",
							match: {
								scheme: "https",
								host: "openclaw-provider.example.test",
								pathPrefix: "/v1/",
								headers: {},
								query: {},
							},
							logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
							priority: 240,
							owner: "provider-projection",
						},
						{
							id: "direct-provider-passthrough-hermes",
							enabled: true,
							kind: "passthrough",
							match: {
								scheme: "https",
								host: "hermes-provider.example.test",
								pathPrefix: "/v1/",
								headers: {},
								query: {},
							},
							logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
							priority: 240,
							owner: "provider-projection",
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
			environmentRoot: join(run, "systemd", "env"),
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
			expect(systemctlCalls).toContain("--user reset-failed openclaw-gateway.service");
			expect(systemctlCalls.some((call) => call.includes("enable --now"))).toBe(false);
			expect(systemctlCalls).toContain("start clawdi-runtime-sidecar.service");
			expect(systemctlCalls).toContain("restart clawdi-daemon.service");
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

	it("restores rendered state without systemd mutation when process revision preflight races PID exit", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl-preflight-race.log");
		const systemctlStateRoot = join(root, "systemctl-preflight-race-state");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			environmentRoot: join(run, "systemd", "env"),
			sidecarReadyPath: join(run, "egress", "systemd", "ca.pem"),
		});
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
		const baselineUnits = readSystemdUnitSnapshot(paths);
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, baselineUnits);
		for (const unit of baselineUnits.user.keys()) {
			writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
		}
		console.log = (value?: unknown) => logs.push(String(value));
		process.exitCode = undefined;
		setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
		const warmupFetch = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, 2), {
						etag: testBundleEtag("manifest-preflight-race-2"),
					}),
			},
		]);
		try {
			await runtimeWatch({ once: true, json: true });
		} finally {
			warmupFetch.restore();
		}
		if (process.exitCode !== undefined && process.exitCode !== 0) {
			throw new Error(logs.join("\n"));
		}
		const activeUnits = readSystemdUnitSnapshot(paths);
		writeFileSync(
			fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-files.service", "active"),
			"\n",
		);
		const gatewayPidPath = fakeSystemdStatePath(
			systemctlStateRoot,
			"user",
			"openclaw-gateway.service",
			"pid",
		);
		const gatewayPid = Number(readFileSync(gatewayPidPath, "utf8").trim());
		process.kill(gatewayPid, "SIGTERM");
		writeFileSync(gatewayPidPath, "2147483647\n");

		const transaction = new SystemdRuntimeTransaction();
		expect(() =>
			applySystemdRuntimeUpdate(paths, activeUnits, activeUnits, {
				transaction,
				stage: "final-activation",
			}),
		).toThrow(
			"could not prove active runtime revision for managed systemd unit openclaw-gateway.service",
		);
		expect(transaction.journal).toEqual([]);

		const gatewayEnvPath = join(paths.systemdEnvRoot, "openclaw-gateway.service.env");
		const gatewayDropInPath = join(
			paths.systemdUserRoot,
			"openclaw-gateway.service.d",
			"10-clawdi-hosted.conf",
		);
		const preImage = {
			managedConfig: readFileSync(paths.managedConfig, "utf8"),
			gatewayEnv: readFileSync(gatewayEnvPath, "utf8"),
			gatewayDropIn: readFileSync(gatewayDropInPath, "utf8"),
			appliedState: readFileSync(paths.appliedState, "utf8"),
			managerState: Object.fromEntries(
				readdirSync(systemctlStateRoot)
					.sort()
					.map((entry) => [entry, readFileSync(join(systemctlStateRoot, entry), "utf8")]),
			),
		};
		writeFileSync(systemctlLog, "");
		logs.length = 0;
		process.exitCode = undefined;
		setRuntimeApplyGeneration(3, CANONICAL_TEST_CONTEXT);
		const fetchMock = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, 3, "en"), {
						etag: testBundleEtag("manifest-preflight-race-3"),
					}),
			},
		]);
		try {
			await runtimeWatch({ once: true, json: true });
		} finally {
			fetchMock.restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}

		const event = JSON.parse(logs.at(-1) ?? "{}");
		expect(event.status).toBe("error");
		expect(event.error).toContain(
			"could not prove active runtime revision for managed systemd unit openclaw-gateway.service",
		);
		expect(readFileSync(paths.managedConfig, "utf8")).toBe(preImage.managedConfig);
		expect(readFileSync(gatewayEnvPath, "utf8")).toBe(preImage.gatewayEnv);
		expect(readFileSync(gatewayDropInPath, "utf8")).toBe(preImage.gatewayDropIn);
		expect(readFileSync(paths.appliedState, "utf8")).toBe(preImage.appliedState);
		expect(systemdEnvRevision(readFileSync(gatewayEnvPath, "utf8"))).toBe(
			systemdEnvRevision(preImage.gatewayEnv),
		);
		expect(
			Object.fromEntries(
				readdirSync(systemctlStateRoot)
					.sort()
					.map((entry) => [entry, readFileSync(join(systemctlStateRoot, entry), "utf8")]),
			),
		).toEqual(preImage.managerState);
		const mutationCalls = readFileSync(systemctlLog, "utf8")
			.trim()
			.split("\n")
			.filter((call) =>
				/^(?:--user )?(?:daemon-reload|disable|enable|reset-failed|restart|start|stop)(?: |$)/.test(
					call,
				),
			);
		expect(mutationCalls).toEqual([]);
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

	it.each([
		"authentication failure",
		"task completion",
	])("runtime watch re-subscribes after SSE %s with unchanged connection identity", async (completionMode) => {
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
					return hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, 2), {
						etag: testBundleEtag("manifest-locale-2"),
					});
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
	});

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
			environmentRoot: join(run, "systemd", "env"),
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
		seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
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
									packageSpec: "clawdi@1.2.3-test",
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
			expect(existsSync(getRuntimePaths().channelsEtag)).toBe(false);
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
				systemUnitsChanged: [
					"clawdi-daemon.service",
					"clawdi-runtime-sidecar.service",
					"clawdi-runtime-watch.service",
				],
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
			environmentRoot: join(run, "systemd", "env"),
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
		seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
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
			const initialDaemonAuthTokenRevision = initialAppliedState?.daemonAuthTokenRevision;
			expect(initialDaemonAuthTokenRevision).toMatch(/^[a-f0-9]{64}$/);
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
			expect(rotatedAppliedState?.daemonAuthTokenRevision).toMatch(/^[a-f0-9]{64}$/);
			expect(rotatedAppliedState?.daemonAuthTokenRevision).not.toBe(initialDaemonAuthTokenRevision);
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
			expect(readSystemdEnvFile(paths, "clawdi-daemon")).toBe(initialDaemonEnv);
			expect(initialDaemonUnit).not.toContain(
				rotatedAppliedState?.daemonAuthTokenRevision ?? "missing-daemon-token-revision",
			);
			expect(initialDaemonEnv).not.toContain(
				rotatedAppliedState?.daemonAuthTokenRevision ?? "missing-daemon-token-revision",
			);

			// Simulate a crash after the desired token file/unit were written but before
			// the private applied authority advanced. The unchanged public unit cannot
			// prove activation, so the next pass must retry the daemon restart.
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
			expect(readRuntimeAppliedState(paths)?.daemonAuthTokenRevision).toBe(
				rotatedAppliedState?.daemonAuthTokenRevision,
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

	it("runtime watch restores managed state when systemd apply fails", async () => {
		setRuntimeApplyGeneration(13, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const failNextSidecarActivation = join(root, "fail-next-sidecar-activation");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
		writeFileSync(failNextSidecarActivation, "fail\n");
		writeFileSync(
			join(bin, "systemctl"),
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--user" ]; then shift; fi
if [ "\${1:-}" = "show" ]; then
  printf 'LoadState=loaded\\nActiveState=active\\nNeedDaemonReload=no\\n'
elif [ "\${1:-}" = "is-enabled" ]; then
  printf 'enabled\\n'
elif { [ "\${1:-}" = "start" ] || [ "\${1:-}" = "restart" ]; } && [[ " $* " = *" clawdi-runtime-sidecar.service "* ]] && [ -f '${failNextSidecarActivation}' ]; then
  rm -f '${failNextSidecarActivation}'
  printf 'injected sidecar activation failure\\n' >&2
  exit 42
fi
`,
		);
		chmodSync(join(bin, "systemctl"), 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
		mkdirSync(dirname(paths.managedConfig), { recursive: true });
		mkdirSync(paths.runConfigRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		const targetConfig = join(home, ".openclaw", "openclaw.json");
		const forwardRunConfig = join(paths.runConfigRoot, "openclaw.json");
		const rollbackFixtures = [paths.managedConfig];
		const previousUserUnit = join(paths.systemdUserRoot, "clawdi-previous.service");
		const forwardOnlyFixtures = [previousUserUnit, targetConfig, forwardRunConfig];
		const seededFixtures = [...rollbackFixtures, ...forwardOnlyFixtures];
		for (const [index, path] of seededFixtures.entries()) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				path === targetConfig ? '{"mcp":{"servers":{}}}\n' : `previous-${index}\n`,
			);
		}
		const rollbackContents = new Map(rollbackFixtures.map((path) => [path, readFileSync(path)]));
		writeFileSync(paths.manifestLastGood, '{"generation":12}\n');
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: "iid_watch_systemd_failure",
				etag: testBundleEtag("etag-watch-previous"),
				sourceRevision: "a".repeat(64),
				generation: 12,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				providerIds: ["previous"],
				projectedProviderIds: { openclaw: ["previous"] },
			},
			paths,
		);
		const previousAppliedState = readFileSync(paths.appliedState, "utf-8");
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
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
								deploymentId: "dep_watch_systemd_failure",
								environmentId: "env_watch_systemd_failure",
								...hostedRequiredState(),
								instanceId: "iid_watch_systemd_failure",
								generation: 13,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: "clawdi@1.2.3-test",
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						},
						{ etag: testBundleEtag("etag-watch-systemd-failure") },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.error).toContain("transparent-egress prerequisite activation failed");
			expect(event.activeGeneration).toBe(12);
			expect(event.rejectedGeneration).toBe(13);
			expect(event.instanceId).toBe("iid_watch_systemd_failure");
			expect(JSON.parse(readFileSync(paths.manifestLastGood, "utf-8"))).toEqual({
				generation: 12,
			});
			expect(readFileSync(paths.appliedState, "utf-8")).toBe(previousAppliedState);
			for (const path of rollbackFixtures) {
				const expected = rollbackContents.get(path);
				if (!expected) throw new Error(`missing rollback fixture for ${path}`);
				expect(readFileSync(path)).toEqual(expected);
			}
			expect(readFileSync(forwardRunConfig, "utf-8")).toContain("previous-");
			expect(existsSync(previousUserUnit)).toBe(true);
		} finally {
			restore();
			console.log = previousLog;
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
					packageSpec: "clawdi@1.2.3-test",
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
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
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
		seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
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
					providerIds: ["clawdi-managed-v2"],
					projectedProviderIds: { openclaw: ["clawdi-managed-v2"] },
				}),
			);
		} finally {
			initial.restore();
		}
		const baselineRevision = systemdEnvRevision(readSystemdEnvFile(paths, "openclaw-gateway"));
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
			expect(systemdEnvRevision(readSystemdEnvFile(paths, "openclaw-gateway"))).toBe(
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
		seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
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
									packageSpec: "clawdi@1.2.3-test",
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
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep-provider-observed",
				environmentId: "env-provider-observed",
				instanceId: "iid-provider-observed",
				generation: 9,
				issuedAt: "2026-06-06T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: { openclaw: { enabled: true } },
				projection: {
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://sub2api.test/v1",
							model: "gpt-5.5",
							apiKeySecretRef: "secret://provider.default.apiKey",
						},
					},
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
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
				model: "gpt-5.5",
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
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep-provider-missing-secret",
				environmentId: "env-provider-missing-secret",
				instanceId: "iid-provider-missing-secret",
				generation: 10,
				issuedAt: "2026-06-06T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: { openclaw: { enabled: true } },
				projection: {
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://sub2api.test/v1",
							apiKeySecretRef: "secret://provider.default.apiKey",
						},
					},
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
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

	it("classifies a fresh CLI package checkpoint as CLI-only", () => {
		const home = join(root, "home", "clawdi");
		const previousManifest = {
			...runtimeWatchLocaleManifest(home, 13),
			applyGeneration: 13,
		};
		const nextManifest: RuntimeManifest = {
			...previousManifest,
			generation: 14,
			issuedAt: "2026-06-06T00:00:14Z",
			clawdiCli: {
				...previousManifest.clawdiCli,
				packageSpec: "clawdi@1.2.4-test",
			},
		};
		const previous = {
			manifest: previousManifest,
			secretValues: { "secret://runtime/openclaw/gateway-token": "gateway-token" },
		};
		const next = { manifest: nextManifest, secretValues: previous.secretValues };

		expect(runtimeOnlyChangesCliPackage(previous, next)).toBe(true);
		expect(
			runtimeOnlyChangesCliPackage(previous, {
				...next,
				manifest: {
					...nextManifest,
					controlPlane: { apiUrl: "https://other-cloud-api.test" },
				},
			}),
		).toBe(false);
		expect(
			runtimeOnlyChangesCliPackage(previous, {
				...next,
				secretValues: { "secret://runtime/openclaw/gateway-token": "rotated-token" },
			}),
		).toBe(false);
		expect(
			runtimeOnlyChangesCliPackage(previous, {
				...next,
				manifest: {
					...nextManifest,
					clawdiCli: { ...nextManifest.clawdiCli, source: "other-source" },
				},
			}),
		).toBe(false);
	});

	it("force-restarts only the daemon for a CLI-only checkpoint", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const systemctlPath = join(root, "bin", "systemctl");
		const systemctlLog = join(root, "systemctl.log");
		const systemctlStateRoot = join(root, "systemctl-cli-only-state");
		writeFakeSystemdManager({
			path: systemctlPath,
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			environmentRoot: join(run, "systemd", "env"),
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_AUTH_TOKEN = "runtime-auth-token";
		seedOpenClawBinary(home);
		const paths = getRuntimePaths();
		const current = runtimeWatchLocaleManifest(home, 10);
		const runtimeAuthSecret = {
			"secret://clawdi/auth-token":
				TEST_RUNTIME_SERVICE_SECRET_VALUES["secret://clawdi/auth-token"],
		};
		expect(
			convergeRuntimeManifest(
				{
					manifest: current,
					source: "remote-datasource",
					sourcePath: "test://cli-current",
					offline: false,
					secretValues: runtimeAuthSecret,
				},
				paths,
			).installErrors,
		).toEqual([]);
		const before = readSystemdUnitSnapshot(paths);
		before.user.set("hermes-gateway.service", "legacy");
		const unchangedUnitInodes = [
			join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
			join(paths.systemdUserRoot, "openclaw-gateway.service.d", "10-clawdi-hosted.conf"),
		].map((path) => statSync(path).ino);
		const next: RuntimeManifest = {
			...current,
			generation: 11,
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@1.2.4-test",
				registry: "https://registry.npmjs.org",
			},
		};
		expect(
			convergeRuntimeManifest(
				{
					manifest: next,
					source: "remote-datasource",
					sourcePath: "test://cli-next",
					offline: false,
					secretValues: runtimeAuthSecret,
				},
				paths,
			).installErrors,
		).toEqual([]);
		expect(
			[
				join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
				join(paths.systemdUserRoot, "openclaw-gateway.service.d", "10-clawdi-hosted.conf"),
			].map((path) => statSync(path).ino),
		).toEqual(unchangedUnitInodes);
		const after = readSystemdUnitSnapshot(paths);
		after.user.set("hermes-gateway.service", "current");
		const currentRevision = "a".repeat(32);
		writeFileSync(
			join(paths.systemdEnvRoot, "hermes-gateway.service.env"),
			`CLAWDI_RUNTIME_REV="${currentRevision}"\n`,
		);
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, before);
		for (const unit of before.user.keys()) {
			writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
		}
		writeFileSync(systemctlLog, "");

		const applied = applySystemdRuntimeUpdate(paths, before, after, {
			transaction: new SystemdRuntimeTransaction(),
			stage: "final-activation",
			forceRestartSystemUnits: ["clawdi-daemon.service"],
			preserveActiveUnits: true,
		});

		expect(applied).toEqual({
			applied: true,
			systemUnitsChanged: ["clawdi-daemon.service"],
			userUnitsChanged: [],
		});
		const calls = readFileSync(systemctlLog, "utf-8");
		expect(calls).toContain("daemon-reload");
		expect(calls).toContain("restart clawdi-daemon.service");
		expect(calls).not.toContain("restart clawdi-runtime-watch.service");
		expect(calls).not.toContain("restart hermes-gateway.service");
		expect(calls).not.toContain("restart openclaw-gateway.service");
		expect(calls).not.toContain("restart clawdi-runtime-sidecar.service");

		const driftedUnits = {
			system: new Map([["clawdi-runtime-watch.service", "watch"]]),
			user: new Map([["hermes-gateway.service", "hermes"]]),
		};
		writeFileSync(
			fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-runtime-watch.service", "active"),
			"\n",
		);
		seedFakeSystemdProcess(systemctlStateRoot, "user", "hermes-gateway.service", "b".repeat(32));
		writeFileSync(
			fakeSystemdStatePath(systemctlStateRoot, "user", "hermes-gateway.service", "enabled"),
			"\n",
		);
		writeFileSync(systemctlLog, "");

		expect(
			applySystemdRuntimeUpdate(paths, driftedUnits, driftedUnits, {
				transaction: new SystemdRuntimeTransaction(),
				stage: "final-activation",
				preserveActiveUnits: true,
			}),
		).toEqual({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: ["hermes-gateway.service"],
		});
		const driftRepairCalls = readFileSync(systemctlLog, "utf-8");
		expect(driftRepairCalls).not.toContain("daemon-reload");
		expect(driftRepairCalls).toContain("--user restart hermes-gateway.service");
		expect(driftRepairCalls).not.toContain("restart clawdi-runtime-watch.service");
	});

	it("adopts a cross-version user revision only until its desired program changes", () => {
		const home = join(root, "revision-alias", "home", "clawdi");
		const state = join(root, "revision-alias", "var", "lib", "clawdi");
		const run = join(root, "revision-alias", "run", "clawdi");
		const systemctlPath = join(root, "revision-alias", "bin", "systemctl");
		const systemctlLog = join(root, "revision-alias", "systemctl.log");
		const systemctlStateRoot = join(root, "revision-alias", "systemctl-state");
		writeFakeSystemdManager({
			path: systemctlPath,
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			environmentRoot: join(run, "systemd", "env"),
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		const paths = getRuntimePaths();
		const unit = "hermes-gateway.service";
		const oldRevision = "a".repeat(32);
		const migratedRevision = "b".repeat(32);
		const changedRevision = "c".repeat(32);
		const before = { system: new Map<string, string>(), user: new Map([[unit, "old"]]) };
		const migrated = {
			system: new Map<string, string>(),
			user: new Map([[unit, "migrated"]]),
		};
		mkdirSync(paths.systemdEnvRoot, { recursive: true });
		writeFileSync(
			join(paths.systemdEnvRoot, `${unit}.env`),
			`CLAWDI_RUNTIME_REV="${migratedRevision}"\n`,
		);
		seedFakeSystemdProcess(systemctlStateRoot, "user", unit, oldRevision);
		writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
		let aliases: RuntimeUserProcessRevisionAliases = {};

		const adopted = applySystemdRuntimeUpdate(paths, before, migrated, {
			transaction: new SystemdRuntimeTransaction(),
			stage: "final-activation",
			preserveActiveUnits: true,
			previousUserDesiredRevisions: new Map([[unit, oldRevision]]),
			onUserProcessRevisionAliases: (value) => {
				aliases = value;
			},
		});

		expect(adopted).toEqual({ applied: true, systemUnitsChanged: [], userUnitsChanged: [] });
		expect(aliases).toEqual({
			[unit]: { desiredRevision: migratedRevision, processRevision: oldRevision },
		});
		expect(readFileSync(systemctlLog, "utf-8")).not.toContain(`--user restart ${unit}`);
		mkdirSync(dirname(paths.appliedState), { recursive: true });
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-08-14T04:02:30.000Z",
				instanceId: "iid_revision_alias",
				etag: `"sha256:${"d".repeat(64)}"`,
				sourceRevision: "d".repeat(64),
				generation: 1,
				contentIdentity: { sourcePath: "test://revision-alias", sha256: "e".repeat(64) },
				userProcessRevisionAliases: aliases,
				providerIds: [],
				projectedProviderIds: {},
			},
			paths,
		);

		aliases = {};
		writeFileSync(systemctlLog, "");
		expect(
			applySystemdRuntimeUpdate(paths, migrated, migrated, {
				transaction: new SystemdRuntimeTransaction(),
				stage: "final-activation",
				onUserProcessRevisionAliases: (value) => {
					aliases = value;
				},
			}),
		).toEqual({ applied: true, systemUnitsChanged: [], userUnitsChanged: [] });
		expect(aliases[unit]).toEqual({
			desiredRevision: migratedRevision,
			processRevision: oldRevision,
		});
		expect(readFileSync(systemctlLog, "utf-8")).not.toMatch(
			/(?:^|\s)(?:daemon-reload|start|restart|stop|enable|disable|reset-failed)(?:\s|$)/m,
		);

		const changed = {
			system: new Map<string, string>(),
			user: new Map([[unit, "changed"]]),
		};
		writeFileSync(
			join(paths.systemdEnvRoot, `${unit}.env`),
			`CLAWDI_RUNTIME_REV="${changedRevision}"\n`,
		);
		aliases = {};
		writeFileSync(systemctlLog, "");
		expect(
			applySystemdRuntimeUpdate(paths, migrated, changed, {
				transaction: new SystemdRuntimeTransaction(),
				stage: "final-activation",
				onUserProcessRevisionAliases: (value) => {
					aliases = value;
				},
			}),
		).toEqual({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: [unit],
		});
		expect(aliases).toEqual({});
		expect(readFileSync(systemctlLog, "utf-8")).toContain(`--user restart ${unit}`);
	});

	it("scopes reload-only and explicit user-unit rollback without touching unrelated units", () => {
		const home = join(root, "home", "clawdi");
		const run = join(root, "run", "clawdi");
		const systemctlPath = join(root, "bin", "systemctl");
		const systemctlLog = join(root, "systemctl-reload-only.log");
		const systemctlStateRoot = join(root, "systemctl-reload-only-state");
		writeFakeSystemdManager({
			path: systemctlPath,
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			environmentRoot: join(run, "systemd", "env"),
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		const paths = getRuntimePaths();
		const units = {
			system: new Map<string, string>(),
			user: new Map([["openclaw-gateway.service", "gateway"]]),
		};
		mkdirSync(paths.systemdEnvRoot, { recursive: true });
		writeFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			`CLAWDI_RUNTIME_REV="${"a".repeat(32)}"\n`,
		);
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, units);
		writeFileSync(
			fakeSystemdStatePath(systemctlStateRoot, "user", "openclaw-gateway.service", "enabled"),
			"\n",
		);
		writeFileSync(
			fakeSystemdStatePath(systemctlStateRoot, "user", "openclaw-gateway.service", "reload"),
			"\n",
		);
		writeFileSync(
			fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-files.service", "active"),
			"\n",
		);
		writeFileSync(systemctlLog, "");
		const transaction = new SystemdRuntimeTransaction();

		expect(
			applySystemdRuntimeUpdate(paths, units, units, {
				transaction,
				stage: "final-activation",
			}),
		).toEqual({ applied: true, systemUnitsChanged: [], userUnitsChanged: [] });
		transaction.quiesce(paths);
		transaction.rollback(paths);

		expect(transaction.journal).toEqual([
			{
				sequence: 1,
				stage: "final-activation",
				scope: "user",
				action: "daemon-reload",
				units: [],
				outcome: "succeeded",
			},
			{
				sequence: 2,
				stage: "rollback",
				scope: "user",
				action: "daemon-reload",
				units: [],
				outcome: "succeeded",
			},
		]);
		expect(readFileSync(systemctlLog, "utf8").trim().split("\n")).toEqual([
			"--user show openclaw-gateway.service --property=LoadState --property=ActiveState --property=MainPID --property=NeedDaemonReload",
			"--user is-enabled openclaw-gateway.service",
			"--user daemon-reload",
			"--user show openclaw-gateway.service --property=LoadState --property=ActiveState --property=MainPID --property=NeedDaemonReload",
			"--user is-enabled openclaw-gateway.service",
			"--user daemon-reload",
		]);
		expect(
			existsSync(
				fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-files.service", "active"),
			),
		).toBe(true);

		writeFileSync(systemctlLog, "");
		const agentPluginTransaction = new SystemdRuntimeTransaction();
		agentPluginTransaction.quiesce(paths, ["openclaw-gateway.service"]);
		agentPluginTransaction.rollback(paths);
		const pluginRollbackCalls = readFileSync(systemctlLog, "utf8").trim().split("\n");
		expect(pluginRollbackCalls).toContain("--user stop openclaw-gateway.service");
		expect(pluginRollbackCalls).toContain("--user start openclaw-gateway.service");
		expect(pluginRollbackCalls.some((call) => call.includes("clawdi-files.service"))).toBe(false);
		expect(
			existsSync(
				fakeSystemdStatePath(systemctlStateRoot, "user", "openclaw-gateway.service", "active"),
			),
		).toBe(true);
		expect(
			existsSync(
				fakeSystemdStatePath(systemctlStateRoot, "user", "openclaw-gateway.service", "enabled"),
			),
		).toBe(true);
	});

	it("stops the egress sidecar while proving independent system units ready", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const systemctlPath = join(root, "bin", "systemctl");
		const systemctlLog = join(root, "systemctl.log");
		const sidecarState = join(root, "sidecar.state");
		mkdirSync(dirname(systemctlPath), { recursive: true });
		writeFileSync(sidecarState, "active\n");
		writeFileSync(
			systemctlPath,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${systemctlLog}'
if [ "\${1:-}" = "show" ]; then
	  printf 'LoadState=loaded\\nMainPID=0\\nNeedDaemonReload=no\\n'
  if [ "\${2:-}" = "clawdi-runtime-sidecar.service" ]; then
    printf 'ActiveState=%s\\n' "$(tr -d '\\n' < '${sidecarState}')"
  else
    printf 'ActiveState=active\\n'
  fi
elif [ "\${1:-}" = "stop" ] && [ "\${2:-}" = "clawdi-runtime-sidecar.service" ]; then
  printf 'inactive\\n' > '${sidecarState}'
fi
`,
		);
		chmodSync(systemctlPath, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		const paths = getRuntimePaths();
		const units = {
			system: new Map([
				["clawdi-daemon.service", "daemon"],
				["clawdi-runtime-sidecar.service", "sidecar"],
			]),
			user: new Map<string, string>(),
		};

		const applied = applySystemdRuntimeUpdate(paths, units, units, {
			transaction: new SystemdRuntimeTransaction(),
			stage: "final-activation",
			forceRestartSystemUnits: ["clawdi-daemon.service"],
			forceStopSystemUnits: ["clawdi-runtime-sidecar.service"],
		});

		expect(applied).toEqual({
			applied: true,
			systemUnitsChanged: ["clawdi-daemon.service", "clawdi-runtime-sidecar.service"],
			userUnitsChanged: [],
		});
		const calls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
		expect(calls).toContain("stop clawdi-runtime-sidecar.service");
		expect(calls).toContain("restart clawdi-daemon.service");
		expect(calls).not.toContain("start clawdi-runtime-sidecar.service");
		expect(calls).not.toContain("restart clawdi-runtime-sidecar.service");
		expect(readFileSync(sidecarState, "utf-8")).toBe("inactive\n");
	});

	it("hands off a CLI-only checkpoint by restarting only the daemon once", async () => {
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
		seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
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
			expect(initialAppliedState?.daemonProgramRevision).toMatch(/^[a-f0-9]{32}$/);
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
			expect(JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"))).toMatchObject({
				transaction: { phase: "activated" },
				badVersions: [],
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
				userUnitsChanged: [],
			});
			const completedAppliedState = readRuntimeAppliedState(paths);
			expect(completedAppliedState).toMatchObject({
				generation: 14,
				applyGeneration: 13,
			});
			expect(completedAppliedState?.daemonProgramRevision).toMatch(/^[a-f0-9]{32}$/);
			expect(completedAppliedState?.daemonProgramRevision).not.toBe(
				initialAppliedState?.daemonProgramRevision,
			);
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
			]);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"restart clawdi-runtime-watch.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"restart clawdi-runtime-sidecar.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"--user restart openclaw-gateway.service",
			);
			expect(JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"))).toMatchObject({
				transaction: null,
				badVersions: [],
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
			expect(readRuntimeAppliedState(paths)?.daemonProgramRevision).toBe(
				completedAppliedState?.daemonProgramRevision,
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
	])("orders the cold $runtime installer after egress (publishCa=$publishCa)", async ({
		runtime,
		publishCa,
	}) => {
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
			runtime === "openclaw" ? "gateway install --force --json" : "gateway install --force";
		const previousLog = console.log;
		const previousUmask = process.umask(0o022);
		const previousExitCode = process.exitCode;
		const previousPath = process.env.PATH;
		let runtimeExitCode: number | undefined;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
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
			environmentRoot: paths.systemdEnvRoot,
			sidecarReadyPath: publishCa ? paths.egressSystemCaFile : undefined,
		});
		writeFileSync(
			runtimeBin,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> '${installerLog}'
if [ "$*" = "--version" ]; then
  printf '%s\n' '${runtime}-test-version'
elif [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"${join(home, ".openclaw", "workspace")}"}]\n'
elif [ "$*" = "${installArgs}" ]; then
  printf '%s\n' 'official ${runtime} installer' >> '${systemctlLog}'
  test -r '${paths.egressSystemCaFile}'
  test -s '${join(paths.systemdEnvRoot, `${serviceName}.service.env`)}'
  test -s '${join(paths.systemdUserRoot, `${serviceName}.service.d`, "10-clawdi-hosted.conf")}'
  mkdir -p '${dirname(runtimeUnit)}' '${systemctlStateRoot}'
  printf '[Service]\\nExecStart=${runtime} gateway run\\n' > '${runtimeUnit}'
	  systemctl --user enable --now '${serviceName}.service'
fi
exit 0
`,
		);
		chmodSync(runtimeBin, 0o700);
		if (runtime === "hermes") {
			const distIndex = join(
				home,
				".hermes",
				"hermes-agent",
				"hermes_cli",
				"web_dist",
				"index.html",
			);
			mkdirSync(join(home, ".hermes", "hermes-agent"), { recursive: true });
			writeFileSync(
				join(bin, "npm"),
				`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "npm $*" >> '${installerLog}'
if [ "$*" = "--version" ]; then
  printf '%s\n' '12.0.2'
elif [ "$*" = "run build -w web" ]; then
  mkdir -p '${dirname(distIndex)}'
  printf '%s\n' '<html>Hermes dashboard</html>' > '${distIndex}'
  printf '%s\n' 'official hermes dashboard artifact' >> '${systemctlLog}'
fi
`,
			);
			chmodSync(join(bin, "npm"), 0o700);
		}
		seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
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
		const dashboardArtifact = calls.indexOf("official hermes dashboard artifact");
		const finalSystemActivation = calls.findIndex(
			(call) => call.startsWith("start") && call.includes("clawdi-daemon.service"),
		);
		expect(sidecarActivation).toBeGreaterThanOrEqual(0);
		expect(officialInstaller).toBeGreaterThan(sidecarActivation);
		if (runtime === "hermes") expect(dashboardArtifact).toBeGreaterThan(officialInstaller);
		expect(finalSystemActivation).toBeGreaterThan(officialInstaller);
		if (runtime === "hermes") expect(finalSystemActivation).toBeGreaterThan(dashboardArtifact);
		expect(calls).not.toContain(`--user restart ${serviceName}.service`);
		const installerCalls = readFileSync(installerLog, "utf8").trim().split("\n");
		const installIndex = installerCalls.indexOf(installArgs);
		if (runtime === "openclaw") {
			expect(installIndex).toBeGreaterThan(0);
			expect(installerCalls.slice(installIndex + 1)).not.toContain("config patch --stdin");
		} else {
			expect(installIndex).toBeGreaterThanOrEqual(0);
			const postInstallCalls = installerCalls.slice(installIndex + 1);
			expect(postInstallCalls.filter((call) => call.startsWith("npm "))).toEqual([
				"npm --version",
				"npm install --workspace web",
				"npm run build -w web",
			]);
			expect(
				postInstallCalls
					.filter((call) => !call.startsWith("npm "))
					.every((call) => call === "--version"),
			).toBe(true);
			expect(existsSync(join(home, ".hermes", "config.yaml"))).toBe(true);
		}
		expect(readRuntimeAppliedState(paths)).toMatchObject({
			generation: 41,
			etag: testBundleEtag("cold-home-egress"),
		});
	});

	it("keeps public sidecar artifacts stable and rejects required engine degradation", async () => {
		setRuntimeApplyGeneration(41, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl-egress-rotation.log");
		const systemctlStateRoot = join(root, "systemctl-egress-state");
		const failNextGatewayRestart = join(root, "fail-next-gateway-restart");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			environmentRoot: join(run, "systemd", "env"),
			failNextGatewayRestart,
			sidecarReadyPath: join(run, "egress", "systemd", "ca.pem"),
		});
		writeFileSync(
			fakeSystemdStatePath(
				systemctlStateRoot,
				"system",
				"clawdi-runtime-sidecar.service",
				"active",
			),
			"orphan-active\n",
		);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		try {
			seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
			writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
			const paths = getRuntimePaths();
			const mitmproxy = seedMitmproxyCache(paths);
			const initialSecret = "000000";
			const rotatedSecret = "000001";
			const rejectedSecret = "000002";
			const invalidEngineSecret = "000003";
			const initialFetch = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () =>
						hostedRuntimeBundleResponse(
							hostedEgressSecretRotationPayload(home, mitmproxy, initialSecret),
							{ etag: testBundleEtag("egress-secret-revision-a") },
						),
				},
			]);
			try {
				await runtimeWatch({ once: true, json: true });
			} finally {
				initialFetch.restore();
			}
			expect(process.exitCode ?? 0).toBe(0);
			expect(JSON.parse(logs.at(-1) ?? "{}").status).toBe("applied");
			const initialSystemctlCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			expect(
				initialSystemctlCalls.filter(
					(call) => call === "start clawdi-daemon.service clawdi-runtime-watch.service",
				),
			).toHaveLength(1);
			expect(
				initialSystemctlCalls.filter(
					(call) => call === "--user enable --now openclaw-gateway.service",
				),
			).toHaveLength(1);
			expect(
				initialSystemctlCalls.filter((call) => call === "restart clawdi-runtime-sidecar.service"),
			).toHaveLength(1);

			const egressSecretFile = join(run, "secrets", "egress-secrets.json");
			const initialSidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
			const initialSidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
			const initialEnvironmentRevision = initialSidecarUnit.match(
				/^# ClawdiEnvironmentRevision=([^\n]+)$/m,
			)?.[1];
			expect(initialEnvironmentRevision).toBeTruthy();
			expect(statSync(egressSecretFile).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(egressSecretFile, "utf-8"))).toMatchObject({
				"secret://provider.default.apiKey": initialSecret,
			});
			const initialAppliedState = readRuntimeAppliedState(paths);
			const initialPrivateRevision = initialAppliedState?.egressSidecarSecretRevision;
			expect(initialPrivateRevision).toMatch(/^[a-f0-9]{64}$/);

			rmSync(
				fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-daemon.service", "active"),
				{ force: true },
			);
			writeFileSync(
				fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-daemon.service", "failed"),
				"failed\n",
			);
			for (const state of ["active", "enabled"] as const) {
				rmSync(
					fakeSystemdStatePath(systemctlStateRoot, "user", "openclaw-gateway.service", state),
					{ force: true },
				);
			}
			writeFileSync(systemctlLog, "");
			logs.length = 0;
			const managerRepairFetch = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () =>
						hostedRuntimeBundleResponse(
							hostedEgressSecretRotationPayload(home, mitmproxy, initialSecret),
							{ etag: testBundleEtag("egress-secret-revision-a-retry") },
						),
				},
			]);
			try {
				await runtimeWatch({ once: true, json: true });
			} finally {
				managerRepairFetch.restore();
			}
			expect(process.exitCode ?? 0).toBe(0);
			expect(JSON.parse(logs.at(-1) ?? "{}").status).toBe("applied");
			const managerRepairCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			for (const call of [
				"reset-failed clawdi-daemon.service",
				"start clawdi-daemon.service",
				"--user enable --now openclaw-gateway.service",
			]) {
				expect(managerRepairCalls.filter((candidate) => candidate === call)).toHaveLength(1);
			}
			expect(managerRepairCalls.some((call) => call.includes("restart"))).toBe(false);
			expect(readRuntimeAppliedState(paths)?.egressSidecarSecretRevision).toBe(
				initialPrivateRevision,
			);

			const crashWrittenSecrets = JSON.parse(readFileSync(egressSecretFile, "utf-8")) as Record<
				string,
				string
			>;
			writeFileSync(
				egressSecretFile,
				`${JSON.stringify(
					Object.fromEntries(Object.keys(crashWrittenSecrets).map((ref) => [ref, rotatedSecret])),
					null,
					2,
				)}\n`,
			);
			chmodSync(egressSecretFile, 0o600);
			writeFileSync(systemctlLog, "");

			const rotationFetch = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () =>
						hostedRuntimeBundleResponse(
							hostedEgressSecretRotationPayload(home, mitmproxy, rotatedSecret),
							{ etag: testBundleEtag("egress-secret-revision-b") },
						),
				},
			]);
			try {
				await runtimeWatch({ once: true, json: true });
			} finally {
				rotationFetch.restore();
			}
			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			const appliedEvent = JSON.parse(logs.at(-1) ?? "{}");
			const appliedEventText = JSON.stringify(appliedEvent);
			expect(appliedEvent.status).toBe("applied");
			expect(appliedEvent.systemdUnitsChanged).toBe(true);
			expect(appliedEvent.systemdApply).toEqual({
				applied: true,
				systemUnitsChanged: ["clawdi-runtime-sidecar.service"],
				userUnitsChanged: [],
			});
			expect(appliedEventText).not.toContain(initialSecret);
			expect(appliedEventText).not.toContain(rotatedSecret);
			expect(appliedEventText).not.toContain("egressSidecarSecretRevision");
			const rotatedSidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
			const rotatedSidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
			expect(rotatedSidecarUnit).toBe(initialSidecarUnit);
			expect(rotatedSidecarEnv).toBe(initialSidecarEnv);
			expect(rotatedSidecarUnit.match(/^# ClawdiEnvironmentRevision=([^\n]+)$/m)?.[1]).toBe(
				initialEnvironmentRevision,
			);
			expect(JSON.parse(readFileSync(egressSecretFile, "utf-8"))).toMatchObject({
				"secret://provider.default.apiKey": rotatedSecret,
			});
			expect(statSync(egressSecretFile).mode & 0o777).toBe(0o600);
			const rotatedAppliedState = readRuntimeAppliedState(paths);
			const rotatedPrivateRevision = rotatedAppliedState?.egressSidecarSecretRevision;
			expect(rotatedPrivateRevision).toMatch(/^[a-f0-9]{64}$/);
			expect(rotatedPrivateRevision).not.toBe(initialPrivateRevision);
			expect(appliedEventText).not.toContain(rotatedPrivateRevision ?? "missing-private-revision");
			expect(rotatedSidecarUnit).not.toContain(
				rotatedPrivateRevision ?? "missing-private-revision",
			);
			expect(rotatedSidecarEnv).not.toContain(rotatedPrivateRevision ?? "missing-private-revision");
			const observedText = JSON.stringify(readHostedRuntimeObserved(paths));
			expect(observedText).not.toContain("egressSidecarSecretRevision");
			expect(observedText).not.toContain(rotatedPrivateRevision ?? "missing-private-revision");
			expect(observedText).not.toContain(rotatedSecret);
			expect(statSync(paths.appliedState).mode & 0o777).toBe(0o600);
			const rotationSystemctlCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			expect(
				rotationSystemctlCalls.filter((call) => call === "restart clawdi-runtime-sidecar.service"),
			).toHaveLength(1);

			const committedAppliedState = readFileSync(paths.appliedState, "utf-8");
			const committedLastGood = readFileSync(paths.manifestLastGood, "utf-8");
			const committedSecretCache = readFileSync(paths.managedSecretCacheFile, "utf-8");
			const crashWrittenRejectedSecrets = JSON.parse(
				readFileSync(egressSecretFile, "utf-8"),
			) as Record<string, string>;
			writeFileSync(
				egressSecretFile,
				`${JSON.stringify(
					Object.fromEntries(
						Object.keys(crashWrittenRejectedSecrets).map((ref) => [ref, rejectedSecret]),
					),
					null,
					2,
				)}\n`,
			);
			chmodSync(egressSecretFile, 0o600);
			writeFileSync(systemctlLog, "");
			writeFileSync(failNextGatewayRestart, "fail\n");
			writeFileSync(
				fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-files.service", "active"),
				"active\n",
			);
			writeFileSync(
				fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-unrelated.service", "failed"),
				"failed\n",
			);
			rmSync(
				fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-daemon.service", "active"),
				{ force: true },
			);
			rmSync(
				fakeSystemdStatePath(systemctlStateRoot, "user", "openclaw-gateway.service", "enabled"),
				{ force: true },
			);
			seedFakeSystemdProcess(
				systemctlStateRoot,
				"user",
				"openclaw-gateway.service",
				"0".repeat(32),
			);
			logs.length = 0;
			process.exitCode = undefined;
			const rejectedFetch = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () =>
						hostedRuntimeBundleResponse(
							hostedEgressSecretRotationPayload(home, mitmproxy, rejectedSecret),
							{ etag: testBundleEtag("egress-secret-revision-c") },
						),
				},
			]);
			try {
				await runtimeWatch({ once: true, json: true });
			} finally {
				rejectedFetch.restore();
			}

			expect(process.exitCode).toBe(1);
			const rejectedEvent = JSON.parse(logs.at(-1) ?? "{}");
			const rejectedEventText = JSON.stringify(rejectedEvent);
			expect(rejectedEvent.status).toBe("error");
			// The verified OpenClaw service receipt keeps the official installer out
			// of this steady-state apply, so sidecar activation belongs to the final
			// systemd transaction instead of the installer prerequisite phase.
			expect(rejectedEvent.error).toContain("systemd apply failed");
			expect(rejectedEvent.systemdUnitsChanged).toBe(false);
			expect(rejectedEvent.systemdApply).toEqual({
				applied: false,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			});
			expect(rejectedEventText).not.toContain(rotatedSecret);
			expect(rejectedEventText).not.toContain(rejectedSecret);
			expect(rejectedEventText).not.toContain("egressSidecarSecretRevision");
			expect(readSystemdSystemUnit(paths, "clawdi-runtime-sidecar")).toBe(initialSidecarUnit);
			expect(readSystemdEnvFile(paths, "clawdi-runtime-sidecar")).toBe(initialSidecarEnv);
			expect(JSON.parse(readFileSync(egressSecretFile, "utf-8"))).toMatchObject({
				"secret://provider.default.apiKey": rotatedSecret,
			});
			expect(readFileSync(paths.appliedState, "utf-8")).toBe(committedAppliedState);
			expect(readFileSync(paths.manifestLastGood, "utf-8")).toBe(committedLastGood);
			expect(readFileSync(paths.managedSecretCacheFile, "utf-8")).toBe(committedSecretCache);
			const rollbackSystemctlCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			expect(rollbackSystemctlCalls).not.toContain("official openclaw installer");
			const rollbackMutations = rollbackSystemctlCalls.filter((call) =>
				/^(?:--user )?(?:daemon-reload|disable|enable|reset-failed|restart|start|stop)(?: |$)/.test(
					call,
				),
			);
			expect(rollbackMutations).toEqual([
				"start clawdi-daemon.service",
				"restart clawdi-runtime-sidecar.service",
				"--user enable openclaw-gateway.service",
				"--user restart openclaw-gateway.service",
				"--user stop openclaw-gateway.service",
				"stop clawdi-daemon.service",
				"stop clawdi-runtime-sidecar.service",
				"start clawdi-runtime-sidecar.service",
				"--user disable openclaw-gateway.service",
				"--user start openclaw-gateway.service",
			]);
			expect(
				existsSync(
					fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-daemon.service", "active"),
				),
			).toBe(false);
			expect(
				existsSync(
					fakeSystemdStatePath(systemctlStateRoot, "user", "openclaw-gateway.service", "active"),
				),
			).toBe(true);
			expect(
				existsSync(
					fakeSystemdStatePath(systemctlStateRoot, "user", "openclaw-gateway.service", "enabled"),
				),
			).toBe(false);
			expect(
				existsSync(
					fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-files.service", "active"),
				),
			).toBe(true);
			expect(
				existsSync(
					fakeSystemdStatePath(systemctlStateRoot, "system", "clawdi-unrelated.service", "failed"),
				),
			).toBe(true);

			writeFileSync(systemctlLog, "");
			logs.length = 0;
			process.exitCode = undefined;
			const invalidEngineFetch = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () =>
						hostedRuntimeBundleResponse(
							hostedEgressSecretRotationPayload(
								home,
								{
									...mitmproxy,
									url: "https://invalid.example.test/mitmproxy.tar.gz",
								},
								invalidEngineSecret,
							),
							{ etag: testBundleEtag("egress-secret-revision-d") },
						),
				},
			]);
			try {
				await runtimeWatch({ once: true, json: true });
			} finally {
				invalidEngineFetch.restore();
			}
			expect(process.exitCode).toBe(1);
			const invalidEngineEvent = JSON.parse(logs.at(-1) ?? "{}");
			expect(invalidEngineEvent.status).toBe("error");
			expect(invalidEngineEvent.error).toContain(
				"required egress engine is not ready: mitmproxy URL must use official mitmproxy downloads",
			);
			expect(JSON.stringify(invalidEngineEvent)).not.toContain(invalidEngineSecret);
			expect(existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"))).toBe(
				true,
			);
			expect(JSON.parse(readFileSync(egressSecretFile, "utf-8"))).toMatchObject({
				"secret://provider.default.apiKey": rotatedSecret,
			});
			expect(readFileSync(paths.appliedState, "utf-8")).toBe(committedAppliedState);
			expect(readFileSync(paths.manifestLastGood, "utf-8")).toBe(committedLastGood);
			expect(readFileSync(paths.managedSecretCacheFile, "utf-8")).toBe(committedSecretCache);
			const invalidEngineRollbackCalls = readFileSync(systemctlLog, "utf-8");
			expect(invalidEngineRollbackCalls).not.toContain("--user restart openclaw-gateway.service");
			expect(invalidEngineRollbackCalls).not.toContain("restart clawdi-daemon.service");
		} finally {
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

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
			environmentRoot: join(run, "systemd", "env"),
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
		seedCurrentCliInstall(state, "clawdi@1.2.1-test.1", "1.2.1-test.1");
		const mitmproxy = seedMitmproxyCache(paths);
		convergeRuntimeManifest(
			{
				source: "remote-datasource",
				sourcePath: "test://self-upgrade-egress-before",
				offline: false,
				secretValues: {
					"secret://provider.default.apiKey": "sk-before-upgrade",
				},
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_cli_mitm",
					environmentId: "env_cli_mitm",
					instanceId: "iid_cli_mitm",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					workspaceRoot: join(home, "clawdi"),
					controlPlane: { apiUrl: "https://cloud-api.test" },
					egressEngine: mitmproxy,
					runtimes: {
						openclaw: {
							enabled: true,
							provider_ids: ["default"],
							primary_model: { provider_id: "default", model: "gpt-5.5" },
						},
					},
					projection: {
						providers: {
							default: {
								kind: "openai-compatible",
								type: "custom_openai_compatible",
								baseUrl: "https://ai-gateway.example.test/v1",
								models: [{ id: "gpt-5.5" }],
								apiMode: "openai_responses",
								runtimeEnvName: "OPENAI_API_KEY",
								apiKeySecretRef: "secret://provider.default.apiKey",
							},
						},
					},
					egressProfiles: {
						profiles: [
							{
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
								priority: 80,
								owner: "provider-projection",
							},
						],
					},
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
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
			expect(systemctlCalls).toContain("restart clawdi-runtime-sidecar.service");
			expect(systemctlCalls).not.toContain("restart clawdi-daemon.service");
			const sidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
			const sidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
			const transparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
			expect(sidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
			expect(sidecarEnv).toContain('CLAWDI_RUNTIME_REV="');
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
	])("hosted exact CLI desired state %s without npm view", (_name, currentVersion, desiredVersion) => {
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
		const currentSpec = `clawdi@${currentVersion}`;
		const desiredSpec = `clawdi@${desiredVersion}`;
		seedCurrentCliInstall(state, currentSpec, currentVersion, "https://registry.npmjs.org");

		try {
			const desired = normalizeHostedManifestFixture(hostedCliManifestResponse(home, desiredSpec));
			const paths = getRuntimePaths();
			const result = applyRuntimeCliDesiredState(desired.manifest, paths);

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
			expect(statSync(result.activeTarget).mode & 0o777).toBe(0o755);
			expect(statSync(paths.cliBootstrapStatus).mode & 0o777).toBe(0o600);
			expect(statSync(paths.cliUpgradeState).mode & 0o777).toBe(0o600);
			const npmCalls = readFileSync(npmLog, "utf-8").trim().split("\n");
			expect(npmCalls.some((call) => call.startsWith("view "))).toBe(false);
			expect(npmCalls.some((call) => call.includes(desiredSpec))).toBe(true);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("cancels a prepared CLI transaction while the previous target is still active", () => {
		const { paths, previousIdentity, newIdentity } = seedCliRecoveryFixture(
			join(root, "state-cli-prepared-previous"),
			join(root, "run-cli-prepared-previous"),
		);
		pointManagedCliAt(paths, previousIdentity);
		writeCliBootstrapFixture(paths, previousIdentity);
		writeCliTransactionFixture(paths, {
			phase: "prepared",
			previousIdentity,
			newIdentity,
		});

		const recovered = reconcilePendingRuntimeCliUpgrade(paths, previousIdentity.version);

		expect(recovered).toEqual({ status: "unchanged", selfReexec: false });
		expect(readlinkSync(paths.cliManagedBin)).toBe(previousIdentity.activeTarget);
		expect(JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8")).transaction).toBeNull();
		expect(existsSync(newIdentity.npmPrefix)).toBe(false);
	});

	it("activates a prepared CLI transaction whose valid new target is already active", () => {
		const { paths, previousIdentity, newIdentity } = seedCliRecoveryFixture(
			join(root, "state-cli-prepared-new"),
			join(root, "run-cli-prepared-new"),
		);
		pointManagedCliAt(paths, newIdentity);
		writeCliBootstrapFixture(paths, previousIdentity);
		writeCliTransactionFixture(paths, {
			phase: "prepared",
			previousIdentity,
			newIdentity,
		});

		const recovered = reconcilePendingRuntimeCliUpgrade(paths, previousIdentity.version);
		const transactionState = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
		const bootstrap = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));

		expect(recovered).toEqual({ status: "activated", selfReexec: true });
		expect(transactionState.transaction).toMatchObject({
			phase: "activated",
			newIdentity,
		});
		expect(bootstrap).toMatchObject({
			activeTarget: newIdentity.activeTarget,
			version: newIdentity.version,
		});
		expect(readlinkSync(paths.cliManagedBin)).toBe(newIdentity.activeTarget);
	});

	it("keeps an old process behind the handoff fence for an activated transaction", () => {
		const { paths, previousIdentity, newIdentity } = seedCliRecoveryFixture(
			join(root, "state-cli-activated-old-process"),
			join(root, "run-cli-activated-old-process"),
		);
		pointManagedCliAt(paths, newIdentity);
		writeCliBootstrapFixture(paths, newIdentity);
		writeCliTransactionFixture(paths, {
			phase: "activated",
			previousIdentity,
			newIdentity,
		});

		const recovered = reconcilePendingRuntimeCliUpgrade(paths, previousIdentity.version);

		expect(recovered).toEqual({ status: "unchanged", selfReexec: true });
		expect(JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"))).toMatchObject({
			transaction: { phase: "activated", newIdentity },
			badVersions: [],
		});
	});

	it("accepts a verified external bootstrap that supersedes a stale activated transaction", () => {
		const { paths, previousIdentity, newIdentity, bootstrapIdentity } =
			seedExternalCliBootstrapRecoveryFixture(
				join(root, "state-cli-external-bootstrap"),
				join(root, "run-cli-external-bootstrap"),
			);
		const before = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
		expect(existsSync(previousIdentity.npmPrefix)).toBe(false);

		const recovered = reconcilePendingRuntimeCliUpgrade(paths, bootstrapIdentity.version);
		const handedOff = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
		const bootstrap = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));

		expect(recovered).toEqual({ status: "activated", selfReexec: false });
		expect(readlinkSync(paths.cliManagedBin)).toBe(bootstrapIdentity.activeTarget);
		expect(handedOff.transaction).toMatchObject({
			phase: "activated",
			previousIdentity: null,
			newIdentity: bootstrapIdentity,
			rollbackEligible: false,
			rollback: null,
		});
		expect(handedOff.badVersions).toEqual(before.badVersions);
		expect(bootstrap).toMatchObject({
			packageSpec: bootstrapIdentity.packageSpec,
			npmPrefix: bootstrapIdentity.npmPrefix,
			activeTarget: bootstrapIdentity.activeTarget,
			version: bootstrapIdentity.version,
			verification: {
				verifiedAt: expect.any(String),
				device: expect.any(Number),
				inode: expect.any(Number),
				size: expect.any(Number),
				modifiedAtMs: expect.any(Number),
			},
		});
		expect(existsSync(bootstrapIdentity.npmPrefix)).toBe(true);
		expect(existsSync(newIdentity.npmPrefix)).toBe(false);

		const journalAfterHandoff = readFileSync(paths.cliUpgradeState, "utf-8");
		const staleOwnerRollback = rollbackPendingRuntimeCliUpgrade(
			paths,
			"stale self-upgrade owner must not roll back bootstrap",
		);
		expect(staleOwnerRollback.status).toBe("not_pending");
		expect(readFileSync(paths.cliUpgradeState, "utf-8")).toBe(journalAfterHandoff);

		const replayed = reconcilePendingRuntimeCliUpgrade(paths, bootstrapIdentity.version);
		expect(replayed).toEqual({ status: "unchanged", selfReexec: false });
		expect(readFileSync(paths.cliUpgradeState, "utf-8")).toBe(journalAfterHandoff);

		completePendingRuntimeCliUpgrade(paths, bootstrapIdentity.version);
		const completed = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
		expect(completed.transaction).toBeNull();
		expect(completed.badVersions).toEqual(before.badVersions);
	});

	it("runtime watch fences an old process after durably handing off a trusted activation", async () => {
		const runningVersion = getCliVersion();
		const bootstrapVersion = runningVersion === "999.0.0" ? "999.0.1" : "999.0.0";
		const state = join(root, "state-cli-external-bootstrap-old-process");
		const run = join(root, "run-cli-external-bootstrap-old-process");
		process.env.HOME = join(root, "home-cli-external-bootstrap-old-process");
		process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(run, "systemd", "system");
		const { paths, bootstrapIdentity } = seedExternalCliBootstrapRecoveryFixture(
			state,
			run,
			bootstrapVersion,
		);
		const before = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
		const logs: string[] = [];
		const previousLog = console.log;
		const previousExitCode = process.exitCode;
		const { captured, restore } = mockFetch([]);
		expect(bootstrapIdentity.version).not.toBe(runningVersion);
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		process.exitCode = undefined;

		try {
			await runtimeWatch({ once: true, json: true, notifications: false });

			const event = JSON.parse(logs[0]);
			const handedOff = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
			expect(process.exitCode ?? 0).toBe(0);
			expect(event).toMatchObject({
				status: "cli_handoff",
				handoff: "cli_reexec",
				reconciliation: { status: "activated", selfReexec: true },
				selfReexec: true,
			});
			expect(captured).toHaveLength(0);
			expect(readlinkSync(paths.cliManagedBin)).toBe(bootstrapIdentity.activeTarget);
			expect(handedOff).toMatchObject({
				transaction: {
					phase: "activated",
					previousIdentity: null,
					newIdentity: bootstrapIdentity,
					rollbackEligible: false,
					rollback: null,
				},
				badVersions: before.badVersions,
			});
			expect(existsSync(paths.manifestLastGood)).toBe(false);
			expect(existsSync(paths.appliedState)).toBe(false);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("hands off by verified identity without using version ordering", () => {
		const { paths, bootstrapIdentity } = seedExternalCliBootstrapRecoveryFixture(
			join(root, "state-cli-external-bootstrap-lower-version"),
			join(root, "run-cli-external-bootstrap-lower-version"),
			"1.2.0",
		);

		const recovered = reconcilePendingRuntimeCliUpgrade(paths, bootstrapIdentity.version);
		const handedOff = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));

		expect(recovered).toEqual({ status: "activated", selfReexec: false });
		expect(handedOff.transaction).toMatchObject({
			newIdentity: bootstrapIdentity,
			rollbackEligible: false,
		});
	});

	it("fails closed when a bootstrap-owned handoff journal replays a tampered target", () => {
		const { paths, bootstrapIdentity } = seedExternalCliBootstrapRecoveryFixture(
			join(root, "state-cli-external-bootstrap-replay-tampered"),
			join(root, "run-cli-external-bootstrap-replay-tampered"),
		);
		reconcilePendingRuntimeCliUpgrade(paths, bootstrapIdentity.version);
		writeFileSync(bootstrapIdentity.activeTarget, "#!/usr/bin/env bash\nexit 1\n", {
			mode: 0o700,
		});
		const handoffJournal = readFileSync(paths.cliUpgradeState, "utf-8");

		expect(() => reconcilePendingRuntimeCliUpgrade(paths, bootstrapIdentity.version)).toThrow(
			"clawdi CLI transaction cannot restore a verified previous identity",
		);
		expect(readFileSync(paths.cliUpgradeState, "utf-8")).toBe(handoffJournal);
		expect(readlinkSync(paths.cliManagedBin)).toBe(bootstrapIdentity.activeTarget);
	});

	it("fails closed when an external bootstrap target was tampered", () => {
		const { paths, bootstrapIdentity } = seedExternalCliBootstrapRecoveryFixture(
			join(root, "state-cli-external-bootstrap-tampered"),
			join(root, "run-cli-external-bootstrap-tampered"),
		);
		writeFileSync(bootstrapIdentity.activeTarget, "#!/usr/bin/env bash\nexit 1\n", {
			mode: 0o700,
		});
		const before = readFileSync(paths.cliUpgradeState, "utf-8");

		expect(() => reconcilePendingRuntimeCliUpgrade(paths, bootstrapIdentity.version)).toThrow(
			"clawdi CLI transaction cannot restore a verified previous identity",
		);
		expect(readFileSync(paths.cliUpgradeState, "utf-8")).toBe(before);
		expect(readlinkSync(paths.cliManagedBin)).toBe(bootstrapIdentity.activeTarget);
	});

	it("fails closed when bootstrap status is stale for the externally active target", () => {
		const { paths, newIdentity, bootstrapIdentity } = seedExternalCliBootstrapRecoveryFixture(
			join(root, "state-cli-external-bootstrap-stale-status"),
			join(root, "run-cli-external-bootstrap-stale-status"),
		);
		writeCliBootstrapFixture(paths, newIdentity);
		const before = readFileSync(paths.cliUpgradeState, "utf-8");

		expect(() => reconcilePendingRuntimeCliUpgrade(paths, bootstrapIdentity.version)).toThrow(
			"clawdi CLI transaction cannot restore a verified previous identity",
		);
		expect(readFileSync(paths.cliUpgradeState, "utf-8")).toBe(before);
		expect(readlinkSync(paths.cliManagedBin)).toBe(bootstrapIdentity.activeTarget);
	});

	it("fails closed when bootstrap identity mismatches the externally active version", () => {
		const { paths, bootstrapIdentity } = seedExternalCliBootstrapRecoveryFixture(
			join(root, "state-cli-external-bootstrap-mismatch"),
			join(root, "run-cli-external-bootstrap-mismatch"),
		);
		const bootstrap = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		bootstrap.version = "1.2.5";
		writeFileSync(paths.cliBootstrapStatus, `${JSON.stringify(bootstrap)}\n`);
		const before = readFileSync(paths.cliUpgradeState, "utf-8");

		expect(() => reconcilePendingRuntimeCliUpgrade(paths, bootstrapIdentity.version)).toThrow(
			"clawdi CLI transaction cannot restore a verified previous identity",
		);
		expect(readFileSync(paths.cliUpgradeState, "utf-8")).toBe(before);
		expect(readlinkSync(paths.cliManagedBin)).toBe(bootstrapIdentity.activeTarget);
	});

	it("completes a normal activated transaction without changing bad-version history", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state-cli-normal-completion");
		process.env.CLAWDI_RUN_DIR = join(root, "run-cli-normal-completion");
		const paths = getRuntimePaths();
		const previousIdentity = createVersionedCliFixture(paths, "1.2.3");
		const newIdentity = createVersionedCliFixture(paths, "1.2.4");
		pointManagedCliAt(paths, newIdentity);
		writeCliBootstrapFixture(paths, newIdentity);
		writeCliTransactionFixture(paths, {
			phase: "activated",
			previousIdentity,
			newIdentity,
			badVersions: [{ version: "1.2.2", reason: "existing rollback" }],
		});
		const before = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));

		const completed = completePendingRuntimeCliUpgrade(paths, newIdentity.version);
		const after = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));

		expect(completed).toEqual({ status: "unchanged", selfReexec: false });
		expect(after.transaction).toBeNull();
		expect(after.badVersions).toEqual(before.badVersions);
		expect(readlinkSync(paths.cliManagedBin)).toBe(newIdentity.activeTarget);
		expect(existsSync(previousIdentity.npmPrefix)).toBe(false);
		expect(existsSync(newIdentity.npmPrefix)).toBe(true);
	});

	it("rolls back an activated CLI transaction whose new target is invalid", () => {
		const { paths, previousIdentity, newIdentity } = seedCliRecoveryFixture(
			join(root, "state-cli-activated-invalid"),
			join(root, "run-cli-activated-invalid"),
		);
		pointManagedCliAt(paths, newIdentity);
		writeCliBootstrapFixture(paths, newIdentity);
		writeCliTransactionFixture(paths, {
			phase: "activated",
			previousIdentity,
			newIdentity,
			badVersions: [{ version: "1.2.2", reason: "existing rollback" }],
		});
		writeFileSync(newIdentity.activeTarget, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });

		const recovered = reconcilePendingRuntimeCliUpgrade(paths, newIdentity.version);
		const transactionState = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));

		expect(recovered).toEqual({ status: "rolled_back", selfReexec: true });
		expect(readlinkSync(paths.cliManagedBin)).toBe(previousIdentity.activeTarget);
		expect(transactionState.transaction).toBeNull();
		expect(transactionState.badVersions).toContainEqual(
			expect.objectContaining({ version: newIdentity.version }),
		);
		expect(transactionState.badVersions).toContainEqual(
			expect.objectContaining({ version: "1.2.2", reason: "existing rollback" }),
		);
	});

	it("finishes a durable rollback intent while the new target is still active", () => {
		const { paths, previousIdentity, newIdentity } = seedCliRecoveryFixture(
			join(root, "state-cli-rollback-new"),
			join(root, "run-cli-rollback-new"),
		);
		pointManagedCliAt(paths, newIdentity);
		writeCliBootstrapFixture(paths, newIdentity);
		writeCliTransactionFixture(paths, {
			phase: "activated",
			previousIdentity,
			newIdentity,
			rollbackReason: "fixture convergence failure",
		});

		const recovered = reconcilePendingRuntimeCliUpgrade(paths, newIdentity.version);
		const transactionState = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));

		expect(recovered).toEqual({ status: "rolled_back", selfReexec: true });
		expect(readlinkSync(paths.cliManagedBin)).toBe(previousIdentity.activeTarget);
		expect(transactionState.transaction).toBeNull();
		expect(transactionState.badVersions).toContainEqual(
			expect.objectContaining({
				version: newIdentity.version,
				reason: "fixture convergence failure",
			}),
		);
		expect(existsSync(newIdentity.npmPrefix)).toBe(false);
	});

	it("finishes rollback journal, status, and pruning when the previous target is active", () => {
		const { paths, previousIdentity, newIdentity } = seedCliRecoveryFixture(
			join(root, "state-cli-rollback-previous"),
			join(root, "run-cli-rollback-previous"),
		);
		pointManagedCliAt(paths, previousIdentity);
		writeCliBootstrapFixture(paths, newIdentity);
		writeCliTransactionFixture(paths, {
			phase: "activated",
			previousIdentity,
			newIdentity,
			rollbackReason: "fixture convergence failure",
		});

		const recovered = reconcilePendingRuntimeCliUpgrade(paths, newIdentity.version);
		const transactionState = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
		const bootstrap = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));

		expect(recovered).toEqual({ status: "rolled_back", selfReexec: true });
		expect(transactionState.transaction).toBeNull();
		expect(bootstrap).toMatchObject({
			activeTarget: previousIdentity.activeTarget,
			version: previousIdentity.version,
		});
		expect(existsSync(newIdentity.npmPrefix)).toBe(false);
	});

	it("re-verifies a current CLI periodically and whenever its file identity drifts", () => {
		const state = join(root, "state-cli-verification-cache");
		const run = join(root, "run-cli-verification-cache");
		const commandLog = join(root, "cli-verification-cache.log");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		seedCurrentCliInstall(state, "clawdi@1.2.3", "1.2.3");
		const paths = getRuntimePaths();
		const activeTarget = readlinkSync(paths.cliManagedBin);
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

		applyRuntimeCliDesiredState(manifest, paths);
		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(2);
		applyRuntimeCliDesiredState(manifest, paths);
		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(2);

		const driftedAt = new Date(Date.now() + 1_000);
		utimesSync(activeTarget, driftedAt, driftedAt);
		applyRuntimeCliDesiredState(manifest, paths);
		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(4);

		const status = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		status.verification.verifiedAt = "2020-01-01T00:00:00.000Z";
		writeFileSync(paths.cliBootstrapStatus, JSON.stringify(status));
		applyRuntimeCliDesiredState(manifest, paths);
		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(6);
	});

	it("does not cache a changed target as the verified desired CLI", () => {
		const state = join(root, "state-cli-verification-race");
		const run = join(root, "run-cli-verification-race");
		const bin = join(root, "bin-cli-verification-race");
		const previousPath = process.env.PATH;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		seedCurrentCliInstall(state, "clawdi@1.2.3", "1.2.3");
		const paths = getRuntimePaths();
		const activeTarget = readlinkSync(paths.cliManagedBin);
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "npm"), "#!/usr/bin/env bash\nexit 97\n");
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		writeFileSync(
			activeTarget,
			`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  cat > "$0" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo '1.2.2'; exit 0; fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then echo '{"status":"ok"}'; exit 0; fi
exit 64
SH
  chmod +x "$0"
  echo '1.2.3'
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then echo '{"status":"ok"}'; exit 0; fi
exit 64
`,
		);
		chmodSync(activeTarget, 0o700);

		try {
			expect(() => applyRuntimeCliDesiredState(cliManifest("1.2.3"), paths)).toThrow(/npm install/);
			const status = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			expect(status.packageSpec).toBe("clawdi@1.2.2");
			expect(status.version).toBe("1.2.2");
			expect(status.verification).toBeDefined();
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("fails closed on a corrupt CLI transaction journal before install or prune", () => {
		const state = join(root, "state-cli-corrupt-journal");
		const run = join(root, "run-cli-corrupt-journal");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		seedCurrentCliInstall(state, "clawdi@1.2.3", "1.2.3");
		const paths = getRuntimePaths();
		const activeTarget = readlinkSync(paths.cliManagedBin);
		const lastGood = join(paths.cliNpmPrefix, "packages", "1.2.2", "bin", "clawdi");
		mkdirSync(dirname(lastGood), { recursive: true });
		writeFileSync(lastGood, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(lastGood, 0o700);
		writeFileSync(paths.cliUpgradeState, "{broken journal");

		expect(() => applyRuntimeCliDesiredState(cliManifest("1.2.4"), paths)).toThrow(
			/invalid clawdi CLI upgrade transaction JSON/,
		);
		expect(readlinkSync(paths.cliManagedBin)).toBe(activeTarget);
		expect(existsSync(lastGood)).toBe(true);
		expect(readFileSync(paths.cliUpgradeState, "utf-8")).toBe("{broken journal");
	});

	it("recovers an exact CLI install when matching bootstrap status has no version", () => {
		const desiredVersion = "1.2.3-test.2";
		const desiredSpec = `clawdi@${desiredVersion}`;
		const home = join(root, "home-exact-recovery", "clawdi");
		const state = join(root, "state-exact-recovery");
		const run = join(root, "run-exact-recovery");
		const bin = join(root, "bin-exact-recovery");
		const npmLog = join(root, "npm-exact-recovery.log");
		const previousPath = process.env.PATH;
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "npm"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${npmLog}'
exit 97
`,
		);
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		seedCurrentCliInstall(state, desiredSpec, desiredVersion, "https://registry.npmjs.org");
		const paths = getRuntimePaths();
		const exactPrefix = join(paths.cliNpmPrefix, "packages", desiredVersion);
		const exactTarget = join(exactPrefix, "bin", "clawdi");
		mkdirSync(dirname(exactTarget), { recursive: true });
		writeFileSync(
			exactTarget,
			`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${desiredVersion}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"ok"}'
  exit 0
fi
exit 64
`,
		);
		chmodSync(exactTarget, 0o700);
		rmSync(paths.cliManagedBin, { force: true });
		symlinkSync(exactTarget, paths.cliManagedBin);
		const bootstrapStatus = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		bootstrapStatus.npmPrefix = exactPrefix;
		bootstrapStatus.activeTarget = exactTarget;
		delete bootstrapStatus.version;
		writeFileSync(paths.cliBootstrapStatus, JSON.stringify(bootstrapStatus));

		try {
			const desired = normalizeHostedManifestFixture(hostedCliManifestResponse(home, desiredSpec));
			const result = applyRuntimeCliDesiredState(desired.manifest, paths);

			expect(result.status).toBe("current");
			expect(result.packageSpec).toBe(desiredSpec);
			expect(result.version).toBe(desiredVersion);
			expect(result.npmPrefix).toBe(exactPrefix);
			expect(result.activeTarget).toBe(exactTarget);
			expect(readlinkSync(paths.cliManagedBin)).toBe(exactTarget);
			expect(existsSync(npmLog)).toBe(false);
			const repairedStatus = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			expect(repairedStatus.version).toBe(desiredVersion);
			expect(repairedStatus.npmPrefix).toBe(exactPrefix);
			expect(repairedStatus.activeTarget).toBe(exactTarget);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("reinstalls an exact CLI spec when the active link uses a legacy hash prefix", () => {
		const desiredVersion = "1.2.3-test.2";
		const desiredSpec = `clawdi@${desiredVersion}`;
		const registry = "https://registry.npmjs.org";
		const home = join(root, "home-exact-missing-version", "clawdi");
		const state = join(root, "state-exact-missing-version");
		const run = join(root, "run-exact-missing-version");
		const bin = join(root, "bin-exact-missing-version");
		const npmLog = join(root, "npm-exact-missing-version.log");
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
		seedCurrentCliInstall(state, desiredSpec, desiredVersion, registry);
		const paths = getRuntimePaths();
		const legacyHash = createHash("sha256")
			.update(JSON.stringify({ packageSpec: desiredSpec, registry }))
			.digest("hex")
			.slice(0, 16);
		const legacyPrefix = join(paths.cliNpmPrefix, "packages", legacyHash);
		const legacyTarget = join(legacyPrefix, "bin", "clawdi");
		mkdirSync(dirname(legacyTarget), { recursive: true });
		writeFileSync(
			legacyTarget,
			`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${desiredVersion}"
  exit 0
fi
exit 64
`,
		);
		chmodSync(legacyTarget, 0o700);
		rmSync(paths.cliManagedBin, { force: true });
		symlinkSync(legacyTarget, paths.cliManagedBin);
		const bootstrapStatus = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		bootstrapStatus.npmPrefix = legacyPrefix;
		bootstrapStatus.activeTarget = legacyTarget;
		delete bootstrapStatus.version;
		writeFileSync(paths.cliBootstrapStatus, JSON.stringify(bootstrapStatus));

		try {
			const desired = normalizeHostedManifestFixture(hostedCliManifestResponse(home, desiredSpec));
			const result = applyRuntimeCliDesiredState(desired.manifest, paths);
			const canonicalPrefix = join(paths.cliNpmPrefix, "packages", desiredVersion);
			const canonicalTarget = join(canonicalPrefix, "bin", "clawdi");

			expect(result.status).toBe("installed");
			expect(result.packageSpec).toBe(desiredSpec);
			expect(result.version).toBe(desiredVersion);
			expect(result.npmPrefix).toBe(canonicalPrefix);
			expect(result.activeTarget).toBe(canonicalTarget);
			expect(readlinkSync(paths.cliManagedBin)).toBe(canonicalTarget);
			const npmCalls = readFileSync(npmLog, "utf-8").trim().split("\n");
			expect(npmCalls.some((call) => call.startsWith("view "))).toBe(false);
			expect(npmCalls.some((call) => call.startsWith("install "))).toBe(true);
			expect(npmCalls.some((call) => call.includes(desiredSpec))).toBe(true);
			const repairedStatus = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			expect(repairedStatus.version).toBe(desiredVersion);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("rejects an exact CLI install that reports a different version without swapping active", () => {
		const desiredVersion = "1.2.3-test.2";
		const actualVersion = "1.2.3-test.1";
		const desiredSpec = `clawdi@${desiredVersion}`;
		const home = join(root, "home-exact-version-mismatch", "clawdi");
		const state = join(root, "state-exact-version-mismatch");
		const run = join(root, "run-exact-version-mismatch");
		const bin = join(root, "bin-exact-version-mismatch");
		const npmLog = join(root, "npm-exact-version-mismatch.log");
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
  echo "${actualVersion}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
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
		seedCurrentCliInstall(
			state,
			"clawdi@1.2.3-test.1",
			"1.2.3-test.1",
			"https://registry.npmjs.org",
		);
		const paths = getRuntimePaths();
		const oldTarget = readlinkSync(paths.cliManagedBin);
		const oldStatus = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));

		try {
			const desired = normalizeHostedManifestFixture(hostedCliManifestResponse(home, desiredSpec));
			expect(() => applyRuntimeCliDesiredState(desired.manifest, paths)).toThrow(
				`npm install ${desiredSpec} reported version ${actualVersion}, expected ${desiredVersion}`,
			);

			expect(readlinkSync(paths.cliManagedBin)).toBe(oldTarget);
			expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"))).toEqual(oldStatus);
			const npmCalls = readFileSync(npmLog, "utf-8").trim().split("\n");
			expect(npmCalls).toHaveLength(1);
			expect(npmCalls[0].startsWith("install ")).toBe(true);
			expect(npmCalls[0]).toContain(desiredSpec);
			expect(npmCalls.some((call) => call.startsWith("view "))).toBe(false);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime watch self-heal installs an exact hosted CLI version and hands off", async () => {
		installSuccessfulSystemctlFixture();
		setRuntimeApplyGeneration(30, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const npmLog = join(root, "npm-self-heal.log");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
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
	  echo "1.2.3-test"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
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
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		const paths = getRuntimePaths();
		seedCurrentCliInstall(
			state,
			"clawdi@1.2.3-test.2",
			"1.2.3-test.2",
			"https://registry.npmjs.org",
		);
		const manifestPayload = {
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				runtime: "openclaw",
				deploymentId: "dep_cli_self_heal",
				environmentId: "env_cli_self_heal",
				...hostedRequiredState(),
				instanceId: "iid_cli_self_heal",
				generation: 30,
				issuedAt: "2026-07-11T00:00:00Z",
				locale: TEST_HOSTED_LOCALE,
				system: hostedSystemFixture(home),
				controlPlane: { cloudApiUrl: "https://cloud-api.test" },
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@1.2.3-test",
					registry: "https://registry.npmjs.org",
				},
				runtimes: { openclaw: hostedOpenClawRuntime() },
			},
			secretValues: {},
		};
		const bundleEtag = `"sha256:${"a".repeat(64)}"`;
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: "iid_cli_self_heal",
				etag: bundleEtag,
				sourceRevision: "a".repeat(64),
				generation: 30,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				providerIds: ["default"],
				projectedProviderIds: {},
			},
			paths,
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: (request) =>
					request.headers["if-none-match"]
						? new Response(null, {
								status: 304,
								headers: { etag: bundleEtag },
							})
						: hostedRuntimeBundleResponse(manifestPayload, {
								etag: bundleEtag,
							}),
			},
		]);
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		try {
			await Promise.race([
				runtimeWatch({
					intervalMs: 20,
					selfHealMs: 10,
					json: true,
					notifications: false,
				}),
				new Promise<never>(
					(_, reject) =>
						(timeoutId = setTimeout(
							() => reject(new Error("runtime watch self-heal test timed out")),
							2_000,
						)),
				),
			]);

			expect(process.exitCode ?? 0).toBe(0);
			expect(captured).toHaveLength(2);
			expect(captured.map((request) => request.path)).toEqual([
				"/v1/runtime/manifest",
				"/v1/runtime/manifest",
			]);
			expect(captured[0].headers["if-none-match"]).toBe(bundleEtag);
			expect(captured[1].headers["if-none-match"]).toBeUndefined();
			const events = logs.map((line) => JSON.parse(line));
			expect(events.map((event) => event.status)).toEqual(["cli_handoff"]);
			expect(events[0].cliUpdate).toEqual(
				expect.objectContaining({
					status: "installed",
					packageSpec: "clawdi@1.2.3-test",
					version: "1.2.3-test",
				}),
			);
			expect(events[0].selfReexec).toBe(true);
			const npmCalls = readFileSync(npmLog, "utf-8").trim().split("\n");
			expect(npmCalls.some((call) => call.startsWith("view "))).toBe(false);
			expect(npmCalls.some((call) => call.startsWith("install "))).toBe(true);
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime watch never enters a failing projection after CLI activation", async () => {
		setRuntimeApplyGeneration(16);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const openclawInstaller = join(root, "install-openclaw.sh");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(home, { recursive: true });
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
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "1.3.0-test.1"
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
		writeFileSync(
			openclawInstaller,
			`#!/usr/bin/env bash
set -euo pipefail
install -d "$HOME/.local/bin"
cat > "$HOME/.local/bin/openclaw" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-} \${2:-} \${3:-}" = "config patch --stdin" ]; then
  echo "projection boom" >&2
  exit 73
fi
if [ "\${1:-}" = "plugins" ] && [ "\${2:-}" = "install" ]; then
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
SH
chmod +x "$HOME/.local/bin/openclaw"
`,
		);
		chmodSync(openclawInstaller, 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = openclawInstaller;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
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
								deploymentId: "dep_cli_update_converge_failure",
								environmentId: "env_cli_update_converge_failure",
								...hostedRequiredState(),
								instanceId: "iid_cli_update_converge_failure",
								generation: 16,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: "clawdi@1.3.0-test.1",
									registry: "https://registry.npmjs.org",
								},
								agentPlugins: {
									schemaVersion: 1,
									installations: {
										"unavailable.plugin": {
											installationId: "install_unavailable_plugin",
											version: "1.0.0",
											agentPluginsSchema:
												"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
											source: {
												type: "github",
												url: "https://github.com/acme/unavailable-agent-plugin",
												path: "plugin",
												commit: "d".repeat(40),
											},
											contentDigest: `sha256-tree-v1:${"e".repeat(64)}`,
										},
									},
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime({}),
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
								"secret://channels/telegram/clawdi_accttelegram/agent-token":
									"telegram-agent-token-failure",
								"secret://channels/telegram/clawdi_accttelegram/placeholder-token":
									"999999999:00000000000000000000000000000000",
							},
						},
						{ etag: testBundleEtag("etag-projection-failed") },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(0);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("cli_handoff");
			expect(event.cliUpdate.status).toBe("installed");
			expect(event.selfReexec).toBe(true);
			expect(event.errors).toBeUndefined();
			expect(captured.map((request) => request.path)).toEqual(["/v1/runtime/manifest"]);
			expect(existsSync(join(home, ".local", "bin", "openclaw"))).toBe(false);
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
			expect(existsSync(getRuntimePaths().appliedState)).toBe(false);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("rolls back a CLI upgrade when first converge fails for an already-applied manifest", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const npmLog = join(root, "npm.log");
		const openclawInstaller = join(root, "install-openclaw.sh");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const currentVersion = getCliVersion();
		setRuntimeApplyGeneration(18);
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(bin, "npm"),
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${npmLog}'
if [ "\${1:-}" = "view" ]; then
  echo '"${currentVersion}"'
  exit 0
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
		writeFileSync(openclawInstaller, "#!/usr/bin/env bash\necho install failed >&2\nexit 73\n");
		chmodSync(openclawInstaller, 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = openclawInstaller;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		seedCurrentCliInstall(state, `clawdi@${currentVersion}`, currentVersion);
		const paths = getRuntimePaths();
		const oldTarget = readlinkSync(paths.cliManagedBin);
		const manifest = {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			runtime: "openclaw",
			deploymentId: "dep_cli_rollback",
			environmentId: "env_cli_rollback",
			...hostedRequiredState(),
			instanceId: "iid_cli_rollback",
			generation: 18,
			issuedAt: "2026-06-06T00:00:00Z",
			locale: TEST_HOSTED_LOCALE,
			system: hostedSystemFixture(home),
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: `clawdi@${currentVersion}`,
				registry: "https://registry.npmjs.org",
			},
			runtimes: {
				openclaw: hostedOpenClawRuntime({}),
			},
		};
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: "iid_cli_rollback",
				etag: testBundleEtag("etag-cli-rollback"),
				sourceRevision: "a".repeat(64),
				generation: 18,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				providerIds: ["default"],
				projectedProviderIds: {},
			},
			paths,
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(
						{
							manifest,
							secretValues: {},
						},
						{ etag: testBundleEtag("etag-cli-rollback") },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(0);
			const handoffEvent = JSON.parse(logs[0]);
			expect(handoffEvent.status).toBe("cli_handoff");
			expect(handoffEvent.cliUpdate.status).toBe("installed");
			expect(handoffEvent.cliRollback).toBeUndefined();
			expect(readlinkSync(paths.cliManagedBin)).not.toBe(oldTarget);
			expect(JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"))).toMatchObject({
				transaction: { phase: "activated", newIdentity: { version: currentVersion } },
				badVersions: [],
			});

			logs.length = 0;
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.cliUpdate.status).toBe("current");
			expect(event.cliRollback.status).toBe("rolled_back");
			expect(event.cliRollback.version).toBe(currentVersion);
			expect(event.selfReexec).toBe(true);
			expect(readlinkSync(paths.cliManagedBin)).toBe(oldTarget);
			const upgradeState = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
			expect(upgradeState.transaction).toBeNull();
			expect(upgradeState.badVersions).toContainEqual(
				expect.objectContaining({
					packageSpec: `clawdi@${currentVersion}`,
					version: currentVersion,
				}),
			);
			const beforeRetryLog = readFileSync(npmLog, "utf-8");
			expect(() =>
				applyRuntimeCliDesiredState(
					{
						schemaVersion: "clawdi.runtimeDesiredState.v1",
						deploymentId: "dep_cli_rollback",
						environmentId: "env_cli_rollback",
						instanceId: "iid_cli_rollback",
						generation: 18,
						issuedAt: "2026-06-06T00:00:00Z",
						controlPlane: { apiUrl: "https://cloud-api.test" },
						clawdiCli: {
							source: "npm:clawdi",
							packageSpec: `clawdi@${currentVersion}`,
							registry: "https://registry.npmjs.org",
						},
						runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
						recovery: {},
					},
					paths,
				),
			).toThrow(/marked bad/);
			const afterRetryLog = readFileSync(npmLog, "utf-8");
			expect(afterRetryLog.split("\n").filter((line) => line.startsWith("install ")).length).toBe(
				beforeRetryLog.split("\n").filter((line) => line.startsWith("install ")).length,
			);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime watch keeps npm ETARGET retryable without converging or marking the version bad", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const currentVersion = getCliVersion();
		setRuntimeApplyGeneration(17);
		const firstAttempt = join(root, "npm-etarget-first-attempt");
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
		writeFileSync(
			join(bin, "npm"),
			`#!/usr/bin/env bash
set -euo pipefail
if [ ! -e '${firstAttempt}' ]; then
  touch '${firstAttempt}'
  echo 'npm ERR! code ETARGET' >&2
  echo 'npm ERR! notarget No matching version found' >&2
  exit 1
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
  echo "${currentVersion}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
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
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
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
								deploymentId: "dep_cli_update_failure",
								environmentId: "env_cli_update_failure",
								...hostedRequiredState(),
								instanceId: "iid_cli_update_failure",
								generation: 17,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: `clawdi@${currentVersion}`,
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						},
						{ etag: testBundleEtag("etag-cli-failed") },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.stage).toBe("cli-update");
			expect(event.cliUpdate.status).toBe("error");
			expect(event.error).toContain("ETARGET");
			expect(event.activeGeneration).toBeNull();
			expect(event.rejectedGeneration).toBe(17);
			const paths = getRuntimePaths();
			expect(event.convergence).toBeUndefined();
			expect(event.systemdUnitsChanged).toBe(false);
			expect(event.systemdApply).toEqual({
				applied: false,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			});
			expect(existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"))).toBe(false);
			expect(existsSync(join(paths.systemdUserRoot, "openclaw-gateway.service"))).toBe(false);
			expect(existsSync(paths.manifestLastGood)).toBe(false);
			expect(existsSync(paths.appliedState)).toBe(false);
			expect(existsSync(paths.cliUpgradeState)).toBe(false);

			logs.length = 0;
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(0);
			const handoff = JSON.parse(logs[0]);
			expect(handoff.status).toBe("cli_handoff");
			expect(handoff.cliUpdate.status).toBe("installed");
			expect(handoff.cliRollback).toBeUndefined();
			expect(JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"))).toMatchObject({
				transaction: { phase: "activated", newIdentity: { version: currentVersion } },
				badVersions: [],
			});
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("keeps the previous active CLI when installed CLI smoke fails", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(bin, { recursive: true });
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
  echo "broken smoke" >&2
  exit 42
fi
echo "new broken clawdi"
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
		seedCurrentCliInstall(state, "clawdi@1.2.1-test.1", "1.2.1-test.1");
		const paths = getRuntimePaths();
		const oldTarget = readlinkSync(paths.cliManagedBin);
		const oldStatus = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_cli_smoke_failure",
			environmentId: "env_cli_smoke_failure",
			instanceId: "iid_cli_smoke_failure",
			generation: 14,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@1.2.4-test.1",
			},
			runtimes: {
				openclaw: { enabled: false },
				hermes: { enabled: false },
			},
			recovery: {},
		};

		try {
			expect(() => applyRuntimeCliDesiredState(manifest, paths)).toThrow(/smoke check/);
			expect(readlinkSync(paths.cliManagedBin)).toBe(oldTarget);
			const status = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			expect(status).toEqual(oldStatus);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("keeps the previous active CLI when installed CLI self-check fails", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(bin, { recursive: true });
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
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "1.2.4-test.2"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"error","errors":["manifest parse failed"]}'
  exit 42
fi
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
		seedCurrentCliInstall(state, "clawdi@1.2.1-test.1", "1.2.1-test.1");
		const paths = getRuntimePaths();
		const oldTarget = readlinkSync(paths.cliManagedBin);
		const oldStatus = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_cli_selfcheck_failure",
			environmentId: "env_cli_selfcheck_failure",
			instanceId: "iid_cli_selfcheck_failure",
			generation: 14,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@1.2.4-test.2",
			},
			runtimes: {
				openclaw: { enabled: false },
				hermes: { enabled: false },
			},
			recovery: {},
		};

		try {
			expect(() => applyRuntimeCliDesiredState(manifest, paths)).toThrow(/self-check/);
			expect(readlinkSync(paths.cliManagedBin)).toBe(oldTarget);
			const status = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			expect(status).toEqual(oldStatus);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("rejects unsafe clawdi CLI package specs and registries", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const npmMarker = join(root, "npm-invoked");
		const previousPath = process.env.PATH;
		mkdirSync(home, { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "npm"), `#!/usr/bin/env sh\ntouch '${npmMarker}'\nexit 99\n`);
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const baseManifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_cli_spec_validation",
			environmentId: "env_cli_spec_validation",
			instanceId: "iid_cli_spec_validation",
			generation: 15,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@1.2.4-test.1" },
			runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
			recovery: {},
		};

		for (const packageSpec of [
			"clawdi@01.2.3",
			"clawdi@1.2.3-01",
			"clawdi@1.2.3+build.1",
			"clawdi",
			"clawdi@latest",
			"clawdi@npm:evil",
			"clawdi@https://evil.test/clawdi.tgz",
			"clawdi@github:evil/clawdi",
			"clawdi@file:/tmp/clawdi.tgz",
		]) {
			expect(() =>
				applyRuntimeCliDesiredState(
					{ ...baseManifest, clawdiCli: { source: "npm:clawdi", packageSpec } },
					paths,
				),
			).toThrow(/packageSpec/);
		}
		expect(existsSync(npmMarker)).toBe(false);
		expect(() =>
			applyRuntimeCliDesiredState(
				{
					...baseManifest,
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: "clawdi@1.2.4-test.1",
						registry: "https://registry.evil.test",
					},
				},
				paths,
			),
		).toThrow(/registry/);
		expect(existsSync(npmMarker)).toBe(false);
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	});

	it("rebuilds missing CLI bootstrap status without reinstalling the active package", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const npmLog = join(root, "npm.log");
		const previousPath = process.env.PATH;
		mkdirSync(bin, { recursive: true });
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
printf 'npm called\\n' >> '${npmLog}'
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "1.2.6-test.1"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"ok"}'
  exit 0
fi
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
		const paths = getRuntimePaths();
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_cli_status_rebuild",
			environmentId: "env_cli_status_rebuild",
			instanceId: "iid_cli_status_rebuild",
			generation: 1,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@1.2.6-test.1" },
			runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
			recovery: {},
		};

		try {
			const installed = applyRuntimeCliDesiredState(manifest, paths);
			expect(installed.status).toBe("installed");
			rmSync(paths.cliBootstrapStatus, { force: true });
			rmSync(npmLog, { force: true });

			const recovered = applyRuntimeCliDesiredState(manifest, paths);

			expect(recovered.status).toBe("current");
			expect(existsSync(npmLog)).toBe(false);
			const status = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			expect(status.packageSpec).toBe("clawdi@1.2.6-test.1");
			expect(status.activeTarget).toBe(readlinkSync(paths.cliManagedBin));
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("keeps the paired-image CLI current only behind the exact test fixture gate", () => {
		const home = join(root, "home-paired-cli", "clawdi");
		const state = join(root, "state-paired-cli");
		const run = join(root, "run-paired-cli");
		const bin = join(root, "bin-paired-cli");
		const npmMarker = join(root, "paired-npm-invoked");
		const previousPath = process.env.PATH;
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "npm"), `#!/usr/bin/env sh\ntouch '${npmMarker}'\nexit 99\n`);
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		seedCurrentCliInstall(
			state,
			"/usr/local/share/clawdi/bootstrap/clawdi-local.tgz",
			"1.2.22",
			"https://registry.npmjs.org",
		);
		const paths = getRuntimePaths();
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_paired_cli",
			environmentId: "env_paired_cli",
			instanceId: "iid_paired_cli",
			generation: 1,
			issuedAt: "2026-07-31T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@1.2.22",
				registry: "https://registry.npmjs.org",
			},
			runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
			recovery: {},
		};

		try {
			const current = applyRuntimeCliDesiredState(manifest, paths);
			expect(current.status).toBe("current");
			expect(current.selfReexec).toBe(false);
			expect(existsSync(npmMarker)).toBe(false);
			expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8")).packageSpec).toBe(
				"/usr/local/share/clawdi/bootstrap/clawdi-local.tgz",
			);
		} finally {
			delete process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("preserves the real last-good CLI across a status-missing rollback and later upgrade", () => {
		const home = join(root, "home-cli-rollback-lifecycle", "clawdi");
		const state = join(root, "state-cli-rollback-lifecycle");
		const run = join(root, "run-cli-rollback-lifecycle");
		const bin = join(root, "bin-cli-rollback-lifecycle");
		const previousPath = process.env.PATH;
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "npm"),
			`#!/usr/bin/env bash
set -euo pipefail
prefix=""
package=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  case "$1" in clawdi@*) package="$1" ;; esac
  shift
done
version="\${package#clawdi@}"
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<SH
#!/usr/bin/env bash
if [ "\\\${1:-}" = "--version" ]; then
  echo "$version"
  exit 0
fi
if [ "\\\${1:-} \\\${2:-} \\\${3:-}" = "runtime verify --json" ]; then
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
		const paths = getRuntimePaths();
		const manifestIdentity = {
			generation: 1,
			etag: testBundleEtag("etag-cli-rollback-lifecycle"),
			previouslyApplied: true,
		};
		const manifestFor = (version: string): RuntimeManifest => ({
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_cli_rollback_lifecycle",
			environmentId: "env_cli_rollback_lifecycle",
			instanceId: "iid_cli_rollback_lifecycle",
			generation: 1,
			issuedAt: "2026-07-29T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: { source: "npm:clawdi", packageSpec: `clawdi@${version}` },
			runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
			recovery: {},
		});

		try {
			const first = applyRuntimeCliDesiredState(manifestFor("1.2.20-test.1"), paths, {
				rollbackEligible: manifestIdentity.previouslyApplied,
			});
			if (!first.activeTarget) throw new Error("first CLI install has no active target");
			const lastGoodTarget = first.activeTarget;
			const lastGoodPrefix = first.npmPrefix;
			const firstState = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
			expect(firstState.transaction.rollbackEligible).toBe(false);

			rmSync(paths.cliBootstrapStatus, { force: true });
			const failed = applyRuntimeCliDesiredState(manifestFor("1.2.20-test.2"), paths, {
				rollbackEligible: manifestIdentity.previouslyApplied,
			});
			if (!failed.activeTarget) throw new Error("failed CLI install has no active target");
			const failedTarget = failed.activeTarget;
			const failedState = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
			expect(failedState.transaction).toMatchObject({
				rollbackEligible: true,
				previousIdentity: {
					activeTarget: lastGoodTarget,
					npmPrefix: lastGoodPrefix,
					version: "1.2.20-test.1",
				},
			});

			const firstRollback = rollbackPendingRuntimeCliUpgrade(
				paths,
				"injected first converge failure",
			);
			expect(firstRollback.status).toBe("rolled_back");
			expect(readlinkSync(paths.cliManagedBin)).toBe(lastGoodTarget);
			expect(existsSync(lastGoodPrefix)).toBe(true);
			expect(existsSync(dirname(dirname(failedTarget)))).toBe(false);
			expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"))).toMatchObject({
				packageSpec: "clawdi@1.2.20-test.1",
				npmPrefix: lastGoodPrefix,
				activeTarget: lastGoodTarget,
				version: "1.2.20-test.1",
			});

			applyRuntimeCliDesiredState(manifestFor("1.2.20-test.3"), paths, {
				rollbackEligible: manifestIdentity.previouslyApplied,
			});
			const secondState = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
			expect(secondState.transaction.previousIdentity.activeTarget).toBe(lastGoodTarget);
			expect(secondState.transaction.previousIdentity.activeTarget).not.toBe(failedTarget);
			expect(existsSync(lastGoodPrefix)).toBe(true);

			const secondRollback = rollbackPendingRuntimeCliUpgrade(
				paths,
				"injected second converge failure",
			);
			expect(secondRollback.status).toBe("rolled_back");
			expect(readlinkSync(paths.cliManagedBin)).toBe(lastGoodTarget);
			expect(existsSync(lastGoodPrefix)).toBe(true);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("prunes old versioned CLI package prefixes after successful swaps", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "npm"),
			`#!/usr/bin/env bash
set -euo pipefail
prefix=""
package=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  package="$1"
  shift
done
version="\${package#clawdi@}"
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<SH
#!/usr/bin/env bash
if [ "\\\${1:-}" = "--version" ]; then
  echo "$version"
  exit 0
fi
if [ "\\\${1:-} \\\${2:-} \\\${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"ok"}'
  exit 0
fi
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
		const paths = getRuntimePaths();
		const manifestFor = (packageSpec: string): RuntimeManifest => ({
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_cli_prune",
			environmentId: "env_cli_prune",
			instanceId: "iid_cli_prune",
			generation: 1,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: { source: "npm:clawdi", packageSpec },
			runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
			recovery: {},
		});

		try {
			applyRuntimeCliDesiredState(manifestFor("clawdi@1.2.7-test.1"), paths);
			applyRuntimeCliDesiredState(manifestFor("clawdi@1.2.8-test.1"), paths);
			applyRuntimeCliDesiredState(manifestFor("clawdi@1.2.9-test.1"), paths);
			const packageDirs = readdirSync(join(getRuntimePaths().cliNpmPrefix, "packages")).sort();

			expect(packageDirs).toHaveLength(2);
			const status = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			expect(readlinkSync(paths.cliManagedBin)).toBe(status.activeTarget);
			expect(packageDirs.map((entry) => join(paths.cliNpmPrefix, "packages", entry))).toContain(
				status.npmPrefix,
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime init restarts the bootstrap before convergence and the new CLI completes init", async () => {
		const home = join(root, "home-init-cli-handoff", "clawdi");
		const state = join(root, "state-init-cli-handoff");
		const run = join(root, "run-init-cli-handoff");
		installSuccessfulSystemctlFixture(join(run, "egress", "systemd", "ca.pem"));
		const policyPath = join(root, "etc-init-cli-handoff", "host-policy.json");
		const bin = join(root, "bin-init-cli-handoff");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const currentVersion = getCliVersion();
		setRuntimeApplyGeneration(1);
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(dirname(policyPath), { recursive: true });
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
test -n "$prefix"
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
exit 64
SH
chmod +x "$prefix/bin/clawdi"
`,
		);
		chmodSync(join(bin, "npm"), 0o700);
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
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_HOST_POLICY_PATH = policyPath;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(hostedCliManifestResponse(home, `clawdi@${currentVersion}`), {
						etag: testBundleEtag("etag-init-cli-handoff"),
					}),
			},
		]);

		try {
			await runtimeInit({ nonInteractive: true, json: true });

			const paths = getRuntimePaths();
			expect(process.exitCode).toBe(75);
			expect(captured).toHaveLength(1);
			const handoff = JSON.parse(logs[0]);
			expect(handoff.status).toBe("ok");
			expect(handoff.handoff).toBe("cli_reexec");
			expect(handoff.cliUpdate.status).toBe("installed");
			expect(handoff.selfReexec).toBe(true);
			expect(handoff.exitCode).toBe(75);
			expect(existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"))).toBe(false);
			expect(existsSync(join(paths.systemdUserRoot, "openclaw-gateway.service"))).toBe(false);
			expect(existsSync(paths.manifestLastGood)).toBe(false);
			expect(existsSync(paths.appliedState)).toBe(false);
			expect(JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"))).toMatchObject({
				transaction: { phase: "activated", newIdentity: { version: currentVersion } },
				badVersions: [],
			});

			logs.length = 0;
			process.exitCode = undefined;
			setRuntimeApplyGeneration(1);
			await runtimeInit({ nonInteractive: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(process.exitCode).toBe(0);
			expect(captured).toHaveLength(2);
			const completed = JSON.parse(logs[0]);
			expect(completed.status).toBe("ok");
			expect(completed.handoff).toBeUndefined();
			expect(readRuntimeAppliedState(paths)).toMatchObject({ generation: 1 });
			expect(JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"))).toMatchObject({
				transaction: null,
				badVersions: [],
			});
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime init applies remote channel desired state during first boot", async () => {
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
		mkdirSync(join(root, "etc", "clawdi"), { recursive: true });
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
  printf '%s\n' "$*" >> '${openclawPatchArgs}'
  cat >> '${openclawPatch}'
  printf '\\n---\\n' >> '${openclawPatch}'
  exit 0
fi
if [ "\${1:-}" = "plugins" ] && [ "\${2:-}" = "install" ]; then
  printf '%s\\n' "\${3:-}" >> '${openclawPluginInstalls}'
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
		seedCurrentCliInstall(state, "clawdi@1.2.3-test", "1.2.3-test", "https://registry.npmjs.org");
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
									packageSpec: "clawdi@1.2.3-test",
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
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				etag: testBundleEtag("manifest-etag-init-7"),
				generation: 7,
			});
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
			expect(existsSync(getRuntimePaths().channelsEtag)).toBe(false);
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
			for (const current of ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"]) {
				expect({ dmScope: current, resetTriggers: ["/new"], ...sessionPatch }).toEqual({
					dmScope: "per-account-channel-peer",
					resetTriggers: ["/new"],
				});
			}
			expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe("@openclaw/discord\n");
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
			const cachedManifestText = readFileSync(getRuntimePaths().manifestLastGood, "utf-8");
			expect(cachedManifestText).toContain('"channels"');
			expect(cachedManifestText).not.toContain("agent-token-init");
			expect(cachedManifestText).not.toContain("discord-agent-token-init");
			const cachedSecretsText = readFileSync(getRuntimePaths().managedSecretCacheFile, "utf-8");
			expect(cachedSecretsText).toContain("placeholder-token");
			expect(cachedSecretsText).toContain("999999999:");
			expect(cachedSecretsText).toContain("clawdi_");
			expect(cachedSecretsText).toContain("agent-token-init");
			expect(cachedSecretsText).toContain("discord-agent-token-init");
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
		writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 0\n");
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"custom_root: keep",
				"streaming:",
				"  enabled: false",
				"discord:",
				'  allow_from: ["*"]',
				'  group_allow_from: ["*"]',
				"display:",
				"  theme: user-theme",
				"  platforms:",
				"    discord:",
				"      streaming: false",
				"    telegram:",
				"      compact: true",
				"platforms:",
				"  telegram:",
				"    custom: keep-telegram",
				"    extra:",
				"      custom_extra: keep-extra",
				"  discord:",
				"    custom: keep-discord",
				"",
			].join("\n"),
		);
		writeFileSync(ambientHermesConfig, ambientSentinel);
		chmodSync(hermesBin, 0o700);
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
							args: ["gateway", "run", "--replace"],
							env: { HERMES_EXISTING_ENV: "kept" },
							prependPath: [],
						},
						services: {},
					},
				},
				projection: {
					sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
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
		expect(hermesConfig).toContain("base_url: https://api.telegram.org/bot");
		expect(hermesConfig).toContain("base_file_url: https://api.telegram.org/file/bot");
		expect(hermesConfig).toContain("discord:");
		expect(hermesConfig).toContain("thread_require_mention: false");
		expect(hermesConfig).not.toContain("telegram-agent-token");
		expect(hermesConfig).not.toContain("discord-agent-token");
		const parsedHermesConfig = readHermesConfigYaml(home);
		expect(parsedHermesConfig.streaming).toEqual({ enabled: false });
		expect(parsedHermesConfig.group_sessions_per_user).toBe(false);
		expect(parsedHermesConfig.thread_sessions_per_user).toBe(false);
		expect(parsedHermesConfig).not.toHaveProperty("discord.allow_from");
		expect(parsedHermesConfig).not.toHaveProperty("discord.group_allow_from");
		expect(parsedHermesConfig).not.toHaveProperty("streaming.transport");
		expect(parsedHermesConfig).toMatchObject({
			custom_root: "keep",
			display: {
				theme: "user-theme",
				platforms: {
					discord: { streaming: false },
					telegram: { compact: true, streaming: true },
				},
			},
			platforms: {
				telegram: {
					custom: "keep-telegram",
					extra: {
						custom_extra: "keep-extra",
						group_sessions_per_user: false,
						thread_sessions_per_user: false,
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
		expect(discordOnlyHermesConfig.thread_sessions_per_user).toBe(false);
		expect(discordOnlyHermesConfig).not.toHaveProperty(
			"platforms.telegram.extra.group_sessions_per_user",
		);
		expect(discordOnlyHermesConfig).not.toHaveProperty(
			"platforms.telegram.extra.thread_sessions_per_user",
		);

		const removed = convergeRuntimeManifest(
			applyRuntimeBundleChannelsToManifestLoad({ ...load, channelBindings: [] }, paths),
			paths,
		);
		expect(removed.installErrors).toEqual([]);
		const clearedHermesConfig = readHermesConfigYaml(home);
		expect(clearedHermesConfig.streaming).toEqual({ enabled: false });
		expect(clearedHermesConfig).not.toHaveProperty("group_sessions_per_user");
		expect(clearedHermesConfig).not.toHaveProperty("thread_sessions_per_user");
		expect(clearedHermesConfig).not.toHaveProperty("streaming.transport");
		expect(clearedHermesConfig).not.toHaveProperty(
			"platforms.telegram.extra.thread_sessions_per_user",
		);
		expect(clearedHermesConfig).toMatchObject({
			custom_root: "keep",
			display: {
				theme: "user-theme",
				platforms: {
					discord: { streaming: false },
					telegram: { compact: true },
				},
			},
			platforms: {
				telegram: {
					custom: "keep-telegram",
					extra: { custom_extra: "keep-extra" },
				},
				discord: { custom: "keep-discord" },
			},
		});
		expect(clearedHermesConfig).not.toHaveProperty(
			"platforms.telegram.extra.group_sessions_per_user",
		);
		expect(clearedHermesConfig).not.toHaveProperty("display.platforms.telegram.streaming");
	});

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
		const capability = `clawdi_${createHash("sha256")
			.update(`whatsapp:${accountKey}:${linkId}`)
			.digest("hex")
			.slice(0, 32)}`;
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
		writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 0\n");
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"custom_root: keep",
				"whatsapp:",
				"  user_owned: keep-whatsapp",
				"platforms:",
				"  matrix:",
				"    custom: keep-matrix",
				"  whatsapp:",
				"    custom: keep-platform",
				"    extra:",
				"      custom_extra: keep-extra",
				"",
			].join("\n"),
		);
		chmodSync(hermesBin, 0o700);
		seedHermesManagedBaileys(home);
		seedOpenClawBinary(home);
		writeFakeSystemdManager({
			path: systemctlPath,
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			environmentRoot: join(run, "systemd", "env"),
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		const paths = getRuntimePaths();
		const hermesWhatsAppReceipt = join(paths.managedResourceRoot, "hermes-whatsapp.json");
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
							args: ["gateway", "run", "--replace"],
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
		projected.manifest.runtimes.openclaw = {
			enabled: true,
			run: {
				args: ["gateway", "run"],
				env: {},
				prependPath: [],
			},
			services: {},
		};
		const credentialProjection = projected.manifest.projection?.channelCredentials as unknown[];
		expect(credentialProjection).toEqual([
			expect.objectContaining({
				provider: "whatsapp",
				kind: "whatsapp_baileys_auth_state",
				accountId,
				accountKey,
				linkId,
				credentialId,
				authDir: sessionDir,
				targets: { hermes: { authDir: sessionDir } },
			}),
		]);
		expect(JSON.stringify(projected.manifest)).not.toContain("wa-hermes-secret");
		expect(JSON.stringify(projected)).toContain("x-clawdi-whatsapp-link-capability");
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
		});
		const convergence = convergeRuntimeManifest(projected, paths);
		expect(convergence.installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(hermesWhatsAppReceipt, "utf8"))).toMatchObject({
			schemaVersion: "clawdi.managedHermesWhatsApp.v1",
			deploymentId: projected.manifest.deploymentId,
			environmentId: projected.manifest.environmentId,
			instanceId: projected.manifest.instanceId,
			accountKey,
			linkId,
			credentialId,
			authDir: sessionDir,
		});
		commitRuntimeAppliedState({
			load: projected,
			paths,
			etag: '"hermes-whatsapp-active"',
			sourceRevision: "a".repeat(64),
			convergence,
			applyIdentity: projected.applyContext?.identity ?? null,
		});
		expect(existsSync(sessionDir)).toBe(true);
		expect(readFileSync(legacySentinel, "utf-8")).toBe("preserved\n");
		expect(readHermesConfigYaml(home)).toHaveProperty(
			"platforms.whatsapp.extra.session_path",
			sessionDir,
		);
		const initialHermesRevision = systemdEnvRevision(readSystemdEnvFile(paths, "hermes-gateway"));
		const initialOpenClawRevision = systemdEnvRevision(
			readSystemdEnvFile(paths, "openclaw-gateway"),
		);
		const hermesDropIn = join(
			paths.systemdUserRoot,
			"hermes-gateway.service.d",
			"10-clawdi-hosted.conf",
		);
		const initialHermesDropInInode = statSync(hermesDropIn).ino;
		const initialUnits = readSystemdUnitSnapshot(paths);
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
			applySystemdRuntimeUpdate(paths, initialUnits, readSystemdUnitSnapshot(paths), {
				transaction: new SystemdRuntimeTransaction(),
				stage: "final-activation",
			}),
		).toEqual({ applied: true, systemUnitsChanged: [], userUnitsChanged: [] });
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "hermes-gateway"))).toBe(
			initialHermesRevision,
		);
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "openclaw-gateway"))).toBe(
			initialOpenClawRevision,
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
		const preserveActiveUnits = runtimeOnlyChangesCliPackage(projected, changedCheckpoint);
		expect(preserveActiveUnits).toBe(false);
		const changedCredential = convergeRuntimeManifest(changedCheckpoint, paths);
		expect(changedCredential.installErrors).toEqual([]);
		commitRuntimeAppliedState({
			load: changedCheckpoint,
			paths,
			etag: '"hermes-whatsapp-rotated"',
			sourceRevision: "b".repeat(64),
			convergence: changedCredential,
			applyIdentity: changedCheckpoint.applyContext?.identity ?? null,
		});
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "hermes-gateway"))).not.toBe(
			initialHermesRevision,
		);
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "openclaw-gateway"))).toBe(
			initialOpenClawRevision,
		);
		writeFileSync(systemctlLog, "");
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		expect(
			applySystemdRuntimeUpdate(paths, beforeCredentialChange, readSystemdUnitSnapshot(paths), {
				transaction: new SystemdRuntimeTransaction(),
				stage: "final-activation",
				preserveActiveUnits,
			}),
		).toEqual({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: ["hermes-gateway.service"],
		});
		const systemctlCalls = readFileSync(systemctlLog, "utf-8");
		expect(systemctlCalls).toContain("--user restart hermes-gateway.service");
		expect(systemctlCalls).not.toContain("restart openclaw-gateway.service");

		const removed = applyRuntimeBundleChannelsToManifestLoad(
			{ ...load, channelBindings: [], secretValues: {} },
			paths,
		);
		const committedReceipt = readFileSync(hermesWhatsAppReceipt, "utf8");
		writeFileSync(
			hermesWhatsAppReceipt,
			`${JSON.stringify({
				...(JSON.parse(committedReceipt) as Record<string, unknown>),
				authDir: join(home, ".hermes", "user-session"),
			})}\n`,
		);
		expect(() => convergeRuntimeManifest(removed, paths)).toThrow(
			"managed Hermes WhatsApp receipt auth directory must be",
		);
		writeFileSync(hermesWhatsAppReceipt, committedReceipt);

		const sessionMarker = join(sessionDir, ".clawdi-managed-whatsapp-auth.json");
		const committedMarker = readFileSync(sessionMarker, "utf8");
		writeFileSync(sessionMarker, "{\"schemaVersion\":\"invalid\"}\n");
		const invalidMarkerRemoval = convergeRuntimeManifest(removed, paths);
		expect(invalidMarkerRemoval.installErrors.join("\n")).toContain(
			"managed Hermes WhatsApp session marker is missing or invalid",
		);
		expect(existsSync(sessionDir)).toBe(true);
		expect(readFileSync(hermesWhatsAppReceipt, "utf8")).toBe(committedReceipt);
		writeFileSync(sessionMarker, committedMarker);

		// Simulate a pre-receipt CLI after Hermes normalized its own config.
		rmSync(hermesWhatsAppReceipt);
		const hermesConfigPath = join(home, ".hermes", "config.yaml");
		const hermesConfigBeforeNormalization = readFileSync(hermesConfigPath, "utf8");
		const hermesConfigAfterNormalization = hermesConfigBeforeNormalization
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("session_path:"))
			.join("\n");
		expect(hermesConfigAfterNormalization).not.toBe(hermesConfigBeforeNormalization);
		writeFileSync(hermesConfigPath, hermesConfigAfterNormalization);
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
			"native-whatsapp-baileys-invalid-capability",
		);

		writeFileSync(baileysSocket, patchedSocket);
		const removedConvergence = convergeRuntimeManifest(removed, paths);
		expect(removedConvergence.installErrors).toEqual([]);
		expect(existsSync(paths.egressProfileBundle)).toBe(false);
		expect(existsSync(sessionDir)).toBe(false);
		expect(existsSync(hermesWhatsAppReceipt)).toBe(false);
		const removedHermesConfig = readHermesConfigYaml(home);
		expect(removedHermesConfig).toHaveProperty("whatsapp", {
			user_owned: "keep-whatsapp",
			enabled: false,
		});
		expect(removedHermesConfig).toHaveProperty("platforms.whatsapp", {
			custom: "keep-platform",
			enabled: false,
			extra: { custom_extra: "keep-extra" },
		});
		expect(removedHermesConfig).toMatchObject({
			custom_root: "keep",
			platforms: { matrix: { custom: "keep-matrix" } },
		});
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_MODE).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ALLOWED_USERS).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ALLOW_ALL_USERS).toBeUndefined();
		const removedHermesRevision = systemdEnvRevision(readSystemdEnvFile(paths, "hermes-gateway"));

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
		expect(convergeRuntimeManifest(removed, paths).installErrors).toEqual([]);
		expect(readHermesConfigYaml(home)).toMatchObject({
			whatsapp: { enabled: true, user_owned: "manual" },
			platforms: { whatsapp: { enabled: true, extra: { session_path: "/user/session" } } },
		});
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "hermes-gateway"))).toBe(
			removedHermesRevision,
		);
	});

	it("isolates OpenClaw WhatsApp DMs and clears stale managed config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-channel-delete-patch.jsonl");
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
  printf 'openclaw 2026.7.1\\n'
  exit 0
fi
if [ "\${1:-}" = "plugins" ] && [ "\${2:-}" = "install" ]; then
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
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_channel_delete",
				environmentId: "env_channel_delete",
				instanceId: "iid_channel_delete",
				generation: 8,
				issuedAt: "2026-06-06T00:00:00Z",
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
					hermes: { enabled: false },
				},
				projection: {
					system: { home, workspace },
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
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://channel-delete",
			offline: false,
			secretValues: {},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
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
		expect(removedConvergence.installErrors).toEqual([]);
		const patches = readFileSync(openclawPatch, "utf-8")
			.split("\n---\n")
			.filter((entry) => entry.trim().length > 0)
			.map((entry) => JSON.parse(entry));
		expect(patches).toHaveLength(2);
		expect(patches[0].channels.whatsapp.accounts).toHaveProperty("clawdi_whatsapp");
		expect(patches[0].channels.whatsapp.accounts.clawdi_whatsapp.authDir).toBe(
			join(home, ".openclaw", "credentials", "whatsapp"),
		);
		expect(patches[0].session).toEqual({ dmScope: "per-account-channel-peer" });
		expect(patches[1].channels.whatsapp).toBeNull();
		expect(patches[1].session).toEqual({ dmScope: null });
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
if [ "\${1:-}" = "plugins" ] && [ "\${2:-}" = "install" ]; then
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
			paths.managedConfig,
			paths.syncState,
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
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_channel_plugin_failure",
				environmentId: "env_channel_plugin_failure",
				instanceId: "iid_channel_plugin_failure",
				generation: 2,
				issuedAt: "2026-07-13T00:00:00Z",
				workspaceRoot: workspace,
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
						discord: {
							enabled: true,
							accounts: { default: { enabled: true } },
						},
					},
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://channel-plugin-install-failure",
			offline: false,
			secretValues: {},
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
		const workspace = join(home, "clawdi");
		const accountKey = "clawdi_whatsapp_runtime";
		const accountId = "00000000-0000-0000-0000-000000000001";
		const authDir = join(home, ".openclaw", "credentials", "whatsapp", accountKey);
		mkdirSync(workspace, { recursive: true });
		const managedMetadata = {
			schemaVersion: "clawdi.managedWhatsAppSocket.v1",
			capability: `clawdi_${"a".repeat(32)}`,
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
								authDir,
								files: [{ path: "creds.json", secretRef }],
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
			additionalData: { "clawdi.managedWhatsAppSocket": managedMetadata },
		};
		const rotatedCreds = {
			advSecretKey: "wa-rotated-secret",
			me: { id: "15557654321:1@s.whatsapp.net" },
			noiseKey: { private: { type: "Buffer", data: "BAUG" } },
			additionalData: { "clawdi.managedWhatsAppSocket": managedMetadata },
		};

		const initial = manifestWithCredential("credential-whatsapp-1", initialCreds, 10);
		materializeHostedChannelCredentials(initial.manifest, initial.secretValues, home);
		expect(readFileSync(join(authDir, "creds.json"), "utf8")).toContain("wa-materialized-secret");

		const rotated = manifestWithCredential("credential-whatsapp-2", rotatedCreds, 11);
		materializeHostedChannelCredentials(rotated.manifest, rotated.secretValues, home);
		const rotatedFile = readFileSync(join(authDir, "creds.json"), "utf8");
		expect(rotatedFile).toContain("wa-rotated-secret");
		expect(rotatedFile).not.toContain("wa-materialized-secret");
		expect(readFileSync(join(authDir, ".clawdi-managed-whatsapp-auth.json"), "utf8")).toContain(
			"credential-whatsapp-2",
		);

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
			join(authDir, ".clawdi-managed-whatsapp-auth.json"),
			`${JSON.stringify({
				schemaVersion: "clawdi.managedWhatsAppAuth.v1",
				provider: "whatsapp",
				accountKey,
				credentialId: "credential-stale",
			})}\n`,
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
if [ "\${1:-}" = "plugins" ] && [ "\${2:-}" = "install" ]; then
  printf '%s\\n' "\${3:-}" >> '${openclawPluginInstalls}'
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
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_whatsapp_missing_secret",
				environmentId: "env_whatsapp_missing_secret",
				instanceId: "iid_whatsapp_missing_secret",
				generation: 9,
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
							accountKey,
							credentialId: "credential-missing",
							authDir,
							files: [{ path: "creds.json", secretRef: missingSecretRef }],
						},
					],
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://whatsapp-missing-secret",
			offline: false,
			secretValues: {},
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
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >> '${openclawPatch}'
  printf '\\n---\\n' >> '${openclawPatch}'
  exit 0
fi
if [ "\${1:-}" = "plugins" ] && [ "\${2:-}" = "install" ]; then
  printf '%s\\n' "\${3:-}" >> '${openclawPluginInstalls}'
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
		): RuntimeManifestLoad => ({
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_channel_remove",
				environmentId: "env_channel_remove",
				instanceId: "iid_channel_remove",
				generation,
				issuedAt: "2026-06-06T00:00:00Z",
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
					hermes: { enabled: false },
				},
				projection: {
					system: { home, workspace },
					channels,
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: `test://channel-remove-${generation}`,
			offline: false,
			secretValues: {},
		});
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
			.map((entry) => JSON.parse(entry));
		expect(patches).toHaveLength(3);
		expect(patches[0].channels.discord).toEqual({ enabled: true, token: "discord-token" });
		expect(patches[0].session).toEqual({ dmScope: "per-account-channel-peer" });
		expect(patches[1].channels.discord).toBeNull();
		expect(patches[1].plugins.entries.discord).toBeNull();
		expect(patches[1].channels.telegram).toEqual(telegramChannel);
		expect(patches[2].session).toEqual({ dmScope: null });
		expect(patches[2].channels.telegram).toBeNull();
		expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe("@openclaw/discord\n");
	});

	it("treats already-installed OpenClaw channel plugins as converged", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
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
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat > '${openclawPatch}'
  exit 0
fi
if [ "\${1:-}" = "plugins" ] && [ "\${2:-}" = "install" ]; then
  printf '%s\\n' "\${3:-}" >> '${openclawPluginInstalls}'
  printf 'plugin already exists: %s\\n' "$HOME/.openclaw/npm/projects/openclaw-discord/node_modules/\${3:-}" >&2
  printf 'Use openclaw plugins update to upgrade the tracked plugin.\\n' >&2
  exit 1
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

		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_installed_plugin",
				environmentId: "env_installed_plugin",
				instanceId: "iid_installed_plugin",
				generation: 2,
				issuedAt: "2026-06-11T00:00:00Z",
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
					hermes: { enabled: false },
				},
				projection: {
					system: { home, workspace },
					channels: {
						discord: {
							token: "secret://channels/discord/acct-discord-1",
						},
					},
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://already-installed-plugin",
			offline: false,
			secretValues: {},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe("@openclaw/discord\n");
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
								packageSpec: "clawdi@1.2.3-test",
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
						packageSpec: "clawdi@1.2.3-test",
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

	it.each([
		"liveSync",
		"recovery",
	] as const)("rejects hosted manifests without required %s state", async (field) => {
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
	});

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
						packageSpec: "clawdi@1.2.3-test",
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
		expect(hermesRunConfig.defaultArgs).toEqual(["gateway", "run", "--replace"]);
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
			command: string,
			install: RuntimeManifest["runtimes"][string]["install"],
		): RuntimeManifestLoad => ({
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_cold_mcp",
				environmentId: "env_cold_mcp",
				instanceId: "iid_cold_mcp",
				generation,
				issuedAt: "2026-07-29T00:00:00Z",
				workspaceRoot: workspace,
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: { openclaw: { enabled: true, install } },
				projection: {
					system: { home, workspace },
					mcp: { servers: { clawdi: { command, args: ["mcp"] } } },
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: `test://cold-mcp-${generation}`,
			offline: false,
			secretValues: {},
		});
		const officialInstall = {
			authority: "official" as const,
			method: "official-installer" as const,
			url: "https://openclaw.ai/install-cli.sh",
			home,
			args: officialInstallArgs("openclaw", home),
		};

		const installed = convergeRuntimeManifest(
			load(1, "clawdi", officialInstall),
			getRuntimePaths(),
		);

		expect(installed.installErrors).toEqual([]);
		expect(readFileSync(installerLog, "utf-8")).toBe("installed\n");
		expect(readOpenClawMcpServers(home).clawdi).toEqual({
			command: "clawdi",
			args: ["mcp"],
		});

		rmSync(commandPath);
		const unavailable = convergeRuntimeManifest(load(2, "missing", undefined), getRuntimePaths());

		expect(unavailable.installErrors.join("\n")).toContain(
			"could not mutate managed OpenClaw MCP servers: runtime is unavailable",
		);
		expect(readOpenClawMcpServers(home).clawdi).toEqual({
			command: "clawdi",
			args: ["mcp"],
		});
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
		const ledgerPath = join(paths.managedResourceRoot, "managed-mcp-servers.json");
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
		writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(hermesBin, 0o700);
		mkdirSync(join(home, ".hermes"), { recursive: true });
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			"mcp_servers:\n  user-entry:\n    command: user-owned\n    args:\n      - keep\n",
		);
		process.env.CLAWDI_AUTH_TOKEN = "deploy-key-secret";

		const load = (
			generation: number,
			selectedRuntime: "openclaw" | "hermes",
			servers: Record<string, { command: string; args: string[] }>,
			skillEnabled = true,
		): RuntimeManifestLoad => ({
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_generic_mcp",
				environmentId: "env_generic_mcp",
				instanceId: "iid_generic_mcp",
				generation,
				issuedAt: "2026-07-28T00:00:00Z",
				workspaceRoot: workspace,
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: {
						enabled: selectedRuntime === "openclaw",
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: [],
						},
					},
					hermes: {
						enabled: selectedRuntime === "hermes",
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://hermes-agent.nousresearch.com/install.sh",
							home,
							args: [],
						},
					},
				},
				projection: {
					system: { home, workspace },
					mcp: { servers },
					skills: { entries: { clawdi: { enabled: skillEnabled, version: 1 } } },
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: `test://generic-mcp-${generation}`,
			offline: false,
			secretValues: {},
		});
		const initialServers = {
			clawdi: { command: "clawdi", args: ["mcp"] },
			"search-proxy": { command: "searchctl", args: ["serve", "v1"] },
		};
		const updatedServers = {
			...initialServers,
			"search-proxy": { command: "searchctl", args: ["serve", "v2"] },
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

		expect(() =>
			convergeRuntimeManifest(
				loadWithSkillEntry("unknown", { enabled: true, version: 1 }),
				getRuntimePaths(),
			),
		).toThrow("no bundled hosted skill is registered for unknown");
		expect(() =>
			convergeRuntimeManifest(
				loadWithSkillEntry("clawdi", { enabled: true, version: 2 }),
				getRuntimePaths(),
			),
		).toThrow("no bundled hosted skill clawdi version 2 is registered");
		expect(existsSync(ledgerPath)).toBe(false);

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
		expect(() =>
			convergeRuntimeManifest(load(1, "openclaw", initialServers), getRuntimePaths()),
		).toThrow(`refusing to replace unmanaged clawdi skill at ${openclawSkill}`);
		expect(readFileSync(join(openclawSkill, "SKILL.md"), "utf-8")).toBe("local setup skill\n");
		expect(existsSync(ledgerPath)).toBe(false);
		releaseManagedSkill({
			targetDir: openclawSkill,
			id: "clawdi",
			manager: "local-setup",
			removeTarget: () => rmSync(openclawSkill, { recursive: true, force: true }),
		});

		const initial = convergeRuntimeManifest(load(1, "openclaw", initialServers), getRuntimePaths());
		expect(initial.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home).clawdi).toEqual(initialServers.clawdi);
		expect(readOpenClawMcpServers(home)["search-proxy"]).toEqual(initialServers["search-proxy"]);
		expect(readOpenClawMcpServers(home)["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(JSON.parse(readFileSync(ledgerPath, "utf-8"))).toEqual({
			schemaVersion: "clawdi.hostedManagedMcpServers.v2",
			runtimes: { openclaw: ["clawdi", "search-proxy"] },
		});
		expect(
			existsSync(join(dirname(openclawSkill), ".clawdi-manifest-receipts", "clawdi.json")),
		).toBe(true);

		writeFileSync(join(openclawSkill, "SKILL.md"), "tenant mutation before restart\n");
		rmSync(paths.configurationRoot, { recursive: true, force: true });
		const restarted = convergeRuntimeManifest(load(1, "openclaw", initialServers), paths);
		expect(restarted.installErrors).toEqual([]);
		expect(readFileSync(join(openclawSkill, "SKILL.md"), "utf-8")).not.toContain("tenant mutation");
		expect(readOpenClawMcpServers(home).clawdi).toEqual(initialServers.clawdi);
		expect(existsSync(ledgerPath)).toBe(true);

		const updated = convergeRuntimeManifest(load(2, "openclaw", updatedServers), getRuntimePaths());
		expect(updated.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home)["search-proxy"]).toEqual(updatedServers["search-proxy"]);
		const updatedConfig = readFileSync(openclawConfigPath, "utf-8");
		const updatedLedger = readFileSync(ledgerPath, "utf-8");
		const callsBeforeIdempotent = readFileSync(openclawCalls, "utf-8");
		const idempotent = convergeRuntimeManifest(
			load(2, "openclaw", updatedServers),
			getRuntimePaths(),
		);
		expect(idempotent.installErrors).toEqual([]);
		expect(readFileSync(openclawConfigPath, "utf-8")).toBe(updatedConfig);
		expect(readFileSync(ledgerPath, "utf-8")).toBe(updatedLedger);
		expect(readFileSync(openclawCalls, "utf-8")).toBe(callsBeforeIdempotent);

		const switched = convergeRuntimeManifest(load(3, "hermes", updatedServers), getRuntimePaths());
		expect(switched.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home).clawdi).toBeUndefined();
		expect(readOpenClawMcpServers(home)["search-proxy"]).toBeUndefined();
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
		expect(hermesAfterSwitch.clawdi).toEqual(initialServers.clawdi);
		expect(hermesAfterSwitch["search-proxy"]).toEqual(updatedServers["search-proxy"]);
		expect(JSON.parse(readFileSync(ledgerPath, "utf-8")).runtimes).toEqual({
			hermes: ["clawdi", "search-proxy"],
		});
		const hermesSkill = join(home, ".hermes", "skills", "clawdi");
		expect(existsSync(join(hermesSkill, ".clawdi-managed.json"))).toBe(true);
		process.env.CLAWDI_RUNTIME_MODE = "local";
		expect(() =>
			convergeRuntimeManifest(load(4, "hermes", updatedServers, true), getRuntimePaths()),
		).toThrow("hosted convergence requires CLAWDI_RUNTIME_MODE=hosted explicitly");
		expect(existsSync(hermesSkill)).toBe(true);
		expect(readFileSync(openclawUserSkill, "utf-8")).toBe("user-owned skill\n");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";

		const removedGeneric = convergeRuntimeManifest(
			load(5, "hermes", { clawdi: initialServers.clawdi }, false),
			getRuntimePaths(),
		);
		expect(removedGeneric.installErrors).toEqual([]);
		const hermesAfterRemoval = expectRecord(
			readHermesConfigYaml(home).mcp_servers,
			"Hermes MCP servers",
		);
		expect(hermesAfterRemoval["search-proxy"]).toBeUndefined();
		expect(hermesAfterRemoval.clawdi).toEqual(initialServers.clawdi);
		expect(hermesAfterRemoval["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(JSON.parse(readFileSync(ledgerPath, "utf-8")).runtimes).toEqual({
			hermes: ["clawdi"],
		});
		expect(existsSync(hermesSkill)).toBe(false);
		mkdirSync(hermesSkill, { recursive: true });
		writeFileSync(join(hermesSkill, "SKILL.md"), "user-owned canonical skill\n");

		const disabled = convergeRuntimeManifest(load(6, "hermes", {}, false), getRuntimePaths());
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
		expect(JSON.parse(readFileSync(ledgerPath, "utf-8")).runtimes).toEqual({});
		expect(readFileSync(join(hermesSkill, "SKILL.md"), "utf-8")).toBe(
			"user-owned canonical skill\n",
		);
		expect(readFileSync(openclawCalls, "utf-8")).toContain("unset search-proxy");
	});

	it("migrates retained v1 MCP ownership without copying legacy config values", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const legacyLedgerPath = join(paths.projectionRoot, "managed-mcp-servers.json");
		const ledgerPath = join(paths.managedResourceRoot, "managed-mcp-servers.json");
		const hermesConfigPath = join(home, ".hermes", "config.yaml");
		const legacySecretRef = "env://REDACTED_LEGACY_NAME";
		const legacyPrefix = "Bearer ";
		const legacyServer = {
			url: "https://legacy.example.test/mcp",
			transport: "streamable-http",
			headers: {
				Authorization: { secretRef: legacySecretRef, prefix: legacyPrefix },
			},
		};
		const retainedV1Ledger = {
			schemaVersion: "clawdi.hostedManagedMcpServers.v1",
			runtimes: { hermes: { clawdi: legacyServer } },
		};
		writeHermesVersionBinary(home, "0.18.0");
		mkdirSync(dirname(hermesConfigPath), { recursive: true });
		writeFileSync(
			hermesConfigPath,
			`${JSON.stringify({ mcp_servers: { clawdi: legacyServer } }, null, 2)}\n`,
		);
		mkdirSync(dirname(legacyLedgerPath), { recursive: true });
		writeFileSync(legacyLedgerPath, `${JSON.stringify(retainedV1Ledger, null, 2)}\n`);
		expect(legacyPrefix).toHaveLength(7);
		const load = (generation: number, includeServer: boolean): RuntimeManifestLoad => ({
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_mcp_ledger_migration",
				environmentId: "env_mcp_ledger_migration",
				instanceId: "iid_mcp_ledger_migration",
				generation,
				issuedAt: "2026-07-31T00:00:00Z",
				workspaceRoot: workspace,
				controlPlane: { apiUrl: "https://cloud-api.test" },
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
					},
				},
				projection: {
					system: { home, workspace },
					mcp: {
						servers: includeServer
							? {
									clawdi: {
										url: "https://current.example.test/mcp",
										transport: "sse",
										headers: { "X-Manifest": "current-only" },
									},
								}
							: {},
					},
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: `test://mcp-ledger-migration-${generation}`,
			offline: false,
			secretValues: {},
		});

		const migrated = convergeRuntimeManifest(load(1, true), getRuntimePaths());
		expect(migrated.installErrors).toEqual([]);
		expect(readHermesConfigYaml(home).mcp_servers).toEqual({
			clawdi: {
				url: "https://current.example.test/mcp",
				transport: "sse",
				headers: { "X-Manifest": "current-only" },
			},
		});
		const migratedLedgerPayload = JSON.parse(readFileSync(ledgerPath, "utf-8"));
		expect(migratedLedgerPayload).toEqual({
			schemaVersion: "clawdi.hostedManagedMcpServers.v2",
			runtimes: { hermes: ["clawdi"] },
		});
		const migratedNative = readFileSync(hermesConfigPath, "utf-8");
		const migratedLedger = readFileSync(ledgerPath, "utf-8");
		for (const legacyValue of [
			legacyServer.url,
			legacyServer.transport,
			legacySecretRef,
			legacyPrefix,
		]) {
			expect(migratedNative).not.toContain(legacyValue);
			expect(migratedLedger).not.toContain(legacyValue);
		}
		expect(migratedLedger).not.toContain("env://");
		expect(JSON.stringify(migratedLedgerPayload)).not.toContain(JSON.stringify(legacyServer));

		const roundTripped = convergeRuntimeManifest(load(2, true), getRuntimePaths());
		expect(roundTripped.installErrors).toEqual([]);
		expect(readFileSync(hermesConfigPath, "utf-8")).toBe(migratedNative);
		expect(readFileSync(ledgerPath, "utf-8")).toBe(migratedLedger);

		const removed = convergeRuntimeManifest(load(3, false), getRuntimePaths());
		expect(removed.installErrors).toEqual([]);
		expect(readHermesConfigYaml(home).mcp_servers).toEqual({});
		expect(JSON.parse(readFileSync(ledgerPath, "utf-8"))).toEqual({
			schemaVersion: "clawdi.hostedManagedMcpServers.v2",
			runtimes: {},
		});
	});

	it.each([
		[
			"unsupported schema",
			{ schemaVersion: "clawdi.hostedManagedMcpServers.v3", runtimes: {} },
			"unsupported schema",
		],
		[
			"unsupported runtime",
			{ schemaVersion: "clawdi.hostedManagedMcpServers.v2", runtimes: { codex: ["clawdi"] } },
			"invalid runtimes",
		],
		[
			"invalid v1 server name",
			{
				schemaVersion: "clawdi.hostedManagedMcpServers.v1",
				runtimes: {
					hermes: {
						"Invalid Name": {
							url: "https://legacy.example.test/mcp",
							transport: "streamable-http",
							headers: {
								Authorization: {
									secretRef: "env://REDACTED_LEGACY_NAME",
									prefix: "Bearer ",
								},
							},
						},
					},
				},
			},
			"invalid hermes server name",
		],
		[
			"invalid v2 server name",
			{
				schemaVersion: "clawdi.hostedManagedMcpServers.v2",
				runtimes: { hermes: ["Invalid Name"] },
			},
			"invalid hermes server name",
		],
	] as const)("rejects an MCP ownership ledger with %s", (_case, ledger, expectedError) => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const ledgerPath = join(getRuntimePaths().managedResourceRoot, "managed-mcp-servers.json");
		const originalLedger = `${JSON.stringify(ledger, null, 2)}\n`;
		mkdirSync(dirname(ledgerPath), { recursive: true });
		writeFileSync(ledgerPath, originalLedger);
		expect(() =>
			convergeRuntimeManifest(
				{
					manifest: {
						schemaVersion: "clawdi.runtimeDesiredState.v1",
						deploymentId: "dep_invalid_mcp_ledger",
						environmentId: "env_invalid_mcp_ledger",
						instanceId: "iid_invalid_mcp_ledger",
						generation: 1,
						issuedAt: "2026-07-31T00:00:00Z",
						workspaceRoot: workspace,
						controlPlane: { apiUrl: "https://cloud-api.test" },
						runtimes: {},
						projection: { system: { home, workspace }, mcp: { servers: {} } },
						recovery: {},
					},
					source: "remote-datasource",
					sourcePath: "test://invalid-mcp-ledger",
					offline: false,
					secretValues: {},
				},
				getRuntimePaths(),
			),
		).toThrow(expectedError);
		expect(readFileSync(ledgerPath, "utf-8")).toBe(originalLedger);
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
		const ledgerPath = join(getRuntimePaths().managedResourceRoot, "managed-mcp-servers.json");
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
		process.env.CLAWDI_AUTH_TOKEN = "deploy-key-secret";

		const load = (
			generation: number,
			servers: Record<string, { command: string; args: string[] }>,
		): RuntimeManifestLoad => ({
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_mcp_ownership",
				environmentId: "env_mcp_ownership",
				instanceId: "iid_mcp_ownership",
				generation,
				issuedAt: "2026-07-28T00:00:00Z",
				workspaceRoot: workspace,
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
				projection: { system: { home, workspace }, mcp: { servers } },
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: `test://mcp-ownership-${generation}`,
			offline: false,
			secretValues: {},
		});

		const beforeCollision = readFileSync(openclawConfigPath, "utf-8");
		expect(() =>
			convergeRuntimeManifest(
				load(1, { "user-owned": { command: "platform-command", args: [] } }),
				getRuntimePaths(),
			),
		).toThrow(/refusing to replace unmanaged openclaw MCP server user-owned/);
		expect(readFileSync(openclawConfigPath, "utf-8")).toBe(beforeCollision);
		expect(existsSync(ledgerPath)).toBe(false);
		expect(existsSync(calls)).toBe(false);

		writeFileSync(failSet, "fail\n");
		const failedSet = convergeRuntimeManifest(
			load(2, { "failed-new": { command: "platform-command", args: [] } }),
			getRuntimePaths(),
		);
		expect(failedSet.installErrors.join("\n")).toContain("runtime MCP projection failed");
		expect(existsSync(ledgerPath)).toBe(false);
		expect(readFileSync(openclawConfigPath, "utf-8")).toBe(beforeCollision);
		rmSync(failSet);

		const omittedAfterFailure = convergeRuntimeManifest(load(3, {}), getRuntimePaths());
		expect(omittedAfterFailure.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home)["user-owned"]).toEqual({
			command: "user",
			args: ["keep"],
		});
		expect(readFileSync(calls, "utf-8")).not.toContain("unset failed-new");

		const managed = convergeRuntimeManifest(
			load(4, { "owned-server": { command: "owned", args: ["serve"] } }),
			getRuntimePaths(),
		);
		expect(managed.installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(ledgerPath, "utf-8")).runtimes).toEqual({
			openclaw: ["owned-server"],
		});
		expect(readOpenClawMcpServers(home)["owned-server"]).toEqual({
			command: "owned",
			args: ["serve"],
		});
		writeFileSync(failUnset, "fail\n");
		const failedRemoval = convergeRuntimeManifest(load(5, {}), getRuntimePaths());
		expect(failedRemoval.installErrors.join("\n")).toContain("runtime MCP projection failed");
		expect(JSON.parse(readFileSync(ledgerPath, "utf-8")).runtimes).toEqual({
			openclaw: ["owned-server"],
		});
		expect(readOpenClawMcpServers(home)["owned-server"]).toEqual({
			command: "owned",
			args: ["serve"],
		});

		const driftedConfig = expectRecord(
			JSON.parse(readFileSync(openclawConfigPath, "utf-8")),
			"drifted OpenClaw config",
		);
		const driftedMcp = expectRecord(driftedConfig.mcp, "drifted OpenClaw MCP config");
		const driftedServers = expectRecord(driftedMcp.servers, "drifted OpenClaw MCP servers");
		delete driftedServers["owned-server"];
		writeFileSync(openclawConfigPath, `${JSON.stringify(driftedConfig, null, 2)}\n`);
		const callsBeforeDriftReconcile = readFileSync(calls, "utf-8");
		const retriedRemoval = convergeRuntimeManifest(load(6, {}), getRuntimePaths());
		expect(retriedRemoval.installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(ledgerPath, "utf-8")).runtimes).toEqual({});
		expect(readOpenClawMcpServers(home)["owned-server"]).toBeUndefined();
		expect(readOpenClawMcpServers(home)["user-owned"]).toEqual({
			command: "user",
			args: ["keep"],
		});
		expect(readFileSync(calls, "utf-8")).toBe(callsBeforeDriftReconcile);
		rmSync(failUnset);
	});

	it("restores live MCP config after a partial native projection", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const calls = join(root, "partial-mcp-calls.log");
		const { configPath: openclawConfig } = writeFakeOpenClawMcpBinary(home, {
			callsPath: calls,
			failSetServer: "second",
		});
		const ledgerPath = join(getRuntimePaths().managedResourceRoot, "managed-mcp-servers.json");
		const originalConfig = `${JSON.stringify(
			{
				custom: "keep",
				mcp: { servers: { "user-entry": { command: "user-owned", args: ["keep"] } } },
			},
			null,
			2,
		)}\n`;
		writeFileSync(openclawConfig, originalConfig);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const failed = convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_partial_mcp",
					environmentId: "env_partial_mcp",
					instanceId: "iid_partial_mcp",
					generation: 1,
					issuedAt: "2026-07-28T00:00:00Z",
					workspaceRoot: workspace,
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
						mcp: {
							servers: {
								first: { command: "first", args: [] },
								second: { command: "second", args: [] },
							},
						},
					},
					recovery: {},
				},
				source: "remote-datasource",
				sourcePath: "test://partial-mcp",
				offline: false,
				secretValues: {},
			},
			getRuntimePaths(),
		);

		expect(failed.installErrors.join("\n")).toContain("runtime MCP projection failed");
		expect(readFileSync(calls, "utf-8")).toBe("set first\nset second\n");
		expect(readOpenClawMcpServers(home)).toEqual({
			"user-entry": { command: "user-owned", args: ["keep"] },
		});
		expect(existsSync(ledgerPath)).toBe(false);
	});

	it("restores prior MCP authority when a forward projection is partial", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const calls = join(root, "existing-managed-mcp-calls.log");
		const { configPath: openclawConfig } = writeFakeOpenClawMcpBinary(home, {
			callsPath: calls,
			failSetServer: "second",
		});
		const hermesBin = join(home, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesBin), { recursive: true });
		writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(hermesBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const ledgerPath = join(getRuntimePaths().managedResourceRoot, "managed-mcp-servers.json");
		const hermesConfig = join(home, ".hermes", "config.yaml");

		const load = (
			generation: number,
			servers: Record<string, { command: string; args: string[] }>,
		): RuntimeManifestLoad => ({
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_existing_managed_mcp",
				environmentId: "env_existing_managed_mcp",
				instanceId: "iid_existing_managed_mcp",
				generation,
				issuedAt: "2026-07-28T00:00:00Z",
				workspaceRoot: workspace,
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
					hermes: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://hermes-agent.nousresearch.com/install.sh",
							home,
							args: [],
						},
					},
				},
				projection: { system: { home, workspace }, mcp: { servers } },
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: `test://existing-managed-mcp-${generation}`,
			offline: false,
			secretValues: {},
		});

		const initial = convergeRuntimeManifest(
			load(1, { owned: { command: "owned", args: ["v1"] } }),
			getRuntimePaths(),
		);
		expect(initial.installErrors).toEqual([]);
		const previousLedger = readFileSync(ledgerPath);
		const previousOpenClawStat = statSync(openclawConfig);
		const previousHermesStat = statSync(hermesConfig);

		const failed = convergeRuntimeManifest(
			load(2, {
				owned: { command: "owned", args: ["v2"] },
				second: { command: "second", args: [] },
			}),
			getRuntimePaths(),
		);

		expect(failed.installErrors.join("\n")).toContain("runtime MCP projection failed");
		expect(readFileSync(calls, "utf-8")).toContain("set owned\nset owned\nset second\n");
		expect(readOpenClawMcpServers(home)).toEqual({
			owned: { command: "owned", args: ["v1"] },
		});
		expect(readHermesConfigYaml(home).mcp_servers).toEqual({
			owned: { command: "owned", args: ["v1"] },
		});
		expect(readFileSync(ledgerPath)).toEqual(previousLedger);
		expect(statSync(openclawConfig).mode).toBe(previousOpenClawStat.mode);
		expect(statSync(openclawConfig).uid).toBe(previousOpenClawStat.uid);
		expect(statSync(openclawConfig).gid).toBe(previousOpenClawStat.gid);
		expect(statSync(hermesConfig).mode).toBe(previousHermesStat.mode);
		expect(statSync(hermesConfig).uid).toBe(previousHermesStat.uid);
		expect(statSync(hermesConfig).gid).toBe(previousHermesStat.gid);
	});

	it("does not add the hosted runtime sidecar without egress profiles", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const convergence = convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_runtime_no_egress",
					environmentId: "env_runtime_no_egress",
					instanceId: "iid_runtime_no_egress",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: {
							enabled: true,
							provider_ids: ["default"],
							primary_model: { provider_id: "default", model: "gpt-5.5" },
						},
						hermes: { enabled: false },
					},
					recovery: {},
				},
				source: "remote-datasource",
				sourcePath: "test://runtime-no-egress",
				offline: false,
				secretValues: {},
			},
			getRuntimePaths(),
		);

		expect(
			convergence.outputs.systemdUserUnits.map((path) => path.split("/").at(-1)),
		).not.toContain("clawdi-runtime-sidecar.service");
		expect(
			convergence.outputs.systemdSystemUnits.map((path) => path.split("/").at(-1)),
		).not.toContain("clawdi-runtime-sidecar.service");
	});

	it("keeps provider secrets sidecar-only in the ephemeral run-dir config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const mitmproxy = seedMitmproxyCache();

		const convergence = convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_provider_secret_boundary",
					environmentId: "env_provider_secret_boundary",
					instanceId: "iid_provider_secret_boundary",
					generation: 1,
					issuedAt: "2026-06-26T00:00:00Z",
					controlPlane: { apiUrl: "https://cloud-api.test" },
					egressEngine: mitmproxy,
					runtimes: {
						openclaw: {
							enabled: true,
							provider_ids: ["default"],
							primary_model: { provider_id: "default", model: "gpt-5.5" },
						},
						hermes: { enabled: false },
					},
					projection: {
						providers: {
							default: {
								kind: "openai-compatible",
								baseUrl: "https://provider.test/v1",
								model: "gpt-5.5",
								apiMode: "openai_responses",
								managed_by: "clawdi",
								runtimeEnvName: "CLAWDI_AI_API_KEY",
								apiKeySecretRef: "secret://provider.default.apiKey",
							},
						},
					},
					egressProfiles: {
						profiles: [
							{
								id: "managed-provider",
								enabled: true,
								kind: "provider",
								match: {
									scheme: "https",
									host: "provider.test",
									headers: {},
									query: {},
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
								priority: 80,
								owner: "provider-projection",
							},
						],
					},
					recovery: {},
				},
				source: "remote-datasource",
				sourcePath: "test://provider-secret-boundary",
				offline: false,
				secretValues: {
					"secret://provider.default.apiKey": "sk-runtime",
					"secret://provider.hermes.apiKey": "sk-other-runtime",
				},
			},
			getRuntimePaths(),
		);

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
		expect(runtimeSidecarUnit).toContain("Before=user@10001.service");
		expect(runtimeSidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
		expect(transparentEgressEnv).toContain('CLAWDI_RUNTIME_USER="clawdi"');
		expect(transparentEgressEnv).toContain('CLAWDI_RUNTIME_UID="10001"');
		expect(transparentEgressEnv).toContain('CLAWDI_RUNTIME_GID="10001"');
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
		expect(openclawUnit).toContain('ExecStart="openclaw" "gateway" "run"');
		expect(openclawUnit).not.toContain("user=clawdi");
		expect(openclawUnit).not.toContain("sk-runtime");
		expect(openclawEnv).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
		expect(openclawEnv).not.toMatch(/^OPENAI_API_KEY=/m);
		expect(openclawEnv).not.toContain("sk-runtime");
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
		expect(egressSecrets["secret://provider.default.apiKey"]).toBe("sk-runtime");
		expect(JSON.stringify(egressSecrets)).not.toContain("sk-other-runtime");
	});

	it("does not put missing provider secrets into direct systemd launch env", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_provider_secret_missing",
					environmentId: "env_provider_secret_missing",
					instanceId: "iid_provider_secret_missing",
					generation: 1,
					issuedAt: "2026-06-26T00:00:00Z",
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: {
							enabled: true,
							provider_ids: ["default"],
							primary_model: { provider_id: "default", model: "gpt-5.5" },
						},
					},
					projection: {
						providers: {
							default: {
								kind: "openai-compatible",
								baseUrl: "https://provider.test/v1",
								model: "gpt-5.5",
								apiMode: "openai_responses",
								managed_by: "clawdi",
								runtimeEnvName: "CLAWDI_AI_API_KEY",
								apiKeySecretRef: "secret://provider.default.apiKey",
							},
						},
					},
					recovery: {},
				},
				source: "remote-datasource",
				sourcePath: "test://provider-secret-missing",
				offline: false,
				secretValues: {},
			},
			getRuntimePaths(),
		);
		const openclawEnv = readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway");
		expect(openclawEnv).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
		expect(openclawEnv).not.toMatch(/^OPENAI_API_KEY=/m);
		expect(openclawEnv).not.toContain("secret://provider.default.apiKey");
	});

	it("runs the egress-only sidecar with a lifecycle nft redirect", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const mitmproxy = seedMitmproxyCache();

		const load: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_transparent_egress",
				environmentId: "env_transparent_egress",
				instanceId: "iid_transparent_egress",
				generation: 1,
				issuedAt: "2026-06-26T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				egressEngine: mitmproxy,
				runtimes: {
					openclaw: { enabled: true },
					hermes: { enabled: false },
				},
				egressProfiles: {
					profiles: [
						{
							id: "deny-metadata",
							enabled: true,
							kind: "deny",
							match: {
								scheme: "https",
								host: "169.254.169.254",
								pathPrefix: "/",
							},
							priority: 1,
						},
					],
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://transparent-egress",
			offline: false,
			secretValues: {},
		};
		convergeRuntimeManifest(load, getRuntimePaths());

		const paths = getRuntimePaths();
		const sidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
		const sidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
		const initialSidecarRevision = systemdEnvRevision(sidecarEnv);
		const transparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
		const openclawUnit = readSystemdUserServiceConfig(paths, "openclaw-gateway");
		const openclawEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(sidecarUnit).toContain("Type=notify");
		expect(sidecarUnit).toContain("Before=user@10001.service");
		expect(sidecarUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "sidecar"`);
		expect(sidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
		expect(transparentEgressEnv).toContain(
			'CLAWDI_EGRESS_TRANSPORT_VERSION="clawdi-transparent-egress-v1"',
		);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_TRANSPARENT_PORT="${TRANSPARENT_EGRESS_PORT}"`,
		);
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_NFT_TABLE="clawdi_transparent_egress"');
		expect(transparentEgressEnv).toContain('CLAWDI_RUNTIME_UID="10001"');
		expect(transparentEgressEnv).toContain('CLAWDI_RUNTIME_GID="10001"');
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
		expect(sidecarUnit).toContain(
			`BindReadOnlyPaths=${cachedMitmproxyBinary(paths, mitmproxy)}:${paths.egressServiceBinary}:norbind`,
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
		expect(statSync(join(run, "egress-scratch")).mode & 0o777).toBe(0o700);
		expect(openclawUnit).toContain('ExecStart="openclaw" "gateway" "run"');
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
		expect(systemdEnvRevision(updatedSidecarEnv)).not.toBe(initialSidecarRevision);
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
			paths.managedConfig,
			paths.syncState,
			join(paths.projectionRoot, "openclaw.json"),
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

		expect(convergence.installErrors.join("\n")).toContain("runtime openclaw installer exited 42");
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
		writeFileSync(soulPath, "User preface.\n\nUser epilogue.\n");
		writeFileSync(userPath, "User profile stays untouched.\n");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const manifestFor = (language: "en" | "fr", timezone: string): RuntimeManifest => ({
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_locale_openclaw",
			environmentId: "env_locale_openclaw",
			instanceId: "iid_locale_openclaw",
			generation: language === "en" ? 1 : 2,
			issuedAt: "2026-07-11T00:00:00Z",
			locale: { language, timezone },
			workspaceRoot: workspace,
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: { command: "/bin/true", args: [], env: {}, prependPath: [] },
				},
			},
			recovery: {},
		});
		const paths = getRuntimePaths();
		const converge = (manifest: RuntimeManifest) =>
			convergeRuntimeManifest(
				{
					manifest,
					source: "remote-datasource",
					sourcePath: "test://locale-openclaw",
					offline: false,
					secretValues: {},
				},
				paths,
			);

		converge(manifestFor("en", "UTC"));
		const initialRevision = systemdEnvRevision(readSystemdEnvFile(paths, "openclaw-gateway"));
		expect(readSystemdEnvFile(paths, "openclaw-gateway")).toContain('TZ="UTC"');

		converge(manifestFor("fr", "Europe/Paris"));
		const soul = readFileSync(soulPath, "utf-8");
		expect(soul.startsWith("User preface.\n\nUser epilogue.\n")).toBe(true);
		expect(soul.match(/clawdi managed locale/g)).toHaveLength(2);
		expect(soul).toContain("`fr`");
		expect(soul).toContain("`Europe/Paris`");
		expect(readFileSync(userPath, "utf-8")).toBe("User profile stays untouched.\n");
		const updatedEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(updatedEnv).toContain('TZ="Europe/Paris"');
		expect(systemdEnvRevision(updatedEnv)).not.toBe(initialRevision);
		converge(manifestFor("fr", "Europe/Paris"));
		expect(readFileSync(soulPath, "utf-8")).toBe(soul);
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "openclaw-gateway"))).toBe(
			systemdEnvRevision(updatedEnv),
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
					run: { command: "/bin/true", args: [], env: {}, prependPath: [] },
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
		expect(readSystemdEnvFile(paths, "clawdi-hermes")).toContain('TZ="Asia/Taipei"');
	});

	it("runtime program revisions ignore unrelated control-plane and sibling runtime changes", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const baseManifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_revision",
			environmentId: "env_revision",
			instanceId: "iid_revision",
			generation: 1,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@1.2.3-test" },
			runtimes: {
				openclaw: {
					enabled: true,
					services: {
						worker: {
							command: "/bin/true",
							args: [],
							env: {},
							prependPath: [],
						},
					},
				},
				hermes: { enabled: false },
			},
			recovery: {},
		};
		const revisionFor = (manifest: RuntimeManifest, unitName: string) => {
			const paths = getRuntimePaths();
			convergeRuntimeManifest(
				{
					manifest,
					source: "remote-datasource",
					sourcePath: "test://revision",
					offline: false,
					secretValues: {},
				},
				paths,
			);
			return systemdEnvRevision(readSystemdEnvFile(paths, unitName));
		};

		const baseRev = revisionFor(baseManifest, "openclaw-gateway");
		const baseWorkerRev = revisionFor(baseManifest, "clawdi-openclaw-worker");
		const controlPlaneRev = revisionFor(
			{
				...baseManifest,
				controlPlane: { apiUrl: "https://cloud-api-next.test" },
			},
			"openclaw-gateway",
		);
		const controlPlaneWorkerRev = revisionFor(
			{
				...baseManifest,
				controlPlane: { apiUrl: "https://cloud-api-next.test" },
			},
			"clawdi-openclaw-worker",
		);
		const skillOnlyManifest: RuntimeManifest = {
			...baseManifest,
			projection: {
				skills: { entries: { clawdi: { enabled: true, version: 1 } } },
			},
		};
		const skillGatewayRev = revisionFor(skillOnlyManifest, "openclaw-gateway");
		const skillWorkerRev = revisionFor(skillOnlyManifest, "clawdi-openclaw-worker");
		const siblingRuntimeRev = revisionFor(
			{
				...baseManifest,
				runtimes: {
					...baseManifest.runtimes,
					hermes: { enabled: true },
				},
			},
			"openclaw-gateway",
		);

		expect(controlPlaneRev).toBe(baseRev);
		expect(controlPlaneWorkerRev).toBe(baseWorkerRev);
		expect(skillGatewayRev).toBe(baseRev);
		expect(skillWorkerRev).toBe(baseWorkerRev);
		expect(siblingRuntimeRev).toBe(baseRev);
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
								packageSpec: "clawdi@1.2.3-test",
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
								packageSpec: "clawdi@1.2.3-test",
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
			const providerHealth = JSON.parse(
				readFileSync(getRuntimePaths().providerHealthStatus, "utf-8"),
			);
			expect(providerHealth.providers["clawdi-managed-v2"]).toEqual({
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
								packageSpec: "clawdi@1.2.3-test",
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
			expect(daemonEnv).toContain('CLAWDI_RUNTIME_REV="');
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
						packageSpec: "clawdi@1.2.3-test",
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
						packageSpec: "clawdi@1.2.3-test",
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
