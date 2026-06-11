import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runtimeInit, runtimeWatch } from "../src/commands/runtime";
import {
	deniedCommandReason,
	evaluateHostPolicyForCommand,
	readHostPolicy,
} from "../src/runtime/host-policy";
import { convergeRuntimeManifest, loadRuntimeManifest } from "../src/runtime/manifest";
import {
	loadRemoteRuntimeChannels,
	loadRemoteRuntimeManifest,
} from "../src/runtime/manifest-source";
import { readHostedRuntimeObserved } from "../src/runtime/observed";
import { detectRuntimeMode, getRuntimePaths } from "../src/runtime/paths";
import {
	buildRuntimeBootStatus,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../src/runtime/state";
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
	"CLAWDI_SUPERVISORCTL_PATH",
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
			expect(loaded.manifest.mitmProfiles?.profiles.map((profile) => profile.id)).toEqual([
				"native-telegram-bot-api-passthrough",
				"native-discord-rest-passthrough",
				"native-discord-gateway-passthrough",
				"native-whatsapp-graph-passthrough",
				"codex-openai-responses",
				"codex-openai-responses-passthrough",
				"codex-chatgpt-backend-responses",
				"codex-chatgpt-backend-responses-passthrough",
			]);
			const profiles = Object.fromEntries(
				loaded.manifest.mitmProfiles?.profiles.map((profile) => [profile.id, profile]) ?? [],
			);
			expect(profiles["native-telegram-bot-api-passthrough"]?.kind).toBe("passthrough");
			expect(profiles["native-discord-rest-passthrough"]?.kind).toBe("passthrough");
			expect(profiles["native-discord-gateway-passthrough"]?.kind).toBe("passthrough");
			expect(profiles["native-whatsapp-graph-passthrough"]?.kind).toBe("passthrough");
			expect(profiles["codex-openai-responses"]?.match.headers.authorization).toEqual({
				type: "equals",
				value: "clawdi-mitm-placeholder",
				prefix: "Bearer ",
			});
			expect(profiles["codex-openai-responses"]?.rewrite).toEqual({
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
			expect(profiles["codex-chatgpt-backend-responses"]?.match).toEqual({
				scheme: "https",
				host: "chatgpt.com",
				path: { type: "equals", value: "/backend-api/codex/responses" },
				headers: {
					authorization: {
						type: "equals",
						value: "clawdi-mitm-placeholder",
						prefix: "Bearer ",
					},
				},
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
			expect(profiles["codex-openai-responses-passthrough"]?.kind).toBe("passthrough");
			expect(profiles["codex-chatgpt-backend-responses-passthrough"]?.kind).toBe("passthrough");
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

	it("loads remote manifests with If-None-Match and auth-token file fallback", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const sourcePath = join(root, "runtime-source.json");
		mkdirSync(join(run, "sync"), { recursive: true });
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		writeFileSync(join(run, "sync", "auth-token"), "file-runtime-token\n");
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
		mkdirSync(join(run, "sync"), { recursive: true });
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_SOURCE_PATH = sourcePath;
		writeFileSync(join(run, "sync", "auth-token"), "file-runtime-token\n");
		writeFileSync(
			sourcePath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeSource.v1",
				type: "http",
				url: "https://runtime.test/api/runtime/manifest?ignored=1",
				auth: { type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" },
			}),
		);
		const { captured, restore } = mockFetch([
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
			expect(captured[0].path).toBe("/api/channels");
			expect(captured[0].headers.authorization).toBe("Bearer file-runtime-token");
			expect(captured[0].headers["if-none-match"]).toBe('"channels-etag-0"');
		} finally {
			restore();
		}
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
		mkdirSync(join(run, "sync"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(bin, "supervisorctl"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${supervisorCalls}'
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
		writeFileSync(join(run, "sync", "auth-token"), "file-runtime-token\n");
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

			if (process.exitCode !== undefined) {
				throw new Error(logs.join("\n"));
			}
			expect(process.exitCode).toBeUndefined();
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
				`-c ${join(state, "supervisor", "supervisord.conf")} reread\n-c ${join(
					state,
					"supervisor",
					"supervisord.conf",
				)} update\n`,
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
					description: "pid 11, uptime 0:00:12",
				},
				{
					name: "clawdi-daemon",
					state: "RUNNING",
					status: "ok",
					description: "pid 12, uptime 0:00:10",
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
		mkdirSync(join(run, "sync"), { recursive: true });
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
		writeFileSync(join(run, "sync", "auth-token"), "file-runtime-token\n");
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

			expect(process.exitCode).toBeUndefined();
			expect(captured).toHaveLength(2);
			const active = join(state, "bin", "clawdi");
			const activeTarget = join(state, "npm", "bin", "clawdi");
			expect(readlinkSync(active)).toBe(activeTarget);
			const status = JSON.parse(readFileSync(join(state, "status", "cli-bootstrap.json"), "utf-8"));
			expect(status.packageSpec).toBe("clawdi@0.13.1-beta.0");
			expect(status.activePath).toBe(active);
			expect(status.activeTarget).toBe(activeTarget);
			expect(status.version).toBe("0.13.1-beta.0");
			expect(readFileSync(supervisorCalls, "utf-8")).toBe(
				`-c ${join(state, "supervisor", "supervisord.conf")} reread\n-c ${join(
					state,
					"supervisor",
					"supervisord.conf",
				)} update\n`,
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
		mkdirSync(join(run, "sync"), { recursive: true });
		mkdirSync(join(home, ".openclaw", "bin"), { recursive: true });
		mkdirSync(join(root, "etc", "clawdi"), { recursive: true });
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
		writeFileSync(join(run, "sync", "auth-token"), "file-runtime-token\n");
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
			expect(patchText).toContain('"telegram"');
			expect(patchText).toContain('"botToken": "agent-token-init"');
			expect(patchText).toContain('"discord"');
			expect(patchText).toContain('"token": "discord-agent-token-init"');
			expect(patchText).toContain('"plugins"');
			expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe("@openclaw/discord\n");
			const secretsText = readFileSync(join(run, "mitm", "secrets.json"), "utf-8");
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
		const authTokenFile = join(run, "sync", "auth-token");
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
			expect(supervisorConfig).toContain("[program:clawdi-runtime-watch]");
			expect(supervisorConfig).toContain("command=/usr/bin/env clawdi runtime watch");
			expect(supervisorConfig).toContain("chmod=0770");
			expect(supervisorConfig).toContain("chown=clawdi:clawdi");
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
		expect(loaded.manifest.mitmProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"native-telegram-bot-api-passthrough",
			"native-discord-rest-passthrough",
			"native-discord-gateway-passthrough",
			"native-whatsapp-graph-passthrough",
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
