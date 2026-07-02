import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convergeRuntimeManifest, loadRuntimeManifest, runtimeCommandShimScript } from "./manifest";
import type { RuntimePaths } from "./paths";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "clawdi-runtime-shim-"));
	tempDirs.push(dir);
	return dir;
}

function executable(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
}

function minimalPaths(serviceStateRoot: string, cliManagedBin: string): RuntimePaths {
	return {
		mode: "hosted",
		userHome: "/tmp/clawdi-user",
		clawdiHome: "/tmp/clawdi-home",
		localConfig: "/tmp/clawdi-home/config.json",
		localAuth: "/tmp/clawdi-home/auth.json",
		localPendingAuth: "/tmp/clawdi-home/pending-auth.json",
		localEnvironments: "/tmp/clawdi-home/environments",
		serveState: "/tmp/clawdi-home/serve",
		imageShim: "/usr/local/bin/clawdi",
		hostPolicy: "/etc/clawdi/host-policy.json",
		runtimeSource: "/etc/clawdi/runtime-source.json",
		shareRoot: "/usr/share/clawdi",
		serviceStateRoot,
		managedConfig: join(serviceStateRoot, "config", "clawdi.json"),
		syncState: join(serviceStateRoot, "sync", "runtimes.json"),
		cliShim: "/usr/local/bin/clawdi",
		cliManagedBin,
		cliNpmPrefix: join(serviceStateRoot, "npm"),
		cliNpmCache: join(serviceStateRoot, "npm-cache"),
		cliBootstrapStatus: join(serviceStateRoot, "status", "cli-bootstrap.json"),
		providerHealthStatus: join(serviceStateRoot, "status", "provider-health.json"),
		cacheRoot: join(serviceStateRoot, "cache"),
		manifestLastGood: join(serviceStateRoot, "cache", "manifest.last-good.json"),
		manifestEtag: join(serviceStateRoot, "cache", "manifest.etag"),
		channelsEtag: join(serviceStateRoot, "cache", "channels.etag"),
		runConfigRoot: join(serviceStateRoot, "config", "run"),
		mitmProfileRoot: join(serviceStateRoot, "config", "mitm"),
		mitmProfileBundle: join(serviceStateRoot, "config", "mitm", "profiles.json"),
		supervisorRoot: join(serviceStateRoot, "supervisor"),
		supervisorConfig: join(serviceStateRoot, "supervisor", "supervisord.conf"),
		bootRoot: join(serviceStateRoot, "boot"),
		bootStatus: join(serviceStateRoot, "cache", "boot-status.json"),
		runtimeWatchStatus: join(serviceStateRoot, "status", "runtime-watch.json"),
		cloudStatus: join(serviceStateRoot, "boot", "status.json"),
		cloudResult: join(serviceStateRoot, "boot", "result.json"),
		instanceRoot: join(serviceStateRoot, "instances"),
		installInventory: join(serviceStateRoot, "install-inventory"),
		projectionRoot: join(serviceStateRoot, "config", "projections"),
		runRoot: join(serviceStateRoot, "run"),
		managedSecretRoot: join(serviceStateRoot, "run", "secrets"),
		managedSecretFile: join(serviceStateRoot, "run", "secrets", "runtime-secrets.json"),
		daemonAuthToken: join(serviceStateRoot, "run", "secrets", "auth-token"),
		mcpHttpAuthToken: join(serviceStateRoot, "run", "secrets", "mcp-http-token"),
		instanceData: join(serviceStateRoot, "run", "instance-data.json"),
		sensitiveInstanceData: join(serviceStateRoot, "run", "instance-data-sensitive.json"),
		workspaceRoot: "/tmp/clawdi-user/clawdi",
	};
}

describe("runtime command shim", () => {
	it("lets OpenClaw's official update CLI bypass the runtime wrapper", () => {
		const root = makeTempDir();
		const shimDir = join(root, "service", "bin");
		const realBin = join(root, "real-bin");
		const logPath = join(root, "calls.log");
		mkdirSync(shimDir, { recursive: true });
		mkdirSync(realBin, { recursive: true });
		executable(join(realBin, "openclaw"), `#!/usr/bin/env sh\necho "openclaw:$*" >> ${logPath}\n`);
		executable(join(root, "clawdi"), `#!/usr/bin/env sh\necho "clawdi:$*" >> ${logPath}\n`);
		const shimPath = join(shimDir, "openclaw");
		writeFileSync(
			shimPath,
			runtimeCommandShimScript(minimalPaths(join(root, "service"), join(root, "clawdi"))),
			{ mode: 0o755 },
		);
		chmodSync(shimPath, 0o755);

		const env = { ...process.env, PATH: [shimDir, realBin, process.env.PATH ?? ""].join(":") };
		expect(spawnSync(shimPath, ["update", "--dry-run"], { env }).status).toBe(0);
		expect(spawnSync(shimPath, ["tui"], { env }).status).toBe(0);

		expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
			"openclaw:update --dry-run",
			"clawdi:run -- openclaw tui",
		]);
	});
});

