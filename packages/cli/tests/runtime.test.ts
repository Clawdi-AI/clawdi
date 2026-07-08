import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
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
import { runtimeInit, runtimeWatch } from "../src/commands/runtime";
import {
	RUNTIME_BRIDGE_LISTEN_HOST_ENV,
	RUNTIME_BRIDGE_SURFACES_ENV,
	RUNTIME_BRIDGE_TOKEN_ENV,
} from "../src/runtime/bridge";
import { applyRuntimeChannelsToManifestLoad } from "../src/runtime/channels";
import { applyRuntimeCliDesiredState } from "../src/runtime/cli-update";
import {
	deniedCommandReason,
	evaluateHostPolicyForCommand,
	readHostPolicy,
} from "../src/runtime/host-policy";
import {
	convergeRuntimeManifest,
	loadRuntimeManifest,
	type RuntimeManifest,
	withRuntimeConvergeLock,
} from "../src/runtime/manifest";
import {
	loadRemoteRuntimeChannels,
	loadRemoteRuntimeManifest,
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
import { jsonResponse, mockFetch } from "./commands/helpers";

const ENV_KEYS = [
	"HOME",
	"CLAWDI_HOME",
	"CLAWDI_RUNTIME_MODE",
	"CLAWDI_HOST_POLICY_PATH",
	"CLAWDI_SERVICE_STATE_DIR",
	"CLAWDI_RUN_DIR",
	"CLAWDI_RUNTIME_HOME",
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_RUNTIME_MANIFEST_PATH",
	"CLAWDI_RUNTIME_MANIFEST_URL",
	"CLAWDI_RUNTIME_SOURCE_PATH",
	"CLAWDI_RUNTIME_AUTH_ENV",
	"CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS",
	"CLAWDI_RUNTIME_INSTALL_TIMEOUT",
	"CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER",
	"CLAWDI_RUNTIME_TEST_HERMES_INSTALLER",
	"CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES",
	"CLAWDI_RUNTIME_PID1_ENVIRON_PATH",
	"CUSTOM_RUNTIME_TOKEN",
	"CLAWDI_RUNTIME_MANIFEST_TIMEOUT_MS",
	"CLAWDI_API_URL",
	"CLAWDI_SYSTEMD_APPLY",
	"CLAWDI_SYSTEMD_SYSTEM_ROOT",
	"CLAWDI_SYSTEMCTL_PATH",
	"CLAWDI_RUNTIME_USER",
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
	packageSpec = "clawdi@latest",
	version = "0.13.0-test",
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
			registry: null,
			npmPrefix: join(state, "npm"),
			npmCache: join(state, "npm-cache"),
			activePath: active,
			activeTarget: target,
			version,
			error: null,
		}),
	);
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
	install?: { source: "official"; channel?: string; args?: string[] };
	run?: HostedRunFixture;
	services?: Record<string, HostedRunFixture>;
	paths?: { home?: string; workspace?: string };
	provider_ids?: string[];
	primary_model?: unknown;
};

function hostedOpenClawRuntime(
	overrides: Partial<HostedRuntimeFixtureEntry> = {},
): HostedRuntimeFixtureEntry {
	return {
		enabled: true,
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
		...overrides,
	};
}

function hostedHermesRuntime(
	overrides: Partial<HostedRuntimeFixtureEntry> = {},
): HostedRuntimeFixtureEntry {
	return {
		enabled: true,
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
		...overrides,
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
			mitmProfiles: { profiles: [] },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		},
	};
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
		expect(paths.mitmProfileRoot).toBe(join(state, "config", "mitm"));
		expect(paths.mitmProfileBundle).toBe(join(state, "config", "mitm", "profiles.json"));
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
			"--auth",
			"none",
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
	it("parses denied commands from strings and objects", () => {
		const path = join(root, "host-policy.json");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_HOST_POLICY_PATH = path;
		writeFileSync(
			path,
			JSON.stringify({
				schemaVersion: "clawdi.hostPolicy.v1",
				mode: "hosted-runtime",
				deniedCommands: ["setup", { command: "config set", reason: "managed config" }],
				managedState: ["/var/lib/clawdi/config"],
				systemWritableState: ["/var/lib/clawdi", "/run/clawdi"],
				userWritableState: ["/home/clawdi", "/tmp"],
				ordinaryUserDeniedState: ["/var/lib/clawdi"],
			}),
		);

		const result = readHostPolicy(path);
		expect(result.valid).toBe(true);
		expect(result.policy?.systemWritableState).toEqual(["/var/lib/clawdi", "/run/clawdi"]);
		expect(result.policy?.userWritableState).toEqual(["/home/clawdi", "/tmp"]);
		expect(result.policy?.ordinaryUserDeniedState).toEqual(["/var/lib/clawdi"]);
		expect(deniedCommandReason(result.policy, "setup")).toBe("disabled by hosted runtime policy");
		expect(deniedCommandReason(result.policy, "config set apiUrl http://x")).toBe("managed config");
		expect(deniedCommandReason(result.policy, "mcp")).toBe(null);
		expect(evaluateHostPolicyForCommand("config set apiUrl http://x")).toEqual({
			allowed: false,
			command: "config set apiUrl http://x",
			runtimeMode: "hosted",
			policyPath: path,
			reason: "managed config",
		});
		expect(evaluateHostPolicyForCommand("mcp")).toEqual({
			allowed: true,
			command: "mcp",
			runtimeMode: "hosted",
			policyPath: path,
		});
	});

	it("fails closed for malformed policy JSON", () => {
		const path = join(root, "host-policy.json");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_HOST_POLICY_PATH = path;
		writeFileSync(path, "{not-json");

		const result = readHostPolicy(path);
		expect(result.exists).toBe(true);
		expect(result.valid).toBe(false);
		expect(result.error).toBeTruthy();
		expect(evaluateHostPolicyForCommand("config set apiUrl http://x").allowed).toBe(false);
		expect(evaluateHostPolicyForCommand("runtime doctor").allowed).toBe(true);
	});

	it("fails closed for missing policy except recovery commands", () => {
		const path = join(root, "missing-host-policy.json");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_HOST_POLICY_PATH = path;

		const denied = evaluateHostPolicyForCommand("auth login");
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toContain("missing hosted runtime policy");
		expect(evaluateHostPolicyForCommand("config paths").allowed).toBe(true);
		expect(evaluateHostPolicyForCommand("runtime status").allowed).toBe(true);
	});
});

