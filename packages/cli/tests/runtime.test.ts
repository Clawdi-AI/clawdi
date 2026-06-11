import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deniedCommandReason,
	evaluateHostPolicyForCommand,
	readHostPolicy,
} from "../src/runtime/host-policy";
import { convergeRuntimeManifest, loadRuntimeManifest } from "../src/runtime/manifest";
import { detectRuntimeMode, getRuntimePaths } from "../src/runtime/paths";
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
	"CUSTOM_RUNTIME_TOKEN",
	"CLAWDI_RUNTIME_MANIFEST_TIMEOUT_MS",
	"CLAWDI_API_URL",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

let originalEnv: Partial<Record<EnvKey, string>>;
let root: string;

beforeEach(() => {
	originalEnv = {};
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
	rmSync(root, { recursive: true, force: true });
});

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
			expect(loaded.manifest.runtimes.openclaw.install?.url).toBe(
				"https://openclaw.ai/install-cli.sh",
			);
			expect(loaded.manifest.runtimes.openclaw.install?.home).toBe(home);
			expect(loaded.manifest.runtimes.openclaw.install?.args).toEqual(["--json", "--no-onboard"]);
			expect(loaded.manifest.mitmProfiles?.profiles.map((profile) => profile.id)).toEqual([
				"native-telegram-bot-api",
				"native-discord-rest",
				"native-discord-gateway",
				"native-whatsapp-graph",
				"codex-openai-responses",
				"codex-chatgpt-backend-responses",
			]);
			const profiles = Object.fromEntries(
				loaded.manifest.mitmProfiles?.profiles.map((profile) => [profile.id, profile]) ?? [],
			);
			expect(profiles["native-telegram-bot-api"]?.rewrite).toEqual({
				upstreamBaseUrl: "https://cloud-api.test/api/channels/telegram",
				preservePath: true,
				setHeaders: {},
			});
			expect(profiles["native-discord-rest"]?.rewrite).toEqual({
				upstreamBaseUrl: "https://cloud-api.test/api/channels/discord",
				preservePath: true,
				setHeaders: {},
			});
			expect(profiles["native-discord-gateway"]?.rewrite).toEqual({
				upstreamBaseUrl: "wss://cloud-api.test/api/channels/discord/gateway",
				preservePath: true,
				setHeaders: {},
			});
			expect(profiles["native-whatsapp-graph"]?.rewrite).toEqual({
				upstreamBaseUrl: "https://cloud-api.test/api/channels/whatsapp/graph",
				preservePath: true,
				setHeaders: {},
			});
			expect(profiles["codex-openai-responses"]?.match.headers.authorization).toEqual({
				type: "secretRefEquals",
				secretRef: "secret://provider.default.apiKey",
				prefix: "Bearer ",
			});
			expect(profiles["codex-openai-responses"]?.rewrite).toEqual({
				upstreamBaseUrl: "https://sub2api.test/v1/responses",
				preservePath: false,
				setHeaders: {},
			});
			expect(profiles["codex-chatgpt-backend-responses"]?.match).toEqual({
				scheme: "https",
				host: "chatgpt.com",
				path: { type: "equals", value: "/backend-api/codex/responses" },
				headers: { authorization: { type: "exists" } },
				query: {},
			});
			expect(profiles["codex-chatgpt-backend-responses"]?.rewrite).toEqual({
				upstreamBaseUrl: "https://sub2api.test/v1/responses",
				preservePath: false,
				setHeaders: {
					authorization: {
						type: "secretRef",
						secretRef: "secret://provider.default.apiKey",
						prefix: "Bearer ",
					},
				},
			});
			expect(loaded.secretValues).toEqual({
				"provider.default.apiKey": "sk-runtime",
				"secret://provider.default.apiKey": "sk-runtime",
			});
		} finally {
			restore();
		}
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
			expect(convergence.outputs.mitmProfileBundle).toBe(
				join(state, "config", "mitm", "profiles.json"),
			);
			expect(convergence.outputs.mitmSecretFile).toBe(join(run, "mitm", "secrets.json"));
			expect(convergence.outputs.supervisorConfig).toBe(
				join(state, "supervisor", "supervisord.conf"),
			);
			expect(existsSync(convergence.outputs.mitmSecretFile ?? "")).toBe(true);
			expect(existsSync(convergence.outputs.supervisorConfig)).toBe(true);
			expect(readFileSync(convergence.outputs.supervisorConfig, "utf-8")).not.toContain(
				"[program:",
			);
			expect(readFileSync(join(state, "cache", "manifest.last-good.json"), "utf-8")).not.toContain(
				"sk-runtime",
			);
			expect(readFileSync(join(run, "mitm", "secrets.json"), "utf-8")).toContain("sk-runtime");
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
			expect(convergence.outputs.daemonAuthTokenFile).toBe(join(run, "sync", "auth-token"));
			expect(readFileSync(join(run, "sync", "auth-token"), "utf-8")).toBe("runtime-auth-token\n");
			expect(openclawEnv.id).toBe("env-openclaw");
			expect(codexEnv.id).toBe("env-codex");
			expect(supervisorConfig).toContain("[program:clawdi-daemon]");
			expect(supervisorConfig).toContain("clawdi daemon run");
			expect(supervisorConfig).toContain('CLAWDI_SERVE_MODE="container"');
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
		expect(loaded.manifest.mitmProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"native-telegram-bot-api",
			"native-discord-rest",
			"native-discord-gateway",
			"native-whatsapp-graph",
		]);
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