describe("external runtime manifest mode", () => {
	it("normalizes hosted runtimeTargets into target-id keyed runtimes", async () => {
		const root = makeTempDir();
		const manifestPath = join(root, "hosted-runtime-targets.json");
		writeFileSync(
			manifestPath,
			`${JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					deploymentId: "hdep_targets",
					environmentId: "env_targets",
					instanceId: "inst_targets",
					generation: 1,
					issuedAt: "2026-07-01T00:00:00Z",
					system: {
						home: "/home/clawdi",
						workspace: "/home/clawdi/clawdi",
					},
					controlPlane: {
						cloudApiUrl: "https://api.example.test",
					},
					runtimes: {},
					runtimeTargets: {
						"openclaw-a": {
							type: "openclaw",
							enabled: true,
							environmentId: "env-openclaw-a",
							execution: {
								mode: "external",
								stateDir: "/state/openclaw-a",
							},
						},
						"openclaw-b": {
							type: "openclaw",
							enabled: true,
							environmentId: "env-openclaw-b",
							execution: {
								mode: "external",
								stateDir: "/state/openclaw-b",
							},
						},
						"hermes-a": {
							type: "hermes",
							enabled: true,
							environmentId: "env-hermes-a",
							execution: {
								mode: "external",
								home: "/home/hermes-a",
							},
						},
					},
				},
				secretValues: {},
			})}\n`,
		);

		const loaded = await loadRuntimeManifest(
			minimalPaths(join(root, "service"), join(root, "clawdi")),
			{ manifestPath },
		);

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) return;
		expect(Object.keys(loaded.manifest.runtimes).sort()).toEqual([
			"hermes-a",
			"openclaw-a",
			"openclaw-b",
		]);
		expect(loaded.manifest.runtimes["openclaw-a"]?.type).toBe("openclaw");
		expect(loaded.manifest.runtimes["openclaw-b"]?.execution?.stateDir).toBe("/state/openclaw-b");
		expect(loaded.manifest.runtimeTargets["hermes-a"]?.type).toBe("hermes");
	});

	it("rejects liveSync agentType values that are not runtime families", async () => {
		const root = makeTempDir();
		const manifestPath = join(root, "hosted-runtime-livesync-type.json");
		writeFileSync(
			manifestPath,
			`${JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					deploymentId: "hdep_livesync",
					environmentId: "env_livesync",
					instanceId: "inst_livesync",
					generation: 1,
					issuedAt: "2026-07-01T00:00:00Z",
					controlPlane: {
						cloudApiUrl: "https://api.example.test",
					},
					runtimeTargets: {
						"openclaw-a": {
							type: "openclaw",
							enabled: true,
							environmentId: "env-openclaw-a",
						},
					},
					liveSync: {
						enabled: true,
						agents: [
							{
								agentType: "openclaw-a",
								agentId: "openclaw-a",
								environmentId: "env-openclaw-a",
							},
						],
					},
				},
				secretValues: {},
			})}\n`,
		);

		const loaded = await loadRuntimeManifest(
			minimalPaths(join(root, "service"), join(root, "clawdi")),
			{ manifestPath },
		);

		expect("mode" in loaded && loaded.mode).toBe("manifest-rejected");
		expect("errors" in loaded ? loaded.errors.join("\n") : "").toContain(
			"manifest.liveSync.agents.0.agentType",
		);
	});

	it("normalizes hosted external runtimes without installer metadata", async () => {
		const root = makeTempDir();
		const manifestPath = join(root, "hosted-runtime.json");
		writeFileSync(
			manifestPath,
			`${JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					deploymentId: "hdep_external",
					environmentId: "env_external",
					instanceId: "inst_external",
					generation: 1,
					issuedAt: "2026-07-01T00:00:00Z",
					system: {
						home: "/home/clawdi",
						workspace: "/home/clawdi/clawdi",
					},
					controlPlane: {
						cloudApiUrl: "https://api.example.test",
					},
					runtimes: {
						openclaw: {
							type: "openclaw",
							enabled: true,
							install: { source: "official" },
							execution: { mode: "external" },
							paths: {
								home: "/home/node",
								stateDir: "/home/node/.openclaw",
								workspace: "/home/node/.openclaw/workspace",
							},
						},
					},
				},
				secretValues: {},
			})}\n`,
		);

		const loaded = await loadRuntimeManifest(
			minimalPaths(join(root, "service"), join(root, "clawdi")),
			{ manifestPath },
		);

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) return;
		const runtime = loaded.manifest.runtimes.openclaw;
		expect(runtime.install).toBeUndefined();
		expect(runtime.execution).toEqual({
			mode: "external",
			home: "/home/node",
			stateDir: "/home/node/.openclaw",
			workspace: "/home/node/.openclaw/workspace",
		});
	});

	it("keeps external runtimes out of sidecar run configs and supervisor programs", () => {
		const root = makeTempDir();
		const serviceRoot = join(root, "service");
		const paths = minimalPaths(serviceRoot, join(root, "clawdi"));
		const previousAuthToken = process.env.CLAWDI_AUTH_TOKEN;
		process.env.CLAWDI_AUTH_TOKEN = "test-runtime-token";
		try {
			const result = convergeRuntimeManifest(
				{
					manifest: {
						schemaVersion: "clawdi.runtimeDesiredState.v1",
						deploymentId: "hdep_external",
						environmentId: "env_external",
						instanceId: "inst_external",
						generation: 1,
						issuedAt: "2026-07-01T00:00:00Z",
						workspaceRoot: join(root, "workspace"),
						controlPlane: { apiUrl: "https://api.example.test" },
						runtimes: {
							openclaw: {
								type: "openclaw",
								enabled: true,
								services: {},
								execution: {
									mode: "external",
									home: "/home/node",
									stateDir: "/home/node/.openclaw",
									workspace: "/home/node/.openclaw/workspace",
								},
							},
						},
						liveSync: {
							enabled: true,
							agents: [
								{ agentType: "openclaw", agentId: "openclaw", environmentId: "env_external" },
							],
						},
						runtimeTargets: {},
						recovery: {},
					},
					source: "fixture-file",
					sourcePath: "test",
					offline: false,
				},
				paths,
			);

			expect(result.installErrors).toEqual([]);
			expect(result.outputs.runConfigs).toEqual([]);
			expect(readFileSync(paths.supervisorConfig, "utf8")).not.toContain(
				"[program:clawdi-openclaw]",
			);
			expect(readFileSync(paths.supervisorConfig, "utf8")).not.toContain(
				"[program:clawdi-runtime-bridge]",
			);
			expect(readFileSync(paths.supervisorConfig, "utf8")).toContain(
				'OPENCLAW_STATE_DIR="/home/node/.openclaw"',
			);
			expect(readFileSync(join(paths.installInventory, "openclaw.json"), "utf8")).toContain(
				'"status": "external"',
			);
			expect(readFileSync(paths.syncState, "utf8")).toContain('"executionMode": "external"');
			expect(readFileSync(join(paths.localEnvironments, "openclaw.json"), "utf8")).toContain(
				'"agentType": "openclaw"',
			);
		} finally {
			if (previousAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = previousAuthToken;
		}
	});

	it("projects external MCP directly to the backend by default", () => {
		const root = makeTempDir();
		const paths = minimalPaths(join(root, "service"), join(root, "clawdi"));
		const controlPath = join(root, "agent-control");
		const logPath = join(root, "agent-control.log");
		executable(
			controlPath,
			`#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> ${logPath}\ncat >/dev/null\n`,
		);
		const previousAuthToken = process.env.CLAWDI_AUTH_TOKEN;
		process.env.CLAWDI_AUTH_TOKEN = "test-runtime-token";
		try {
			const result = convergeRuntimeManifest(
				{
					manifest: {
						schemaVersion: "clawdi.runtimeDesiredState.v1",
						deploymentId: "hdep_external",
						environmentId: "env_external",
						instanceId: "inst_external",
						generation: 1,
						issuedAt: "2026-07-01T00:00:00Z",
						workspaceRoot: join(root, "workspace"),
						controlPlane: { apiUrl: "https://api.example.test" },
						runtimes: {
							openclaw: {
								type: "openclaw",
								enabled: true,
								services: {},
								execution: {
									mode: "external",
									home: "/home/node",
									stateDir: "/home/node/.openclaw",
									controlCommand: { command: controlPath, args: [], env: {} },
								},
							},
						},
						projection: { mcp: {} },
						runtimeTargets: {},
						recovery: {},
					},
					source: "fixture-file",
					sourcePath: "test",
					offline: false,
				},
				paths,
			);

			expect(result.installErrors).toEqual([]);
			const supervisor = readFileSync(paths.supervisorConfig, "utf8");
			expect(supervisor).not.toContain("[program:clawdi-mcp-http]");
			expect(result.outputs.mcpHttpAuthTokenFile).toBeNull();
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("mcp set clawdi");
			expect(log).toContain('"url":"https://api.example.test/mcp/clawdi"');
			expect(log).toContain('"transport":"streamable-http"');
			expect(log).toContain('"Authorization":"Bearer test-runtime-token"');
		} finally {
			if (previousAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = previousAuthToken;
		}
	});

	it("starts sidecar MCP HTTP only for explicit sidecar-local MCP", () => {
		const root = makeTempDir();
		const paths = minimalPaths(join(root, "service"), join(root, "clawdi"));
		const controlPath = join(root, "agent-control");
		const logPath = join(root, "agent-control.log");
		executable(
			controlPath,
			`#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> ${logPath}\nprintf 'OPENCLAW_STATE_DIR=%s\\n' "$OPENCLAW_STATE_DIR" >> ${logPath}\ncat >/dev/null\n`,
		);
		const previousAuthToken = process.env.CLAWDI_AUTH_TOKEN;
		process.env.CLAWDI_AUTH_TOKEN = "test-runtime-token";
		try {
			const result = convergeRuntimeManifest(
				{
					manifest: {
						schemaVersion: "clawdi.runtimeDesiredState.v1",
						deploymentId: "hdep_external",
						environmentId: "env_external",
						instanceId: "inst_external",
						generation: 1,
						issuedAt: "2026-07-01T00:00:00Z",
						workspaceRoot: join(root, "workspace"),
						controlPlane: { apiUrl: "https://api.example.test" },
						runtimes: {
							openclaw: {
								type: "openclaw",
								enabled: true,
								services: {},
								execution: {
									mode: "external",
									home: "/home/node",
									stateDir: "/home/node/.openclaw",
									controlCommand: { command: controlPath, args: [], env: {} },
									mcp: {
										source: "sidecar-local",
										url: "http://clawdi-sidecar:8788/mcp",
										transport: "streamable-http",
									},
								},
							},
						},
						projection: { mcp: {} },
						runtimeTargets: {},
						recovery: {},
					},
					source: "fixture-file",
					sourcePath: "test",
					offline: false,
				},
				paths,
			);

			expect(result.installErrors).toEqual([]);
			const supervisor = readFileSync(paths.supervisorConfig, "utf8");
			expect(supervisor).toContain("[program:clawdi-mcp-http]");
			expect(supervisor).toContain("clawdi mcp http");
			expect(supervisor).toContain("--host");
			expect(supervisor).toContain("0.0.0.0");
			expect(supervisor).toContain("--port");
			expect(supervisor).toContain("8788");
			expect(supervisor).toContain("--path");
			expect(supervisor).toContain("/mcp");
			expect(supervisor).toContain("--auth-token-file");
			expect(supervisor).toContain(paths.mcpHttpAuthToken);
			expect(result.outputs.mcpHttpAuthTokenFile).toBe(paths.mcpHttpAuthToken);
			expect(readFileSync(logPath, "utf8")).toContain("mcp set clawdi");
			expect(readFileSync(logPath, "utf8")).toContain('"transport":"streamable-http"');
			expect(readFileSync(logPath, "utf8")).toContain('"headers"');
			expect(readFileSync(logPath, "utf8")).toContain('"Authorization":"Bearer ');
			expect(readFileSync(logPath, "utf8")).toContain("OPENCLAW_STATE_DIR=/home/node/.openclaw");
		} finally {
			if (previousAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = previousAuthToken;
		}
	});

	it("rejects external OpenClaw projections without an explicit control command", async () => {
		const root = makeTempDir();
		const manifestPath = join(root, "hosted-openclaw-no-control.json");
		writeFileSync(
			manifestPath,
			`${JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					deploymentId: "hdep_no_control",
					environmentId: "env_no_control",
					instanceId: "inst_no_control",
					generation: 1,
					issuedAt: "2026-07-01T00:00:00Z",
					controlPlane: {
						cloudApiUrl: "https://api.example.test",
					},
					runtimeTargets: {
						"openclaw-a": {
							type: "openclaw",
							enabled: true,
							execution: {
								mode: "external",
								stateDir: "/state/openclaw-a",
								mcp: {
									source: "sidecar-local",
									url: "http://clawdi-sidecar:8788/mcp",
									transport: "streamable-http",
								},
							},
						},
					},
					mcp: { enabled: true },
				},
				secretValues: {},
			})}\n`,
		);

		const loaded = await loadRuntimeManifest(
			minimalPaths(join(root, "service"), join(root, "clawdi")),
			{ manifestPath },
		);

		expect("mode" in loaded && loaded.mode).toBe("manifest-rejected");
		expect("errors" in loaded ? loaded.errors.join("\n") : "").toContain(
			"runtime openclaw-a external OpenClaw projection requires execution.controlCommand",
		);
	});

	it("projects two external OpenClaw targets with separate state directories", () => {
		const root = makeTempDir();
		const paths = minimalPaths(join(root, "service"), join(root, "clawdi"));
		const controlPath = join(root, "agent-control");
		const logPath = join(root, "agent-control.log");
		executable(
			controlPath,
			[
				"#!/usr/bin/env sh",
				`printf 'ARGS=%s\\n' "$*" >> ${logPath}`,
				`printf 'STATE=%s\\n' "$OPENCLAW_STATE_DIR" >> ${logPath}`,
				"cat >/dev/null",
				"",
			].join("\n"),
		);
		const previousAuthToken = process.env.CLAWDI_AUTH_TOKEN;
		process.env.CLAWDI_AUTH_TOKEN = "test-runtime-token";
		try {
			const result = convergeRuntimeManifest(
				{
					manifest: {
						schemaVersion: "clawdi.runtimeDesiredState.v1",
						deploymentId: "hdep_multi",
						environmentId: "env_multi",
						instanceId: "inst_multi",
						generation: 1,
						issuedAt: "2026-07-01T00:00:00Z",
						workspaceRoot: join(root, "workspace"),
						controlPlane: { apiUrl: "https://api.example.test" },
						runtimes: {
							"openclaw-a": {
								type: "openclaw",
								enabled: true,
								environmentId: "env-openclaw-a",
								services: {},
								execution: {
									mode: "external",
									stateDir: "/state/openclaw-a",
									controlCommand: { command: controlPath, args: ["openclaw-a"], env: {} },
								},
							},
							"openclaw-b": {
								type: "openclaw",
								enabled: true,
								environmentId: "env-openclaw-b",
								services: {},
								execution: {
									mode: "external",
									stateDir: "/state/openclaw-b",
									controlCommand: { command: controlPath, args: ["openclaw-b"], env: {} },
								},
							},
						},
						runtimeTargets: {},
						projection: {
							providers: {
								"openclaw-a": {
									baseUrl: "https://provider-a.example.test/v1",
									model: "model-a",
									apiKeySecretRef: "provider.openclaw-a.apiKey",
								},
								"openclaw-b": {
									baseUrl: "https://provider-b.example.test/v1",
									model: "model-b",
									apiKeySecretRef: "provider.openclaw-b.apiKey",
								},
							},
						},
						liveSync: { enabled: true, agents: [] },
						recovery: {},
					},
					source: "fixture-file",
					sourcePath: "test",
					offline: false,
					secretValues: {
						"provider.openclaw-a.apiKey": "sk-a",
						"provider.openclaw-b.apiKey": "sk-b",
					},
				},
				paths,
			);

			expect(result.installErrors).toEqual([]);
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("ARGS=openclaw-a config patch --stdin --replace-path models.providers");
			expect(log).toContain("STATE=/state/openclaw-a");
			expect(log).toContain("ARGS=openclaw-b config patch --stdin --replace-path models.providers");
			expect(log).toContain("STATE=/state/openclaw-b");
			expect(readFileSync(join(paths.localEnvironments, "openclaw-a.json"), "utf8")).toContain(
				'"agentId": "openclaw-a"',
			);
			expect(readFileSync(join(paths.localEnvironments, "openclaw-b.json"), "utf8")).toContain(
				'"agentId": "openclaw-b"',
			);
			const supervisor = readFileSync(paths.supervisorConfig, "utf8");
			expect(supervisor).toContain("[program:clawdi-daemon-openclaw-a]");
			expect(supervisor).toContain("[program:clawdi-daemon-openclaw-b]");
			expect(supervisor).toContain('CLAWDI_AGENT_ID="openclaw-a"');
			expect(supervisor).toContain('CLAWDI_AGENT_ID="openclaw-b"');
			expect(supervisor).toContain('OPENCLAW_STATE_DIR="/state/openclaw-a"');
			expect(supervisor).toContain('OPENCLAW_STATE_DIR="/state/openclaw-b"');
		} finally {
			if (previousAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = previousAuthToken;
		}
	});

	it("records observed versions from explicit external version commands", () => {
		const root = makeTempDir();
		const paths = minimalPaths(join(root, "service"), join(root, "clawdi"));
		const controlPath = join(root, "agent-control");
		const versionPath = join(root, "agent-version");
		executable(controlPath, "#!/usr/bin/env sh\ncat >/dev/null\n");
		executable(versionPath, "#!/usr/bin/env sh\nprintf 'OpenClaw 2026.6.11\\n'\n");

		const result = convergeRuntimeManifest(
			{
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "hdep_version",
					environmentId: "env_version",
					instanceId: "inst_version",
					generation: 1,
					issuedAt: "2026-07-01T00:00:00Z",
					workspaceRoot: join(root, "workspace"),
					controlPlane: { apiUrl: "https://api.example.test" },
					runtimes: {
						"openclaw-a": {
							type: "openclaw",
							enabled: true,
							version: { desired: "2026.6.11" },
							services: {},
							execution: {
								mode: "external",
								stateDir: "/state/openclaw-a",
								controlCommand: { command: controlPath, args: [], env: {} },
								versionCommand: { command: versionPath, args: [], env: {} },
							},
						},
					},
					runtimeTargets: {},
					recovery: {},
				},
				source: "fixture-file",
				sourcePath: "test",
				offline: false,
			},
			paths,
		);

		expect(result.installErrors).toEqual([]);
		const inventory = JSON.parse(
			readFileSync(join(paths.installInventory, "openclaw-a.json"), "utf8"),
		) as { version: { observed: string; source: string; upgradeAvailable: boolean } };
		expect(inventory.version.observed).toBe("OpenClaw 2026.6.11");
		expect(inventory.version.source).toBe("version-command");
		expect(inventory.version.upgradeAvailable).toBe(true);
	});

	it("rejects external runtimes that do not share one sidecar MCP endpoint", () => {
		const root = makeTempDir();
		const paths = minimalPaths(join(root, "service"), join(root, "clawdi"));
		const previousAuthToken = process.env.CLAWDI_AUTH_TOKEN;
		process.env.CLAWDI_AUTH_TOKEN = "test-runtime-token";
		try {
			expect(() =>
				convergeRuntimeManifest(
					{
						manifest: {
							schemaVersion: "clawdi.runtimeDesiredState.v1",
							deploymentId: "hdep_external",
							environmentId: "env_external",
							instanceId: "inst_external",
							generation: 1,
							issuedAt: "2026-07-01T00:00:00Z",
							workspaceRoot: join(root, "workspace"),
							controlPlane: { apiUrl: "https://api.example.test" },
							runtimes: {
								openclaw: {
									type: "openclaw",
									enabled: true,
									services: {},
									execution: {
										mode: "external",
										home: "/home/node",
										stateDir: "/home/node/.openclaw",
										mcp: {
											source: "sidecar-local",
											url: "http://clawdi-sidecar:8788/mcp",
											transport: "streamable-http",
										},
									},
								},
								hermes: {
									type: "hermes",
									enabled: true,
									services: {},
									execution: {
										mode: "external",
										home: "/opt/data",
										stateDir: "/opt/data",
										mcp: {
											source: "sidecar-local",
											url: "http://clawdi-sidecar:8789/mcp",
											transport: "streamable-http",
										},
									},
								},
							},
							projection: { mcp: {} },
							runtimeTargets: {},
							recovery: {},
						},
						source: "fixture-file",
						sourcePath: "test",
						offline: false,
					},
					paths,
				),
			).toThrow("sidecar-local MCP runtimes must share one sidecar port and path");
		} finally {
			if (previousAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = previousAuthToken;
		}
	});
});
