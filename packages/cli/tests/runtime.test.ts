import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
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
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runtimeAppliedContentIdentity, runtimeInit, runtimeWatch } from "../src/commands/runtime";
import {
	readRuntimeAppliedState,
	runtimeContentSha256,
	writeRuntimeAppliedState,
} from "../src/runtime/applied-state";
import { runtimeAuthEnvName } from "../src/runtime/auth-token";
import {
	RUNTIME_BRIDGE_LISTEN_HOST_ENV,
	RUNTIME_BRIDGE_SURFACES_ENV,
	RUNTIME_BRIDGE_TOKEN_ENV,
} from "../src/runtime/bridge";
import {
	applyRuntimeBundleChannelsToManifestLoad,
	applyRuntimeChannelsToManifestLoad,
} from "../src/runtime/channels";
import { applyRuntimeCliDesiredState } from "../src/runtime/cli-update";
import {
	deniedCommandReason,
	evaluateHostPolicyForCommand,
	readHostPolicy,
} from "../src/runtime/host-policy";
import {
	convergeRuntimeManifest,
	loadRuntimeManifest,
	type RuntimeConvergenceResult,
	type RuntimeManifest,
	withRuntimeConvergeLock,
} from "../src/runtime/manifest";
import {
	HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
	loadRemoteRuntimeManifest,
	normalizeManifestPayload,
	type RuntimeBundleChannelBinding,
	type RuntimeChannelsLoad,
	type RuntimeManifestLoad,
} from "../src/runtime/manifest-source";
import { readHostedRuntimeObserved } from "../src/runtime/observed";
import { detectRuntimeMode, getRuntimePaths, type RuntimePaths } from "../src/runtime/paths";
import { buildRuntimeRunConfig } from "../src/runtime/run-config";
import {
	buildRuntimeBootStatus,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../src/runtime/state";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "../src/runtime/systemd-user";
import { mockFetch } from "./commands/helpers";

const ENV_KEYS = [
	"HOME",
	"CLAWDI_HOME",
	"CLAWDI_RUNTIME_MODE",
	"CLAWDI_HOST_POLICY_PATH",
	"CLAWDI_SERVICE_STATE_DIR",
	"CLAWDI_RUN_DIR",
	"CLAWDI_RUNTIME_HOME",
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_RUNTIME_AUTH_ENV",
	"CLAWDI_RUNTIME_MANIFEST_PATH",
	"CLAWDI_RUNTIME_MANIFEST_URL",
	"CLAWDI_RUNTIME_SOURCE_PATH",
	"CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS",
	"CLAWDI_RUNTIME_INSTALL_TIMEOUT",
	"CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER",
	"CLAWDI_RUNTIME_TEST_HERMES_INSTALLER",
	"CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES",
	"CLAWDI_RUNTIME_PID1_ENVIRON_PATH",
	"CODEX_HOME",
	"CLAWDI_CODEX_INSTALL_DISABLED",
	"CLAWDI_CODEX_INSTALL_TIMEOUT",
	"CLAWDI_CODEX_PACKAGE_SPEC",
	"CUSTOM_RUNTIME_TOKEN",
	"CLAWDI_RUNTIME_MANIFEST_TIMEOUT_MS",
	"CLAWDI_API_URL",
	"CLAWDI_SYSTEMD_APPLY",
	"CLAWDI_SYSTEMD_SYSTEM_ROOT",
	"CLAWDI_SYSTEMCTL_PATH",
	"CLAWDI_RUNTIME_USER",
	"CLAWDI_RUNTIME_UID",
	"CLAWDI_EGRESS_UID",
	"CLAWDI_EGRESS_GID",
	"OPENCLAW_GATEWAY_TOKEN",
	RUNTIME_BRIDGE_TOKEN_ENV,
	RUNTIME_BRIDGE_LISTEN_HOST_ENV,
	RUNTIME_BRIDGE_SURFACES_ENV,
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

let originalEnv: Partial<Record<EnvKey, string>>;
let root: string;

beforeEach(() => {
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
	process.env.CLAWDI_RUNTIME_AUTH_ENV = "CLAWDI_AUTH_TOKEN";
});

afterEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(originalEnv)) {
		process.env[key as EnvKey] = value;
	}
	process.exitCode = undefined;
	rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
	process.exitCode = 0;
});

