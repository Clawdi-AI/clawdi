import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runtimeInit, runtimeWatch } from "../src/commands/runtime";
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
import { detectRuntimeMode, getRuntimePaths } from "../src/runtime/paths";
import { buildRuntimeRunConfig } from "../src/runtime/run-config";
import {
	buildRuntimeBootStatus,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../src/runtime/state";
import { UI_ACCESS_TOKEN_ENV, UI_BRIDGE_LISTEN_HOST_ENV } from "../src/runtime/ui-bridge";
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
	"CUSTOM_RUNTIME_TOKEN",
	"CLAWDI_RUNTIME_MANIFEST_TIMEOUT_MS",
	"CLAWDI_API_URL",
	"CLAWDI_SUPERVISORCTL_PATH",
	"CLAWDI_RUNTIME_USER",
	UI_ACCESS_TOKEN_ENV,
	UI_BRIDGE_LISTEN_HOST_ENV,
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

	it("refuses last-good offline boot when cached manifest references secretValues", async () => {
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

		const loaded = await loadRuntimeManifest(getRuntimePaths());
		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("repair");
		expect(loaded.errors).toContain(
			"cached manifest references secretValues (provider.default.apiKey); refusing offline boot without a fresh runtime manifest",
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
								openclaw: {
									enabled: true,
									install: { source: "official", channel: "stable" },
									paths: { home },
								},
								hermes: {
									enabled: false,
									install: { source: "official", channel: "stable" },
									paths: { home },
								},
							},
							providers: {
								default: {
									kind: "openai-compatible",
									baseUrl: "https://sub2api.test/v1",
									model: "gpt-5.5",
									apiKeySecretRef: "provider.default.apiKey",
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
								openclaw: { enabled: false },
								hermes: { enabled: false },
							},
							providers: {
								default: {
									kind: "openai-compatible",
									baseUrl: "https://ai-gateway.example.test/v1",
									model: "openai-codex/gpt-5.4-mini",
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
				model: "openai-codex/gpt-5.4-mini",
				apiMode: "openai_chat",
				runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
			});
			expect(loaded.manifest.mitmProfiles?.profiles).toEqual([]);
		} finally {
			restore();
		}
	});

	it("generates managed Codex MITM profiles from hosted-runtime manifests", async () => {
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
								openclaw: { enabled: false },
								hermes: { enabled: false },
							},
							providers: {
								default: {
									kind: "openai-compatible",
									baseUrl: "https://ai-gateway.example.test/v1",
									model: "openai-codex/gpt-5.4-mini",
									apiMode: "codex_responses",
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
			expect(loaded.manifest.mitmProfiles?.profiles).toEqual([
				expect.objectContaining({
					id: "codex-chatgpt-backend-responses",
					kind: "provider",
					match: expect.objectContaining({
						scheme: "https",
						host: "chatgpt.com",
						path: { type: "equals", value: "/backend-api/codex/responses" },
					}),
					rewrite: expect.objectContaining({
						upstreamBaseUrl: "https://ai-gateway.example.test/backend-api/codex/responses",
						preservePath: false,
					}),
					owner: "provider-projection",
				}),
			]);
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
					system: { home },
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://ai-gateway.example.test/v1",
							model: "openai-codex/gpt-5.4-mini",
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
		const patch = JSON.parse(readFileSync(openclawPatch, "utf-8"));
		expect(patch.agents.defaults.model.primary).toBe("default/openai-codex/gpt-5.4-mini");
		expect(patch.models.providers.default).toMatchObject({
			baseUrl: "https://ai-gateway.example.test/v1",
			api: "openai-completions",
			apiKey: {
				source: "env",
				provider: "default",
				id: "CLAWDI_MANAGED_OPENAI_API_KEY",
			},
		});
		expect(JSON.stringify(patch)).not.toContain("chatgpt.com");
		const runConfig = JSON.parse(
			readFileSync(join(state, "config", "run", "openclaw.json"), "utf-8"),
		);
		expect(runConfig).not.toHaveProperty("secretEnv");
		expect(runConfig.secretFilePath).toBe(join(run, "secrets", "runtime-secrets.json"));
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
	});

	it("adds Hermes to legacy hosted-runtime manifests when the UI bridge token is present", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-ui-token.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env[UI_ACCESS_TOKEN_ENV] = "ui-token";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					deploymentId: "dep_ui_token",
					environmentId: "env_ui_token",
					instanceId: "iid_ui_token",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					system: { home },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: { enabled: true, install: { source: "official" }, paths: { home } },
					},
				},
				secretValues: {},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		expect(loaded.manifest.runtimes.hermes.enabled).toBe(true);
		expect(loaded.manifest.runtimes.hermes.install?.url).toBe(
			"https://hermes-agent.nousresearch.com/install.sh",
		);
		expect(loaded.manifest.runtimes.hermes.install?.args).toEqual([
			"--skip-setup",
			"--skip-browser",
			"--non-interactive",
		]);
	});

	it("keeps Hermes disabled when a hosted-runtime manifest explicitly disables it", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-ui-token-hermes-disabled.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env[UI_ACCESS_TOKEN_ENV] = "ui-token";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					deploymentId: "dep_ui_token_explicit",
					environmentId: "env_ui_token_explicit",
					instanceId: "iid_ui_token_explicit",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					system: { home },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: { enabled: true, install: { source: "official" }, paths: { home } },
						hermes: { enabled: false, install: { source: "official" }, paths: { home } },
					},
				},
				secretValues: {},
			}),
		);

		const loaded = await loadRuntimeManifest(getRuntimePaths(), { manifestPath });

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		expect(loaded.manifest.runtimes.hermes.enabled).toBe(false);
		expect(loaded.manifest.runtimes.hermes.install).toBeUndefined();
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
							deploymentId: "dep_custom_auth",
							instanceId: "iid_custom_auth",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							system: { home },
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
							runtimes: { hermes: { enabled: false } },
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
				url: "https://runtime.test/prefix/api/runtime/manifest?ignored=1",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/prefix/api/channels",
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
			expect(loaded.channels[0]?.runtime_links[0]?.agent_token).toBe("agent-token-runtime");
			expect(captured).toHaveLength(1);
			expect(captured[0].path).toBe("/prefix/api/channels");
			expect(captured[0].headers.authorization).toBe("Bearer file-runtime-token");
			expect(captured[0].headers["if-none-match"]).toBe('"channels-etag-0"');
		} finally {
			restore();
		}
	});

	it("projects an empty runtime channel list as an empty projection", () => {
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				deploymentId: "dep_empty_channels",
				environmentId: "env_empty_channels",
				instanceId: "iid_empty_channels",
				generation: 3,
				issuedAt: "2026-06-14T00:00:00Z",
				system: { home: "/home/clawdi", workspace: "/home/clawdi/clawdi" },
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: { enabled: true },
					hermes: { enabled: false },
				},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
			secretValues: { "provider.default.apiKey": "sk-provider" },
		};
		const channels: RuntimeChannelsLoad = {
			channels: [],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/api/channels",
			etag: '"empty-channels"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(loaded, channels);

		expect(projected.manifest.projection?.channels).toEqual({});
		expect(projected.manifest.mitmProfiles?.profiles ?? []).toEqual([]);
		expect(projected.secretValues).toEqual({ "provider.default.apiKey": "sk-provider" });
	});

	it("removes stale channel-driven MITM profiles when runtime channels are disabled", () => {
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				deploymentId: "dep_stale_channels",
				environmentId: "env_stale_channels",
				instanceId: "iid_stale_channels",
				generation: 4,
				issuedAt: "2026-06-14T00:00:00Z",
				system: { home: "/home/clawdi", workspace: "/home/clawdi/clawdi" },
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: { enabled: true },
					hermes: { enabled: false },
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
							id: "direct-provider-passthrough",
							enabled: true,
							kind: "passthrough",
							match: {
								scheme: "https",
								host: "ai-gateway.example.test",
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
							owner: "provider-projection",
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
			sourcePath: "https://runtime.test/api/channels",
			etag: '"empty-channels"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(loaded, channels);

		expect(projected.manifest.mitmProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"explicit-provider-profile",
		]);
	});

	it("adds direct provider passthrough only when managed channels enable the broker", () => {
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
						default: {
							baseUrl: "https://ai-gateway.example.test/v1",
							apiMode: "openai_chat",
							apiKeySecretRef: "provider.default.apiKey",
						},
					},
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
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
							agent_id: "env_channel_provider",
							status: "active",
							agent_token: "agent-token-runtime",
						},
					],
				},
			],
			source: "remote-datasource",
			sourcePath: "https://runtime.test/api/channels",
			etag: '"channels"',
		};

		const projected = applyRuntimeChannelsToManifestLoad(loaded, channels);

		expect(projected.manifest.mitmProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"native-telegram-clawdi_accttelegram-managed",
			"direct-provider-passthrough",
		]);
		expect(
			projected.manifest.mitmProfiles?.profiles.find(
				(profile) => profile.id === "direct-provider-passthrough",
			),
		).toMatchObject({
			kind: "passthrough",
			match: {
				scheme: "https",
				host: "ai-gateway.example.test",
				pathPrefix: "/v1/",
			},
		});
	});

	it("runtime watch applies remote changes, reloads supervisor, and saves the new ETag", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
		const supervisorCalls = join(root, "supervisorctl.log");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(bin, "supervisorctl"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${supervisorCalls}'
if [ "\${3:-}" = "status" ]; then
  cat <<'STATUS'
clawdi-daemon                    RUNNING   pid 10, uptime 0:00:12
clawdi-openclaw                  RUNNING   pid 11, uptime 0:00:12
clawdi-runtime-watch             RUNNING   pid 12, uptime 0:00:12
STATUS
fi
`,
		);
		chmodSync(join(bin, "supervisorctl"), 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.env.CLAWDI_SUPERVISORCTL_PATH = join(bin, "supervisorctl");
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
								deploymentId: "dep_watch",
								environmentId: "env_watch",
								instanceId: "iid_watch",
								generation: 12,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								runtimes: {
									openclaw: { enabled: false },
									hermes: { enabled: false },
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
				path: "/api/channels",
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
			expect(readFileSync(supervisorCalls, "utf-8")).toBe(
				`-c ${join(state, "supervisor", "supervisord.conf")} status\n-c ${join(
					state,
					"supervisor",
					"supervisord.conf",
				)} reread\n-c ${join(
					state,
					"supervisor",
					"supervisord.conf",
				)} update clawdi-daemon\n-c ${join(
					state,
					"supervisor",
					"supervisord.conf",
				)} update clawdi-openclaw\n`,
			);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(12);
			expect(event.etag).toBe('"etag-watch-12"');
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
			const supervisorConfig = readFileSync(join(state, "supervisor", "supervisord.conf"), "utf-8");
			expect(supervisorConfig).toContain("[program:clawdi-runtime-watch]");
			expect(supervisorConfig).not.toContain("file-runtime-token");
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
		const supervisorCalls = join(root, "supervisorctl.log");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		const providerSecretRef = "provider.default.apiKey";
		const channelSecretRef = "secret://channels/telegram/clawdi_accttelegram/agent-token";
		const hostedPayload = {
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				deploymentId: "dep_watch_secret",
				environmentId: "env_watch_secret",
				instanceId: "iid_watch_secret",
				generation: 22,
				issuedAt: "2026-06-06T00:00:00Z",
				system: { home, workspace: join(home, "clawdi") },
				controlPlane: { cloudApiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: {
						enabled: true,
						install: { source: "official", channel: "stable" },
						paths: { home },
					},
					hermes: { enabled: false },
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
		const openclawRevision = (config: string): string => {
			const match = config.match(/\[program:clawdi-openclaw\][\s\S]*?CLAWDI_RUNTIME_REV="([^"]+)"/);
			expect(match?.[1]).toBeTruthy();
			return match?.[1] ?? "";
		};

		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(
			join(bin, "supervisorctl"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${supervisorCalls}'
if [ "\${3:-}" = "status" ]; then
  cat <<'STATUS'
clawdi-openclaw                  RUNNING   pid 11, uptime 0:00:12
clawdi-runtime-watch             RUNNING   pid 12, uptime 0:00:12
STATUS
fi
`,
		);
		chmodSync(join(bin, "supervisorctl"), 0o700);
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
		process.env.CLAWDI_SUPERVISORCTL_PATH = join(bin, "supervisorctl");
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
			{ method: "GET", path: "/api/channels", response: channelsResponse },
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
		const baselineConfig = readFileSync(paths.supervisorConfig, "utf-8");
		const baselineRevision = openclawRevision(baselineConfig);
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
			{ method: "GET", path: "/api/channels", response: channelsResponse },
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(watchFetch.captured.map((request) => request.path)).toEqual([
				"/manifest",
				"/api/channels",
				"/manifest",
			]);
			expect(watchFetch.captured[0].headers["if-none-match"]).toBe('"manifest-etag-stable"');
			expect(watchFetch.captured[1].headers["if-none-match"]).toBe('"channels-etag-current"');
			expect(watchFetch.captured[2].headers["if-none-match"]).toBeUndefined();
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(22);
			expect(event.supervisorConfigChanged).toBe(false);
			const secrets = JSON.parse(
				readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8"),
			);
			expect(secrets["secret://provider.default.apiKey"]).toBe("sk-provider-watch");
			expect(secrets[channelSecretRef]).toBe("agent-token-watch");
			const supervisorConfig = readFileSync(paths.supervisorConfig, "utf-8");
			expect(openclawRevision(supervisorConfig)).toBe(baselineRevision);
			expect(existsSync(supervisorCalls)).toBe(false);
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
		const bin = join(root, "bin");
		const supervisorCalls = join(root, "supervisorctl.log");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(bin, "supervisorctl"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${supervisorCalls}'
if [ "\${3:-}" = "status" ]; then
  cat <<'STATUS'
clawdi-daemon                    RUNNING   pid 10, uptime 0:00:12
clawdi-runtime-watch             RUNNING   pid 12, uptime 0:00:12
STATUS
fi
`,
		);
		chmodSync(join(bin, "supervisorctl"), 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.env.CLAWDI_SUPERVISORCTL_PATH = join(bin, "supervisorctl");
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
				{ method: "GET", path: "/api/channels", response: () => jsonResponse([]) },
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
								deploymentId: "dep_watch_recovery",
								environmentId: "env_watch_recovery",
								instanceId: "iid_watch_recovery",
								generation: 18,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
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
			{ method: "GET", path: "/api/channels", response: () => jsonResponse([]) },
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

	it("runtime observed samples supervisor program health", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		mkdirSync(join(state, "cache"), { recursive: true });
		mkdirSync(join(state, "supervisor"), { recursive: true });
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "supervisorctl"),
			`#!/usr/bin/env bash
cat <<'EOF'
clawdi-runtime-watch              RUNNING   pid 11, uptime 0:00:12
clawdi-daemon                     RUNNING   pid 12, uptime 0:00:10
clawdi-openclaw                   FATAL     Exited too quickly (process log may have details)
EOF
`,
		);
		chmodSync(join(bin, "supervisorctl"), 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SUPERVISORCTL_PATH = join(bin, "supervisorctl");
		const paths = getRuntimePaths();
		writeFileSync(paths.supervisorConfig, "[supervisord]\n");
		writeFileSync(join(run, "supervisor.sock"), "");
		writeRuntimeBootStatus(
			buildRuntimeBootStatus(
				{
					mode: "normal",
					status: "ok",
					stage: "final",
					bootId: "boot-supervisor",
					runtimeMode: "hosted",
					activeGeneration: 9,
					instanceId: "iid-supervisor",
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
			{ status: "applied", generation: 9, instanceId: "iid-supervisor" },
			paths,
		);

		const observed = readHostedRuntimeObserved(paths);

		expect(observed?.status).toBe("error");
		expect(observed?.supervisor).toEqual({
			status: "error",
			available: true,
			socketExists: true,
			programCount: 3,
			programs: [
				{
					name: "clawdi-runtime-watch",
					state: "RUNNING",
					status: "ok",
					description: null,
				},
				{
					name: "clawdi-daemon",
					state: "RUNNING",
					status: "ok",
					description: null,
				},
				{
					name: "clawdi-openclaw",
					state: "FATAL",
					status: "error",
					description: "Exited too quickly (process log may have details)",
				},
			],
		});
	});

	it("runtime observed ignores volatile watch timestamps and running uptimes", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		mkdirSync(join(state, "cache"), { recursive: true });
		mkdirSync(join(state, "supervisor"), { recursive: true });
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		const supervisorctl = join(bin, "supervisorctl");
		writeFileSync(
			supervisorctl,
			`#!/usr/bin/env bash
if [ ! -f '${root}/supervisor-count' ]; then
  echo 1 > '${root}/supervisor-count'
  echo 'clawdi-runtime-watch              RUNNING   pid 11, uptime 0:00:12'
else
  echo 'clawdi-runtime-watch              RUNNING   pid 11, uptime 0:12:34'
fi
`,
		);
		chmodSync(supervisorctl, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SUPERVISORCTL_PATH = supervisorctl;
		const paths = getRuntimePaths();
		writeFileSync(paths.supervisorConfig, "[supervisord]\n");
		writeFileSync(join(run, "supervisor.sock"), "");
		writeRuntimeWatchStatus(
			{ status: "applied", generation: 9, instanceId: "iid-observed-stable" },
			paths,
		);

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
		expect(second?.supervisor).toEqual({
			status: "ok",
			available: true,
			socketExists: true,
			programCount: 1,
			programs: [
				{
					name: "clawdi-runtime-watch",
					state: "RUNNING",
					status: "ok",
					description: null,
				},
			],
		});
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
				reasons: ["secret_missing"],
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
		const supervisorCalls = join(root, "supervisorctl.log");
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
		writeFileSync(
			join(bin, "supervisorctl"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${supervisorCalls}'
if [ "\${3:-}" = "status" ]; then
  cat <<'STATUS'
clawdi-daemon                    RUNNING   pid 10, uptime 0:00:12
clawdi-openclaw                  RUNNING   pid 11, uptime 0:00:12
clawdi-runtime-watch             RUNNING   pid 12, uptime 0:00:12
STATUS
fi
`,
		);
		chmodSync(join(bin, "supervisorctl"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.env.CLAWDI_SUPERVISORCTL_PATH = join(bin, "supervisorctl");
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
									openclaw: { enabled: false },
									hermes: { enabled: false },
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
				path: "/api/channels",
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
			expect(readFileSync(supervisorCalls, "utf-8")).toBe(
				`-c ${join(state, "supervisor", "supervisord.conf")} status\n-c ${join(
					state,
					"supervisor",
					"supervisord.conf",
				)} reread\n-c ${join(
					state,
					"supervisor",
					"supervisord.conf",
				)} update clawdi-daemon\n-c ${join(
					state,
					"supervisor",
					"supervisord.conf",
				)} update clawdi-openclaw\n`,
			);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.selfReexec).toBe(true);
			expect(event.cliUpdate.status).toBe("installed");
			expect(event.cliUpdate.packageSpec).toBe("clawdi@0.13.1-beta.0");
		} finally {
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
								deploymentId: "dep_cli_update_converge_failure",
								environmentId: "env_cli_update_converge_failure",
								instanceId: "iid_cli_update_converge_failure",
								generation: 16,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@0.13.3-beta.0" },
								runtimes: {
									openclaw: { enabled: true },
									hermes: { enabled: false },
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
				path: "/api/channels",
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

	it("runtime watch applies supervisor state when CLI install fails", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		const bin = join(root, "bin");
		const supervisorCalls = join(root, "supervisorctl.log");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(join(bin, "npm"), "#!/usr/bin/env bash\necho npm down >&2\nexit 42\n");
		chmodSync(join(bin, "npm"), 0o700);
		writeFileSync(
			join(bin, "supervisorctl"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${supervisorCalls}'
if [ "\${3:-}" = "status" ]; then
  cat <<'STATUS'
clawdi-daemon                    RUNNING   pid 10, uptime 0:00:12
clawdi-runtime-watch             RUNNING   pid 12, uptime 0:00:12
STATUS
fi
`,
		);
		chmodSync(join(bin, "supervisorctl"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		process.env.CLAWDI_SUPERVISORCTL_PATH = join(bin, "supervisorctl");
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
								deploymentId: "dep_cli_update_failure",
								environmentId: "env_cli_update_failure",
								instanceId: "iid_cli_update_failure",
								generation: 17,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@0.13.4-beta.0" },
								runtimes: {
									openclaw: { enabled: false },
									hermes: { enabled: false },
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
				path: "/api/channels",
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
			expect(event.convergence.supervisorConfig).toBe(
				join(state, "supervisor", "supervisord.conf"),
			);
			expect(readFileSync(supervisorCalls, "utf-8")).toContain("update clawdi-daemon");
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
								deploymentId: "dep_init",
								environmentId: "env_init",
								instanceId: "iid_init",
								generation: 7,
								issuedAt: "2026-06-06T00:00:00Z",
								system: { home, workspace: join(home, "clawdi") },
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								runtimes: {
									openclaw: {
										enabled: true,
										install: { source: "official", args: [] },
									},
									hermes: { enabled: false },
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
				path: "/api/channels",
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
			expect(captured.map((request) => request.path)).toEqual(["/manifest", "/api/channels"]);
			expect(readFileSync(join(state, "cache", "manifest.etag"), "utf-8")).toBe(
				'"manifest-etag-init-7"\n',
			);
			expect(readFileSync(join(state, "cache", "channels.etag"), "utf-8")).toBe(
				'"channels-etag-init-1"\n',
			);
			const patchText = readFileSync(openclawPatch, "utf-8");
			expect(patchText).not.toContain('"$patch"');
			expect(patchText).toContain('"telegram"');
			expect(patchText).toContain('"botToken": "agent-token-init"');
			expect(patchText).toContain('"discord"');
			expect(patchText).toContain('"token": "discord-agent-token-init"');
			expect(patchText).toContain('"plugins"');
			expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe("@openclaw/discord\n");
			const secretsText = readFileSync(join(run, "secrets", "runtime-secrets.json"), "utf-8");
			expect(secretsText).toContain("secret://channels/telegram/");
			expect(secretsText).toContain("agent-token-init");
			expect(secretsText).toContain("secret://channels/discord/");
			expect(secretsText).toContain("discord-agent-token-init");
			const profileBundle = readFileSync(join(state, "config", "mitm", "profiles.json"), "utf-8");
			expect(profileBundle).toContain("clawdi-native-channels");
			expect(profileBundle).toContain("/api/channels/telegram");
			const status = JSON.parse(logs[0] ?? "{}");
			expect(status.status).toBe("ok");
			expect(status.activeGeneration).toBe(7);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
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
		expect(patchText).toContain('"bluebubbles": null');
		expect(patchText).not.toContain('"$patch"');
		expect(patchText).not.toContain('"botToken"');
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

	it("uses hosted system workspace when converging run and supervisor config", async () => {
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
							deploymentId: "dep_workspace",
							instanceId: "iid_workspace",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							system: { home, workspace },
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
							runtimes: {
								hermes: { enabled: false },
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
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			const hermesRunConfig = JSON.parse(
				readFileSync(join(state, "config", "run", "hermes.json"), "utf-8"),
			);

			expect(convergence.outputs.workspaceRoot).toBe(workspace);
			expect(existsSync(workspace)).toBe(true);
			expect(hermesRunConfig.cwd).toBe(workspace);
			expect(readFileSync(convergence.outputs.supervisorConfig, "utf-8")).toContain(
				`; Desired-state generation: 1`,
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
					deploymentId: "dep_legacy_api_url",
					instanceId: "iid_legacy_api_url",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					system: { home },
					controlPlane: { apiUrl: "https://api.test" },
					runtimes: {
						hermes: { enabled: false },
					},
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
					deploymentId: "dep_runtime_workspace",
					instanceId: "iid_runtime_workspace",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					system: { home, workspace: join(home, "system-workspace") },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					runtimes: {
						hermes: {
							enabled: false,
							paths: { workspace: runtimeWorkspace },
						},
					},
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

		expect(convergence.outputs.workspaceRoot).toBe(join(home, "system-workspace"));
		expect(hermesRunConfig.cwd).toBe(runtimeWorkspace);
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
		expect(openclawConfig.command).toBe("/bin/sh");
		expect(openclawConfig.args[0]).toBe("-lc");
		expect(openclawConfig.args[1]).toContain("CLAWDI_API_URL='https://cloud-api.test'");
		expect(openclawConfig.args[1]).toContain(`cat '${authTokenFile}'`);
		expect(JSON.stringify(openclawConfig)).not.toContain("deploy-key-secret");
		const hermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(hermesConfig).toContain("mcp_servers:");
		expect(hermesConfig).toContain("clawdi:");
		expect(hermesConfig).toContain("command: /bin/sh");
		expect(hermesConfig).toContain('CLAWDI_AUTH_TOKEN="$(cat');
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

	it("adds the hosted UI bridge supervisor program for enabled UI runtimes", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env[UI_ACCESS_TOKEN_ENV] = "ui-secret";
		process.env[UI_BRIDGE_LISTEN_HOST_ENV] = "10.42.0.20";

		const convergence = convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_ui_bridge",
					environmentId: "env_ui_bridge",
					instanceId: "iid_ui_bridge",
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
				sourcePath: "test://ui-bridge",
				offline: false,
				secretValues: {},
			},
			getRuntimePaths(),
		);

		const supervisorConfig = readFileSync(convergence.outputs.supervisorConfig, "utf-8");
		expect(supervisorConfig).toContain("[program:clawdi-ui-bridge]");
		expect(supervisorConfig).toContain("command=/usr/bin/env clawdi runtime ui-bridge");
		expect(supervisorConfig).toContain('CLAWDI_UI_BRIDGE_LISTEN_HOST="10.42.0.20"');
		expect(supervisorConfig).toContain('CLAWDI_RUNTIME_REV="');
		const uiBridgeSection = supervisorConfig.split("[program:clawdi-openclaw]")[0];
		const openclawSection = supervisorConfig.split("[program:clawdi-openclaw]")[1] ?? "";
		expect(uiBridgeSection).toContain('UI_ACCESS_TOKEN="ui-secret"');
		expect(openclawSection).toContain('UI_ACCESS_TOKEN=""');
		expect(openclawSection).not.toContain("ui-secret");
	});

	it("does not advance last-good manifest cache when convergence has install errors", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const cachePath = join(state, "cache", "manifest.last-good.json");
		mkdirSync(dirname(cachePath), { recursive: true });
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
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
				runtimes: { openclaw: { enabled: true }, hermes: { enabled: false } },
			} as RuntimeManifest,
			source: "fixture-file",
			sourcePath: "test://install-error",
			offline: false,
			secretValues: {},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([
			"runtime openclaw is enabled but missing install metadata",
		]);
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
			convergeRuntimeManifest(
				{
					manifest,
					source: "fixture-file",
					sourcePath: "test://revision",
					offline: false,
					secretValues: {},
				},
				getRuntimePaths(),
			);
			const supervisorConfig = readFileSync(join(state, "supervisor", "supervisord.conf"), "utf-8");
			const match = supervisorConfig.match(
				new RegExp(`\\[program:clawdi-${runtime}\\][\\s\\S]*?CLAWDI_RUNTIME_REV="([^"]+)"`),
			);
			if (!match) throw new Error(`missing runtime revision for ${runtime}`);
			return match[1];
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
							deploymentId: "dep_manifest_only",
							instanceId: "iid_manifest_only",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							system: { home, workspace: join(home, "clawdi") },
							controlPlane: {
								manifestUrl: "https://runtime-source.test/v1/desired-state/",
							},
							runtimes: {
								openclaw: { enabled: false },
								hermes: { enabled: false },
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
								openclaw: { enabled: false, install: { source: "official" }, paths: { home } },
								hermes: { enabled: false, install: { source: "official" }, paths: { home } },
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
			expect(convergence.outputs.mitmSecretFile).toBe(join(run, "secrets", "runtime-secrets.json"));
			expect(convergence.outputs.supervisorConfig).toBe(
				join(state, "supervisor", "supervisord.conf"),
			);
			expect(existsSync(convergence.outputs.mitmSecretFile ?? "")).toBe(true);
			expect(existsSync(convergence.outputs.supervisorConfig)).toBe(true);
			const supervisorConfig = readFileSync(convergence.outputs.supervisorConfig, "utf-8");
			expect(supervisorConfig).toContain("[program:clawdi-runtime-watch]");
			expect(supervisorConfig).toContain("command=/usr/bin/env clawdi runtime watch");
			expect(supervisorConfig).not.toContain("[program:clawdi-daemon]");
			expect(supervisorConfig).not.toContain("[program:clawdi-openclaw]");
			expect(supervisorConfig).not.toContain("[program:clawdi-hermes]");
			expect(supervisorConfig).not.toContain("sk-runtime");
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
				status: "ok",
				configured: true,
				kind: "openai-compatible",
				baseUrl: "https://sub2api.test/v1",
				model: null,
				apiKeySecretRef: "provider.default.apiKey",
				secretAvailable: true,
				reasons: [],
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
								openclaw: { enabled: false, install: { source: "official" }, paths: { home } },
								hermes: { enabled: false, install: { source: "official" }, paths: { home } },
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
			const supervisorConfig = readFileSync(convergence.outputs.supervisorConfig, "utf-8");
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
			expect(supervisorConfig).toContain("[program:clawdi-runtime-watch]");
			expect(supervisorConfig).toContain("command=/usr/bin/env clawdi runtime watch");
			expect(supervisorConfig).toContain("chmod=0700");
			expect(supervisorConfig).toContain("chown=root:root");
			expect(supervisorConfig).toContain("[program:clawdi-daemon]");
			expect(supervisorConfig).toContain("clawdi daemon run");
			expect(supervisorConfig).toContain('CLAWDI_SERVE_MODE="container"');
			expect(supervisorConfig).toContain('CLAWDI_RUNTIME_REV="');
			expect(supervisorConfig).toContain("https://cloud-api.test");
			expect(supervisorConfig).not.toContain("runtime-auth-token");
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
					deploymentId: "dep_no_secret_ref",
					appId: "app_no_secret_ref",
					instanceId: "iid_no_secret_ref",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					system: { home, workspace: join(home, "clawdi") },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: { enabled: false, install: { source: "official" }, paths: { home } },
						hermes: { enabled: false, install: { source: "official" }, paths: { home } },
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
					deploymentId: "dep_bad_mitm",
					appId: "app_bad_mitm",
					instanceId: "iid_bad_mitm",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					system: { home, workspace: join(home, "clawdi") },
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					runtimes: {
						hermes: { enabled: false },
					},
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
								upstreamBaseUrl: "http://127.0.0.1:18890/api/channels/telegram",
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