describe("runtime manifest datasource", () => {
	it("reports missing runtime source when no fixture or cache exists", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const loaded = await loadRuntimeManifest(getRuntimePaths());
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("repair");
		expect(loaded.stage).toBe("network");
		expect(loaded.errors[0]).toContain("could not fetch runtime manifest");
		expect(loaded.errors[0]).toContain("runtime source config does not exist");
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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/manifest",
				response: () =>
					jsonResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_test",
							environmentId: "env_test",
							appId: "app_test",
							instanceId: "iid_remote",
							generation: 3,
							issuedAt: "2026-06-06T00:00:00Z",
							system: {
								user: "clawdi",
								home,
								workspace: join(home, "managed-workspace"),
								persistentPaths: [home],
							},
							controlPlane: {
								manifestUrl: "https://runtime-source.test/desired-state",
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								managedConfig: true,
								userEditableConfig: false,
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime({
									install: { source: "official", channel: "stable" },
									paths: { home },
								}),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									baseUrl: "https://sub2api.test/v1",
									model: "gpt-5.5",
									apiKeySecretRef: "provider.default.apiKey",
								},
								codex: {
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
			expect(loaded.sourcePath).toBe("https://runtime.test/v1/manifest");
			expect(loaded.manifest.schemaVersion).toBe("clawdi.runtimeDesiredState.v1");
			expect(loaded.manifest.workspaceRoot).toBe(join(home, "managed-workspace"));
			expect(loaded.manifest.environmentId).toBe("env_test");
			expect(loaded.manifest.controlPlane.apiUrl).toBe("https://cloud-api.test");
			expect(loaded.manifest.clawdiCli?.source).toBe("npm:clawdi");
			expect(loaded.manifest.clawdiCli?.packageSpec).toBe("clawdi@latest");
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
			expect(loaded.manifest.mitmProfiles?.profiles).toEqual([]);
			expect(loaded.secretValues).toEqual({
				"provider.default.apiKey": "sk-runtime",
				"secret://provider.default.apiKey": "sk-runtime",
			});
		} finally {
			restore();
		}
	});

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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_HERMES_INSTALLER = hermesInstaller;
		process.env.CLAWDI_RUNTIME_PID1_ENVIRON_PATH = pid1EnvPath;
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/v1/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/manifest",
				response: () =>
					jsonResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "hermes",
							deploymentId: "dep_runtime_bridge",
							environmentId: "env_runtime_bridge",
							appId: "app_runtime_bridge",
							instanceId: "iid_runtime_bridge",
							generation: 4,
							issuedAt: "2026-06-06T00:00:00Z",
							system: { home, workspace: join(home, "managed-workspace") },
							controlPlane: {
								manifestUrl: "https://runtime-source.test/desired-state",
								cloudApiUrl: "https://cloud-api.test",
							},
							runtimes: {
								hermes: hostedHermesRuntime({
									install: { source: "official", channel: "stable" },
									paths: { home },
								}),
							},
							bridge: {
								surfaces: [hostedHermesBridgeSurface()],
							},
							providers: {
								default: {
									kind: "openai-compatible",
									baseUrl: "https://ai-gateway.test/v1",
									model: "gpt-5.5",
									apiMode: "openai_chat",
									runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
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
			expect(hermesEnv).toContain('CLAWDI_MANAGED_OPENAI_API_KEY="sk-runtime"');
			expect(hermesDashboardEnv).toContain('CLAWDI_MANAGED_OPENAI_API_KEY="sk-runtime"');
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
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/desired-state";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/desired-state",
				response: () =>
					jsonResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_chat_provider",
							environmentId: "env_chat_provider",
							appId: "app_chat_provider",
							instanceId: "iid_chat_provider",
							generation: 1,
							issuedAt: "2026-06-22T00:00:00Z",
							system: { home, workspace: join(home, "clawdi") },
							controlPlane: {
								manifestUrl: "https://runtime-source.test/desired-state",
								cloudApiUrl: "https://cloud-api.test",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									baseUrl: "https://ai-gateway.example.test/v1",
									model: "gpt-5.4-mini",
									apiMode: "openai_chat",
									runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
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
				model: "gpt-5.4-mini",
				apiMode: "openai_chat",
				runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
			});
			expect(loaded.manifest.mitmProfiles?.profiles).toEqual([]);
		} finally {
			restore();
		}
	});

	it("does not derive provider MITM profiles from hosted-runtime manifests", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/desired-state";
		process.env.CLAWDI_AUTH_TOKEN = "runtime-auth-token";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/desired-state",
				response: () =>
					jsonResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_codex_provider",
							environmentId: "env_codex_provider",
							appId: "app_codex_provider",
							instanceId: "iid_codex_provider",
							generation: 1,
							issuedAt: "2026-06-22T00:00:00Z",
							system: { home, workspace: join(home, "clawdi") },
							controlPlane: {
								manifestUrl: "https://runtime-source.test/desired-state",
								cloudApiUrl: "https://cloud-api.test",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									baseUrl: "https://ai-gateway.example.test/v1",
									model: "gpt-5.4-mini",
									apiMode: "openai_responses",
									runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
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
			expect(loaded.manifest.mitmProfiles?.profiles).toEqual([]);
			expect(JSON.stringify(loaded.manifest.mitmProfiles)).not.toContain("sk-runtime");
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
							runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
							apiKeySecretRef: "provider.default.apiKey",
						},
					},
				},
				mitmProfiles: { profiles: [] },
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
				id: "CLAWDI_MANAGED_OPENAI_API_KEY",
			},
		});
		expect(patch.models.providers.default.api).toBeUndefined();
		expect(JSON.stringify(patch)).not.toContain("agentRuntime");
		expect(JSON.stringify(patch)).not.toContain("chatgpt.com");
		const runConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "openclaw.json"), "utf-8"),
		);
		expect(runConfig.secretEnv).toEqual({
			CLAWDI_MANAGED_OPENAI_API_KEY: "secret://provider.default.apiKey",
		});
		expect(runConfig.secretFilePath).toBe(join(run, "secrets", "runtimes", "openclaw.json"));
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
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
							runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
							apiKeySecretRef: "provider.default.apiKey",
						},
					},
				},
				mitmProfiles: { profiles: [] },
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

	it("reapplies OpenClaw hosted gateway config after the official gateway installer", () => {
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
							runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
							apiKeySecretRef: "provider.default.apiKey",
						},
					},
				},
				mitmProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf-8").trim().split("\n")).toEqual([
			"config patch --stdin",
			"config patch --stdin",
			"gateway install --force --json",
			"config patch --stdin",
			"config patch --stdin",
		]);
		expect(JSON.parse(readFileSync(join(root, "openclaw-patch-1.json"), "utf-8"))).toEqual(
			JSON.parse(readFileSync(join(root, "openclaw-patch-3.json"), "utf-8")),
		);
		expect(JSON.parse(readFileSync(join(root, "openclaw-patch-2.json"), "utf-8"))).toEqual(
			JSON.parse(readFileSync(join(root, "openclaw-patch-4.json"), "utf-8")),
		);
		expect(JSON.parse(readFileSync(join(root, "openclaw-patch-4.json"), "utf-8"))).toEqual({
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
				mitmProfiles: { profiles: [] },
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
		expect(openclawRunConfig.secretEnv).toEqual({
			OPENCLAW_PROVIDER_API_KEY: "secret://provider.openclaw.apiKey",
		});
		expect(hermesRunConfig.secretEnv).toEqual({
			HERMES_PROVIDER_API_KEY: "secret://provider.hermes.apiKey",
		});
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
		expect(hermesRunConfig.secretEnv).toEqual({
			HERMES_PROVIDER_API_KEY: "secret://provider.hermes.apiKey",
			MOONSHOT_PROVIDER_API_KEY: "secret://provider.moonshot.apiKey",
		});
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
		expect(
			expectRecord(hermesConfig.providers, "Hermes providers config")["clawdi-hermes"],
		).toBeUndefined();
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
				mitmProfiles: { profiles: [] },
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
				mitmProfiles: { profiles: [] },
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
					mitmProfiles: { profiles: [] },
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

	it("injects provider secrets from hosted runtime manifest responses into runtime run config", async () => {
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
					runtime: "openclaw",
					deploymentId: "dep_hosted_provider_secret",
					environmentId: "env_hosted_provider_secret",
					instanceId: "iid_hosted_provider_secret",
					generation: 5,
					issuedAt: "2026-06-15T00:00:00Z",
					system: { home, workspace: join(home, "clawdi") },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
					},
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://ai-gateway.example.test/v1",
							model: "gpt-5.5",
							apiMode: "openai_responses",
							runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
							apiKeySecretRef: "provider.default.apiKey",
						},
					},
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
				secretValues: {
					"provider.default.apiKey": "sk-runtime-provider",
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
		expect(runConfig.secretEnv).toEqual({
			CLAWDI_MANAGED_OPENAI_API_KEY: "secret://provider.default.apiKey",
		});
		expect(runConfig.secretFilePath).toBe(join(run, "secrets", "runtimes", "openclaw.json"));
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
		const aggregateSecrets = JSON.parse(
			readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8"),
		);
		expect(aggregateSecrets["secret://provider.default.apiKey"]).toBe("sk-runtime-provider");
		const runtimeSecrets = JSON.parse(
			readFileSync(join(run, "secrets", "runtimes", "openclaw.json"), "utf-8"),
		);
		expect(runtimeSecrets).toEqual({
			"provider.default.apiKey": "sk-runtime-provider",
			"secret://provider.default.apiKey": "sk-runtime-provider",
		});
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
					runtime: "openclaw",
					deploymentId: "dep_bridge_token",
					environmentId: "env_bridge_token",
					instanceId: "iid_bridge_token",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					system: { home },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
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
					runtime: "openclaw",
					deploymentId: "dep_bridge_token_explicit",
					environmentId: "env_bridge_token_explicit",
					instanceId: "iid_bridge_token_explicit",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					system: { home },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
						hermes: { enabled: false, install: { source: "official" }, paths: { home } },
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

	it("honors the auth env declared by the runtime source", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.env.CUSTOM_RUNTIME_TOKEN = "custom-token";
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CUSTOM_RUNTIME_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/manifest",
				response: () =>
					jsonResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "hermes",
							deploymentId: "dep_custom_auth",
							instanceId: "iid_custom_auth",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							system: { home },
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
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
			expect(captured[0].headers.authorization).toBe("Bearer custom-token");
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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/manifest",
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

	it("loads runtime channels from the cloud-api origin with ETag support", async () => {
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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/prefix/v1/runtime/manifest?ignored=1",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/prefix/v1/channels",
				response: () =>
					new Response(
						JSON.stringify([
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
										agent_id: "env_runtime",
										status: "active",
										agent_token: "agent-token-runtime",
									},
								],
							},
							{
								id: "acct-imessage-legacy",
								provider: "imessage",
								name: "Legacy iMessage",
								status: "active",
								visibility: "private",
								runtime_links: [
									{
										id: "link-imessage-legacy",
										account_id: "acct-imessage-legacy",
										agent_id: "env_runtime",
										status: "active",
										agent_token: "legacy-imessage-token",
									},
								],
							},
						]),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								etag: '"channels-etag-1"',
							},
						},
					),
			},
		]);

		try {
			const loaded = await loadRemoteRuntimeChannels(getRuntimePaths(), {
				ifNoneMatch: '"channels-etag-0"',
			});

			expect("channels" in loaded).toBe(true);
			if (!("channels" in loaded)) throw new Error("expected channels load success");
			expect(loaded.etag).toBe('"channels-etag-1"');
			expect(loaded.channels).toHaveLength(1);
			expect(loaded.channels[0]?.provider).toBe("telegram");
			expect(loaded.channels[0]?.runtime_links[0]?.agent_token).toBe("agent-token-runtime");
			expect(captured).toHaveLength(1);
			expect(captured[0].path).toBe("/prefix/v1/channels");
			expect(captured[0].headers.authorization).toBe("Bearer file-runtime-token");
			expect(captured[0].headers["if-none-match"]).toBe('"channels-etag-0"');
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
		expect(projected.manifest.mitmProfiles?.profiles ?? []).toEqual([]);
		expect(projected.secretValues).toEqual({ "provider.default.apiKey": "sk-provider" });
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
		expect(projected.manifest.mitmProfiles?.profiles ?? []).toEqual([]);
		expect(JSON.stringify(projected.manifest)).not.toContain(accountId);
		expect(JSON.stringify(projected.manifest)).not.toContain("baileys");
		expect(JSON.stringify(projected.manifest)).not.toContain("wa-agent-token");
		expect(JSON.stringify(projected.manifest)).not.toContain("wa-adv-secret");
		expect(JSON.stringify(projected.secretValues ?? {})).not.toContain("wa-agent-token");
		expect(JSON.stringify(projected.secretValues ?? {})).not.toContain("wa-adv-secret");
	});

	it("removes stale channel-driven MITM profiles when runtime channels are disabled", () => {
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
				mitmProfiles: {
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

		expect(projected.manifest.mitmProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"explicit-provider-profile",
		]);
	});

	it("adds direct provider passthrough only when managed channels enable the sidecar", () => {
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

		expect(projected.manifest.mitmProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"native-telegram-clawdi_accttelegram-managed",
			"direct-provider-passthrough-hermes",
			"direct-provider-passthrough-openclaw",
		]);
		expect(
			projected.manifest.mitmProfiles?.profiles.find(
				(profile) => profile.id === "direct-provider-passthrough-openclaw",
			),
		).toMatchObject({
			kind: "passthrough",
			match: {
				scheme: "https",
				host: "openclaw-provider.example.test",
				pathPrefix: "/v1/",
			},
		});
		expect(
			projected.manifest.mitmProfiles?.profiles.find(
				(profile) => profile.id === "direct-provider-passthrough-hermes",
			),
		).toMatchObject({
			kind: "passthrough",
			match: {
				scheme: "https",
				host: "hermes-provider.example.test",
				pathPrefix: "/v1/",
			},
		});
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
		mkdirSync(home, { recursive: true });
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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state);
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/manifest",
				response: () =>
					new Response(
						JSON.stringify({
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_watch",
								environmentId: "env_watch",
								instanceId: "iid_watch",
								generation: 12,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						}),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								etag: '"etag-watch-12"',
							},
						},
					),
			},
			{
				method: "GET",
				path: "/v1/channels",
				response: () =>
					new Response(JSON.stringify([]), {
						status: 200,
						headers: {
							"content-type": "application/json",
							etag: '"channels-etag-watch-1"',
						},
					}),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(process.exitCode ?? 0).toBe(0);
			expect(captured).toHaveLength(2);
			expect(captured[0].headers.authorization).toBe("Bearer file-runtime-token");
			expect(captured[1].headers.authorization).toBe("Bearer file-runtime-token");
			expect(readFileSync(join(state, "cache", "manifest.etag"), "utf-8")).toBe(
				'"etag-watch-12"\n',
			);
			expect(readFileSync(join(state, "cache", "channels.etag"), "utf-8")).toBe(
				'"channels-etag-watch-1"\n',
			);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(12);
			expect(event.etag).toBe('"etag-watch-12"');
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
			expect(observed?.manifest).toEqual({
				etag: '"etag-watch-12"',
				lastGoodExists: true,
			});
			expect(observed?.channels).toEqual({ etag: '"channels-etag-watch-1"' });
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

	it("runtime watch does not advance last-good or ETags when systemd apply fails", async () => {
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
		mkdirSync(home, { recursive: true });
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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state);
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/manifest",
				response: () =>
					new Response(
						JSON.stringify({
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_watch_systemd_failure",
								environmentId: "env_watch_systemd_failure",
								instanceId: "iid_watch_systemd_failure",
								generation: 13,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						}),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								etag: '"etag-watch-systemd-failure"',
							},
						},
					),
			},
			{
				method: "GET",
				path: "/v1/channels",
				response: () =>
					new Response(JSON.stringify([]), {
						status: 200,
						headers: {
							"content-type": "application/json",
							etag: '"channels-etag-systemd-failure"',
						},
					}),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.error).toContain("systemd apply failed");
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
			expect(existsSync(join(state, "cache", "channels.etag"))).toBe(false);
			expect(existsSync(join(state, "cache", "manifest.last-good.json"))).toBe(false);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("runtime watch keeps provider secrets when manifest is 304 and channels changed", async () => {
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
		const hostedPayload = {
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				runtime: "openclaw",
				deploymentId: "dep_watch_secret",
				environmentId: "env_watch_secret",
				instanceId: "iid_watch_secret",
				generation: 22,
				issuedAt: "2026-06-06T00:00:00Z",
				system: { home, workspace: join(home, "clawdi") },
				controlPlane: { cloudApiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: hostedOpenClawRuntime({
						install: { source: "official", channel: "stable" },
						paths: { home },
					}),
				},
				providers: {
					default: {
						kind: "openai-compatible",
						baseUrl: "https://sub2api.test/v1",
						model: "gpt-5.5",
						apiKeySecretRef: providerSecretRef,
					},
				},
			},
			secretValues: {
				[providerSecretRef]: "sk-provider-watch",
			},
		};
		const channelsPayload = [
			{
				id: "acct-telegram-watch",
				provider: "telegram",
				name: "Runtime Telegram",
				status: "active",
				visibility: "private",
				runtime_links: [
					{
						id: "link-telegram-watch",
						account_id: "acct-telegram-watch",
						agent_id: "env_watch_secret",
						status: "active",
						agent_token: "agent-token-watch",
					},
				],
			},
		];
		const manifestResponse = () =>
			new Response(JSON.stringify(hostedPayload), {
				status: 200,
				headers: {
					"content-type": "application/json",
					etag: '"manifest-etag-stable"',
				},
			});
		const channelsResponse = () =>
			new Response(JSON.stringify(channelsPayload), {
				status: 200,
				headers: {
					"content-type": "application/json",
					etag: '"channels-etag-next"',
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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state);
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const paths = getRuntimePaths();
		const initial = mockFetch([
			{ method: "GET", path: "/manifest", response: manifestResponse },
			{ method: "GET", path: "/v1/channels", response: channelsResponse },
		]);
		try {
			const manifestLoad = await loadRemoteRuntimeManifest(paths);
			if (!("manifest" in manifestLoad) || "notModified" in manifestLoad) {
				throw new Error("expected initial manifest load success");
			}
			const channelsLoad = await loadRemoteRuntimeChannels(paths);
			if (!("channels" in channelsLoad) || "notModified" in channelsLoad) {
				throw new Error("expected initial channels load success");
			}
			const initialConvergence = convergeRuntimeManifest(
				applyRuntimeChannelsToManifestLoad(
					manifestLoad as RuntimeManifestLoad,
					channelsLoad as RuntimeChannelsLoad,
				),
				paths,
			);
			expect(initialConvergence.installErrors).toEqual([]);
			writeFileSync(paths.manifestEtag, '"manifest-etag-stable"\n');
			writeFileSync(paths.channelsEtag, '"channels-etag-current"\n');
		} finally {
			initial.restore();
		}
		const baselineRevision = systemdEnvRevision(readSystemdEnvFile(paths, "openclaw-gateway"));
		const baselineSecrets = JSON.parse(
			readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8"),
		);
		expect(baselineSecrets["secret://provider.default.apiKey"]).toBe("sk-provider-watch");
		expect(baselineSecrets[channelSecretRef]).toBe("agent-token-watch");

		const watchFetch = mockFetch([
			{
				method: "GET",
				path: "/manifest",
				response: (request) =>
					request.headers["if-none-match"]
						? new Response(null, {
								status: 304,
								headers: { etag: '"manifest-etag-stable"' },
							})
						: manifestResponse(),
			},
			{ method: "GET", path: "/v1/channels", response: channelsResponse },
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(watchFetch.captured.map((request) => request.path)).toEqual([
				"/manifest",
				"/v1/channels",
				"/manifest",
			]);
			expect(watchFetch.captured[0].headers["if-none-match"]).toBe('"manifest-etag-stable"');
			expect(watchFetch.captured[1].headers["if-none-match"]).toBe('"channels-etag-current"');
			expect(watchFetch.captured[2].headers["if-none-match"]).toBeUndefined();
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(22);
			expect(event.systemdUnitsChanged).toBe(false);
			expect(event.systemdApply).toEqual({
				applied: true,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			});
			const secrets = JSON.parse(
				readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8"),
			);
			expect(secrets["secret://provider.default.apiKey"]).toBe("sk-provider-watch");
			expect(secrets[channelSecretRef]).toBe("agent-token-watch");
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
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		seedCurrentCliInstall(state);
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
				{ method: "GET", path: "/manifest", response: manifestResponse },
				{ method: "GET", path: "/v1/channels", response: () => jsonResponse([]) },
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
				() => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
				"error",
			);
			const recovered = await runOnce(
				() =>
					new Response(
						JSON.stringify({
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_watch_recovery",
								environmentId: "env_watch_recovery",
								instanceId: "iid_watch_recovery",
								generation: 18,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								runtimes: { openclaw: hostedOpenClawRuntime() },
							},
							secretValues: {},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json", etag: '"etag-recovered"' },
						},
					),
				"applied",
			);

			expect(recovered.generation).toBe(18);
			expect(readFileSync(join(state, "cache", "manifest.etag"), "utf-8")).toBe(
				'"etag-recovered"\n',
			);
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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		writeFileSync(join(run, "secrets", "auth-token"), "revoked-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/manifest",
				response: () => new Response("revoked", { status: 401 }),
			},
			{ method: "GET", path: "/v1/channels", response: () => jsonResponse([]) },
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
		mkdirSync(join(run, "mitm"), { recursive: true });
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
			join(run, "mitm", "secrets.json"),
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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
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
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/manifest",
				response: () =>
					new Response(
						JSON.stringify({
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_cli_update",
								environmentId: "env_cli_update",
								instanceId: "iid_cli_update",
								generation: 13,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: "clawdi@0.13.1-beta.0",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						}),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								etag: '"etag-cli-update-13"',
							},
						},
					),
			},
			{
				method: "GET",
				path: "/v1/channels",
				response: () =>
					new Response(JSON.stringify([]), {
						status: 200,
						headers: {
							"content-type": "application/json",
							etag: '"channels-cli-update-1"',
						},
					}),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(process.exitCode ?? 0).toBe(0);
			expect(captured).toHaveLength(2);
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

	it("runtime CLI update resolves floating npm tags before treating an install as current", () => {
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
printf '%s\\n' "$*" >> '${npmLog}'
if [ "\${1:-}" = "view" ]; then
  echo '"0.12.10-beta.22"'
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
if [ -z "$prefix" ]; then
  echo "missing --prefix" >&2
  exit 64
fi
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "0.12.10-beta.22"
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
		try {
			const paths = getRuntimePaths();
			seedCurrentCliInstall(state, "clawdi@beta", "0.12.10-beta.21");
			const result = applyRuntimeCliDesiredState(
				{
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_floating_cli_tag",
					environmentId: "env_floating_cli_tag",
					instanceId: "iid_floating_cli_tag",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					system: { home, workspace: join(home, "clawdi") },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@beta" },
					runtimes: { openclaw: hostedOpenClawRuntime() },
				},
				paths,
			);

			expect(result.status).toBe("installed");
			expect(result.version).toBe("0.12.10-beta.22");
			expect(readlinkSync(paths.cliManagedBin)).toBe(result.activeTarget);
			const status = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			expect(status.packageSpec).toBe("clawdi@beta");
			expect(status.version).toBe("0.12.10-beta.22");
			expect(readFileSync(npmLog, "utf-8")).toContain("view clawdi@beta version --json");
			expect(readFileSync(npmLog, "utf-8")).toContain("install");
		} finally {
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
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
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
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/manifest",
				response: () =>
					new Response(
						JSON.stringify({
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_cli_update_converge_failure",
								environmentId: "env_cli_update_converge_failure",
								instanceId: "iid_cli_update_converge_failure",
								generation: 16,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@0.13.3-beta.0" },
								runtimes: {
									openclaw: hostedOpenClawRuntime({
										install: { source: "official", channel: "stable" },
										paths: { home },
									}),
								},
							},
							secretValues: {},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json", etag: '"etag-projection-failed"' },
						},
					),
			},
			{
				method: "GET",
				path: "/v1/channels",
				response: () =>
					jsonResponse([
						{
							id: "acct-telegram-failure",
							provider: "telegram",
							name: "Telegram",
							status: "active",
							visibility: "private",
							runtime_links: [
								{
									id: "link-telegram-failure",
									account_id: "acct-telegram-failure",
									agent_id: "env_cli_update_converge_failure",
									status: "active",
									agent_token: "telegram-agent-token-failure",
								},
							],
						},
					]),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.cliUpdate.status).toBe("installed");
			expect(event.selfReexec).toBe(true);
			expect(event.errors[0]).toContain("runtime openclaw channel projection failed");
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

	it("runtime watch applies systemd state when CLI install fails", async () => {
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
		writeFileSync(join(bin, "npm"), "#!/usr/bin/env bash\necho npm down >&2\nexit 42\n");
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
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
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/manifest",
				response: () =>
					new Response(
						JSON.stringify({
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_cli_update_failure",
								environmentId: "env_cli_update_failure",
								instanceId: "iid_cli_update_failure",
								generation: 17,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@0.13.4-beta.0" },
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json", etag: '"etag-cli-failed"' },
						},
					),
			},
			{
				method: "GET",
				path: "/v1/channels",
				response: () =>
					new Response(JSON.stringify([]), {
						status: 200,
						headers: { "content-type": "application/json", etag: '"channels-cli-failed"' },
					}),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.stage).toBe("cli-update");
			expect(event.cliUpdate.status).toBe("error");
			expect(event.convergence.processManager).toBe("systemd");
			const paths = getRuntimePaths();
			expect(event.convergence.systemdSystemUnits).toContain(
				join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
			);
			expect(event.systemdApply).toEqual({
				applied: false,
				systemUnitsChanged: ["clawdi-runtime-watch.service"],
				userUnitsChanged: ["openclaw-gateway.service"],
			});
			expect(readFileSync(join(state, "cache", "manifest.etag"), "utf-8")).toBe(
				'"etag-cli-failed"\n',
			);
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

	it("rejects unsafe clawdi CLI package specs and registries", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
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
				url: "https://runtime.test/manifest",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.env.CLAWDI_HOST_POLICY_PATH = policyPath;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/manifest",
				response: () =>
					new Response(
						JSON.stringify({
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_init",
								environmentId: "env_init",
								instanceId: "iid_init",
								generation: 7,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								runtimes: {
									openclaw: hostedOpenClawRuntime({
										install: { source: "official", args: [] },
									}),
								},
							},
							secretValues: {},
						}),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								etag: '"manifest-etag-init-7"',
							},
						},
					),
			},
			{
				method: "GET",
				path: "/v1/channels",
				response: () =>
					new Response(
						JSON.stringify([
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
										agent_id: "env_init",
										status: "active",
										agent_token: "agent-token-init",
									},
								],
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
										agent_id: "env_init",
										status: "active",
										agent_token: "discord-agent-token-init",
									},
								],
							},
						]),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								etag: '"channels-etag-init-1"',
							},
						},
					),
			},
		]);

		try {
			await runtimeInit({ nonInteractive: true, json: true });

			expect(process.exitCode).toBe(0);
			expect(captured).toHaveLength(2);
			expect(captured.map((request) => request.path)).toEqual(["/manifest", "/v1/channels"]);
			expect(readFileSync(join(state, "cache", "manifest.etag"), "utf-8")).toBe(
				'"manifest-etag-init-7"\n',
			);
			expect(readFileSync(join(state, "cache", "channels.etag"), "utf-8")).toBe(
				'"channels-etag-init-1"\n',
			);
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
					"secret://channels/telegram/clawdi_accttelegram/agent-token",
				CLAWDI_CHANNEL_DISCORD_CLAWDI_ACCTDISCORD1_AGENT_TOKEN:
					"secret://channels/discord/clawdi_acctdiscord1/agent-token",
			});
			const secretsText = readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8");
			expect(secretsText).toContain("secret://channels/telegram/");
			expect(secretsText).toContain("agent-token-init");
			expect(secretsText).toContain("secret://channels/discord/");
			expect(secretsText).toContain("discord-agent-token-init");
			const profileBundle = readFileSync(join(state, "config", "mitm", "profiles.json"), "utf-8");
			expect(profileBundle).toContain("clawdi-native-channels");
			expect(profileBundle).toContain("/v1/channels/telegram");
			const status = JSON.parse(logs[0] ?? "{}");
			expect(status.status).toBe("ok");
			expect(status.activeGeneration).toBe(7);
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
			/^secret:\/\/channels\/telegram\/clawdi_accttelegram\/agent-token$/,
		);
		expect(runConfig.secretEnv.DISCORD_BOT_TOKEN).toMatch(
			/^secret:\/\/channels\/discord\/clawdi_acctdiscordh\/agent-token$/,
		);
		const hermesEnv = readSystemdEnvFile(getRuntimePaths(), "hermes-gateway");
		expect(hermesEnv).toContain('TELEGRAM_BOT_TOKEN="123456789:telegram-agent-token"');
		expect(hermesEnv).toContain('DISCORD_BOT_TOKEN="discord-agent-token"');
		expect(hermesEnv).toContain('TELEGRAM_ALLOW_ALL_USERS="true"');
		expect(hermesEnv).toContain('DISCORD_ALLOW_ALL_USERS="true"');
		expect(hermesEnv).toContain('HERMES_TELEGRAM_DISABLE_FALLBACK_IPS="true"');
		const profileBundle = readFileSync(join(state, "config", "mitm", "profiles.json"), "utf-8");
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

	it("uses hosted system workspace when converging run config and systemd units", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "custom-workspace");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/desired-state";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/desired-state",
				response: () =>
					jsonResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "hermes",
							deploymentId: "dep_workspace",
							instanceId: "iid_workspace",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							system: { home, workspace },
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
							runtimes: {
								hermes: hostedHermesRuntime(),
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
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
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
					runtime: "hermes",
					deploymentId: "dep_legacy_api_url",
					instanceId: "iid_legacy_api_url",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					system: { home },
					controlPlane: { apiUrl: "https://api.test" },
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
		expect(loaded.errors.join("\n")).toContain("hosted runtime controlPlane must use cloudApiUrl");
	});

	it("uses hosted runtime workspace paths even without explicit run settings", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const runtimeWorkspace = join(home, "hermes-workspace");
		const manifestPath = join(root, "runtime-workspace.json");
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
					runtime: "hermes",
					deploymentId: "dep_runtime_workspace",
					instanceId: "iid_runtime_workspace",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					system: { home, workspace: join(home, "system-workspace") },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
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
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
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

	it("does not add the hosted runtime sidecar without bridge surfaces or MITM profiles", () => {
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
		const unitNames = convergence.outputs.systemdUserUnits.map((path) => path.split("/").at(-1));
		expect(unitNames).not.toContain("clawdi-runtime-bridge.service");
		expect(unitNames).toContain("clawdi-runtime-sidecar.service");
		const runtimeSidecarUnit = readSystemdUserUnit(paths, "clawdi-runtime-sidecar");
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

	it("keeps provider-secret systemd env in the ephemeral run-dir config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

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
								runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
								apiKeySecretRef: "provider.default.apiKey",
							},
						},
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
		const unitNames = convergence.outputs.systemdUserUnits.map((path) => path.split("/").at(-1));
		const runtimeSidecarUnit = readSystemdUserUnit(paths, "clawdi-runtime-sidecar");
		const openclawUnit = readSystemdUserServiceConfig(paths, "openclaw-gateway");
		const openclawEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(convergence.outputs.processManager).toBe("systemd");
		expect(convergence.outputs.systemdUserUnitRoot).toBe(join(home, ".config", "systemd", "user"));
		expect(convergence.outputs.systemdSystemUnitRoot).toBe(paths.systemdSystemRoot);
		expect(existsSync(join(state, "supervisor", "supervisord.conf"))).toBe(false);
		expect(unitNames).not.toContain("clawdi-runtime-bridge.service");
		expect(runtimeSidecarUnit).toContain('ExecStart="clawdi" "runtime" "sidecar"');
		expect(runtimeSidecarUnit).not.toContain("user=clawdi");
		expect(openclawUnit).toContain('ExecStart="openclaw" "gateway" "run"');
		expect(openclawUnit).not.toContain("user=clawdi");
		expect(openclawUnit).not.toContain("sk-runtime");
		expect(openclawEnv).toContain('CLAWDI_MANAGED_OPENAI_API_KEY="sk-runtime"');
		expect(openclawEnv).not.toContain(join(state, "bin"));
		expect(statSync(join(run, "secrets")).mode & 0o777).toBe(0o711);
		const aggregateSecretPath = join(run, "secrets", "runtime-secrets.json");
		expect(statSync(aggregateSecretPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(run, "secrets", "runtimes")).mode & 0o777).toBe(0o700);
		const runtimeSecrets = JSON.parse(
			readFileSync(join(run, "secrets", "runtimes", "openclaw.json"), "utf-8"),
		);
		expect(runtimeSecrets["secret://provider.default.apiKey"]).toBe("sk-runtime");
		expect(JSON.stringify(runtimeSecrets)).not.toContain("sk-other-runtime");
	});

	it("fails closed when direct systemd launch cannot resolve a provider secret", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		expect(() =>
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
									runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
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
			),
		).toThrow(
			"Runtime secret secret://provider.default.apiKey for CLAWDI_MANAGED_OPENAI_API_KEY is unavailable.",
		);
	});

	it("runs MITM as a systemd sidecar and gives runtime programs only final proxy env", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_mitm_sidecar",
					environmentId: "env_mitm_sidecar",
					instanceId: "iid_mitm_sidecar",
					generation: 1,
					issuedAt: "2026-06-26T00:00:00Z",
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: { enabled: true },
						hermes: { enabled: false },
					},
					mitmProfiles: {
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
				sourcePath: "test://mitm-sidecar",
				offline: false,
				secretValues: {},
			},
			getRuntimePaths(),
		);

		const paths = getRuntimePaths();
		const mitmUnit = readSystemdUserUnit(paths, "clawdi-runtime-sidecar");
		const mitmEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
		const openclawUnit = readSystemdUserServiceConfig(paths, "openclaw-gateway");
		const openclawEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(mitmUnit).toContain('ExecStart="clawdi" "runtime" "sidecar"');
		expect(mitmEnv).toContain(
			`CLAWDI_MITM_PROFILE_BUNDLE="${join(state, "config", "mitm", "profiles.json")}"`,
		);
		expect(mitmEnv).toContain(`CLAWDI_MITM_CA_FILE="${join(run, "mitm", "systemd", "ca.pem")}"`);
		expect(openclawUnit).toContain('ExecStart="openclaw" "gateway" "run"');
		expect(openclawEnv).not.toContain("CLAWDI_MITM_PROFILE_BUNDLE");
		expect(openclawEnv).not.toContain("CLAWDI_MITM_SECRET_FILE");
		expect(openclawEnv).toContain('HTTPS_PROXY="http://127.0.0.1:');
		expect(openclawEnv).toContain('OPENCLAW_PROXY_URL="http://127.0.0.1:');
		expect(openclawEnv).toContain(
			`NODE_EXTRA_CA_CERTS="${join(run, "mitm", "systemd", "ca.pem")}"`,
		);
		expect(openclawUnit).not.toContain("clawdi run -- openclaw");
	});

	it("does not advance last-good manifest cache when convergence has install errors", async () => {
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

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors.join("\n")).toContain("runtime openclaw installer exited 42");
		expect(convergence.outputs.manifestLastGood).toBeNull();
		expect(JSON.parse(readFileSync(cachePath, "utf-8")).generation).toBe(1);
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

	it("allows generation reset for the same runtime instance identity", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "runtime-reset.json");
		mkdirSync(join(state, "cache"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const previousManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_generation_reset",
			environmentId: "env_generation_reset",
			instanceId: "iid_generation_reset",
			generation: 42,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		};
		writeFileSync(paths.manifestLastGood, JSON.stringify(previousManifest));
		writeFileSync(
			manifestPath,
			JSON.stringify({
				...previousManifest,
				generation: 1,
				issuedAt: "2026-06-07T00:00:00Z",
			}),
		);

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
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
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
				mitmProfiles: {
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

	it("derives a safe API origin when manifests only include a source URL", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/desired-state";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/desired-state",
				response: () =>
					jsonResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_manifest_only",
							instanceId: "iid_manifest_only",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							system: { home, workspace: join(home, "clawdi") },
							controlPlane: {
								manifestUrl: "https://runtime-source.test/v1/desired-state/",
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
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			expect(loaded.manifest.controlPlane.apiUrl).toBe("https://runtime-source.test");
		} finally {
			restore();
		}
	});

	it("converges remote manifests without caching secret values", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/desired-state";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/desired-state",
				response: () =>
					jsonResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_test",
							appId: "app_test",
							instanceId: "iid_remote",
							generation: 4,
							issuedAt: "2026-06-06T00:00:00Z",
							system: { home, workspace: join(home, "clawdi") },
							controlPlane: {
								manifestUrl: "https://runtime-source.test/desired-state",
								cloudApiUrl: "https://cloud-api.test",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									baseUrl: "https://sub2api.test/v1",
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
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

			expect(convergence.mode).toBe("normal");
			expect(convergence.outputs.mitmProfileBundle).toBe(null);
			expect(convergence.outputs.mitmSecretFile).toBeNull();
			expect(existsSync(join(run, "secrets", "runtime-secrets.json"))).toBe(true);
			const paths = getRuntimePaths();
			expect(convergence.outputs.processManager).toBe("systemd");
			expect(convergence.outputs.systemdSystemUnits).toEqual([
				join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
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
			expect(readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8")).toContain(
				"sk-runtime",
			);
			const providerHealth = JSON.parse(
				readFileSync(join(state, "status", "provider-health.json"), "utf-8"),
			);
			expect(providerHealth.providers.default).toEqual({
				status: "error",
				configured: true,
				kind: "openai-compatible",
				baseUrl: "https://sub2api.test/v1",
				model: null,
				apiKeySecretRef: "provider.default.apiKey",
				secretAvailable: true,
				reasons: ["model_missing"],
			});
			expect(JSON.stringify(providerHealth)).not.toContain("sk-runtime");
		} finally {
			restore();
		}
	});

	it("removes stale MITM and run config state when the next manifest stops declaring it", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "manifest-no-mitm.json");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(state, "config", "mitm"), { recursive: true });
		mkdirSync(join(state, "config", "run"), { recursive: true });
		mkdirSync(join(run, "mitm"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(join(state, "config", "mitm", "profiles.json"), "{}\n");
		writeFileSync(join(run, "mitm", "secrets.json"), '{"secret://old":"old"}\n');
		writeFileSync(join(state, "config", "run", "openclaw.json"), '{"enabled":true}\n');
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_no_mitm",
				environmentId: "env_no_mitm",
				instanceId: "iid_no_mitm",
				generation: 2,
				issuedAt: "2026-06-06T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.example.test" },
				runtimes: {
					hermes: { enabled: false },
				},
				mitmProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.outputs.mitmProfileBundle).toBeNull();
		expect(convergence.outputs.mitmSecretFile).toBeNull();
		expect(existsSync(join(state, "config", "mitm", "profiles.json"))).toBe(false);
		expect(existsSync(join(run, "mitm", "secrets.json"))).toBe(false);
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
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
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
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
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
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "runtime-auth-token";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime-source.test/desired-state";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/desired-state",
				response: () =>
					jsonResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_sync",
							appId: "app_sync",
							instanceId: "iid_sync",
							generation: 9,
							issuedAt: "2026-06-06T00:00:00Z",
							system: { home, workspace: join(home, "clawdi") },
							controlPlane: {
								manifestUrl: "https://runtime-source.test/desired-state",
								cloudApiUrl: "https://cloud-api.test",
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
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			const paths = getRuntimePaths();
			const systemUnitNames = convergence.outputs.systemdSystemUnits.map((path) =>
				path.split("/").at(-1),
			);
			const watchUnit = readSystemdSystemUnit(paths, "clawdi-runtime-watch");
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
			expect(daemonUnit).not.toContain("runtime-auth-token");
			expect(daemonEnv).not.toContain("runtime-auth-token");
		} finally {
			restore();
		}
	});

	it("does not generate Codex MITM profiles without a managed provider secret ref", async () => {
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
					appId: "app_no_secret_ref",
					instanceId: "iid_no_secret_ref",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					system: { home, workspace: join(home, "clawdi") },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
					},
					providers: {
						default: { kind: "openai-compatible", baseUrl: "https://sub2api.test/v1" },
					},
				},
				secretValues: {},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		expect(loaded.manifest.mitmProfiles?.profiles).toEqual([]);
	});

	it("rejects invalid explicit hosted MITM profiles instead of falling back", async () => {
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "hosted-bad-mitm.json");
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
					appId: "app_bad_mitm",
					instanceId: "iid_bad_mitm",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					system: { home, workspace: join(home, "clawdi") },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					runtimes: {
						hermes: hostedHermesRuntime(),
					},
					bridge: { surfaces: [hostedHermesBridgeSurface()] },
					mitmProfiles: {
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
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
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

	it("accepts non-secret MITM profile bundles in runtime manifests", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "manifest.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
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
				mitmProfiles: {
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
		expect(loaded.manifest.mitmProfiles?.profiles[0]?.id).toBe("native-telegram-agent-token");
	});
});