function seedCurrentCliInstall(
	state: string,
	packageSpec: string,
	version = "0.13.0-test",
	registry: string | null = null,
): void {
	const active = join(state, "bin", "clawdi");
	const target = join(state, "npm", "bin", "clawdi");
	mkdirSync(dirname(active), { recursive: true });
	mkdirSync(dirname(target), { recursive: true });
	mkdirSync(join(state, "status"), { recursive: true });
	writeFileSync(
		target,
		`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${version}"
  exit 0
fi
echo "seeded clawdi"
`,
	);
	chmodSync(target, 0o700);
	rmSync(active, { force: true });
	symlinkSync(target, active);
	writeFileSync(
		join(state, "status", "cli-bootstrap.json"),
		JSON.stringify({
			schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
			generatedAt: "2026-06-06T00:00:00Z",
			status: "installed",
			source: "npm",
			packageSpec,
			registry,
			npmPrefix: join(state, "npm"),
			npmCache: join(state, "npm-cache"),
			activePath: active,
			activeTarget: target,
			version,
			error: null,
		}),
	);
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
const TEST_HOSTED_MINIMUM_CLI_VERSION = "0.12.10-beta.51";

function hostedRequiredState() {
	return {
		providers: {
			default: {
				kind: "openai-compatible",
				status: "error",
				error: { code: "provider_not_found", message: "fixture provider unavailable" },
			},
		},
		liveSync: { enabled: false, agents: [] },
		recovery: { cacheManifest: true, allowOfflineBoot: true },
	};
}

function hostedSystemFixture(
	home: string,
	workspace = join(home, "clawdi"),
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		user: "clawdi",
		home,
		workspace,
		persistentPaths: [home, workspace],
		...overrides,
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
			packageSpec: "clawdi@0.13.0-test",
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

function hostedRuntimeBundleResponse(
	payload: HostedRuntimeResponseFixture,
	options: { etag?: string; sourceRevision?: string } = {},
): Response {
	const channelBindings = payload.channelBindings ?? [];
	const secretValues = payload.secretValues ?? {};
	const sourceRevision =
		options.sourceRevision ??
		runtimeContentSha256({
			manifest: payload.manifest,
			channelBindings,
			secretValues,
		});
	if (!/^[a-f0-9]{64}$/.test(sourceRevision)) {
		throw new Error("hosted runtime bundle fixture sourceRevision must be 64 hex characters");
	}
	const etag = options.etag ?? `"sha256:${sourceRevision}"`;
	if (!/^"[^"]+"$/.test(etag)) {
		throw new Error("hosted runtime bundle fixture ETag must be a strong quoted validator");
	}
	return new Response(
		JSON.stringify({
			schemaVersion: "clawdi.hosted-runtime.bundle.v2",
			sourceRevision,
			manifest: payload.manifest,
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

function hostedRuntimeWatchLocalePayload(
	home: string,
	generation: number,
	language: "en" | "fr" = "fr",
	timezone = "Europe/Paris",
): HostedRuntimeResponseFixture {
	return {
		manifest: {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
				packageSpec: "clawdi@0.13.0-test",
				registry: "https://registry.npmjs.org",
			},
			runtimes: {
				openclaw: hostedOpenClawRuntime({
					paths: { home, workspace: join(home, "clawdi") },
				}),
			},
		},
		secretValues: {},
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
				apiKeySecretRef: opts.providerSecretRef,
			}
		: hostedRequiredState().providers.default;
	return {
		manifest: {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
				openclaw: hostedOpenClawRuntime({
					paths: { home, workspace: join(home, "clawdi") },
				}),
			},
		},
		secretValues: {},
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
	const openclawBin = join(home, ".openclaw", "bin", "openclaw");
	mkdirSync(dirname(openclawBin), { recursive: true });
	writeFileSync(openclawBin, "#!/bin/sh\nexit 0\n");
	chmodSync(openclawBin, 0o700);
}

function seedRuntimeWatchLocaleBaseline(home: string, state: string, run: string): RuntimePaths {
	mkdirSync(join(run, "secrets"), { recursive: true });
	seedOpenClawBinary(home);
	process.env.HOME = home;
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_SERVICE_STATE_DIR = state;
	process.env.CLAWDI_RUN_DIR = run;
	process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
	seedCurrentCliInstall(state, "clawdi@0.13.0-test", "0.13.0-test", "https://registry.npmjs.org");
	writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
	const paths = getRuntimePaths();
	const load: RuntimeManifestLoad = {
		manifest: runtimeWatchLocaleManifest(home, 1),
		source: "remote-datasource",
		sourcePath: "https://runtime.test/v1/runtime/manifest",
		offline: false,
		secretValues: {},
	};
	const convergence = convergeRuntimeManifest(load, paths);
	writeTestRuntimeAppliedState(paths, load, convergence, {
		etag: '"manifest-locale-1"',
	});
	return paths;
}

function seedMitmproxyCache(paths = getRuntimePaths()): typeof TEST_EGRESS_ENGINE_PIN {
	const binary = join(
		paths.egressEngineMaintainedRoot,
		TEST_EGRESS_ENGINE_PIN.version,
		TEST_EGRESS_ENGINE_PIN.sha256,
		"mitmdump",
	);
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
	install: { source: "official" };
	run?: HostedRunFixture;
	services?: Record<string, HostedRunFixture>;
	paths: { home: string; workspace: string };
	provider_ids: string[];
	primary_model: { provider_id: string; model: string };
};

function hostedOpenClawRuntime(
	overrides: Partial<HostedRuntimeFixtureEntry> = {},
): HostedRuntimeFixtureEntry {
	const home = process.env.HOME ?? "/home/clawdi";
	const {
		paths,
		provider_ids = ["default"],
		primary_model = { provider_id: provider_ids[0] ?? "default", model: "gpt-test" },
		...entryOverrides
	} = overrides;
	return {
		enabled: true,
		install: { source: "official" },
		provider_ids,
		primary_model,
		run: {
			args: [
				"gateway",
				"run",
				"--allow-unconfigured",
				"--auth",
				"token",
				"--bind",
				"lan",
				"--force",
			],
			env: {},
			prependPath: [],
		},
		services: {},
		...entryOverrides,
		paths: {
			home,
			workspace: join(home, "clawdi"),
			...paths,
		},
	};
}

function hostedHermesRuntime(
	overrides: Partial<HostedRuntimeFixtureEntry> = {},
): HostedRuntimeFixtureEntry {
	const home = process.env.HOME ?? "/home/clawdi";
	const {
		paths,
		provider_ids = ["default"],
		primary_model = { provider_id: provider_ids[0] ?? "default", model: "gpt-test" },
		...entryOverrides
	} = overrides;
	return {
		enabled: true,
		install: { source: "official" },
		provider_ids,
		primary_model,
		run: {
			args: ["gateway", "run", "--replace"],
			env: {},
			prependPath: [],
		},
		services: {
			dashboard: {
				args: ["dashboard", "--host", "127.0.0.1", "--port", "9119", "--no-open"],
				env: {},
				prependPath: [],
			},
		},
		...entryOverrides,
		paths: {
			home,
			workspace: join(home, "clawdi"),
			...paths,
		},
	};
}

function hostedHermesBridgeSurface() {
	return {
		name: "hermes",
		kind: "control-ui",
		listenPort: 28793,
		upstreamHost: "127.0.0.1",
		upstreamPort: 9119,
	};
}

function systemdUnitFileName(name: string): string {
	return `${name}.service`;
}

function readSystemdSystemUnit(paths: RuntimePaths, name: string): string {
	return readFileSync(join(paths.systemdSystemRoot, systemdUnitFileName(name)), "utf-8");
}

function readSystemdUserUnit(paths: RuntimePaths, name: string): string {
	return readFileSync(join(paths.systemdUserRoot, systemdUnitFileName(name)), "utf-8");
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
	expect(providerProfiles).toHaveLength(1);
	const providerProfileText = JSON.stringify(providerProfiles[0]);
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

function readHermesModelProviderPluginFile(
	home: string,
	name: "__init__.py" | "plugin.yaml",
): string {
	return readFileSync(join(hermesModelProviderPluginDir(home), name), "utf-8");
}

function readHermesConfigYaml(home: string): Record<string, unknown> {
	const parsed = parseYaml(readFileSync(join(home, ".hermes", "config.yaml"), "utf-8"));
	if (!isRecord(parsed)) {
		throw new Error("Expected Hermes config.yaml to parse to a YAML object.");
	}
	return parsed;
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

function hostedHermesProviderLoad(home: string): RuntimeManifestLoad {
	return {
		source: "remote-datasource",
		sourcePath: "https://runtime-source.test/desired-state",
		offline: false,
		secretValues: {
			"provider.hermes.apiKey": "sk-hermes-provider",
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
						apiKeySecretRef: "provider.hermes.apiKey",
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
		runtimeEnvName: managedBy === "clawdi" ? "OPENAI_API_KEY" : `BYOK_${envPrefix}_API_KEY`,
		apiKeySecretRef: `provider.${providerId}.apiKey`,
	};
}

function hostedProviderSwitchModel(providerId: string): string {
	return `${providerId}-model`;
}

function hostedProviderSwitchLoad(
	home: string,
	selectedProviderId: string,
	generation: number,
): RuntimeManifestLoad {
	return {
		source: "remote-datasource",
		sourcePath: "https://runtime-source.test/desired-state",
		offline: false,
		secretValues: Object.fromEntries(
			Object.keys(HOSTED_PROVIDER_SWITCH_PROVIDERS).map((providerId) => [
				`provider.${providerId}.apiKey`,
				`sk-${providerId}`,
			]),
		),
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
			},
			egressProfiles: { profiles: [] },
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
	} = {},
): void {
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
			contentIdentity: {
				sourcePath: load.sourcePath,
				sha256: runtimeContentSha256({
					manifest: load.manifest,
					secretValues: load.secretValues ?? {},
				}),
			},
			providerIds,
			projectedProviderIds: convergence.projectedProviderIds,
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
		expect(paths.workspaceRoot).toBe(join(home, "clawdi"));
		expect(paths.managedConfig).toBe(join(state, "config", "clawdi.json"));
		expect(paths.syncState).toBe(join(state, "sync", "runtimes.json"));
		expect(paths.runtimeSource).toBe("/etc/clawdi/runtime-source.json");
		expect(paths.egressProfileRoot).toBe(join(state, "config", "egress"));
		expect(paths.egressProfileBundle).toBe(join(state, "config", "egress", "profiles.json"));
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
	it("starts Hermes dashboard on its default loopback port", () => {
		const config = buildRuntimeRunConfig({
			runtime: "hermes",
			enabled: true,
			generatedAt: "2026-06-15T00:00:00.000Z",
			generation: 1,
			instanceId: "iid_hermes_ui",
			commandPath: "/home/clawdi/.local/bin/hermes",
			appRoot: "/home/clawdi/.hermes/hermes-agent",
			workspaceRoot: "/home/clawdi/clawdi",
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
			commandPath: "/home/clawdi/.openclaw/bin/openclaw",
			appRoot: "/home/clawdi/.openclaw",
			workspaceRoot: "/home/clawdi/clawdi",
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
			commandPath: "/home/clawdi/.openclaw/bin/openclaw",
			appRoot: "/home/clawdi/.openclaw",
			workspaceRoot: "/home/clawdi/clawdi",
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
		expect(result.policy?.systemWritableState).toEqual(["/var/lib/clawdi", "/run/clawdi"]);
		expect(result.policy?.userWritableState).toEqual(["/home/clawdi", "/tmp"]);
		expect(result.policy?.ordinaryUserDeniedState).toEqual(["/var/lib/clawdi"]);
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
	it("changes when fixture secret values rotate without an ETag", () => {
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_identity",
			environmentId: "env_identity",
			instanceId: "iid_identity",
			generation: 1,
			issuedAt: "2026-07-13T00:00:00.000Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: {},
			recovery: {},
		};
		const load = (secret: string): RuntimeManifestLoad => ({
			manifest,
			sourceManifest: manifest,
			secretValues: { "provider.default.apiKey": secret },
			source: "fixture-file",
			sourcePath: "inline-secret-identity",
			offline: false,
		});

		expect(runtimeAppliedContentIdentity(load("sk-one")).sha256).not.toBe(
			runtimeAppliedContentIdentity(load("sk-two")).sha256,
		);
	});
});

describe("runtime manifest datasource", () => {
	it("validates the deployment-selected auth environment name", () => {
		delete process.env.CLAWDI_RUNTIME_AUTH_ENV;
		expect(() => runtimeAuthEnvName()).toThrow("missing CLAWDI_RUNTIME_AUTH_ENV");

		process.env.CLAWDI_RUNTIME_AUTH_ENV = "lowercase_token";
		expect(() => runtimeAuthEnvName()).toThrow("expected an uppercase environment variable name");

		process.env.CLAWDI_RUNTIME_AUTH_ENV = "CUSTOM_RUNTIME_TOKEN";
		expect(runtimeAuthEnvName()).toBe("CUSTOM_RUNTIME_TOKEN");
	});

	it("reports missing runtime source when no fixture or cache exists", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		delete process.env.CLAWDI_RUNTIME_MANIFEST_URL;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const loaded = await loadRuntimeManifest(getRuntimePaths());
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("repair");
		expect(loaded.stage).toBe("network");
		expect(loaded.errors[0]).toContain("could not fetch runtime manifest");
		expect(loaded.errors[0]).toContain("missing CLAWDI_RUNTIME_MANIFEST_URL");
	});

	it("rejects the /api hosted manifest path even when it has a normal query", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL =
			"https://cloud-api.example.test/api/runtime/manifest?environment_id=env_runtime";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const loaded = await loadRuntimeManifest(getRuntimePaths());
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("repair");
		expect(loaded.errors[0]).toContain("hosted manifest path must end with /v1/runtime/manifest");
	});

	it("loads last-good offline boot when cached secret values satisfy refs", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(join(state, "cache"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			join(state, "cache", "manifest.last-good.json"),
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
					packageSpec: "clawdi@0.13.0-test",
					registry: "https://registry.npmjs.org",
				},
				runtimes: { openclaw: { enabled: false } },
				projection: {
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://sub2api.test/v1",
							apiKeySecretRef: "provider.default.apiKey",
						},
					},
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);
		writeFileSync(
			join(state, "cache", "runtime-secrets.last-good.json"),
			JSON.stringify({ "provider.default.apiKey": "sk-cached-provider" }),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths());
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected offline manifest load success");
		expect(loaded.source).toBe("last-good-cache");
		expect(loaded.offline).toBe(true);
		expect(loaded.secretValues).toEqual({
			"provider.default.apiKey": "sk-cached-provider",
			"secret://provider.default.apiKey": "sk-cached-provider",
		});
	});

	it("reports degraded-offline apply and boot state after remote fetch failure", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(join(state, "cache"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		writeFileSync(
			join(state, "cache", "manifest.last-good.json"),
			JSON.stringify(cachedHostedCliDesiredState(home, "clawdi@0.13.0-test")),
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
			const paths = getRuntimePaths();
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

	it("refuses last-good offline boot when cached secret values are missing", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(join(state, "cache"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			join(state, "cache", "manifest.last-good.json"),
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
					packageSpec: "clawdi@0.13.0-test",
					registry: "https://registry.npmjs.org",
				},
				runtimes: { openclaw: { enabled: false } },
				projection: {
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://sub2api.test/v1",
							apiKeySecretRef: "provider.default.apiKey",
						},
					},
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths());
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("repair");
		expect(loaded.errors).toContain(
			"cached manifest references secretValues (provider.default.apiKey); refusing offline boot because cached secret values are missing",
		);
	});

	it("fetches hosted-runtime manifests from a configured runtime source", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
							runtime: "openclaw",
							deploymentId: "dep_test",
							environmentId: "env_test",
							...hostedRequiredState(),
							instanceId: "iid_remote",
							generation: 3,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: {
								user: "clawdi",
								home,
								workspace: join(home, "managed-workspace"),
								persistentPaths: [home],
							},
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: "clawdi@0.13.0-test",
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime({
									paths: { home },
									provider_ids: ["default", "codex"],
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
									apiKeySecretRef: "provider.default.apiKey",
								},
								codex: {
									kind: "openai-compatible",
									type: "openai",
									baseUrl: "https://api.openai.com/v1",
									models: [{ id: "gpt-5.5" }],
									apiMode: "openai_responses",
									auth: {
										type: "agent_profile",
										tool: "codex",
										profile: "default",
									},
								},
							},
							mcp: { enabled: true, profile: "clawdi-default" },
							tools: { catalog: "clawdi-default" },
						},
						secretValues: {
							"provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			expect(captured).toHaveLength(1);
			expect(captured[0].headers.authorization).toBe("Bearer auth-token");
			expect(loaded.source).toBe("remote-datasource");
			expect(loaded.sourcePath).toBe("https://runtime.test/v1/runtime/manifest");
			expect(loaded.manifest.schemaVersion).toBe("clawdi.runtimeDesiredState.v1");
			expect(loaded.manifest.workspaceRoot).toBe(join(home, "managed-workspace"));
			expect(loaded.manifest.environmentId).toBe("env_test");
			expect(loaded.manifest.controlPlane.apiUrl).toBe("https://cloud-api.test");
			expect(loaded.manifest.clawdiCli?.source).toBe("npm:clawdi");
			expect(loaded.manifest.clawdiCli?.packageSpec).toBe("clawdi@0.13.0-test");
			expect(loaded.manifest.projection?.mcp).toEqual({
				enabled: true,
				profile: "clawdi-default",
			});
			expect(loaded.manifest.projection?.tools).toEqual({ catalog: "clawdi-default" });
			expect(loaded.manifest.projection?.providers.codex).toMatchObject({
				type: "openai",
				auth: {
					type: "agent_profile",
					tool: "codex",
					profile: "default",
				},
			});
			expect(loaded.manifest.runtimes.openclaw.install?.url).toBe(
				"https://openclaw.ai/install-cli.sh",
			);
			expect(loaded.manifest.runtimes.openclaw.install?.home).toBe(home);
			expect(loaded.manifest.runtimes.openclaw.install?.args).toEqual(["--json", "--no-onboard"]);
			expectProviderEgressProfileUsesSecretRef(
				loaded.manifest.egressProfiles?.profiles,
				"secret://provider.default.apiKey",
				"sk-runtime",
			);
			expect(JSON.stringify(loaded.manifest.egressProfiles)).not.toContain("sk-runtime");
			expect(loaded.secretValues).toEqual({
				"provider.default.apiKey": "sk-runtime",
				"secret://provider.default.apiKey": "sk-runtime",
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		const packageSpec = "/usr/local/share/clawdi/bootstrap/clawdi-0.13.0-test.tgz";
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
			process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
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

	it("rejects CLAWDI_RUNTIME_MANIFEST_PATH without the fixture test gate", async () => {
		const manifestPath = join(root, "hosted-bootstrap-fixture.json");
		process.env.CLAWDI_RUNTIME_MANIFEST_PATH = manifestPath;

		const loaded = await loadRuntimeManifest(getRuntimePaths({ mode: "hosted" }));
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected fixture gate rejection");
		expect(loaded.errors).toContain(
			"CLAWDI_RUNTIME_MANIFEST_PATH requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1",
		);
	});

	it("accepts a managed bootstrap tarball only from CLAWDI_RUNTIME_MANIFEST_PATH", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-bootstrap-fixture.json");
		const packageSpec = "/usr/local/share/clawdi/bootstrap/clawdi-0.13.0-test.tgz";
		mkdirSync(home, { recursive: true });
		writeFileSync(manifestPath, JSON.stringify(hostedCliManifestResponse(home, packageSpec)));
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_PATH = manifestPath;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";

		const loaded = await loadRuntimeManifest(getRuntimePaths());
		if (!("manifest" in loaded)) {
			throw new Error(`expected fixture manifest load: ${loaded.errors.join("; ")}`);
		}
		expect(loaded.source).toBe("fixture-file");
		expect(loaded.manifest.clawdiCli?.packageSpec).toBe(packageSpec);
	});

	it("rejects an explicit generic internal fixture in hosted mode", async () => {
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "generic-hosted-fixture.json");
		process.env.HOME = home;
		writeFileSync(manifestPath, JSON.stringify(genericCliDesiredState("clawdi@1.2.3")));

		const loaded = await loadRuntimeManifest(getRuntimePaths({ mode: "hosted" }), {
			manifestPath,
		});
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected hosted fixture rejection");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain("manifest: Invalid input");
	});

	it("accepts an explicit strict hosted fixture in hosted mode", async () => {
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "strict-hosted-fixture.json");
		const packageSpec = "/usr/local/share/clawdi/bootstrap/clawdi-0.13.0-test.tgz";
		process.env.HOME = home;
		writeFileSync(manifestPath, JSON.stringify(hostedCliManifestResponse(home, packageSpec)));

		const loaded = await loadRuntimeManifest(getRuntimePaths({ mode: "hosted" }), {
			manifestPath,
		});
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected strict hosted fixture success");
		expect(loaded.manifest.clawdiCli?.packageSpec).toBe(packageSpec);
	});

	it("rejects a strict hosted fixture with secret refs but no inline secret values", async () => {
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "strict-hosted-missing-secret.json");
		const packageSpec = "/usr/local/share/clawdi/bootstrap/clawdi-0.13.0-test.tgz";
		process.env.HOME = home;
		writeFileSync(
			manifestPath,
			JSON.stringify(
				hostedCliManifestResponse(home, packageSpec, {
					providerSecretRef: "provider.default.apiKey",
				}),
			),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths({ mode: "hosted" }), {
			manifestPath,
		});
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected missing fixture secret rejection");
		expect(loaded.errors.join("\n")).toContain("fixture references secretValues");
	});

	for (const packageSpec of [
		"clawdi@latest",
		"clawdi@agent-v2",
		"clawdi@1.2.3+build.1",
		"clawdi",
	]) {
		it(`rejects cached hosted state with ${packageSpec} and no hosted marker`, async () => {
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			mkdirSync(join(state, "cache"), { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = join(root, "run", "clawdi");
			writeFileSync(
				join(state, "cache", "manifest.last-good.json"),
				JSON.stringify(cachedHostedCliDesiredState(home, packageSpec)),
			);

			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("errors" in loaded).toBe(true);
			if (!("errors" in loaded)) throw new Error("expected cached manifest rejection");
			expect(loaded.errors.join("\n")).toContain("must be clawdi@<exact-semver>");
		});
	}

	it("recovers hosted bridge token from pid1 env for Hermes runtime bridge exposure", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const pid1EnvPath = join(root, "pid1-environ");
		const hermesInstaller = join(root, "install-hermes.sh");
		mkdirSync(home, { recursive: true });
		writeFileSync(pid1EnvPath, `PATH=/usr/bin\0${RUNTIME_BRIDGE_TOKEN_ENV}=bridge-token\0`);
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_HERMES_INSTALLER = hermesInstaller;
		process.env.CLAWDI_RUNTIME_PID1_ENVIRON_PATH = pid1EnvPath;
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
							runtime: "hermes",
							deploymentId: "dep_runtime_bridge",
							environmentId: "env_runtime_bridge",
							...hostedRequiredState(),
							instanceId: "iid_runtime_bridge",
							generation: 4,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home, join(home, "managed-workspace")),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: "clawdi@0.13.0-test",
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								hermes: hostedHermesRuntime({
									paths: { home },
								}),
							},
							bridge: {
								surfaces: [hostedHermesBridgeSurface()],
							},
							providers: {
								default: {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://ai-gateway.test/v1",
									models: [{ id: "gpt-5.5" }],
									apiMode: "openai_chat",
									managed_by: "clawdi",
									runtimeEnvName: "OPENAI_API_KEY",
									apiKeySecretRef: "provider.default.apiKey",
								},
							},
						},
						secretValues: {
							"provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const paths = getRuntimePaths();
			const loaded = await loadRuntimeManifest(paths);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			const convergence = convergeRuntimeManifest(loaded, paths);
			expect(convergence.installErrors).toEqual([]);
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			const sidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
			const hermesEnv = readSystemdEnvFile(paths, "hermes-gateway");
			const hermesDashboardEnv = readSystemdEnvFile(paths, "clawdi-hermes-dashboard");

			expect(watchEnv).toContain('CLAWDI_RUNTIME_BRIDGE_TOKEN="bridge-token"');
			expect(sidecarEnv).toContain('CLAWDI_RUNTIME_BRIDGE_TOKEN="bridge-token"');
			expect(
				convergence.outputs.systemdUserUnits.map((path) => path.split("/").at(-1)),
			).not.toContain("clawdi-runtime-bridge.service");
			expect(hermesEnv).toContain('CLAWDI_RUNTIME_BRIDGE_TOKEN=""');
			expect(hermesEnv).not.toContain("CLAWDI_MANAGED_OPENAI_API_KEY");
			expect(hermesEnv).toContain('OPENAI_API_KEY="clawdi-egress-placeholder"');
			expect(hermesDashboardEnv).not.toContain("CLAWDI_MANAGED_OPENAI_API_KEY");
			expect(hermesDashboardEnv).toContain('OPENAI_API_KEY="clawdi-egress-placeholder"');
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/v1/runtime/manifest";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
								packageSpec: "clawdi@0.13.0-test",
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
									runtimeEnvName: "OPENAI_API_KEY",
									apiKeySecretRef: "provider.default.apiKey",
								},
							},
						},
						secretValues: {
							"provider.default.apiKey": "sk-runtime",
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
				runtimeEnvName: "OPENAI_API_KEY",
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/v1/runtime/manifest";
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
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
								packageSpec: "clawdi@0.13.0-test",
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
									runtimeEnvName: "OPENAI_API_KEY",
									apiKeySecretRef: "provider.default.apiKey",
								},
							},
						},
						secretValues: {
							"provider.default.apiKey": "sk-runtime",
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
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-provider-patch.json");
		const openclawOriginsPatch = join(root, "openclaw-origins-patch.json");
		const openclawCommand = join(root, "openclaw-provider-command.txt");
		mkdirSync(dirname(openclawBin), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
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
				"provider.default.apiKey": "sk-runtime-provider",
				"secret://provider.default.apiKey": "sk-runtime-provider",
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
				runtimes: {
					openclaw: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: ["--json", "--no-onboard"],
						},
					},
					hermes: { enabled: false },
				},
				projection: {
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
					system: {
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
							apiKeySecretRef: "provider.default.apiKey",
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
			"config patch --stdin",
		]);
		const patch = JSON.parse(readFileSync(openclawPatch, "utf-8"));
		expect(JSON.parse(readFileSync(openclawOriginsPatch, "utf-8"))).toEqual({
			agents: {
				defaults: {
					userTimezone: "Europe/Paris",
				},
			},
			gateway: {
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
		expect(patch.models.providers.default.apiKey.id).not.toBe("CLAWDI_MANAGED_OPENAI_API_KEY");
		expect(patch.models.providers.default.api).toBeUndefined();
		expect(JSON.stringify(patch)).not.toContain("agentRuntime");
		expect(JSON.stringify(patch)).not.toContain("chatgpt.com");
		const runConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "openclaw.json"), "utf-8"),
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
		expect(runConfig.env.CLAWDI_MANAGED_OPENAI_API_KEY).toBeUndefined();
		expect(runConfig.env.OPENAI_API_KEY).toBeUndefined();
		expect(runConfig.secretEnv).toEqual({ OPENAI_API_KEY: "provider.default.apiKey" });
		expect(runConfig.secretFilePath).toBe(join(run, "secrets", "runtimes", "openclaw.json"));
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
	});

	it("writes Codex managed provider config from hosted runtime converge", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const codexHome = join(home, ".codex");
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(join(codexHome, "config.toml"), "stale image config\n");
		writeFileSync(join(codexHome, "clawdi-managed-provider.json"), '{"stale":true}\n');
		chmodSync(codexHome, 0o755);
		chmodSync(join(codexHome, "config.toml"), 0o644);
		chmodSync(join(codexHome, "clawdi-managed-provider.json"), 0o644);
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
					deploymentId: "dep_codex_provider",
					environmentId: "env_codex_provider",
					instanceId: "iid_codex_provider",
					generation: 1,
					issuedAt: "2026-07-10T00:00:00Z",
					workspaceRoot: join(home, "clawdi"),
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: { enabled: false },
						hermes: { enabled: false },
					},
					projection: {
						sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
						system: { home },
						providers: {
							hermes: {
								kind: "openai-compatible",
								baseUrl: "https://hermes-provider.example.test/v1",
								model: "kimi/kimi-for-coding",
								apiMode: "openai_chat",
								managed_by: "clawdi",
								runtimeEnvName: "OPENAI_API_KEY",
								apiKeySecretRef: "provider.hermes.apiKey",
							},
							openclaw: {
								kind: "openai-compatible",
								baseUrl: "https://openclaw-provider.example.test/v1",
								model: "gpt-5.5",
								apiMode: "openai_responses",
								managed_by: "clawdi",
								runtimeEnvName: "OPENAI_API_KEY",
								apiKeySecretRef: "provider.openclaw.apiKey",
							},
						},
					},
					egressProfiles: { profiles: [] },
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
			},
			getRuntimePaths(),
		);

		expect(convergence.installErrors).toEqual([]);
		expect(statSync(codexHome).mode & 0o777).toBe(0o700);
		const configPath = join(codexHome, "config.toml");
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(configPath, "utf-8")).toBe(
			[
				"# Managed by Clawdi hosted runtime. Do not put API keys in this file.",
				'model = "gpt-5.5"',
				'model_provider = "clawdi-managed"',
				"",
				"[model_providers.clawdi-managed]",
				'name = "Clawdi Managed OpenAI"',
				'base_url = "https://openclaw-provider.example.test/v1"',
				'wire_api = "responses"',
				'env_key = "OPENAI_API_KEY"',
				"",
			].join("\n"),
		);
		const statePath = join(codexHome, "clawdi-managed-provider.json");
		expect(statSync(statePath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({
			schemaVersion: "clawdi.hostedCodexManagedProvider.v1",
			managedBy: "clawdi hosted runtime",
			provider: {
				baseUrl: "https://openclaw-provider.example.test/v1",
				model: "gpt-5.5",
				apiMode: "openai_responses",
				runtimeEnvName: "OPENAI_API_KEY",
				apiKeySecretRef: "provider.openclaw.apiKey",
			},
		});
	});

	it("installs the Codex runtime add-on through npm when managed config is projected", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const binDir = join(root, "fake-bin");
		const npmArgsPath = join(root, "npm-args.txt");
		const previousPath = process.env.PATH;
		mkdirSync(binDir, { recursive: true });
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
				'mkdir -p "$prefix/bin"',
				"cat > \"$prefix/bin/codex\" <<'SH'",
				"#!/usr/bin/env sh",
				"echo fake codex",
				"SH",
				'chmod 755 "$prefix/bin/codex"',
				"",
			].join("\n"),
		);
		chmodSync(join(binDir, "npm"), 0o755);
		delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;
		process.env.CLAWDI_CODEX_PACKAGE_SPEC = "@openai/codex@latest";
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");

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
							providers: {
								default: {
									kind: "openai-compatible",
									baseUrl: "https://managed-provider.example.test/v1",
									model: "gpt-5.5",
									apiMode: "openai_responses",
									managed_by: "clawdi",
									runtimeEnvName: "OPENAI_API_KEY",
									apiKeySecretRef: "provider.default.apiKey",
								},
							},
						},
						egressProfiles: { profiles: [] },
						recovery: { cacheManifest: true, allowOfflineBoot: true },
					},
				},
				getRuntimePaths(),
			);

			expect(convergence.installErrors).toEqual([]);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		}

		const npmArgs = readFileSync(npmArgsPath, "utf-8");
		expect(npmArgs).toContain("@openai/codex@latest");
		expect(npmArgs).toContain(`${join(state, "codex", "npm")}\n`);
		const realBin = join(state, "codex", "npm", "bin", "codex");
		const commandShim = join(state, "bin", "codex");
		expect(statSync(realBin).mode & 0o777).toBe(0o755);
		expect(statSync(commandShim).mode & 0o777).toBe(0o755);
		expect(readFileSync(commandShim, "utf-8")).toBe(`#!/usr/bin/env sh\nexec '${realBin}' "$@"\n`);
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
		process.env.CLAWDI_CODEX_PACKAGE_SPEC = "@openai/codex@latest";
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

	it("does not write Codex managed provider config for user-owned providers", () => {
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
								apiKeySecretRef: "provider.byok.apiKey",
							},
						},
					},
					egressProfiles: { profiles: [] },
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
			},
			getRuntimePaths(),
		);

		expect(convergence.installErrors).toEqual([]);
		expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
		expect(existsSync(join(home, ".codex", "clawdi-managed-provider.json"))).toBe(false);
	});

	it("preserves Clawdi-managed provider ownership when projecting hosted providers", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-managed-provider-patch.json");
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
				"provider.default.apiKey": "sk-runtime-provider",
			},
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_clawdi_managed_provider",
				environmentId: "env_clawdi_managed_provider",
				instanceId: "iid_clawdi_managed_provider",
				generation: 1,
				issuedAt: "2026-06-22T00:00:00Z",
				workspaceRoot: join(home, "clawdi"),
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: ["--json", "--no-onboard"],
						},
						provider_ids: ["clawdi-managed-v2"],
						primary_model: {
							provider_id: "clawdi-managed-v2",
							model: "gpt-5.5",
						},
					},
				},
				projection: {
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
					system: { home },
					providers: {
						"clawdi-managed-v2": {
							kind: "openai-compatible",
							baseUrl: "https://ai-gateway.example.test/v1",
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
							apiMode: "openai_chat",
							managed_by: "clawdi",
							runtimeEnvName: "OPENAI_API_KEY",
							apiKeySecretRef: "provider.default.apiKey",
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
		expect(patch.agents.defaults.model.primary).toBe("clawdi-managed-v2/gpt-5.5");
		expect(patch.models.providers["clawdi-managed-v2"].baseUrl).toBe(
			"https://ai-gateway.example.test/v1",
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
			const caseRoot = join(root, providerCase.id);
			const home = join(caseRoot, "home", "clawdi");
			const state = join(caseRoot, "var", "lib", "clawdi");
			const run = join(caseRoot, "run", "clawdi");
			const workspace = join(home, "clawdi");
			const openclawBin = join(home, ".openclaw", "bin", "openclaw");
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

			const second = convergeRuntimeManifest(
				hostedProviderSwitchLoad(home, providerCase.second, 2),
				paths,
			);
			expect(second.installErrors).toEqual([]);

			const openclawProviders = applyOpenClawProviderPatchLog(openclawPatchLog, {
				"user-local": {
					baseUrl: "http://127.0.0.1:11434/v1",
					models: [{ id: "local-model" }],
				},
			});
			expect(Object.keys(openclawProviders).sort()).toEqual(
				["user-local", providerCase.second].sort(),
			);
			expect(openclawProviders[providerCase.first]).toBeUndefined();
			expect(openclawProviders[providerCase.second]).toMatchObject({
				baseUrl: `https://${providerCase.second}.provider.example.test/v1`,
			});
			expect(openclawProviders["user-local"]).toMatchObject({
				baseUrl: "http://127.0.0.1:11434/v1",
			});

			const hermesConfig = readHermesConfigYaml(home);
			const hermesProviders = expectRecord(hermesConfig.providers, "Hermes providers config");
			expect(Object.keys(hermesProviders).sort()).toEqual(
				["user-local", `clawdi-${providerCase.second}`].sort(),
			);
			expect(hermesProviders[`clawdi-${providerCase.first}`]).toBeUndefined();
			expect(hermesProviders[`clawdi-${providerCase.second}`]).toMatchObject({
				api: `https://${providerCase.second}.provider.example.test/v1`,
			});
			expect(hermesProviders["user-local"]).toMatchObject({
				custom_field: "keep-me",
			});
		}
	});

	it("does not delete unknown provider projections when applied state is missing", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
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
		expect(hermesProviders["clawdi-byok-b"]).toBeDefined();
	});

	it("applies OpenClaw hosted config after the official gateway installer", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const openclawCommand = join(root, "openclaw-command.log");
		const patchCount = join(root, "openclaw-patch-count");
		mkdirSync(dirname(openclawBin), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "1";
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				`printf '%s\\n' "$*" >> '${openclawCommand}'`,
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then',
				`  count=$(cat '${patchCount}' 2>/dev/null || printf '0')`,
				"  count=$((count + 1))",
				`  printf '%s' "$count" > '${patchCount}'`,
				`  cat > '${root}'/openclaw-patch-"$count".json`,
				"  exit 0",
				"fi",
				'if [ "$1 $2 $3 $4" = "gateway install --force --json" ]; then',
				"  printf '{\"ok\":true}\\n'",
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
				"provider.default.apiKey": "sk-runtime-provider",
				"secret://provider.default.apiKey": "sk-runtime-provider",
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
				runtimes: {
					openclaw: {
						enabled: true,
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
					system: {
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
							apiKeySecretRef: "provider.default.apiKey",
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
			"gateway install --force --json",
			"config patch --stdin",
			"config patch --stdin",
		]);
		expect(JSON.parse(readFileSync(join(root, "openclaw-patch-2.json"), "utf-8"))).toEqual({
			gateway: {
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
		const openclawUnit = readSystemdUserServiceConfig(getRuntimePaths(), "openclaw-gateway");
		expect(openclawUnit).toContain(
			'"gateway" "run" "--allow-unconfigured" "--bind" "loopback" "--force"',
		);
		expect(openclawUnit).not.toContain('"--auth"');
	});

	it("projects runtime-scoped hosted providers into each enabled agent config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
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
				"provider.openclaw.apiKey": "sk-openclaw-provider",
				"provider.hermes.apiKey": "sk-hermes-provider",
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
							apiKeySecretRef: "provider.openclaw.apiKey",
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
							apiKeySecretRef: "provider.hermes.apiKey",
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
			api: "openai-responses",
		});
		expect(JSON.stringify(patch)).not.toContain("hermes-provider.example.test");
		const hermesConfig = readHermesConfigYaml(home);
		const hermesModel = expectRecord(hermesConfig.model, "Hermes model config");
		expect(hermesModel.provider).toBe("clawdi-hermes");
		expect(hermesModel.default).toBe("kimi/kimi-for-coding");
		expect(hermesModel.context_length).toBe(262144);
		expect(hermesModel.max_tokens).toBe(32768);
		expect(hermesModel.supports_vision).toBe(true);
		const hermesProviders = expectRecord(hermesConfig.providers, "Hermes providers config");
		expect(hermesProviders.hermes).toBeUndefined();
		const hermesProvider = expectRecord(hermesProviders["clawdi-hermes"], "Hermes provider config");
		expect(hermesProvider.api).toBe("https://hermes-provider.example.test/v1");
		expect(hermesProvider.transport).toBeUndefined();
		expect(hermesProvider.key_env).toBeUndefined();
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
		expect(kimiModel.max_tokens).toBeUndefined();
		const hermesPlugin = readHermesModelProviderPluginFile(home, "__init__.py");
		const hermesPluginYaml = readHermesModelProviderPluginFile(home, "plugin.yaml");
		expect(hermesPlugin).toContain('name="clawdi-hermes"');
		expect(hermesPlugin).toContain('base_url="https://hermes-provider.example.test/v1"');
		expect(hermesPlugin).toContain('env_vars=("HERMES_PROVIDER_API_KEY",)');
		expect(hermesPlugin).toContain('auth_type="api_key"');
		expect(hermesPlugin).toContain('api_mode="chat_completions"');
		expect(hermesPlugin).toContain('fallback_models=("kimi/kimi-for-coding",)');
		expect(hermesPluginYaml).toContain("kind: model-provider");
		expect(hermesPluginYaml).toContain('name: "clawdi"');
		const openclawRunConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "openclaw.json"), "utf-8"),
		);
		const hermesRunConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
		);
		expect(openclawRunConfig.env.OPENCLAW_PROVIDER_API_KEY).toBeUndefined();
		expect(openclawRunConfig.secretEnv).toEqual({
			OPENCLAW_PROVIDER_API_KEY: "provider.openclaw.apiKey",
		});
		expect(hermesRunConfig.env.HERMES_PROVIDER_API_KEY).toBeUndefined();
		expect(hermesRunConfig.secretEnv).toEqual({
			HERMES_PROVIDER_API_KEY: "provider.hermes.apiKey",
		});
		expect(JSON.stringify(openclawRunConfig)).not.toContain("sk-openclaw-provider");
		expect(JSON.stringify(hermesRunConfig)).not.toContain("sk-hermes-provider");
		expect(JSON.stringify(openclawRunConfig)).not.toContain("provider.hermes.apiKey");
		expect(JSON.stringify(hermesRunConfig)).not.toContain("provider.openclaw.apiKey");
	});

	it("reconverges the Hermes model-provider plugin idempotently", () => {
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
		const firstPlugin = readHermesModelProviderPluginFile(home, "__init__.py");
		const firstPluginYaml = readHermesModelProviderPluginFile(home, "plugin.yaml");
		const firstRevision = systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"));

		convergeRuntimeManifest(loaded, paths);

		expect(readHermesModelProviderPluginFile(home, "__init__.py")).toBe(firstPlugin);
		expect(readHermesModelProviderPluginFile(home, "plugin.yaml")).toBe(firstPluginYaml);
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"))).toBe(firstRevision);
	});

	it("registers multiple Hermes hosted providers in a single plugin projection", () => {
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
		loaded.secretValues = {
			...loaded.secretValues,
			"provider.moonshot.apiKey": "sk-moonshot-provider",
		};
		loaded.manifest.runtimes.hermes = {
			...loaded.manifest.runtimes.hermes,
			provider_ids: ["hermes", "moonshot"],
			primary_model: {
				provider_id: "hermes",
				model: "kimi/kimi-for-coding",
			},
		};
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			providers: {
				...loaded.manifest.projection?.providers,
				moonshot: {
					kind: "openai-compatible",
					baseUrl: "https://moonshot-provider.example.test/v1",
					model: "moonshot-v1-8k",
					models: [
						{
							id: "moonshot-v1-8k",
							context_window: 8192,
							max_tokens: 4096,
							supports_tools: true,
						},
					],
					apiMode: "openai_chat",
					runtimeEnvName: "MOONSHOT_PROVIDER_API_KEY",
					apiKeySecretRef: "provider.moonshot.apiKey",
				},
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const hermesPlugin = readHermesModelProviderPluginFile(home, "__init__.py");
		expect(hermesPlugin.match(/register_provider\(/g)?.length).toBe(2);
		expect(hermesPlugin).toContain('name="clawdi-hermes"');
		expect(hermesPlugin).toContain('name="clawdi-moonshot"');
		expect(hermesPlugin).toContain('env_vars=("HERMES_PROVIDER_API_KEY",)');
		expect(hermesPlugin).toContain('env_vars=("MOONSHOT_PROVIDER_API_KEY",)');
		const hermesConfig = readHermesConfigYaml(home);
		const hermesModel = expectRecord(hermesConfig.model, "Hermes model config");
		expect(hermesModel.provider).toBe("clawdi-hermes");
		const hermesProviders = expectRecord(hermesConfig.providers, "Hermes providers config");
		expect(hermesProviders.hermes).toBeUndefined();
		expect(hermesProviders.moonshot).toBeUndefined();
		const primaryHermesProvider = expectRecord(
			hermesProviders["clawdi-hermes"],
			"primary Hermes provider",
		);
		expect(primaryHermesProvider.api).toBe("https://hermes-provider.example.test/v1");
		expect(primaryHermesProvider.transport).toBeUndefined();
		expect(primaryHermesProvider.key_env).toBeUndefined();
		const primaryHermesModels = expectRecord(
			primaryHermesProvider.models,
			"primary Hermes provider models",
		);
		expect(
			expectRecord(primaryHermesModels["kimi/kimi-for-coding"], "primary Hermes model metadata")
				.context_length,
		).toBe(262144);
		const moonshotProvider = expectRecord(
			hermesProviders["clawdi-moonshot"],
			"secondary Hermes provider",
		);
		expect(moonshotProvider.api).toBe("https://moonshot-provider.example.test/v1");
		expect(moonshotProvider.transport).toBeUndefined();
		expect(moonshotProvider.key_env).toBeUndefined();
		const moonshotModels = expectRecord(
			moonshotProvider.models,
			"secondary Hermes provider models",
		);
		expect(
			expectRecord(moonshotModels["moonshot-v1-8k"], "secondary Hermes model metadata")
				.context_length,
		).toBe(8192);
		const hermesRunConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
		);
		expect(hermesRunConfig.env.HERMES_PROVIDER_API_KEY).toBeUndefined();
		expect(hermesRunConfig.env.MOONSHOT_PROVIDER_API_KEY).toBeUndefined();
		expect(hermesRunConfig.secretEnv).toEqual({
			HERMES_PROVIDER_API_KEY: "provider.hermes.apiKey",
			MOONSHOT_PROVIDER_API_KEY: "provider.moonshot.apiKey",
		});
		expect(JSON.stringify(hermesRunConfig)).not.toContain("sk-hermes-provider");
		expect(JSON.stringify(hermesRunConfig)).not.toContain("sk-moonshot-provider");
	});

	it("removes the converge-owned Hermes model-provider plugin when the provider projection disappears", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.18.0");
		const withProvider = hostedHermesProviderLoad(home);
		const withoutProvider: RuntimeManifestLoad = {
			...withProvider,
			manifest: {
				...withProvider.manifest,
				projection: {
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
					system: { home },
				},
			},
		};
		const paths = getRuntimePaths();

		convergeRuntimeManifest(withProvider, paths);
		const firstRevision = systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"));
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);

		convergeRuntimeManifest(withoutProvider, paths);

		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);
		expect(systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"))).not.toBe(firstRevision);
	});

	it("removes stale Hermes hosted capability keys when later manifests omit them", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.18.0");
		const withCapabilities = hostedHermesProviderLoad(home);
		const withoutCapabilities: RuntimeManifestLoad = {
			...withCapabilities,
			manifest: {
				...withCapabilities.manifest,
				projection: {
					...withCapabilities.manifest.projection,
					providers: {
						...withCapabilities.manifest.projection?.providers,
						hermes: {
							...withCapabilities.manifest.projection?.providers?.hermes,
							models: [{ id: "kimi/kimi-for-coding" }],
						},
					},
				},
			},
		};

		convergeRuntimeManifest(withCapabilities, getRuntimePaths());
		const initialConfig = readHermesConfigYaml(home);
		const initialModelConfig = expectRecord(initialConfig.model, "initial Hermes model config");
		expect(initialModelConfig.context_length).toBe(262144);
		expect(initialModelConfig.supports_vision).toBe(true);
		const initialProviderModels = expectRecord(
			expectRecord(
				expectRecord(initialConfig.providers, "initial Hermes providers")["clawdi-hermes"],
				"initial Hermes provider",
			).models,
			"initial Hermes provider models",
		);
		expect(
			expectRecord(
				initialProviderModels["kimi/kimi-for-coding"],
				"initial Hermes provider kimi model",
			).supports_vision,
		).toBe(true);

		const convergence = convergeRuntimeManifest(withoutCapabilities, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const hermesConfig = readHermesConfigYaml(home);
		const hermesModel = expectRecord(hermesConfig.model, "Hermes model config");
		expect(hermesModel.context_length).toBeUndefined();
		expect(hermesModel.max_tokens).toBeUndefined();
		expect(hermesModel.supports_vision).toBeUndefined();
		const hermesProvider = expectRecord(
			expectRecord(hermesConfig.providers, "Hermes providers config")["clawdi-hermes"],
			"Hermes provider config",
		);
		expect(hermesProvider.api).toBe("https://hermes-provider.example.test/v1");
		expect(hermesProvider.models).toBeUndefined();
	});

	it("falls back to Hermes config.yaml provider merges before 0.18.0 and changes revision when plugin support appears", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.17.0");
		const loaded = hostedHermesProviderLoad(home);
		const paths = getRuntimePaths();

		convergeRuntimeManifest(loaded, paths);

		const yamlRevision = systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"));
		const fallbackConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(fallbackConfig).toContain("provider: custom:hermes");
		expect(fallbackConfig).toMatch(/api: "?https:\/\/hermes-provider\.example\.test\/v1"?/);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);

		writeHermesVersionBinary(home, "0.18.0");
		convergeRuntimeManifest(loaded, paths);

		const pluginRevision = systemdEnvRevision(readSystemdEnvFile(paths, "clawdi-hermes"));
		const pluginConfig = readHermesConfigYaml(home);
		expect(expectRecord(pluginConfig.model, "Hermes plugin model config").provider).toBe(
			"clawdi-hermes",
		);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);
		expect(pluginRevision).not.toBe(yamlRevision);
	});

	it("projects runtime-scoped Codex OAuth providers as native agent profiles", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
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
			readFileSync(join(state, "config", "run", "openclaw.json"), "utf-8"),
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
				"provider.openclaw.apiKey": "sk-openclaw-provider",
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
							apiKeySecretRef: "provider.openclaw.apiKey",
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
			readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
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
			const openclawBin = join(home, ".openclaw", "bin", "openclaw");
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
					"provider.openclaw.apiKey": `sk-${providerCase.id}`,
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
								apiKeySecretRef: "provider.openclaw.apiKey",
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
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-runtime-response.json");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
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
					minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
						packageSpec: "clawdi@0.13.0-test",
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
							runtimeEnvName: "OPENAI_API_KEY",
							apiKeySecretRef: "provider.clawdi-managed-v2.apiKey",
						},
					},
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
				secretValues: {
					"provider.clawdi-managed-v2.apiKey": "sk-runtime-provider",
				},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected hosted manifest load success");

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const runConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "openclaw.json"), "utf-8"),
		);
		expect(runConfig.env.CLAWDI_MANAGED_OPENAI_API_KEY).toBeUndefined();
		expect(runConfig.env.OPENAI_API_KEY).toBe("clawdi-egress-placeholder");
		expect(runConfig.secretEnv).toEqual({});
		expect(runConfig.secretFilePath).toBeNull();
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
		expectExistingFileNotToContain(
			join(run, "secrets", "runtime-secrets.json"),
			"sk-runtime-provider",
		);
		const paths = getRuntimePaths();
		expectEgressProfileBundleUsesSecretRef(
			convergence.outputs.egressProfileBundle,
			"secret://provider.clawdi-managed-v2.apiKey",
			"sk-runtime-provider",
		);
		expectMitmSecretFileIsSidecarOnly(
			paths,
			convergence.outputs.egressSecretFile,
			"secret://provider.clawdi-managed-v2.apiKey",
			"sk-runtime-provider",
		);
		expect(existsSync(join(run, "secrets", "runtimes", "openclaw.json"))).toBe(false);
	});

	it("does not project a key-required hosted provider without a secret ref as no-auth", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
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
				source: "fixture-file",
				sourcePath: "test://key-required-missing-ref",
				offline: false,
				secretValues: {},
			},
			getRuntimePaths(),
		);

		expect(convergence.installErrors).toEqual([]);
		const providerHealth = JSON.parse(
			readFileSync(join(state, "status", "provider-health.json"), "utf-8"),
		);
		expect(providerHealth.providers.openclaw.status).toBe("error");
		expect(providerHealth.providers.openclaw.reasons).toContain("provider_error");
		expect(providerHealth.providers.openclaw.reasons).toContain("provider_secret_unavailable");
		expect(providerHealth.providers.openclaw.reasons).toContain("api_key_secret_ref_missing");
	});

	it("does not infer runtime entries from the runtime bridge token", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-runtime-bridge-token.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env[RUNTIME_BRIDGE_TOKEN_ENV] = "bridge-token";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
					runtime: "openclaw",
					deploymentId: "dep_bridge_token",
					environmentId: "env_bridge_token",
					...hostedRequiredState(),
					instanceId: "iid_bridge_token",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: "clawdi@0.13.0-test",
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
					},
				},
				secretValues: {},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

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
		process.env[RUNTIME_BRIDGE_TOKEN_ENV] = "bridge-token";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
					runtime: "openclaw",
					deploymentId: "dep_bridge_token_explicit",
					environmentId: "env_bridge_token_explicit",
					...hostedRequiredState(),
					instanceId: "iid_bridge_token_explicit",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: "clawdi@0.13.0-test",
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
						hermes: {
							enabled: false,
							install: { source: "official" },
							provider_ids: ["default"],
							primary_model: { provider_id: "default", model: "gpt-test" },
							paths: { home, workspace: join(home, "clawdi") },
						},
					},
				},
				secretValues: {},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain(
			"hosted runtime manifests must declare exactly one selected runtime",
		);
	});

	it("uses the deployment-selected auth env and ignores runtime source file auth", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(run, "secrets"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_RUNTIME_AUTH_ENV = "CUSTOM_RUNTIME_TOKEN";
		process.env.CLAWDI_AUTH_TOKEN = "stale-default-token";
		process.env.CUSTOM_RUNTIME_TOKEN = "bootstrap-token";
		writeFileSync(join(run, "secrets", "auth-token"), "stale-file-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CUSTOM_RUNTIME_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
							runtime: "hermes",
							deploymentId: "dep_custom_auth",
							environmentId: "env_custom_auth",
							...hostedRequiredState(),
							instanceId: "iid_custom_auth",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: "clawdi@0.13.0-test",
								registry: "https://registry.npmjs.org",
							},
							runtimes: { hermes: hostedHermesRuntime() },
							bridge: { surfaces: [hostedHermesBridgeSurface()] },
						},
						secretValues: {},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			expect(captured[0].headers.authorization).toBe("Bearer bootstrap-token");
			expect(readFileSync(join(run, "secrets", "auth-token"), "utf-8")).toBe("bootstrap-token\n");
		} finally {
			restore();
		}
	});

	it("uses the same canonical file token for initial fetch and persistent watch fetches", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const wrongSourcePath = join(root, "wrong-runtime-source.json");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(openclawBin, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_AUTH_TOKEN = "runtime-file-token";
		writeFileSync(
			wrongSourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://wrong-runtime.test/wrong-manifest",
				auth: { type: "bearer-env", env: "STALE_RUNTIME_TOKEN_ENV" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
							runtime: "openclaw",
							deploymentId: "dep_same_token",
							environmentId: "env_same_token",
							...hostedRequiredState(),
							instanceId: "iid_same_token",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: "clawdi@0.13.0-test",
								registry: "https://registry.npmjs.org",
							},
							runtimes: { openclaw: hostedOpenClawRuntime() },
							liveSync: {
								enabled: true,
								agents: [{ agentType: "openclaw", environmentId: "env_same_token" }],
							},
						},
						secretValues: {},
					}),
			},
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
							runtime: "openclaw",
							deploymentId: "dep_same_token",
							environmentId: "env_same_token",
							...hostedRequiredState(),
							instanceId: "iid_same_token",
							generation: 2,
							issuedAt: "2026-06-06T00:01:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: "clawdi@0.13.0-test",
								registry: "https://registry.npmjs.org",
							},
							runtimes: { openclaw: hostedOpenClawRuntime() },
							liveSync: {
								enabled: true,
								agents: [{ agentType: "openclaw", environmentId: "env_same_token" }],
							},
						},
						secretValues: {},
					}),
			},
		]);

		try {
			const paths = getRuntimePaths();
			const initial = await loadRuntimeManifest(paths);
			if (!("manifest" in initial)) throw new Error("expected initial manifest load success");
			process.env.CLAWDI_RUNTIME_MANIFEST_URL = "";
			const convergence = convergeRuntimeManifest(initial, paths);
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			const watchManifestUrl = watchEnv.match(/^CLAWDI_RUNTIME_MANIFEST_URL="([^"]+)"$/m)?.[1];
			process.env.CLAWDI_AUTH_TOKEN = "";
			process.env.CLAWDI_RUNTIME_MANIFEST_URL = watchManifestUrl ?? "";
			process.env.CLAWDI_RUNTIME_SOURCE_PATH = wrongSourcePath;
			const watched = await loadRemoteRuntimeManifest(paths);

			expect("manifest" in watched).toBe(true);
			expect(watchManifestUrl).toBe("https://runtime.test/v1/runtime/manifest");
			expect(captured.map((entry) => entry.url)).toEqual([
				"https://runtime.test/v1/runtime/manifest",
				"https://runtime.test/v1/runtime/manifest",
			]);
			expect(captured.map((entry) => entry.headers.authorization)).toEqual([
				"Bearer runtime-file-token",
				"Bearer runtime-file-token",
			]);
			expect(convergence.outputs.daemonAuthTokenFile).toBe(join(run, "secrets", "auth-token"));
			expect(readFileSync(join(run, "secrets", "auth-token"), "utf-8")).toBe(
				"runtime-file-token\n",
			);
			expect(watchEnv).toContain('CLAWDI_AUTH_TOKEN=""');
			expect(watchEnv).not.toContain("CLAWDI_HOST_POLICY_PATH");
			expect(watchEnv).not.toContain("CLAWDI_RUNTIME_SOURCE_PATH");
			expect(watchEnv).not.toContain("runtime-file-token");
		} finally {
			restore();
		}
	});

	it("loads remote manifests with If-None-Match and auth-token file fallback", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_AUTH_TOKEN = "";
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					new Response(null, {
						status: 304,
						headers: { etag: '"etag-current"' },
					}),
			},
		]);

		try {
			const loaded = await loadRemoteRuntimeManifest(getRuntimePaths(), {
				ifNoneMatch: '"etag-current"',
			});

			expect("notModified" in loaded).toBe(true);
			if (!("notModified" in loaded)) throw new Error("expected 304 manifest load");
			expect(loaded.etag).toBe('"etag-current"');
			expect(captured).toHaveLength(1);
			expect(captured[0].headers.authorization).toBe("Bearer file-runtime-token");
			expect(captured[0].headers["if-none-match"]).toBe('"etag-current"');
		} finally {
			restore();
		}
	});

	it("projects an empty runtime channel list as an empty projection", () => {
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "openclaw",
				deploymentId: "dep_empty_channels",
				environmentId: "env_empty_channels",
				instanceId: "iid_empty_channels",
				generation: 3,
				issuedAt: "2026-06-14T00:00:00Z",
				system: { home: "/home/clawdi", workspace: "/home/clawdi/clawdi" },
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: { enabled: true },
				},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
			secretValues: { "provider.default.apiKey": "sk-provider" },
		};
		const channels: RuntimeChannelsLoad = {
			channels: [],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/v1/channels",
			etag: '"empty-channels"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(loaded, channels);

		expect(projected.manifest.projection?.channels).toEqual({});
		expect(projected.manifest.egressProfiles?.profiles ?? []).toEqual([]);
		expect(projected.secretValues).toEqual({ "provider.default.apiKey": "sk-provider" });
	});

	it("merges channel secrets into source-level secretValues during pure projection", () => {
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "openclaw",
				deploymentId: "dep_channel_secret_boundary",
				environmentId: "env_channel_secret_boundary",
				instanceId: "iid_channel_secret_boundary",
				generation: 6,
				issuedAt: "2026-07-08T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: { enabled: true },
					hermes: { enabled: true },
				},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
			offline: false,
			secretValues: { "provider.default.apiKey": "sk-provider" },
		};
		const channels: RuntimeChannelsLoad = {
			channels: [
				{
					id: "acct-telegram-1",
					provider: "telegram",
					name: "Runtime Telegram",
					status: "active",
					visibility: "private",
					runtime_links: [
						{
							id: "link-telegram-1",
							account_id: "acct-telegram-1",
							agent_id: "env_channel_secret_boundary",
							status: "active",
							agent_token: "telegram-agent-token",
						},
					],
					runtime_credentials: [],
				},
				{
					id: "acct-discord-1",
					provider: "discord",
					name: "Runtime Discord",
					status: "active",
					visibility: "private",
					runtime_links: [
						{
							id: "link-discord-1",
							account_id: "acct-discord-1",
							agent_id: "env_channel_secret_boundary",
							status: "active",
							agent_token: "discord-agent-token",
						},
					],
					runtime_credentials: [],
				},
				{
					id: "acct-whatsapp-1",
					provider: "whatsapp",
					name: "Runtime WhatsApp",
					status: "active",
					visibility: "private",
					runtime_links: [
						{
							id: "link-whatsapp-1",
							account_id: "acct-whatsapp-1",
							agent_id: "env_channel_secret_boundary",
							status: "active",
							agent_token: "whatsapp-agent-token",
						},
					],
					runtime_credentials: [],
				},
			],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/v1/channels",
			etag: '"channel-secret-boundary"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(loaded, channels);

		expect(projected.secretValues).toMatchObject({
			"provider.default.apiKey": "sk-provider",
			"secret://channels/telegram/clawdi_accttelegram/agent-token": "telegram-agent-token",
			"secret://channels/discord/clawdi_acctdiscord1/agent-token": "discord-agent-token",
			"secret://channels/whatsapp/clawdi_acctwhatsapp/agent-token": "whatsapp-agent-token",
		});
		expect(projected.sourceManifest).toEqual(loaded.manifest);
		expect(JSON.stringify(projected.sourceManifest)).not.toContain('"channels"');
		expect(
			projected.secretValues?.["secret://channels/telegram/clawdi_accttelegram/agent-token"],
		).toBe("telegram-agent-token");
		expect(
			projected.secretValues?.["secret://channels/telegram/clawdi_accttelegram/placeholder-token"],
		).toMatch(/^999999999:[a-f0-9]{32}$/);
		expect(
			projected.secretValues?.["secret://channels/discord/clawdi_acctdiscord1/agent-token"],
		).toBe("discord-agent-token");
		expect(
			projected.secretValues?.["secret://channels/discord/clawdi_acctdiscord1/placeholder-token"],
		).toMatch(/^clawdi_[a-f0-9]{32}$/);
		expect(
			projected.secretValues?.["secret://channels/whatsapp/clawdi_acctwhatsapp/agent-token"],
		).toBe("whatsapp-agent-token");
		expect(
			projected.secretValues?.["secret://channels/whatsapp/clawdi_acctwhatsapp/placeholder-token"],
		).toMatch(/^clawdi_[a-f0-9]{32}$/);
		expect(projected.manifest.projection?.channels).toMatchObject({
			telegram: { enabled: true },
			discord: { enabled: true },
		});
		expect(JSON.stringify(projected.manifest.projection?.channels ?? {})).not.toContain("whatsapp");
	});

	it("gates WhatsApp runtime channel projection until upstream support is ready", () => {
		const accountId = "00000000-0000-0000-0000-000000000001";
		const linkId = "link-whatsapp-1";
		const credentialId = "credential-whatsapp-1";
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "openclaw",
				deploymentId: "dep_whatsapp_creds_projection",
				environmentId: "env_whatsapp_creds_projection",
				instanceId: "iid_whatsapp_creds_projection",
				generation: 5,
				issuedAt: "2026-06-14T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: { enabled: true },
				},
				projection: {
					system: { home: "/home/clawdi", workspace: "/home/clawdi/clawdi" },
				},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
			secretValues: {},
		};
		const channels: RuntimeChannelsLoad = {
			channels: [
				{
					id: accountId,
					provider: "whatsapp",
					name: "Hosted WhatsApp",
					status: "active",
					visibility: "private",
					runtime_links: [
						{
							id: linkId,
							account_id: accountId,
							agent_id: "env_whatsapp_creds_projection",
							status: "active",
							agent_token: "wa-agent-token",
						},
					],
					runtime_credentials: [
						{
							id: credentialId,
							account_id: accountId,
							agent_link_id: linkId,
							agent_id: "env_whatsapp_creds_projection",
							provider: "whatsapp",
							kind: "whatsapp_baileys_auth_state",
							created_at: "2026-07-07T00:00:00Z",
							jid: "15551234567:1@s.whatsapp.net",
							identity_pub_key_hex: "aabbcc",
							material: {
								schemaVersion: "clawdi.whatsappBaileysAuthState.v1",
								creds: {
									advSecretKey: "wa-adv-secret",
									me: { id: "15551234567:1@s.whatsapp.net" },
								},
							},
						},
					],
				},
			],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/v1/channels",
			etag: '"whatsapp-creds"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(loaded, channels);

		expect(projected.manifest.projection?.channels).toEqual({});
		expect(projected.manifest.projection?.channelCredentials).toEqual([]);
		expect(projected.manifest.egressProfiles?.profiles).toEqual([
			expect.objectContaining({
				id: "native-whatsapp-clawdi_000000000000-graph-managed",
				kind: "http",
				owner: "clawdi-native-channels",
			}),
		]);
		expect(JSON.stringify(projected.manifest)).not.toContain(accountId);
		expect(JSON.stringify(projected.manifest)).not.toContain("baileys");
		expect(JSON.stringify(projected.manifest)).not.toContain("wa-agent-token");
		expect(JSON.stringify(projected.manifest)).not.toContain("wa-adv-secret");
		expect(JSON.stringify(projected.secretValues ?? {})).toContain("wa-agent-token");
		expect(JSON.stringify(projected.secretValues ?? {})).not.toContain("wa-adv-secret");
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
				system: { home: "/home/clawdi", workspace: "/home/clawdi/clawdi" },
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
			secretValues: { "provider.default.apiKey": "sk-provider" },
		};
		const channels: RuntimeChannelsLoad = {
			channels: [],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/v1/channels",
			etag: '"empty-channels"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(loaded, channels);

		expect(projected.manifest.egressProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"explicit-provider-profile",
		]);
	});

	it("keeps managed channels separate from provider projection profiles", () => {
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
							apiKeySecretRef: "provider.openclaw.apiKey",
						},
						hermes: {
							baseUrl: "https://hermes-provider.example.test/v1",
							apiMode: "openai_responses",
							apiKeySecretRef: "provider.hermes.apiKey",
						},
					},
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
			secretValues: {
				"provider.openclaw.apiKey": "sk-openclaw-provider",
				"provider.hermes.apiKey": "sk-hermes-provider",
			},
		};
		const channels: RuntimeChannelsLoad = {
			channels: [
				{
					id: "acct-telegram-1",
					provider: "telegram",
					name: "Runtime Telegram",
					status: "active",
					visibility: "private",
					runtime_links: [
						{
							id: "link-telegram-1",
							account_id: "acct-telegram-1",
							agent_id: "env_channel_provider",
							status: "active",
							agent_token: "agent-token-runtime",
						},
					],
				},
			],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/v1/channels",
			etag: '"channels"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(loaded, channels);

		expect(projected.manifest.egressProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"native-telegram-clawdi_accttelegram-managed",
		]);
	});

	it("runtime watch wakes on its own manifest SSE signal and restarts only the runtime unit", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl-locale.log");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "systemctl"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${systemctlLog}'
exit 0
`,
		);
		chmodSync(join(bin, "systemctl"), 0o700);
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.env.CLAWDI_RUNTIME_USER = "root";
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
		seedRuntimeWatchLocaleBaseline(home, state, run);
		console.log = (value?: unknown) => logs.push(String(value));
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
							headers: { etag: '"manifest-locale-1"' },
						});
					}
					setTimeout(() => abort.abort(), 25);
					return hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, 2), {
						etag: '"manifest-locale-2"',
					});
				},
			},
		]);

		try {
			await runtimeWatch({
				intervalMs: 60_000,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					await options.onEvent({
						type: "runtime_manifest_changed",
						environment_id: "env_other",
					});
					await initialManifestRequest;
					manifestRequestsBeforeOwnSignal = captured.filter(
						(request) => request.path === "/v1/runtime/manifest",
					).length;
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
			expect(events.map((event) => event.status)).toEqual(["not_modified", "applied"]);
			expect(events[0].generation).toBe(1);
			expect(events[0].instanceId).toBe("iid_watch_locale");
			expect(events[1].etag).toBe('"manifest-locale-2"');
			expect(
				captured.filter((request) => request.path === "/v1/runtime/manifest")[1].headers[
					"if-none-match"
				],
			).toBe('"manifest-locale-1"');
			const systemctlCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			expect(systemctlCalls).toContain("--user restart openclaw-gateway.service");
			expect(systemctlCalls.some((call) => call.includes("restart clawdi-runtime-watch"))).toBe(
				false,
			);
			const watchStatus = JSON.parse(readFileSync(getRuntimePaths().runtimeWatchStatus, "utf-8"));
			expect(watchStatus.event.generation).toBe(2);
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it("runtime watch keeps polling after SSE authentication failure", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		seedRuntimeWatchLocaleBaseline(home, state, run);
		console.log = (value?: unknown) => logs.push(String(value));
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
						etag: '"manifest-locale-2"',
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
					options.onAuthFailure?.();
				},
			});

			expect(manifestCalls).toBe(2);
			expect(logs.map((line) => JSON.parse(line).status)).toEqual(["not_modified", "applied"]);
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it.each([
		"authentication failure",
		"task completion",
	])("runtime watch re-subscribes after SSE %s with unchanged connection identity", async (completionMode) => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		seedRuntimeWatchLocaleBaseline(home, state, run);
		console.log = (value?: unknown) => logs.push(String(value));
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
						etag: '"manifest-locale-2"',
					});
				},
			},
		]);
		const timeout = setTimeout(() => abort.abort(), 500);

		try {
			await runtimeWatch({
				intervalMs: 60_000,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					subscriptionCalls += 1;
					if (subscriptionCalls === 1) {
						if (completionMode === "authentication failure") options.onAuthFailure?.();
						return;
					}
					await initialManifestRequest;
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
			expect(manifestCalls).toBe(2);
			expect(logs.map((line) => JSON.parse(line).status)).toEqual(["not_modified", "applied"]);
		} finally {
			clearTimeout(timeout);
			restore();
			console.log = previousLog;
		}
	});

	it("runtime watch applies remote changes, tracks systemd unit changes, and saves the new ETag", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
		writeFileSync(
			join(bin, "systemctl"),
			`#!/usr/bin/env bash
printf 'ActiveState=active\\nSubState=running\\n'
`,
		);
		chmodSync(join(bin, "systemctl"), 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, "clawdi@0.13.0-test", "0.13.0-test", "https://registry.npmjs.org");
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
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
								minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
									packageSpec: "clawdi@0.13.0-test",
									registry: "https://registry.npmjs.org",
								},
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
										apiKeySecretRef: "provider.default.apiKey",
										apiKeyRequired: true,
									},
								},
							},
							channelBindings: [],
							secretValues: { "provider.default.apiKey": "sk-provider-watch" },
						}),
						{
							status: 200,
							headers: {
								"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
								etag: '"etag-watch-12"',
							},
						},
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(process.exitCode ?? 0).toBe(0);
			expect(captured).toHaveLength(1);
			expect(captured[0].headers.authorization).toBe("Bearer file-runtime-token");
			expect(captured[0].headers.accept).toBe(HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE);
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
			expect(existsSync(join(state, "cache", "channels.etag"))).toBe(false);
			const appliedState = readRuntimeAppliedState(getRuntimePaths());
			expect(appliedState).toMatchObject({
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				instanceId: "iid_watch",
				etag: '"etag-watch-12"',
				sourceRevision: "a".repeat(64),
				generation: 12,
				providerIds: ["default"],
			});
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(12);
			expect(event.etag).toBe('"etag-watch-12"');
			expect(event.convergence.appliedState).toBe(getRuntimePaths().appliedState);
			expect(event.systemdUnitsChanged).toBe(true);
			expect(event.systemdApply).toEqual({
				applied: false,
				systemUnitsChanged: ["clawdi-runtime-watch.service"],
				userUnitsChanged: ["openclaw-gateway.service"],
			});
			const watchStatus = JSON.parse(
				readFileSync(join(state, "status", "runtime-watch.json"), "utf-8"),
			);
			expect(watchStatus.event.status).toBe("applied");
			const observed = readHostedRuntimeObserved(getRuntimePaths());
			expect(observed?.status).toBe("ok");
			expect(observed?.applied).toMatchObject({
				etag: '"etag-watch-12"',
				sourceRevision: "a".repeat(64),
				generation: 12,
				appliedProviderIds: ["default"],
			});
			const paths = getRuntimePaths();
			expect(readSystemdSystemUnit(paths, "clawdi-runtime-watch")).toContain(
				'ExecStart="clawdi" "runtime" "watch"',
			);
			expect(readSystemdEnvFile(paths, "clawdi-runtime-watch")).not.toContain("file-runtime-token");
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
		const sourcePath = join(root, "runtime-source.json");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		let generation = 30;
		let manifestEtag = '"manifest-generation-30"';
		mkdirSync(join(run, "secrets"), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, "clawdi@0.13.0-test", "0.13.0-test", "https://registry.npmjs.org");
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const watchFetch = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, generation), {
						etag: manifestEtag,
					}),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				etag: '"manifest-generation-30"',
				generation: 30,
			});

			generation = 31;
			manifestEtag = '"manifest-generation-31"';
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			const event = JSON.parse(logs.at(-1) ?? "{}");
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(31);
			expect(event.etag).toBe('"manifest-generation-31"');
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				etag: '"manifest-generation-31"',
				generation: 31,
			});
			expect(watchFetch.captured).toHaveLength(2);
		} finally {
			watchFetch.restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("runtime watch does not advance last-good or applied authority when systemd apply fails", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
		writeFileSync(
			join(bin, "systemctl"),
			`#!/usr/bin/env bash
printf 'systemctl failed\\n' >&2
exit 42
`,
		);
		chmodSync(join(bin, "systemctl"), 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		const paths = getRuntimePaths();
		mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
		mkdirSync(dirname(paths.managedConfig), { recursive: true });
		mkdirSync(paths.runConfigRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		const targetConfig = join(home, ".openclaw", "openclaw.json");
		const rollbackFixtures = [
			paths.managedConfig,
			join(paths.runConfigRoot, "openclaw.json"),
			join(paths.systemdUserRoot, "clawdi-previous.service"),
			targetConfig,
		];
		for (const [index, path] of rollbackFixtures.entries()) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `previous-${index}\n`);
		}
		const rollbackContents = new Map(rollbackFixtures.map((path) => [path, readFileSync(path)]));
		writeFileSync(paths.manifestLastGood, '{"generation":12}\n');
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: "iid_watch_systemd_failure",
				etag: '"etag-watch-previous"',
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
		seedCurrentCliInstall(state, "clawdi@0.13.0-test", "0.13.0-test", "https://registry.npmjs.org");
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
									packageSpec: "clawdi@0.13.0-test",
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						},
						{ etag: '"etag-watch-systemd-failure"' },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.error).toContain("systemd apply failed");
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
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("runtime watch trusts the committed v2 authority after a manifest 304", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		const providerSecretRef = "provider.default.apiKey";
		const channelSecretRef = "secret://channels/telegram/clawdi_accttelegram/agent-token";
		const channelPlaceholderSecretRef =
			"secret://channels/telegram/clawdi_accttelegram/placeholder-token";
		const hostedPayload = {
			schemaVersion: "clawdi.hosted-runtime.bundle.v2",
			sourceRevision: "d".repeat(64),
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
					packageSpec: "clawdi@0.13.0-test",
					registry: "https://registry.npmjs.org",
				},
				runtimes: {
					openclaw: hostedOpenClawRuntime({
						paths: { home },
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
						runtimeEnvName: "OPENAI_API_KEY",
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
				[providerSecretRef]: "sk-provider-watch",
				[channelSecretRef]: "agent-token-watch",
				[channelPlaceholderSecretRef]: "999999999:54db03c2296520629c70cfb6e3b15f8e",
			},
		};
		const manifestResponse = (etag = '"manifest-etag-stable"') =>
			new Response(JSON.stringify(hostedPayload), {
				status: 200,
				headers: {
					"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
					etag,
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, "clawdi@0.13.0-test", "0.13.0-test", "https://registry.npmjs.org");
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const paths = getRuntimePaths();
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
					etag: '"manifest-etag-stable"',
					sourceRevision: "d".repeat(64),
					generation: 22,
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
		const baselineSecrets = JSON.parse(
			readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8"),
		);
		expect(baselineSecrets["secret://provider.default.apiKey"]).toBeUndefined();
		expect(baselineSecrets[channelPlaceholderSecretRef]).toMatch(/^999999999:[a-f0-9]{32}$/);
		expect(JSON.stringify(baselineSecrets)).not.toContain("agent-token-watch");
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
								headers: { etag: '"manifest-etag-stable"' },
							})
						: manifestResponse('"manifest-etag-effective"'),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(watchFetch.captured.map((request) => request.path)).toEqual(["/v1/runtime/manifest"]);
			expect(watchFetch.captured[0].headers["if-none-match"]).toBe('"manifest-etag-stable"');
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("not_modified");
			expect(event.generation).toBe(22);
			expect(event.etag).toBe('"manifest-etag-stable"');
			expect(readRuntimeAppliedState(paths)).toMatchObject({
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				etag: '"manifest-etag-stable"',
				sourceRevision: "d".repeat(64),
				generation: 22,
				providerIds: ["clawdi-managed-v2"],
			});
			expect(event.systemdUnitsChanged).toBeUndefined();
			expect(event.systemdApply).toBeUndefined();
			const secrets = JSON.parse(
				readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8"),
			);
			expect(secrets["secret://provider.default.apiKey"]).toBeUndefined();
			expect(secrets[channelPlaceholderSecretRef]).toMatch(/^999999999:[a-f0-9]{32}$/);
			expect(JSON.stringify(secrets)).not.toContain("agent-token-watch");
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
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		seedCurrentCliInstall(state, "clawdi@0.13.0-test", "0.13.0-test", "https://registry.npmjs.org");
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
							etag: '"malformed-bundle"',
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
								minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
									packageSpec: "clawdi@0.13.0-test",
									registry: "https://registry.npmjs.org",
								},
								runtimes: { openclaw: hostedOpenClawRuntime() },
							},
							secretValues: {},
						},
						{ etag: '"etag-recovered"' },
					),
				"applied",
			);

			expect(recovered.generation).toBe(18);
			expect(readRuntimeAppliedState(getRuntimePaths())?.etag).toBe('"etag-recovered"');
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
		const sourcePath = join(root, "runtime-source.json");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		writeFileSync(join(run, "secrets", "auth-token"), "revoked-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
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
		mkdirSync(join(state, "cache"), { recursive: true });
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
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
  openclaw-gateway.service)
    printf 'ActiveState=failed\\nSubState=failed\\n'
    ;;
  *)
    printf 'ActiveState=inactive\\nSubState=dead\\n'
    ;;
esac
`,
		);
		chmodSync(join(bin, "systemctl"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		const paths = getRuntimePaths();
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"), "[Service]\n");
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-daemon.service"), "[Service]\n");
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
				unitCount: 3,
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
						error: null,
					},
				],
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime observed does not report ok when managed systemd units are inactive", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(join(state, "cache"), { recursive: true });
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
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const paths = getRuntimePaths();
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
		mkdirSync(join(state, "cache"), { recursive: true });
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
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const paths = getRuntimePaths();
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
		mkdirSync(join(state, "cache"), { recursive: true });
		mkdirSync(join(run, "secrets"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
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
							apiKeySecretRef: "provider.default.apiKey",
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
				etag: '"provider-observed"',
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
				apiKeySecretRef: "provider.default.apiKey",
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
		mkdirSync(join(state, "cache"), { recursive: true });
		mkdirSync(run, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
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
							apiKeySecretRef: "provider.default.apiKey",
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
				apiKeySecretRef: "provider.default.apiKey",
				secretAvailable: false,
				reasons: ["model_missing", "secret_missing"],
			},
		});
	});

	it("runtime watch installs changed CLI package specs and marks itself for re-exec", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
		const npmLog = join(root, "npm.log");
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
  echo "0.13.1-beta.0"
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
								runtime: "openclaw",
								deploymentId: "dep_cli_update",
								environmentId: "env_cli_update",
								...hostedRequiredState(),
								instanceId: "iid_cli_update",
								generation: 13,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: "clawdi@0.13.1-beta.0",
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						},
						{ etag: '"etag-cli-update-13"' },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(process.exitCode ?? 0).toBe(0);
			expect(captured).toHaveLength(1);
			const active = join(state, "bin", "clawdi");
			const sharedPrefixTarget = join(state, "npm", "bin", "clawdi");
			const activeTarget = readlinkSync(active);
			expect(readlinkSync(active)).toBe(activeTarget);
			const status = JSON.parse(readFileSync(join(state, "status", "cli-bootstrap.json"), "utf-8"));
			expect(status.packageSpec).toBe("clawdi@0.13.1-beta.0");
			expect(status.activePath).toBe(active);
			expect(status.activeTarget).toBe(activeTarget);
			expect(status.npmPrefix.startsWith(join(state, "npm", "packages"))).toBe(true);
			expect(activeTarget).toBe(join(status.npmPrefix, "bin", "clawdi"));
			expect(activeTarget).not.toBe(sharedPrefixTarget);
			expect(status.version).toBe("0.13.1-beta.0");
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.selfReexec).toBe(true);
			expect(event.cliUpdate.status).toBe("installed");
			expect(event.cliUpdate.packageSpec).toBe("clawdi@0.13.1-beta.0");
			expect(event.systemdUnitsChanged).toBe(true);
			expect(event.systemdApply).toEqual({
				applied: false,
				systemUnitsChanged: ["clawdi-runtime-watch.service"],
				userUnitsChanged: ["openclaw-gateway.service"],
			});
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime watch reapplies transparent egress across CLI self-upgrade", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl.log");
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
  echo "0.13.2-beta.0"
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
		writeFileSync(
			join(bin, "systemctl"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${systemctlLog}'
printf 'ActiveState=active\\nSubState=running\\n'
`,
		);
		chmodSync(join(bin, "npm"), 0o700);
		chmodSync(join(bin, "systemctl"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const paths = getRuntimePaths();
		seedCurrentCliInstall(state, "clawdi@0.13.1-beta.0", "0.13.1-beta.0");
		const mitmproxy = seedMitmproxyCache(paths);
		convergeRuntimeManifest(
			{
				source: "fixture-file",
				sourcePath: "test://self-upgrade-egress-before",
				offline: false,
				secretValues: {
					"provider.default.apiKey": "sk-before-upgrade",
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
						openclaw: { enabled: true },
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
								apiKeySecretRef: "provider.default.apiKey",
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
								minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
									packageSpec: "clawdi@0.13.2-beta.0",
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
										runtimeEnvName: "OPENAI_API_KEY",
										apiKeySecretRef: "provider.default.apiKey",
									},
								},
							},
							secretValues: {
								"provider.default.apiKey": "sk-after-upgrade",
							},
						},
						{ etag: '"etag-cli-egress-2"' },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.selfReexec).toBe(true);
			expect(event.systemdApply.applied).toBe(true);
			expect(event.systemdApply.systemUnitsChanged).toContain("clawdi-runtime-sidecar.service");
			const systemctlCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			expect(systemctlCalls).toContain("restart clawdi-runtime-sidecar.service");
			const sidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
			const sidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
			const transparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
			expect(sidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
			expect(sidecarEnv).toContain('CLAWDI_RUNTIME_REV="');
			expect(sidecarUnit).toContain('ExecStart="clawdi" "runtime" "sidecar"');
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
		["upgrades", "0.12.10-beta.48", "0.12.10-beta.49"],
		["downgrades", "0.12.10-beta.50", "0.12.10-beta.49"],
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
			const desired = normalizeManifestPayload(hostedCliManifestResponse(home, desiredSpec));
			const result = applyRuntimeCliDesiredState(desired.manifest, getRuntimePaths());

			expect(result.status).toBe("installed");
			expect(result.packageSpec).toBe(desiredSpec);
			expect(result.version).toBe(desiredVersion);
			const npmCalls = readFileSync(npmLog, "utf-8").trim().split("\n");
			expect(npmCalls.some((call) => call.startsWith("view "))).toBe(false);
			expect(npmCalls.some((call) => call.includes(desiredSpec))).toBe(true);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("recovers an exact CLI install when matching bootstrap status has no version", () => {
		const desiredVersion = "0.12.10-beta.49";
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
			const desired = normalizeManifestPayload(hostedCliManifestResponse(home, desiredSpec));
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
		const desiredVersion = "0.12.10-beta.49";
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
			const desired = normalizeManifestPayload(hostedCliManifestResponse(home, desiredSpec));
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
		const desiredVersion = "0.12.10-beta.49";
		const actualVersion = "0.12.10-beta.48";
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
			"clawdi@0.12.10-beta.47",
			"0.12.10-beta.47",
			"https://registry.npmjs.org",
		);
		const paths = getRuntimePaths();
		const oldTarget = readlinkSync(paths.cliManagedBin);
		const oldStatus = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));

		try {
			const desired = normalizeManifestPayload(hostedCliManifestResponse(home, desiredSpec));
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

	it("runtime watch self-heal applies an exact hosted CLI version without npm view", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
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
	  echo "0.13.0-test"
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const paths = getRuntimePaths();
		seedCurrentCliInstall(
			state,
			"clawdi@0.12.10-beta.49",
			"0.12.10-beta.49",
			"https://registry.npmjs.org",
		);
		const manifestPayload = {
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
					packageSpec: "clawdi@0.13.0-test",
					registry: "https://registry.npmjs.org",
				},
				runtimes: { openclaw: hostedOpenClawRuntime() },
			},
			secretValues: {},
		};
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: "iid_cli_self_heal",
				etag: '"manifest-self-heal"',
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
								headers: { etag: '"manifest-self-heal"' },
							})
						: hostedRuntimeBundleResponse(manifestPayload, {
								etag: '"manifest-self-heal"',
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
			expect(captured[0].headers["if-none-match"]).toBe('"manifest-self-heal"');
			expect(captured[1].headers["if-none-match"]).toBeUndefined();
			const events = logs.map((line) => JSON.parse(line));
			expect(events.map((event) => event.status)).toEqual(["not_modified", "applied"]);
			expect(events[1].cliUpdate).toEqual(
				expect.objectContaining({
					status: "installed",
					packageSpec: "clawdi@0.13.0-test",
					version: "0.13.0-test",
				}),
			);
			expect(events[1].selfReexec).toBe(true);
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

	it("runtime watch keeps self re-exec when convergence fails after CLI install", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
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
  echo "0.13.3-beta.0"
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
install -d "$HOME/.openclaw/bin"
cat > "$HOME/.openclaw/bin/openclaw" <<'SH'
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
chmod +x "$HOME/.openclaw/bin/openclaw"
`,
		);
		chmodSync(openclawInstaller, 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = openclawInstaller;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
									packageSpec: "clawdi@0.13.3-beta.0",
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime({
										paths: { home },
									}),
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
						{ etag: '"etag-projection-failed"' },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.cliUpdate.status).toBe("installed");
			expect(event.selfReexec).toBe(true);
			expect(event.errors[0]).toContain("runtime openclaw provider projection failed");
			expect(event.errors[0]).toContain("projection boom");
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
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
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
		const npmLog = join(root, "npm.log");
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
printf '%s\\n' "$*" >> '${npmLog}'
if [ "\${1:-}" = "view" ]; then
  echo '"0.13.5-beta.0"'
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
  echo "0.13.5-beta.0"
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = openclawInstaller;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		seedCurrentCliInstall(state, "clawdi@0.13.4-beta.0", "0.13.4-beta.0");
		const paths = getRuntimePaths();
		const oldTarget = readlinkSync(paths.cliManagedBin);
		const manifest = {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
				packageSpec: "clawdi@0.13.5-beta.0",
				registry: "https://registry.npmjs.org",
			},
			runtimes: {
				openclaw: hostedOpenClawRuntime({
					paths: { home },
				}),
			},
		};
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: "iid_cli_rollback",
				etag: '"etag-cli-rollback"',
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
						{ etag: '"etag-cli-rollback"' },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.cliUpdate.status).toBe("installed");
			expect(event.cliRollback.status).toBe("rolled_back");
			expect(event.cliRollback.version).toBe("0.13.5-beta.0");
			expect(event.selfReexec).toBe(false);
			expect(readlinkSync(paths.cliManagedBin)).toBe(oldTarget);
			const upgradeState = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8"));
			expect(upgradeState.pendingUpgrade).toBeNull();
			expect(upgradeState.badVersions).toContainEqual(
				expect.objectContaining({
					packageSpec: "clawdi@0.13.5-beta.0",
					version: "0.13.5-beta.0",
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
							packageSpec: "clawdi@0.13.5-beta.0",
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

	it("runtime watch does not converge or apply systemd when CLI install fails", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
		writeFileSync(join(bin, "npm"), "#!/usr/bin/env bash\necho npm down >&2\nexit 42\n");
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
									packageSpec: "clawdi@0.13.4-beta.0",
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						},
						{ etag: '"etag-cli-failed"' },
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
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runs CLI update before blocking desired state below minimumCliVersion", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
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
  echo "0.13.10-beta.0"
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
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
								deploymentId: "dep_min_cli",
								environmentId: "env_min_cli",
								...hostedRequiredState(),
								instanceId: "iid_min_cli",
								generation: 19,
								minimumCliVersion: "999.0.0",
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: "clawdi@0.13.10-beta.0",
									registry: "https://registry.npmjs.org",
								},
								runtimes: { openclaw: hostedOpenClawRuntime() },
							},
							secretValues: {},
						},
						{ etag: '"etag-min-cli"' },
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.stage).toBe("config");
			expect(event.mode).toBe("minimum_cli_version_gated");
			expect(event.cliUpdate.status).toBe("installed");
			expect(event.selfReexec).toBe(true);
			expect(event.gate.minimumCliVersion).toBe("999.0.0");
			const paths = getRuntimePaths();
			expect(existsSync(paths.manifestLastGood)).toBe(false);
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
		seedCurrentCliInstall(state, "clawdi@0.13.1-beta.0", "0.13.1-beta.0");
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
				packageSpec: "clawdi@0.13.2-beta.0",
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
  echo "0.13.2-beta.1"
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
		seedCurrentCliInstall(state, "clawdi@0.13.1-beta.0", "0.13.1-beta.0");
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
				packageSpec: "clawdi@0.13.2-beta.1",
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
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@0.13.2-beta.0" },
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
						packageSpec: "clawdi@0.13.2-beta.0",
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
  echo "0.13.6-beta.0"
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
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@0.13.6-beta.0" },
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
			expect(status.packageSpec).toBe("clawdi@0.13.6-beta.0");
			expect(status.activeTarget).toBe(readlinkSync(paths.cliManagedBin));
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
			applyRuntimeCliDesiredState(manifestFor("clawdi@0.13.7-beta.0"), paths);
			applyRuntimeCliDesiredState(manifestFor("clawdi@0.13.8-beta.0"), paths);
			applyRuntimeCliDesiredState(manifestFor("clawdi@0.13.9-beta.0"), paths);
			const packageDirs = readdirSync(join(state, "npm", "packages")).sort();

			expect(packageDirs).toHaveLength(2);
			const status = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			expect(readlinkSync(paths.cliManagedBin)).toBe(status.activeTarget);
			expect(packageDirs.map((entry) => join(state, "npm", "packages", entry))).toContain(
				status.npmPrefix,
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime init applies remote channel desired state during first boot", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const policyPath = join(root, "etc", "clawdi", "host-policy.json");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-channel-patch.json");
		const openclawPluginInstalls = join(root, "openclaw-plugin-installs.txt");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(join(home, ".openclaw", "bin"), { recursive: true });
		mkdirSync(join(root, "etc", "clawdi"), { recursive: true });
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
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_HOST_POLICY_PATH = policyPath;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, "clawdi@0.13.0-test", "0.13.0-test", "https://registry.npmjs.org");
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
									packageSpec: "clawdi@0.13.0-test",
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
						{ etag: '"manifest-etag-init-7"' },
					),
			},
		]);

		try {
			await runtimeInit({ nonInteractive: true, json: true });

			expect(process.exitCode).toBe(0);
			expect(captured).toHaveLength(1);
			expect(captured[0].path).toBe("/v1/runtime/manifest");
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				etag: '"manifest-etag-init-7"',
				generation: 7,
			});
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
			expect(existsSync(join(state, "cache", "channels.etag"))).toBe(false);
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
			expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe("@openclaw/discord\n");
			const openclawRunConfig = JSON.parse(
				readFileSync(join(state, "config", "run", "openclaw.json"), "utf-8"),
			);
			expect(openclawRunConfig.secretEnv).toMatchObject({
				CLAWDI_CHANNEL_TELEGRAM_CLAWDI_ACCTTELEGRAM_AGENT_TOKEN:
					"secret://channels/telegram/clawdi_accttelegram/placeholder-token",
				CLAWDI_CHANNEL_DISCORD_CLAWDI_ACCTDISCORD1_AGENT_TOKEN:
					"secret://channels/discord/clawdi_acctdiscord1/placeholder-token",
			});
			const secretsText = readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8");
			expect(secretsText).toContain("secret://channels/telegram/");
			expect(secretsText).toContain("placeholder-token");
			expect(secretsText).toContain("999999999:");
			expect(secretsText).not.toContain("agent-token-init");
			expect(secretsText).toContain("secret://channels/discord/");
			expect(secretsText).toContain("clawdi_");
			expect(secretsText).not.toContain("discord-agent-token-init");
			const egressSecretsText = readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8");
			expect(egressSecretsText).toContain("agent-token-init");
			expect(egressSecretsText).toContain("discord-agent-token-init");
			const cachedManifestText = readFileSync(
				join(state, "cache", "manifest.last-good.json"),
				"utf-8",
			);
			expect(cachedManifestText).toContain('"channels"');
			expect(cachedManifestText).not.toContain("agent-token-init");
			expect(cachedManifestText).not.toContain("discord-agent-token-init");
			const cachedSecretsText = readFileSync(
				join(state, "cache", "runtime-secrets.last-good.json"),
				"utf-8",
			);
			expect(cachedSecretsText).toContain("placeholder-token");
			expect(cachedSecretsText).toContain("999999999:");
			expect(cachedSecretsText).toContain("clawdi_");
			expect(cachedSecretsText).not.toContain("agent-token-init");
			expect(cachedSecretsText).not.toContain("discord-agent-token-init");
			const profileBundle = readFileSync(join(state, "config", "egress", "profiles.json"), "utf-8");
			expect(profileBundle).toContain("clawdi-native-channels");
			expect(profileBundle).toContain("/v1/channels/telegram");
			expect(profileBundle).toContain("replacementSecretRef");
			expect(profileBundle).toContain("placeholder-token");
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
		const workspace = join(home, "clawdi");
		const bundle = JSON.parse(
			readFileSync(
				join(import.meta.dir, "../../../test-fixtures/runtime-bundle-v2.golden.json"),
				"utf-8",
			),
		) as {
			manifest: {
				runtime: string;
				system: {
					home: string;
					workspace: string;
					persistentPaths: string[];
				};
				runtimes: Record<string, { paths: { home: string; workspace: string } }>;
			};
			channelBindings: Array<{ agentTokenSecretRef: string }>;
			secretValues: Record<string, string>;
		};
		const selectedRuntime = bundle.manifest.runtimes[bundle.manifest.runtime];
		if (!selectedRuntime) throw new Error("golden bundle has no selected runtime");
		bundle.manifest.system.home = home;
		bundle.manifest.system.workspace = workspace;
		bundle.manifest.system.persistentPaths = [home];
		selectedRuntime.paths.home = home;
		selectedRuntime.paths.workspace = workspace;
		const missingSecretRef = bundle.channelBindings[0]?.agentTokenSecretRef;
		if (!missingSecretRef) throw new Error("golden bundle has no channel binding");
		delete bundle.secretValues[missingSecretRef];

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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
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
							etag: '"bundle-malformed-channel-ref"',
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

	it("converges Hermes native Telegram and Discord channel projection", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const hermesBin = join(home, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesBin), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(hermesBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";

		const load: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "hermes",
				deploymentId: "dep_hermes_channels",
				environmentId: "env_hermes_channels",
				instanceId: "iid_hermes_channels",
				generation: 12,
				issuedAt: "2026-07-07T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test/" },
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
			source: "fixture-file",
			sourcePath: "test://hermes-channels",
			offline: false,
			secretValues: {},
		};
		const channels: RuntimeChannelsLoad = {
			channels: [
				{
					id: "acct-telegram-hermes",
					provider: "telegram",
					name: "Hermes Telegram",
					status: "active",
					visibility: "private",
					runtime_links: [
						{
							id: "link-telegram-hermes",
							account_id: "acct-telegram-hermes",
							agent_id: "env_hermes_channels",
							status: "active",
							agent_token: "123456789:telegram-agent-token",
						},
					],
				},
				{
					id: "acct-discord-hermes",
					provider: "discord",
					name: "Hermes Discord",
					status: "active",
					visibility: "private",
					runtime_links: [
						{
							id: "link-discord-hermes",
							account_id: "acct-discord-hermes",
							agent_id: "env_hermes_channels",
							status: "active",
							agent_token: "discord-agent-token",
						},
					],
				},
			],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/v1/channels",
			etag: '"hermes-channels"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(load, channels);
		const convergence = convergeRuntimeManifest(projected, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const hermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(hermesConfig).toContain("telegram:");
		expect(hermesConfig).toContain("enabled: true");
		expect(hermesConfig).toContain("base_url: https://cloud-api.test/v1/channels/telegram/bot");
		expect(hermesConfig).toContain(
			"base_file_url: https://cloud-api.test/v1/channels/telegram/file/bot",
		);
		expect(hermesConfig).toContain("discord:");
		expect(hermesConfig).toContain("thread_require_mention: false");
		expect(hermesConfig).not.toContain("telegram-agent-token");
		expect(hermesConfig).not.toContain("discord-agent-token");

		const runConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
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
		const profileBundle = readFileSync(join(state, "config", "egress", "profiles.json"), "utf-8");
		expect(profileBundle).toContain("/v1/channels/telegram");
		expect(profileBundle).toContain("/v1/channels/discord");
	});

	it("keeps Hermes native WhatsApp disabled until upstream websocket support is ready", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const hermesBin = join(home, ".local", "bin", "hermes");
		const accountId = "00000000-0000-0000-0000-000000000001";
		const accountKey = "clawdi_000000000000";
		const credentialId = "credential-whatsapp-hermes";
		const credentialSecretRef = `secret://channels/whatsapp/${accountKey}/credentials/${credentialId}/creds-json`;
		const sessionDir = join(home, ".hermes", "platforms", "whatsapp", "session");
		const creds = {
			advSecretKey: "wa-hermes-secret",
			me: { id: "15551234567:1@s.whatsapp.net" },
		};
		mkdirSync(dirname(hermesBin), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(hermesBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";

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
			source: "fixture-file",
			sourcePath: "test://hermes-whatsapp",
			offline: false,
			secretValues: {},
		};
		const channels: RuntimeChannelsLoad = {
			channels: [
				{
					id: accountId,
					provider: "whatsapp",
					name: "Hermes WhatsApp",
					status: "active",
					visibility: "private",
					runtime_links: [
						{
							id: "link-whatsapp-hermes",
							account_id: accountId,
							agent_id: "env_hermes_whatsapp",
							status: "active",
							agent_token: "wa-hermes-agent-token",
						},
					],
					runtime_credentials: [
						{
							id: credentialId,
							account_id: accountId,
							agent_link_id: "link-whatsapp-hermes",
							agent_id: "env_hermes_whatsapp",
							provider: "whatsapp",
							kind: "whatsapp_baileys_auth_state",
							created_at: "2026-07-07T00:00:00Z",
							jid: "15551234567:1@s.whatsapp.net",
							identity_pub_key_hex: "aabbcc",
							material: {
								schemaVersion: "clawdi.whatsappBaileysAuthState.v1",
								creds,
							},
						},
					],
				},
			],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/v1/channels",
			etag: '"hermes-whatsapp"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(load, channels);
		const credentialProjection = projected.manifest.projection?.channelCredentials as unknown[];
		expect(credentialProjection).toEqual([]);
		expect(JSON.stringify(projected.manifest)).not.toContain("wa-hermes-secret");
		expect(projected.secretValues?.[credentialSecretRef]).toBeUndefined();
		expect(JSON.stringify(projected.secretValues ?? {})).not.toContain("wa-hermes-secret");

		const convergence = convergeRuntimeManifest(projected, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(existsSync(sessionDir)).toBe(false);
		const hermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(hermesConfig).toContain("whatsapp:");
		expect(hermesConfig).toContain("enabled: false");
		expect(hermesConfig).not.toContain(`session_path: ${sessionDir}`);
		expect(hermesConfig).not.toContain(
			"/v1/channels/whatsapp/00000000-0000-0000-0000-000000000001/baileys",
		);
		expect(hermesConfig).not.toContain("wa-hermes-secret");

		const runConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
		);
		expect(runConfig.env.HERMES_EXISTING_ENV).toBe("kept");
		expect(runConfig.env.WHATSAPP_ENABLED).toBeUndefined();
		expect(runConfig.env.WHATSAPP_MODE).toBeUndefined();
		expect(runConfig.env.WHATSAPP_ALLOWED_USERS).toBeUndefined();
		expect(runConfig.secretEnv.HERMES_WA_CREDS_JSON).toBeUndefined();
		expect(JSON.stringify(runConfig)).not.toContain("wa-hermes-secret");
		const hermesEnv = readSystemdEnvFile(getRuntimePaths(), "hermes-gateway");
		expect(hermesEnv).not.toContain("WHATSAPP_ENABLED");
		expect(hermesEnv).not.toContain("WHATSAPP_MODE");
		expect(hermesEnv).not.toContain("WHATSAPP_ALLOWED_USERS");
		expect(hermesEnv).not.toContain("HERMES_WA_CREDS_JSON");
		expect(hermesEnv).not.toContain("wa-hermes-secret");

		const removed = convergeRuntimeManifest(
			applyRuntimeChannelsToManifestLoad(load, {
				channels: [],
				source: "remote-datasource",
				sourcePath: "https://runtime.test/v1/channels",
				etag: '"empty-hermes-whatsapp"',
			}),
			getRuntimePaths(),
		);

		expect(removed.installErrors).toEqual([]);
		expect(existsSync(sessionDir)).toBe(false);
		const clearedConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(clearedConfig).toContain("whatsapp:");
		expect(clearedConfig).toContain("enabled: false");
		expect(clearedConfig).not.toContain(sessionDir);
		const clearedRunConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
		);
		expect(clearedRunConfig.env.WHATSAPP_ENABLED).toBeUndefined();
		expect(clearedRunConfig.secretEnv.HERMES_WA_CREDS_JSON).toBeUndefined();
		expect(readSystemdEnvFile(getRuntimePaths(), "hermes-gateway")).not.toContain(
			"HERMES_WA_CREDS_JSON",
		);
	});

	it("clears Hermes native channel settings when no channel links are active", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const hermesBin = join(home, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesBin), { recursive: true });
		mkdirSync(join(home, ".hermes"), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 0\n");
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"telegram:",
				"  enabled: true",
				"discord:",
				"  enabled: true",
				"  stale: should-be-removed",
				"whatsapp:",
				"  enabled: true",
				"  stale: should-be-removed",
				"platforms:",
				"  whatsapp:",
				"    enabled: true",
				"    extra:",
				"      session_path: /stale/session",
				"",
			].join("\n"),
		);
		chmodSync(hermesBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";

		const load: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "hermes",
				deploymentId: "dep_hermes_channel_clear",
				environmentId: "env_hermes_channel_clear",
				instanceId: "iid_hermes_channel_clear",
				generation: 13,
				issuedAt: "2026-07-07T00:00:00Z",
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
						run: {
							args: ["gateway", "run", "--replace"],
							env: {
								HERMES_EXISTING_ENV: "kept",
								TELEGRAM_ALLOW_ALL_USERS: "true",
								DISCORD_ALLOW_ALL_USERS: "true",
								WHATSAPP_ENABLED: "true",
								WHATSAPP_MODE: "bot",
								WHATSAPP_ALLOWED_USERS: "*",
							},
							secretEnv: {
								TELEGRAM_BOT_TOKEN: "secret://channels/telegram/clawdi_stale/agent-token",
								DISCORD_BOT_TOKEN: "secret://channels/discord/clawdi_stale/agent-token",
								HERMES_WA_CREDS_JSON:
									"secret://channels/whatsapp/clawdi_stale/credentials/stale/creds-json",
							},
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
			source: "fixture-file",
			sourcePath: "test://hermes-channel-clear",
			offline: false,
			secretValues: {},
		};
		const projected = applyRuntimeChannelsToManifestLoad(load, {
			channels: [],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/v1/channels",
			etag: '"empty-hermes-channels"',
		});

		const convergence = convergeRuntimeManifest(projected, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const hermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(hermesConfig).toContain("telegram:");
		expect(hermesConfig).toContain("discord:");
		expect(hermesConfig).toContain("whatsapp:");
		expect(hermesConfig).toContain("enabled: false");
		expect(hermesConfig).not.toContain("stale: should-be-removed");
		expect(hermesConfig).not.toContain("/stale/session");
		const runConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
		);
		expect(runConfig.env.HERMES_EXISTING_ENV).toBe("kept");
		expect(runConfig.env.TELEGRAM_ALLOW_ALL_USERS).toBeUndefined();
		expect(runConfig.env.DISCORD_ALLOW_ALL_USERS).toBeUndefined();
		expect(runConfig.env.WHATSAPP_ENABLED).toBeUndefined();
		expect(runConfig.env.WHATSAPP_MODE).toBeUndefined();
		expect(runConfig.env.WHATSAPP_ALLOWED_USERS).toBeUndefined();
		expect(runConfig.secretEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
		expect(runConfig.secretEnv.DISCORD_BOT_TOKEN).toBeUndefined();
		expect(runConfig.secretEnv.HERMES_WA_CREDS_JSON).toBeUndefined();
		const hermesEnv = readSystemdEnvFile(getRuntimePaths(), "hermes-gateway");
		expect(hermesEnv).not.toContain("TELEGRAM_BOT_TOKEN");
		expect(hermesEnv).not.toContain("DISCORD_BOT_TOKEN");
		expect(hermesEnv).not.toContain("HERMES_WA_CREDS_JSON");
		expect(hermesEnv).not.toContain("WHATSAPP_ENABLED");
	});

	it("converges empty native channel projection with merge-patch deletes", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-channel-delete-patch.jsonl");
		mkdirSync(join(home, ".openclaw", "bin"), { recursive: true });
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
if [ "\${1:-}" = "plugins" ] && [ "\${2:-}" = "install" ]; then
  echo "plugin install should not run for empty channels" >&2
  exit 64
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
					channels: {},
				},
				recovery: {},
			},
			source: "fixture-file",
			sourcePath: "test://channel-delete",
			offline: false,
			secretValues: {},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const patchText = readFileSync(openclawPatch, "utf-8");
		expect(patchText).toContain('"telegram": null');
		expect(patchText).toContain('"discord": null');
		expect(patchText).toContain('"whatsapp": null');
		expect(patchText).not.toContain("bluebubbles");
		expect(patchText).not.toContain('"$patch"');
		expect(patchText).not.toContain('"botToken"');
	});

	it("does not mutate live config when an OpenClaw channel plugin install fails", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
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
			source: "fixture-file",
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

	it("keeps OpenClaw WhatsApp materialization disabled until upstream support is ready", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const accountKey = "clawdi_whatsapp_runtime";
		const accountId = "00000000-0000-0000-0000-000000000001";
		const authDir = join(home, ".openclaw", "credentials", "whatsapp", accountKey);
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-whatsapp-auth-patch.jsonl");
		const openclawPluginInstalls = join(root, "openclaw-whatsapp-plugin-installs.txt");
		mkdirSync(dirname(openclawBin), { recursive: true });
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
										wsUrl: `wss://cloud-api.test/v1/channels/whatsapp/${accountId}/baileys`,
										token: "wa-runtime-agent-token",
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
				source: "fixture-file",
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
			source: "fixture-file",
			sourcePath: "test://whatsapp-auth-state-unlinked",
			offline: false,
			secretValues: {},
		};

		const initialCreds = {
			advSecretKey: "wa-materialized-secret",
			me: { id: "15551234567:1@s.whatsapp.net" },
			noiseKey: { private: { type: "Buffer", data: "AQID" } },
		};
		const rotatedCreds = {
			advSecretKey: "wa-rotated-secret",
			me: { id: "15557654321:1@s.whatsapp.net" },
			noiseKey: { private: { type: "Buffer", data: "BAUG" } },
		};

		const initial = convergeRuntimeManifest(
			manifestWithCredential("credential-whatsapp-1", initialCreds, 10),
			getRuntimePaths(),
		);
		const rotated = convergeRuntimeManifest(
			manifestWithCredential("credential-whatsapp-2", rotatedCreds, 11),
			getRuntimePaths(),
		);

		expect(initial.installErrors).toEqual([]);
		expect(rotated.installErrors).toEqual([]);
		const patchText = readFileSync(openclawPatch, "utf-8");
		expect(patchText).toContain('"whatsapp": null');
		expect(patchText).not.toContain('"wsUrl"');
		expect(patchText).not.toContain('"authDir"');
		expect(patchText).not.toContain(authDir);
		expect(patchText).not.toContain("wa-runtime-agent-token");
		expect(patchText).not.toContain("wa-materialized-secret");
		expect(patchText).not.toContain("wa-rotated-secret");
		expect(existsSync(openclawPluginInstalls)).toBe(false);
		expect(existsSync(authDir)).toBe(false);

		const removed = convergeRuntimeManifest(unlinkedManifest, getRuntimePaths());

		expect(removed.installErrors).toEqual([]);
		expect(existsSync(authDir)).toBe(false);
	});

	it("removes stale OpenClaw WhatsApp auth state while upstream support is gated", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const accountKey = "clawdi_missing_whatsapp";
		const authDir = join(home, ".openclaw", "credentials", "whatsapp", accountKey);
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
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
									wsUrl: "wss://cloud-api.test/v1/channels/whatsapp/account/baileys",
									token: "wa-runtime-agent-token",
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
			source: "fixture-file",
			sourcePath: "test://whatsapp-missing-secret",
			offline: false,
			secretValues: {},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(existsSync(authDir)).toBe(false);
		const patchText = readFileSync(openclawPatch, "utf-8");
		expect(patchText).toContain('"whatsapp": null');
		expect(patchText).not.toContain('"wsUrl"');
		expect(patchText).not.toContain("wa-runtime-agent-token");
		expect(existsSync(openclawPluginInstalls)).toBe(false);
		expect(JSON.stringify(convergence.manifest)).not.toContain("stale-whatsapp-secret");
	});

	it("removes stale native channels when a later projection omits them", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-channel-remove-patch.jsonl");
		const openclawPluginInstalls = join(root, "openclaw-plugin-installs.txt");
		mkdirSync(join(home, ".openclaw", "bin"), { recursive: true });
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
			source: "fixture-file",
			sourcePath: `test://channel-remove-${generation}`,
			offline: false,
			secretValues: {},
		});

		const initial = convergeRuntimeManifest(
			manifestWithChannels(
				{
					telegram: { enabled: true, botToken: "telegram-token" },
					discord: { enabled: true, token: "discord-token" },
				},
				1,
			),
			getRuntimePaths(),
		);
		const removed = convergeRuntimeManifest(
			manifestWithChannels({ telegram: { enabled: true, botToken: "telegram-token" } }, 2),
			getRuntimePaths(),
		);

		expect(initial.installErrors).toEqual([]);
		expect(removed.installErrors).toEqual([]);
		const patches = readFileSync(openclawPatch, "utf-8")
			.split("\n---\n")
			.filter((entry) => entry.trim().length > 0)
			.map((entry) => JSON.parse(entry));
		expect(patches).toHaveLength(2);
		expect(patches[0].channels.discord).toEqual({ enabled: true, token: "discord-token" });
		expect(patches[1].channels.discord).toBeNull();
		expect(patches[1].plugins.entries.discord).toBeNull();
		expect(patches[1].channels.telegram).toEqual({
			enabled: true,
			botToken: "telegram-token",
		});
		expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe("@openclaw/discord\n");
	});

	it("treats already-installed OpenClaw channel plugins as converged", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-channel-patch.json");
		const openclawPluginInstalls = join(root, "openclaw-plugin-installs.txt");
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
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
			source: "fixture-file",
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

	it("uses explicit hosted workspaces when converging run config and systemd units", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "custom-workspace");
		writeHermesVersionBinary(home, "0.18.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/v1/runtime/manifest";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
							runtime: "hermes",
							deploymentId: "dep_workspace",
							environmentId: "env_workspace",
							...hostedRequiredState(),
							instanceId: "iid_workspace",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home, workspace),
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: "clawdi@0.13.0-test",
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								hermes: hostedHermesRuntime({
									paths: { home, workspace },
								}),
							},
							bridge: { surfaces: [hostedHermesBridgeSurface()] },
						},
						secretValues: {},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			const hermesRunConfig = JSON.parse(
				readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
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

	it("converges future runtimes from explicit run commands without image-level runtime wrappers", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "future-runtime.json");
		const futureBin = join(home, "tools", "future-agent");
		mkdirSync(dirname(futureBin), { recursive: true });
		writeFileSync(futureBin, "#!/bin/sh\nexit 0\n");
		chmodSync(futureBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_future_runtime",
				environmentId: "env_future_runtime",
				instanceId: "iid_future_runtime",
				generation: 1,
				issuedAt: "2026-06-29T00:00:00Z",
				workspaceRoot: join(home, "workspace"),
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					"future-agent": {
						enabled: true,
						run: {
							command: futureBin,
							args: ["serve", "--host", "127.0.0.1"],
							env: { FUTURE_AGENT_MODE: "hosted" },
						},
					},
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const runConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "future-agent.json"), "utf-8"),
		);
		expect(runConfig.command).toBe(futureBin);
		expect(runConfig.commandPath).toBeNull();
		expect(runConfig.defaultArgs).toEqual(["serve", "--host", "127.0.0.1"]);
		expect(runConfig.env).toEqual({ FUTURE_AGENT_MODE: "hosted" });
		expect(existsSync(join(state, "bin", "future-agent"))).toBe(false);
		expect(existsSync(join(state, "bin", ".clawdi-runtime-command-shim"))).toBe(false);
		const paths = getRuntimePaths();
		const futureUnit = readSystemdUserUnit(paths, "clawdi-future-agent");
		const futureEnv = readSystemdEnvFile(paths, "clawdi-future-agent");
		expect(convergence.outputs.systemdUserUnits).toContain(
			join(paths.systemdUserRoot, "clawdi-future-agent.service"),
		);
		expect(futureUnit).toContain(`ExecStart="${futureBin}" "serve" "--host" "127.0.0.1"`);
		expect(futureUnit).not.toContain("clawdi run -- future-agent");
		expect(futureEnv).toContain('FUTURE_AGENT_MODE="hosted"');
		expect(existsSync(join(run, "launch", "future-agent.sh"))).toBe(false);
		expect(existsSync(join(run, "launch", "future-agent.env"))).toBe(false);
		expect(convergence.outputs.systemdUserUnits).not.toContain(
			join(paths.systemdUserRoot, "clawdi-runtime-bridge.service"),
		);
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
					minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
						packageSpec: "clawdi@0.13.0-test",
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						hermes: hostedHermesRuntime(),
					},
					bridge: { surfaces: [hostedHermesBridgeSurface()] },
				},
				secretValues: {},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
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

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain(`manifest.${field}`);
	});

	it("uses hosted runtime workspace paths even without explicit run settings", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const runtimeWorkspace = join(home, "hermes-workspace");
		const manifestPath = join(root, "runtime-workspace.json");
		writeHermesVersionBinary(home, "0.18.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
					runtime: "hermes",
					deploymentId: "dep_runtime_workspace",
					environmentId: "env_runtime_workspace",
					...hostedRequiredState(),
					instanceId: "iid_runtime_workspace",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home, join(home, "system-workspace")),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: "clawdi@0.13.0-test",
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						hermes: hostedHermesRuntime({
							paths: { workspace: runtimeWorkspace },
						}),
					},
					bridge: { surfaces: [hostedHermesBridgeSurface()] },
				},
				secretValues: {},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
		const hermesRunConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
		);
		const hermesDashboardRunConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "hermes+dashboard.json"), "utf-8"),
		);

		expect(convergence.outputs.workspaceRoot).toBe(join(home, "system-workspace"));
		expect(hermesRunConfig.cwd).toBe(runtimeWorkspace);
		expect(hermesRunConfig.defaultArgs).toEqual(["gateway", "run", "--replace"]);
		expect(hermesDashboardRunConfig.cwd).toBe(runtimeWorkspace);
		expect(hermesDashboardRunConfig.defaultArgs).toEqual([
			"dashboard",
			"--host",
			"127.0.0.1",
			"--port",
			"9119",
			"--no-open",
		]);
	});

	it("projects hosted MCP desired state into OpenClaw and Hermes config", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const manifestPath = join(root, "runtime-mcp.json");
		const openclawBin = join(home, ".openclaw", "bin", "openclaw");
		const hermesBin = join(home, ".local", "bin", "hermes");
		const openclawMcp = join(root, "openclaw-mcp.json");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(dirname(hermesBin), { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "set" ] && [ "\${3:-}" = "clawdi" ]; then
  printf '%s\\n' "\${4:-}" > '${openclawMcp}'
  exit 0
fi
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "unset" ] && [ "\${3:-}" = "clawdi" ]; then
  rm -f '${openclawMcp}'
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
		);
		writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(openclawBin, 0o700);
		chmodSync(hermesBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "deploy-key-secret";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_mcp",
				environmentId: "env_mcp",
				instanceId: "iid_mcp",
				generation: 3,
				issuedAt: "2026-06-06T00:00:00Z",
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
				projection: {
					system: { home, workspace },
					mcp: { enabled: true, profile: "clawdi-default" },
					tools: { catalog: "clawdi-default" },
				},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const authTokenFile = join(run, "secrets", "auth-token");
		const openclawConfig = JSON.parse(readFileSync(openclawMcp, "utf-8"));
		expect(openclawConfig.command).toBe("clawdi");
		expect(openclawConfig.args).toEqual([
			"mcp",
			"--api-url",
			"https://cloud-api.test",
			"--auth-token-file",
			authTokenFile,
		]);
		expect(JSON.stringify(openclawConfig)).not.toContain("deploy-key-secret");
		const hermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(hermesConfig).toContain("mcp_servers:");
		expect(hermesConfig).toContain("clawdi:");
		expect(hermesConfig).toContain("command: clawdi");
		expect(hermesConfig).toContain("- mcp");
		expect(hermesConfig).toContain("- --api-url");
		expect(hermesConfig).toContain("- https://cloud-api.test");
		expect(hermesConfig).toContain("- --auth-token-file");
		expect(hermesConfig).toContain(authTokenFile);
		expect(hermesConfig).not.toContain("deploy-key-secret");
		const mcpProjection = JSON.parse(
			readFileSync(join(state, "config", "projections", "clawdi-mcp.json"), "utf-8"),
		);
		expect(mcpProjection.projection.mcp).toEqual({
			enabled: true,
			profile: "clawdi-default",
		});
		expect(mcpProjection.projection.tools).toEqual({ catalog: "clawdi-default" });

		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_mcp",
				environmentId: "env_mcp",
				instanceId: "iid_mcp",
				generation: 4,
				issuedAt: "2026-06-06T00:00:00Z",
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
				projection: {
					system: { home, workspace },
					mcp: { enabled: false },
				},
			}),
		);
		const disabled = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });
		expect("manifest" in disabled).toBe(true);
		if (!("manifest" in disabled)) throw new Error("expected disabled manifest load success");
		const disabledConvergence = convergeRuntimeManifest(disabled, getRuntimePaths());

		expect(disabledConvergence.installErrors).toEqual([]);
		expect(existsSync(openclawMcp)).toBe(false);
		expect(readFileSync(join(home, ".hermes", "config.yaml"), "utf-8")).not.toContain("clawdi:");
	});

	it("does not add the hosted runtime sidecar without bridge surfaces or egress profiles", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env[RUNTIME_BRIDGE_TOKEN_ENV] = "bridge-secret";

		const convergence = convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_runtime_no_bridge",
					environmentId: "env_runtime_no_bridge",
					instanceId: "iid_runtime_no_bridge",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: { enabled: true },
						hermes: { enabled: false },
					},
					recovery: {},
				},
				source: "fixture-file",
				sourcePath: "test://runtime-no-bridge",
				offline: false,
				secretValues: {},
			},
			getRuntimePaths(),
		);

		expect(
			convergence.outputs.systemdUserUnits.map((path) => path.split("/").at(-1)),
		).not.toContain("clawdi-runtime-bridge.service");
		expect(
			convergence.outputs.systemdUserUnits.map((path) => path.split("/").at(-1)),
		).not.toContain("clawdi-runtime-sidecar.service");
		expect(
			convergence.outputs.systemdSystemUnits.map((path) => path.split("/").at(-1)),
		).not.toContain("clawdi-runtime-sidecar.service");
	});

	it("adds the hosted runtime sidecar bridge module for declared control UI surfaces", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env[RUNTIME_BRIDGE_TOKEN_ENV] = "bridge-secret";
		process.env[RUNTIME_BRIDGE_LISTEN_HOST_ENV] = "10.42.0.20";

		const convergence = convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_runtime_bridge",
					environmentId: "env_runtime_bridge",
					instanceId: "iid_runtime_bridge",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: { enabled: true },
						hermes: { enabled: false },
					},
					bridge: {
						surfaces: [
							{
								name: "openclaw",
								kind: "control-ui",
								listenPort: 28789,
								upstreamPort: 18789,
							},
						],
					},
					recovery: {},
				},
				source: "fixture-file",
				sourcePath: "test://runtime-bridge",
				offline: false,
				secretValues: {},
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
		expect(userUnitNames).not.toContain("clawdi-runtime-bridge.service");
		expect(userUnitNames).not.toContain("clawdi-runtime-sidecar.service");
		expect(systemUnitNames).toContain("clawdi-runtime-sidecar.service");
		const runtimeSidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
		const runtimeSidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
		const openclawUnit = readSystemdUserServiceConfig(paths, "openclaw-gateway");
		const openclawEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(runtimeSidecarUnit).toContain('ExecStart="clawdi" "runtime" "sidecar"');
		expect(runtimeSidecarEnv).toContain('CLAWDI_RUNTIME_BRIDGE_LISTEN_HOST="10.42.0.20"');
		expect(runtimeSidecarEnv).toContain('CLAWDI_RUNTIME_REV="');
		expect(runtimeSidecarEnv).toContain('CLAWDI_RUNTIME_BRIDGE_TOKEN="bridge-secret"');
		expect(runtimeSidecarEnv).toContain('CLAWDI_RUNTIME_BRIDGE_SURFACES="');
		expect(runtimeSidecarEnv).toContain('\\"name\\":\\"openclaw\\"');
		expect(runtimeSidecarEnv).toContain('\\"kind\\":\\"control-ui\\"');
		expect(runtimeSidecarEnv).toContain('\\"listenPort\\":28789');
		expect(runtimeSidecarEnv).not.toContain('\\"name\\":\\"hermes\\"');
		expect(openclawEnv).toContain('CLAWDI_RUNTIME_BRIDGE_TOKEN=""');
		expect(openclawEnv).toContain('CLAWDI_RUNTIME_BRIDGE_SURFACES=""');
		expect(openclawUnit).toContain('ExecStart="openclaw" "gateway" "run"');
		expect(openclawUnit).not.toContain("clawdi run -- openclaw");
		expect(openclawUnit).not.toContain("bridge-secret");
		expect(openclawEnv).not.toContain("bridge-secret");
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
						openclaw: { enabled: true },
						hermes: { enabled: false },
					},
					bridge: {
						surfaces: [
							{
								name: "openclaw",
								kind: "control-ui",
								listenPort: 28789,
								upstreamPort: 18789,
							},
						],
					},
					projection: {
						providers: {
							default: {
								kind: "openai-compatible",
								baseUrl: "https://provider.test/v1",
								model: "gpt-5.5",
								apiMode: "openai_responses",
								managed_by: "clawdi",
								runtimeEnvName: "OPENAI_API_KEY",
								apiKeySecretRef: "provider.default.apiKey",
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
				source: "fixture-file",
				sourcePath: "test://provider-secret-boundary",
				offline: false,
				secretValues: {
					"provider.default.apiKey": "sk-runtime",
					"secret://provider.default.apiKey": "sk-runtime",
					"provider.hermes.apiKey": "sk-other-runtime",
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
		expect(userUnitNames).not.toContain("clawdi-runtime-bridge.service");
		expect(userUnitNames).not.toContain("clawdi-runtime-sidecar.service");
		expect(systemUnitNames).toContain("clawdi-runtime-sidecar.service");
		expect(runtimeSidecarUnit).toContain('ExecStart="clawdi" "runtime" "sidecar"');
		expect(runtimeSidecarUnit).toContain("Before=user@10001.service");
		expect(runtimeSidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
		expect(transparentEgressEnv).toContain('CLAWDI_RUNTIME_USER="clawdi"');
		expect(transparentEgressEnv).toContain('CLAWDI_RUNTIME_UID="10001"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_UID="10002"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_GID="10002"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_NFT_TABLE="clawdi_transparent_egress"');
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_PROFILE_BUNDLE="${join(state, "config", "egress", "profiles.json")}"`,
		);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_SECRET_FILE="${egressSecretPath}"`);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_ENGINE_BINARY_PATH="`);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_ADDON_PATH="${paths.egressAddon}"`);
		expect(runtimeSidecarUnit).toContain('ExecStart="clawdi" "runtime" "sidecar"');
		expect(runtimeSidecarUnit).not.toContain("user=clawdi");
		expect(openclawUnit).toContain('ExecStart="openclaw" "gateway" "run"');
		expect(openclawUnit).not.toContain("user=clawdi");
		expect(openclawUnit).not.toContain("sk-runtime");
		expect(openclawEnv).not.toContain("CLAWDI_MANAGED_OPENAI_API_KEY");
		expect(openclawEnv).toContain('OPENAI_API_KEY="clawdi-egress-placeholder"');
		expect(openclawEnv).not.toContain("sk-runtime");
		expect(openclawEnv).not.toContain(join(state, "bin"));
		expect(statSync(join(run, "secrets")).mode & 0o777).toBe(0o711);
		const aggregateSecretPath = join(run, "secrets", "runtime-secrets.json");
		expect(statSync(aggregateSecretPath).mode & 0o777).toBe(0o600);
		expect(existsSync(join(run, "secrets", "runtimes", "openclaw.json"))).toBe(false);
		expect(statSync(egressSecretPath).mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
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
						openclaw: { enabled: true },
					},
					projection: {
						providers: {
							default: {
								kind: "openai-compatible",
								baseUrl: "https://provider.test/v1",
								model: "gpt-5.5",
								apiMode: "openai_responses",
								managed_by: "clawdi",
								runtimeEnvName: "OPENAI_API_KEY",
								apiKeySecretRef: "provider.default.apiKey",
							},
						},
					},
					recovery: {},
				},
				source: "fixture-file",
				sourcePath: "test://provider-secret-missing",
				offline: false,
				secretValues: {},
			},
			getRuntimePaths(),
		);
		const openclawEnv = readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway");
		expect(openclawEnv).not.toContain("CLAWDI_MANAGED_OPENAI_API_KEY");
		expect(openclawEnv).toContain('OPENAI_API_KEY="clawdi-egress-placeholder"');
		expect(openclawEnv).not.toContain("provider.default.apiKey");
	});

	it("runs egress as a transparent systemd engine with lifecycle nft redirect", () => {
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
			source: "fixture-file",
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
		expect(sidecarUnit).toContain('ExecStart="clawdi" "runtime" "sidecar"');
		expect(sidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
		expect(transparentEgressEnv).toContain(
			'CLAWDI_EGRESS_TRANSPORT_VERSION="clawdi-transparent-egress-v1"',
		);
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_NFT_TABLE="clawdi_transparent_egress"');
		expect(transparentEgressEnv).toContain('CLAWDI_RUNTIME_UID="10001"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_UID="10002"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_GID="10002"');
		expect(sidecarEnv).toContain(
			`CLAWDI_EGRESS_ENV_FILE="${join(run, "egress", "transparent-egress.env")}"`,
		);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_PROFILE_BUNDLE="${join(state, "config", "egress", "profiles.json")}"`,
		);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_SYSTEM_CA_BUNDLE="${join(run, "egress", "systemd", "ca.pem")}"`,
		);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_ADDON_PATH="${paths.egressAddon}"`);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_ENGINE_BINARY_PATH="${join(
				paths.egressEngineMaintainedRoot,
				mitmproxy.version,
				mitmproxy.sha256,
				"mitmdump",
			)}"`,
		);
		expect(statSync(join(state, "config", "egress")).mode & 0o777).toBe(0o755);
		expect(statSync(join(state, "config", "egress", "profiles.json")).mode & 0o777).toBe(0o644);
		expect(statSync(join(run, "egress")).mode & 0o777).toBe(0o755);
		expect(statSync(paths.egressAddon).mode & 0o777).toBe(0o644);
		expect(statSync(paths.egressTransparentEnv).mode & 0o777).toBe(0o644);
		expect(statSync(paths.egressCaDir).mode & 0o777).toBe(0o700);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(statSync(paths.egressCaDir).uid).toBe(10002);
			expect(statSync(paths.egressCaDir).gid).toBe(10002);
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
		const cachePath = join(state, "cache", "manifest.last-good.json");
		const failingInstaller = join(root, "install-openclaw.sh");
		mkdirSync(dirname(cachePath), { recursive: true });
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
				etag: '"manifest-generation-1"',
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
			source: "fixture-file",
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
		const soulPath = join(workspace, "SOUL.md");
		const userPath = join(workspace, "USER.md");
		mkdirSync(workspace, { recursive: true });
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
					source: "fixture-file",
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
				source: "fixture-file",
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

	it("runtime program revision changes for control-plane changes but not sibling runtimes", () => {
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
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@0.13.0-test" },
			runtimes: {
				openclaw: { enabled: true },
				hermes: { enabled: false },
			},
			recovery: {},
		};
		const revisionFor = (manifest: RuntimeManifest, runtime: string) => {
			const paths = getRuntimePaths();
			convergeRuntimeManifest(
				{
					manifest,
					source: "fixture-file",
					sourcePath: "test://revision",
					offline: false,
					secretValues: {},
				},
				paths,
			);
			const unitName = runtime === "openclaw" ? "openclaw-gateway" : `clawdi-${runtime}`;
			return systemdEnvRevision(readSystemdEnvFile(paths, unitName));
		};

		const baseRev = revisionFor(baseManifest, "openclaw");
		const controlPlaneRev = revisionFor(
			{
				...baseManifest,
				controlPlane: { apiUrl: "https://cloud-api-next.test" },
			},
			"openclaw",
		);
		const siblingRuntimeRev = revisionFor(
			{
				...baseManifest,
				runtimes: {
					...baseManifest.runtimes,
					hermes: { enabled: true },
				},
			},
			"openclaw",
		);

		expect(controlPlaneRev).not.toBe(baseRev);
		expect(siblingRuntimeRev).toBe(baseRev);
	});

	it("uses applied state, not conflicting last-good, for the live runtime instance identity", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "runtime-reset.json");
		mkdirSync(join(state, "cache"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const desiredManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_generation_reset",
			environmentId: "env_generation_reset",
			instanceId: "iid_generation_reset",
			generation: 1,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		};
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({
				...desiredManifest,
				instanceId: "iid_stale_last_good",
				generation: 99,
			}),
		);
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: desiredManifest.instanceId,
				etag: '"generation-reset-previous"',
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
		writeFileSync(manifestPath, JSON.stringify(desiredManifest));

		const loaded = await loadRuntimeManifest(paths, { manifestPath });

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		expect(loaded.manifest.generation).toBe(1);
		expect(loaded.manifest.instanceId).toBe("iid_generation_reset");
	});

	it("rejects fixture manifests that reference secretValues without inline values", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "runtime-secretref.json");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_fixture_secretref",
				environmentId: "env_fixture_secretref",
				instanceId: "iid_fixture_secretref",
				generation: 1,
				issuedAt: "2026-06-06T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
				egressProfiles: {
					profiles: [
						{
							id: "provider-secretref",
							kind: "provider",
							match: { scheme: "https", host: "api.openai.com", pathPrefix: "/v1/" },
							rewrite: {
								upstreamBaseUrl: "https://sub2api.test/v1",
								setHeaders: {
									authorization: {
										type: "secretRef",
										secretRef: "secret://provider.default.apiKey",
										prefix: "Bearer ",
									},
								},
							},
						},
					],
				},
				recovery: {},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest rejection");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors[0]).toContain("fixture references secretValues");
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/v1/runtime/manifest";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
								packageSpec: "clawdi@0.13.0-test",
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

	it("converges remote manifests without caching secret values", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/v1/runtime/manifest";
		const mitmproxy = seedMitmproxyCache();
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
								packageSpec: "clawdi@0.13.0-test",
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
									runtimeEnvName: "OPENAI_API_KEY",
									apiKeySecretRef: "provider.clawdi-managed-v2.apiKey",
								},
							},
						},
						secretValues: {
							"provider.clawdi-managed-v2.apiKey": "sk-runtime",
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
				"secret://provider.clawdi-managed-v2.apiKey",
				"sk-runtime",
			);
			expectMitmSecretFileIsSidecarOnly(
				paths,
				convergence.outputs.egressSecretFile,
				"secret://provider.clawdi-managed-v2.apiKey",
				"sk-runtime",
			);
			expectExistingFileNotToContain(join(run, "secrets", "runtime-secrets.json"), "sk-runtime");
			expectExistingFileNotToContain(
				join(state, "cache", "runtime-secrets.last-good.json"),
				"sk-runtime",
			);
			expect(convergence.outputs.processManager).toBe("systemd");
			expect(convergence.outputs.systemdSystemUnits).toEqual([
				join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
				join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"),
			]);
			expect(convergence.outputs.systemdUserUnits).toEqual([
				join(paths.systemdUserRoot, "openclaw-gateway.service"),
			]);
			const watchUnit = readSystemdSystemUnit(paths, "clawdi-runtime-watch");
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			expect(watchUnit).toContain('ExecStart="clawdi" "runtime" "watch"');
			expect(watchUnit).not.toContain("sk-runtime");
			expect(watchEnv).not.toContain("sk-runtime");
			expect(readFileSync(join(state, "cache", "manifest.last-good.json"), "utf-8")).not.toContain(
				"sk-runtime",
			);
			const providerHealth = JSON.parse(
				readFileSync(join(state, "status", "provider-health.json"), "utf-8"),
			);
			expect(providerHealth.providers["clawdi-managed-v2"]).toEqual({
				status: "ok",
				configured: true,
				kind: "openai-compatible",
				baseUrl: "https://sub2api.test/v1",
				model: null,
				models: [{ id: "gpt-test" }],
				apiKeySecretRef: "provider.clawdi-managed-v2.apiKey",
				secretAvailable: true,
				reasons: [],
			});
			expect(JSON.stringify(providerHealth)).not.toContain("sk-runtime");
		} finally {
			restore();
		}
	});

	it("removes stale egress and run config state when the next manifest stops declaring it", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "manifest-no-egress.json");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(state, "config", "egress"), { recursive: true });
		mkdirSync(join(state, "config", "run"), { recursive: true });
		mkdirSync(join(run, "secrets"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(join(state, "config", "egress", "profiles.json"), "{}\n");
		writeFileSync(join(run, "secrets", "egress-secrets.json"), '{"secret://old":"old"}\n');
		writeFileSync(join(state, "config", "run", "openclaw.json"), '{"enabled":true}\n');
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_no_egress",
				environmentId: "env_no_egress",
				instanceId: "iid_no_egress",
				generation: 2,
				issuedAt: "2026-06-06T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.example.test" },
				runtimes: {
					hermes: { enabled: false },
				},
				egressProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.outputs.egressProfileBundle).toBeNull();
		expect(convergence.outputs.egressSecretFile).toBeNull();
		expect(existsSync(join(state, "config", "egress", "profiles.json"))).toBe(false);
		expect(existsSync(join(run, "secrets", "egress-secrets.json"))).toBe(false);
		expect(existsSync(join(state, "config", "run", "openclaw.json"))).toBe(false);
		expect(existsSync(join(state, "config", "run", "hermes.json"))).toBe(true);
	});

	it("removes the last-good cache when manifest recovery disables caching", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const cachePath = join(state, "cache", "manifest.last-good.json");
		const manifestPath = join(root, "manifest-no-cache.json");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(state, "cache"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const previousManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_no_cache",
			environmentId: "env_no_cache",
			instanceId: "iid_no_cache",
			generation: 1,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				hermes: { enabled: false },
			},
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		};
		writeFileSync(cachePath, JSON.stringify(previousManifest));
		writeFileSync(
			manifestPath,
			JSON.stringify({
				...previousManifest,
				generation: 2,
				recovery: { cacheManifest: false, allowOfflineBoot: false },
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.outputs.manifestLastGood).toBeNull();
		expect(existsSync(cachePath)).toBe(false);
	});

	it("rejects expired runtime desired state manifests", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "expired-manifest.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_expired",
				environmentId: "env_expired",
				instanceId: "iid_expired",
				generation: 1,
				issuedAt: "2026-06-06T00:00:00Z",
				expiresAt: "2000-01-01T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.example.test" },
				runtimes: {
					hermes: { enabled: false },
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors[0]).toContain("manifest expired");
	});

	it("rejects secret values embedded in runtime desired state", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "current-schema-with-secrets.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_current_schema",
				environmentId: "env_current_schema",
				instanceId: "iid_current_schema",
				generation: 1,
				issuedAt: "2026-06-06T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.example.test" },
				runtimes: {
					hermes: { enabled: false },
				},
				secrets: [{ ref: "secret://old", exposeAs: "OLD_SECRET" }],
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain("Unrecognized key");
		expect(loaded.errors.join("\n")).toContain("secrets");
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/v1/runtime/manifest";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
								packageSpec: "clawdi@0.13.0-test",
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
						secretValues: {},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			process.env.CLAWDI_RUNTIME_MANIFEST_URL = "";
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
				readFileSync(join(home, ".clawdi", "environments", "openclaw.json"), "utf-8"),
			);
			const codexEnv = JSON.parse(
				readFileSync(join(home, ".clawdi", "environments", "codex.json"), "utf-8"),
			);

			expect(convergence.outputs.liveSyncEnvironments.sort()).toEqual([
				join(home, ".clawdi", "environments", "codex.json"),
				join(home, ".clawdi", "environments", "openclaw.json"),
			]);
			expect(convergence.outputs.daemonAuthTokenFile).toBe(join(run, "secrets", "auth-token"));
			expect(readFileSync(join(run, "secrets", "auth-token"), "utf-8")).toBe(
				"runtime-auth-token\n",
			);
			expect(openclawEnv.id).toBe("env-openclaw");
			expect(codexEnv.id).toBe("env-codex");
			expect(systemUnitNames).toContain("clawdi-runtime-watch.service");
			expect(systemUnitNames).toContain("clawdi-daemon.service");
			expect(watchUnit).toContain('ExecStart="clawdi" "runtime" "watch"');
			expect(watchEnv).toContain(
				'CLAWDI_RUNTIME_MANIFEST_URL="https://runtime-source.test/v1/runtime/manifest"',
			);
			expect(watchEnv).not.toContain("runtime-auth-token");
			expect(daemonUnit).toContain(
				`ExecStart="clawdi" "daemon" "run" "--auth-token-file" "${join(
					run,
					"secrets",
					"auth-token",
				)}"`,
			);
			expect(daemonUnit).not.toContain("ExecStart=/bin/sh -lc");
			expect(daemonEnv).toContain('CLAWDI_SERVE_MODE="container"');
			expect(daemonEnv).toContain('CLAWDI_RUNTIME_REV="');
			expect(daemonEnv).toContain("https://cloud-api.test");
			expect(watchEnv).toContain(
				'CLAWDI_RUNTIME_MANIFEST_URL="https://runtime-source.test/v1/runtime/manifest"',
			);
			expect(watchEnv).toContain('CLAWDI_AUTH_TOKEN=""');
			expect(watchUnit).not.toContain("runtime-auth-token");
			expect(watchEnv).not.toContain("runtime-auth-token");
			expect(daemonUnit).not.toContain("runtime-auth-token");
			expect(daemonEnv).not.toContain("runtime-auth-token");
		} finally {
			restore();
		}
	});

	it("does not generate Codex egress profiles without a managed provider secret ref", async () => {
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
					minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
						packageSpec: "clawdi@0.13.0-test",
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
				secretValues: {},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const profiles = loaded.manifest.egressProfiles?.profiles ?? [];
		expect(profiles.every((profile) => profile.owner === "runtime-installer")).toBe(true);
		expect(profiles.some((profile) => profile.kind === "provider")).toBe(false);
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
					minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
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
						packageSpec: "clawdi@0.13.0-test",
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						hermes: hostedHermesRuntime(),
					},
					bridge: { surfaces: [hostedHermesBridgeSurface()] },
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

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain("pathPrefix must start with /");
	});

	it("treats hosted CLI policy as npm-managed metadata only", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "manifest.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_cli_payload",
				environmentId: "env_cli_payload",
				instanceId: "iid_cli_payload",
				generation: 1,
				issuedAt: "2026-06-06T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.example.test" },
				clawdiCli: {
					version: "0.13.0-test",
					channel: "stable",
					source: "npm:clawdi",
					packageSpec: "clawdi@0.13.0-test",
				},
				runtimes: {
					openclaw: { enabled: false },
					hermes: { enabled: false },
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(loaded.manifest.clawdiCli?.source).toBe("npm:clawdi");
		expect(loaded.manifest.clawdiCli?.packageSpec).toBe("clawdi@0.13.0-test");
		expect(existsSync(join(state, "payloads"))).toBe(false);
		expect(existsSync(join(state, "status", "cli-bootstrap.json"))).toBe(false);
	});

	it("accepts non-secret egress profile bundles in runtime manifests", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "manifest.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_test",
				environmentId: "env_test",
				instanceId: "iid_test",
				generation: 1,
				issuedAt: "2026-06-04T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.example.test" },
				runtimes: {
					hermes: { enabled: false },
				},
				egressProfiles: {
					profiles: [
						{
							id: "native-telegram-agent-token",
							kind: "http",
							match: {
								scheme: "https",
								host: "api.telegram.org",
								pathPrefix: "/bot",
								headers: {},
							},
							rewrite: {
								upstreamBaseUrl: "http://127.0.0.1:18890/v1/channels/telegram",
								preservePath: true,
								setHeaders: {},
							},
							owner: "clawdi-native-channels",
						},
					],
				},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		expect(loaded.manifest.egressProfiles?.profiles[0]?.id).toBe("native-telegram-agent-token");
	});
});
