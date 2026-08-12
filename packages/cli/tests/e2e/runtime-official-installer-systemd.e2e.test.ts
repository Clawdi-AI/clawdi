import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	applySystemdRuntimeUpdate,
	quiesceSystemdRuntimeCandidate,
	readSystemdUnitSnapshot,
} from "../../src/commands/runtime";
import { hostedAiProviderCatalog } from "../../src/runtime/hosted-provider-resolution";
import {
	buildOpenClawHostedProviderPatch,
	convergeRuntimeManifest,
} from "../../src/runtime/manifest";
import {
	FILE_BROWSER_AMD64_SHA256,
	FILE_BROWSER_ARM64_SHA256,
	FILE_BROWSER_COMMIT,
	FILE_BROWSER_VERSION,
	type RuntimeManifest,
} from "../../src/runtime/manifest-contract";
import type { RuntimeManifestLoad } from "../../src/runtime/manifest-source";
import { getRuntimePaths } from "../../src/runtime/paths";
import { ensureRuntimeStateDirs } from "../../src/runtime/state";

const REAL_SYSTEMD_GATE = "CLAWDI_TEST_REAL_OPENCLAW_SYSTEMD";

test("propagates the real official OpenClaw installer failure and rolls back as UID 10001", () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const runtimeHome = "/home/clawdi";
	const runtimeUid = 10_001;
	const runtimeGid = 10_001;
	const commandPath = join(runtimeHome, ".local", "bin", "openclaw");
	const expectedVersion = process.env.CLAWDI_TEST_OPENCLAW_VERSION ?? "";
	const expectedCommit = process.env.CLAWDI_TEST_OPENCLAW_COMMIT ?? "";
	const version = spawnSync(commandPath, ["--version"], {
		encoding: "utf8",
		env: { ...process.env, HOME: runtimeHome },
	});
	expect(version.status).toBe(0);
	expect(version.stdout).toContain(`OpenClaw ${expectedVersion}`);
	expect(version.stdout).toContain(`(${expectedCommit.slice(0, 7)})`);
	const loginShell = spawnSync(
		"runuser",
		[
			"-u",
			"clawdi",
			"--",
			"env",
			`HOME=${runtimeHome}`,
			"/bin/bash",
			"-l",
			"-c",
			"command -v openclaw",
		],
		{ encoding: "utf8" },
	);
	expect(loginShell.status, loginShell.stderr).toBe(0);
	expect(loginShell.stdout.trim()).toBe(commandPath);

	const userManager = spawnSync("systemctl", ["is-active", `user@${runtimeUid}.service`], {
		encoding: "utf8",
	});
	expect(userManager.status).toBe(0);
	expect(userManager.stdout.trim()).toBe("active");
	expect(statSync(`/run/user/${runtimeUid}/bus`).isSocket()).toBe(true);
	const userSystemd = spawnSync(
		"runuser",
		[
			"-u",
			"clawdi",
			"--",
			"env",
			`HOME=${runtimeHome}`,
			`XDG_RUNTIME_DIR=/run/user/${runtimeUid}`,
			`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${runtimeUid}/bus`,
			"systemctl",
			"--user",
			"show-environment",
		],
		{ encoding: "utf8" },
	);
	expect(userSystemd.status).toBe(0);

	const root = mkdtempSync(join(tmpdir(), "clawdi-real-openclaw-systemd-"));
	chmodSync(root, 0o755);
	const clawdiHome = join(root, "clawdi-home");
	mkdirSync(clawdiHome);
	chownSync(clawdiHome, runtimeUid, runtimeGid);
	chmodSync(clawdiHome, 0o700);
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = "clawdi";
	process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
	process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
	process.env.CLAWDI_RUNTIME_HOME = runtimeHome;
	process.env.CLAWDI_HOME = clawdiHome;
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
	process.env.CLAWDI_AUTH_TOKEN = "real-systemd-test-auth-token";
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	rmSync(join(paths.systemdUserRoot, "openclaw-gateway.service"), {
		recursive: true,
		force: true,
	});
	const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
	const unitSentinel = join(unitPath, "preserved-before-install");
	const dropInPath = join(
		paths.systemdUserRoot,
		"openclaw-gateway.service.d",
		"10-clawdi-hosted.conf",
	);
	const enablementPath = join(
		paths.systemdUserRoot,
		"default.target.wants",
		"openclaw-gateway.service",
	);
	const openClawConfig = join(runtimeHome, ".openclaw", "openclaw.json");
	const gatewayEnvironment = join(runtimeHome, ".openclaw", "gateway.systemd.env");
	expect(existsSync(unitPath)).toBe(false);
	expect(existsSync(openClawConfig)).toBe(false);
	expect(existsSync(gatewayEnvironment)).toBe(false);
	const openClawWorkspaceRoot = join(runtimeHome, ".openclaw", "workspace");
	const previousOpenClawConfig = `${JSON.stringify({
		agents: { defaults: { workspace: openClawWorkspaceRoot } },
		gateway: { mode: "local" },
	})}\n`;
	const previousGatewayEnvironment = "PRESERVED_ENV=before\n";
	mkdirSync(dirname(openClawConfig), { recursive: true, mode: 0o700 });
	chownSync(dirname(openClawConfig), runtimeUid, runtimeGid);
	writeFileSync(openClawConfig, previousOpenClawConfig, { mode: 0o600 });
	chownSync(openClawConfig, runtimeUid, runtimeGid);
	writeFileSync(gatewayEnvironment, previousGatewayEnvironment, { mode: 0o600 });
	mkdirSync(dirname(unitPath), { recursive: true });
	mkdirSync(unitPath, { recursive: false });
	writeFileSync(unitSentinel, "preserve exact rollback target\n");

	const workspaceRoot = join(runtimeHome, "clawdi-systemd-test-workspace");
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_real_openclaw_systemd",
		environmentId: "env_real_openclaw_systemd",
		instanceId: "hri_real_openclaw_systemd",
		generation: 1,
		issuedAt: "2026-08-02T00:00:00.000Z",
		workspaceRoot,
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: {
			openclaw: {
				enabled: true,
				run: { command: commandPath, args: ["gateway", "run"], env: {}, prependPath: [] },
				services: {},
			},
		},
		recovery: {},
	};
	const load: RuntimeManifestLoad = {
		manifest,
		source: "remote-datasource",
		sourcePath: "real-openclaw-systemd-fixture",
		offline: false,
		applyContext: {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: manifest.generation,
				manifestETag: '"real-systemd-test"',
				applyReceiptId: "real-systemd-test-receipt",
				bootNonce: "real-systemd-test-boot",
			},
			cliPackageSpec: "clawdi@1.2.3",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_real_openclaw_systemd",
				auth: { type: "bearer", token: "real-systemd-test-auth-token" },
			},
		},
	};
	let authorityCommits = 0;
	const result = convergeRuntimeManifest(load, paths, {
		executeOfficialServiceInstallers: true,
		cacheLastGood: false,
		commitAuthority: () => {
			authorityCommits += 1;
		},
	});
	const detail = result.installErrors.join("\n");
	expect(detail).toContain("official openclaw-gateway service install failed");
	expect(detail).toContain("exit code 1");
	expect(detail).toContain("stdout tail:");
	expect(detail).toContain("Gateway install failed:");
	expect(detail).toContain("EISDIR");
	expect(detail).not.toContain("stderr tail:");
	expect(detail.length).toBeLessThan(5000);
	expect(authorityCommits).toBe(0);
	expect(statSync(unitPath).isDirectory()).toBe(true);
	expect(readFileSync(unitSentinel, "utf8")).toBe("preserve exact rollback target\n");
	expect(readFileSync(openClawConfig, "utf8")).toBe(previousOpenClawConfig);
	expect(readFileSync(gatewayEnvironment, "utf8")).toBe(previousGatewayEnvironment);
	for (const path of [unitPath, gatewayEnvironment]) {
		const stat = statSync(path);
		expect(stat.uid).toBe(0);
		expect(stat.gid).toBe(0);
	}
	expect(statSync(openClawConfig).uid).toBe(runtimeUid);
	expect(statSync(openClawConfig).gid).toBe(runtimeGid);
	expect(statSync(openClawConfig).mode & 0o777).toBe(0o600);
	expect(statSync(gatewayEnvironment).mode & 0o777).toBe(0o600);
	for (const path of [
		`${unitPath}.bak`,
		dropInPath,
		enablementPath,
		paths.managedConfig,
		paths.manifestLastGood,
	]) {
		expect(existsSync(path)).toBe(false);
	}
	expect(existsSync(workspaceRoot)).toBe(false);
});

test("projects a large OpenClaw provider model-list reduction through the public mutation SDK", () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const runtimeHome = "/home/clawdi";
	const runtimeUid = 10_001;
	const runtimeGid = 10_001;
	const commandPath = join(runtimeHome, ".local", "bin", "openclaw");
	const expectedNodeVersion = process.env.CLAWDI_TEST_OPENCLAW_NODE_VERSION ?? "";
	const commandStat = lstatSync(commandPath);
	expect(commandStat.isFile()).toBe(true);
	expect(commandStat.isSymbolicLink()).toBe(false);
	expect(commandStat.size).toBe(172);
	expect(realpathSync(join(runtimeHome, ".local", "tools", "node"))).toBe(
		join(runtimeHome, ".local", "tools", `node-v${expectedNodeVersion}`),
	);
	const root = mkdtempSync(join(tmpdir(), "clawdi-real-openclaw-size-drop-"));
	chmodSync(root, 0o755);
	const clawdiHome = join(root, "clawdi-home");
	mkdirSync(clawdiHome);
	chownSync(clawdiHome, runtimeUid, runtimeGid);
	chmodSync(clawdiHome, 0o700);
	const configRoot = join(root, "openclaw");
	mkdirSync(configRoot, { mode: 0o700 });
	chownSync(configRoot, runtimeUid, runtimeGid);
	const configPath = join(configRoot, "openclaw.json");
	const staleModels = Array.from({ length: 18 }, (_, index) => ({
		id: `legacy-managed-${index}`,
		name: `Legacy managed responses model ${index}`,
		api: "openai-completions",
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
	}));
	const userProvider = {
		baseUrl: "https://user-provider.example.test/v1",
		api: "openai-completions",
		models: [
			{
				id: "user-model",
				name: "User-owned model",
				api: "openai-completions",
				input: ["text"],
				contextWindow: 32_768,
				maxTokens: 8_192,
			},
		],
	};
	const existingConfig = {
		agents: { defaults: { workspace: join(runtimeHome, "user-workspace") } },
		gateway: { mode: "local", port: 19_022 },
		logging: { level: "debug" },
		models: {
			mode: "merge",
			providers: {
				"user-owned": userProvider,
				clawdi: {
					baseUrl: "https://ai-gateway.example.test/v1",
					api: "openai-completions",
					models: staleModels,
				},
			},
		},
	};
	const originalConfig = `${JSON.stringify(existingConfig, null, 2)}\n`;
	writeFileSync(configPath, originalConfig, { mode: 0o600 });
	chownSync(configPath, runtimeUid, runtimeGid);

	const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
	const previousProviderKey = process.env.CLAWDI_OPENCLAW_API_KEY;
	process.env.OPENCLAW_CONFIG_PATH = configPath;
	process.env.CLAWDI_OPENCLAW_API_KEY = "clawdi-egress-placeholder";
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = "clawdi";
	process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
	process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
	process.env.CLAWDI_RUNTIME_HOME = runtimeHome;
	process.env.CLAWDI_HOME = clawdiHome;
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
	process.env.CLAWDI_AUTH_TOKEN = "real-size-drop-test-auth-token";
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);

	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_real_openclaw_size_drop",
		environmentId: "env_real_openclaw_size_drop",
		instanceId: "hri_real_openclaw_size_drop",
		generation: 1,
		issuedAt: "2026-08-11T23:08:17.000Z",
		workspaceRoot: runtimeHome,
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		projection: {
			providers: {
				clawdi: {
					type: "custom_openai_compatible",
					managed_by: "clawdi",
					baseUrl: "https://ai-gateway.example.test/v1",
					models: [
						{
							id: "sol",
							label: "Sol",
							api_mode: "openai_chat",
							input_modalities: ["text"],
							supports_tools: true,
							supports_reasoning: true,
							context_window: 200_000,
							max_tokens: 64_000,
							cost: { input: 1.5, output: 12, cache_read: 0.15, cache_write: 1.5 },
						},
					],
					apiMode: "openai_chat",
					runtimeEnvName: "OPENAI_API_KEY",
					apiKeySecretRef: "secret://providers/clawdi/api-key",
				},
			},
		},
		runtimes: {
			openclaw: {
				enabled: true,
				providerMode: "configured",
				provider_ids: ["clawdi"],
				primary_model: { provider_id: "clawdi", model: "sol" },
				run: { command: commandPath, args: ["gateway", "run"], env: {}, prependPath: [] },
				services: {},
			},
		},
		recovery: {},
	};
	const load: RuntimeManifestLoad = {
		manifest,
		source: "remote-datasource",
		sourcePath: "real-openclaw-size-drop-fixture",
		offline: false,
		secretValues: { "secret://providers/clawdi/api-key": "sk-size-drop-fixture" },
		applyContext: {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: manifest.generation,
				manifestETag: '"real-size-drop-test"',
				applyReceiptId: "real-size-drop-test-receipt",
				bootNonce: "real-size-drop-test-boot",
			},
			cliPackageSpec: "clawdi@1.2.3",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_real_openclaw_size_drop",
				auth: { type: "bearer", token: "real-size-drop-test-auth-token" },
			},
		},
	};

	try {
		const projectionInput = hostedAiProviderCatalog(manifest, "openclaw");
		if (!projectionInput) throw new Error("expected OpenClaw provider projection");
		const intendedPatch = buildOpenClawHostedProviderPatch(projectionInput, ["clawdi"]);
		expect(intendedPatch.args).toEqual(["--replace-path", 'models.providers["clawdi"]']);
		const rejected = spawnSync(
			"runuser",
			[
				"-u",
				"clawdi",
				"--",
				"env",
				`HOME=${runtimeHome}`,
				`OPENCLAW_CONFIG_PATH=${configPath}`,
				"CLAWDI_OPENCLAW_API_KEY=clawdi-egress-placeholder",
				commandPath,
				"config",
				"patch",
				"--stdin",
				...intendedPatch.args,
			],
			{ encoding: "utf8", input: intendedPatch.content },
		);
		expect(rejected.status).not.toBe(0);
		const rejectedOutput = `${rejected.stdout}\n${rejected.stderr}`;
		const sizeDrop = rejectedOutput.match(/size-drop:(\d+)->(\d+)/);
		expect(sizeDrop).not.toBeNull();
		if (!sizeDrop) throw new Error(rejectedOutput);
		const beforeBytes = Number(sizeDrop[1]);
		const rejectedBytes = Number(sizeDrop[2]);
		expect(beforeBytes).toBeGreaterThan(5_000);
		expect(rejectedBytes).toBeLessThan(Math.floor(beforeBytes * 0.5));
		expect(readFileSync(configPath, "utf8")).toBe(originalConfig);

		const convergence = convergeRuntimeManifest(load, paths, { cacheLastGood: false });
		expect(convergence.installErrors).toEqual([]);
		const intendedConfig = JSON.parse(intendedPatch.content);
		const appliedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		expect(appliedConfig.models.mode).toBe("replace");
		expect(appliedConfig.models.providers.clawdi).toEqual(intendedConfig.models.providers.clawdi);
		expect(appliedConfig.models.providers.clawdi.models).toEqual(
			intendedConfig.models.providers.clawdi.models,
		);
		expect(appliedConfig.models.providers["user-owned"]).toEqual(userProvider);
		expect(appliedConfig.agents.defaults.workspace).toBe(existingConfig.agents.defaults.workspace);
		expect(appliedConfig.gateway).toEqual(existingConfig.gateway);
		expect(appliedConfig.logging).toEqual(existingConfig.logging);
		expect(JSON.stringify(appliedConfig)).not.toContain("legacy-managed-");
		expect(Buffer.byteLength(readFileSync(configPath, "utf8"))).toBeLessThan(
			Math.floor(beforeBytes * 0.5),
		);
		const configStat = statSync(configPath);
		expect(configStat.uid).toBe(runtimeUid);
		expect(configStat.gid).toBe(runtimeGid);
		expect(configStat.mode & 0o777).toBe(0o600);
	} finally {
		if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
		else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
		if (previousProviderKey === undefined) delete process.env.CLAWDI_OPENCLAW_API_KEY;
		else process.env.CLAWDI_OPENCLAW_API_KEY = previousProviderKey;
	}
}, 60_000);

test("persists and serves the managed token through the real official OpenClaw gateway", async () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const runtimeHome = "/home/clawdi";
	const runtimeUid = 10_001;
	const runtimeGid = 10_001;
	const commandPath = join(runtimeHome, ".local", "bin", "openclaw");
	const root = mkdtempSync(join(tmpdir(), "clawdi-real-openclaw-token-"));
	chmodSync(root, 0o755);
	const clawdiHome = join(root, "clawdi-home");
	mkdirSync(clawdiHome);
	chownSync(clawdiHome, runtimeUid, runtimeGid);
	chmodSync(clawdiHome, 0o700);
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = "clawdi";
	process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
	process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
	process.env.CLAWDI_RUNTIME_HOME = runtimeHome;
	process.env.CLAWDI_HOME = clawdiHome;
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
	process.env.CLAWDI_AUTH_TOKEN = "real-token-test-auth-token";
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
	const dropInRoot = join(paths.systemdUserRoot, "openclaw-gateway.service.d");
	const enablementPath = join(
		paths.systemdUserRoot,
		"default.target.wants",
		"openclaw-gateway.service",
	);
	const openClawConfig = join(runtimeHome, ".openclaw", "openclaw.json");
	const officialGatewayEnvironment = join(runtimeHome, ".openclaw", "gateway.systemd.env");
	const managedToken = "managed-gateway-token";
	const staleToken = "stale-config-token";
	const runUserSystemctl = (...args: string[]) =>
		spawnSync(
			"runuser",
			[
				"-u",
				"clawdi",
				"--",
				"env",
				`HOME=${runtimeHome}`,
				`XDG_RUNTIME_DIR=/run/user/${runtimeUid}`,
				`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${runtimeUid}/bus`,
				"systemctl",
				"--user",
				...args,
			],
			{ encoding: "utf8" },
		);

	runUserSystemctl("disable", "--now", "openclaw-gateway.service");
	rmSync(unitPath, { recursive: true, force: true });
	rmSync(dropInRoot, { recursive: true, force: true });
	rmSync(enablementPath, { force: true });
	const workspaceRoot = join(runtimeHome, ".openclaw", "workspace");
	writeFileSync(
		openClawConfig,
		`${JSON.stringify({
			agents: { defaults: { workspace: workspaceRoot } },
			gateway: { mode: "local", auth: { mode: "token", token: staleToken } },
		})}\n`,
		{ mode: 0o600 },
	);
	chownSync(openClawConfig, runtimeUid, runtimeGid);

	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_real_openclaw_token",
		environmentId: "env_real_openclaw_token",
		instanceId: "hri_real_openclaw_token",
		generation: 1,
		issuedAt: "2026-08-11T00:00:00.000Z",
		workspaceRoot,
		projection: {
			sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
			system: {
				openclawControlUiAllowedOrigins: ["https://agent.example.test"],
			},
		},
		openclawGatewayAuth: {
			mode: "token",
			tokenRef: "secret://runtime/openclaw/gateway-token",
			deviceAuthRequired: false,
			activation: { enabled: true, capability: "openclaw-native-auth-v1" },
		},
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: {
			openclaw: {
				enabled: true,
				run: {
					command: commandPath,
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
			},
		},
		recovery: {},
	};
	const load: RuntimeManifestLoad = {
		manifest,
		source: "remote-datasource",
		sourcePath: "real-openclaw-token-fixture",
		offline: false,
		secretValues: { "secret://runtime/openclaw/gateway-token": managedToken },
		applyContext: {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: manifest.generation,
				manifestETag: '"real-token-test"',
				applyReceiptId: "real-token-test-receipt",
				bootNonce: "real-token-test-boot",
			},
			cliPackageSpec: "clawdi@1.2.3",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_real_openclaw_token",
				auth: { type: "bearer", token: "real-token-test-auth-token" },
			},
		},
	};

	try {
		const result = convergeRuntimeManifest(load, paths, {
			executeOfficialServiceInstallers: true,
			cacheLastGood: false,
		});
		expect(result.installErrors).toEqual([]);
		const config = JSON.parse(readFileSync(openClawConfig, "utf8")) as {
			gateway?: { auth?: { token?: string } };
		};
		expect(config.gateway?.auth?.token).toBe(managedToken);
		expect(readFileSync(unitPath, "utf8")).not.toContain(managedToken);
		if (existsSync(officialGatewayEnvironment)) {
			expect(readFileSync(officialGatewayEnvironment, "utf8")).not.toContain(managedToken);
			expect(readFileSync(officialGatewayEnvironment, "utf8")).not.toContain(staleToken);
		}
		const managedEnvironment = join(paths.systemdEnvRoot, "openclaw-gateway.service.env");
		expect(statSync(managedEnvironment).mode & 0o777).toBe(0o600);
		expect(readFileSync(managedEnvironment, "utf8")).not.toContain("OPENCLAW_GATEWAY_TOKEN");
		expect(readFileSync(managedEnvironment, "utf8")).not.toContain(managedToken);
		expect(readFileSync(managedEnvironment, "utf8")).not.toContain(staleToken);

		expect(runUserSystemctl("daemon-reload").status).toBe(0);
		expect(runUserSystemctl("enable", "--now", "openclaw-gateway.service").status).toBe(0);
		expect(runUserSystemctl("restart", "openclaw-gateway.service").status).toBe(0);
		const gatewayHealth = (token?: string, configPath = openClawConfig) => {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				HOME: runtimeHome,
				OPENCLAW_CONFIG_PATH: configPath,
			};
			if (token === undefined) delete env.OPENCLAW_GATEWAY_TOKEN;
			else env.OPENCLAW_GATEWAY_TOKEN = token;
			return spawnSync(commandPath, ["gateway", "health", "--port", "18789", "--timeout", "1000"], {
				encoding: "utf8",
				env,
			});
		};
		let managedHealth = gatewayHealth(managedToken);
		for (let attempt = 0; attempt < 30 && managedHealth.status !== 0; attempt += 1) {
			await Bun.sleep(100);
			managedHealth = gatewayHealth(managedToken);
		}
		expect(`${managedHealth.stdout}\n${managedHealth.stderr}`).toContain("Gateway Health");
		expect(managedHealth.status).toBe(0);
		// With no env override, the official client resolves the persisted config token.
		expect(gatewayHealth().status).toBe(0);

		const staleClientConfig = join(root, "stale-openclaw-client.json");
		writeFileSync(
			staleClientConfig,
			`${JSON.stringify({ gateway: { auth: { mode: "token", token: staleToken } } })}\n`,
			{ mode: 0o600 },
		);
		const staleHealth = gatewayHealth(undefined, staleClientConfig);
		expect(staleHealth.status).not.toBe(0);
		expect(`${staleHealth.stdout}\n${staleHealth.stderr}`).toMatch(/unauthorized|token mismatch/i);
	} finally {
		runUserSystemctl("disable", "--now", "openclaw-gateway.service");
		rmSync(unitPath, { recursive: true, force: true });
		rmSync(dropInRoot, { recursive: true, force: true });
		rmSync(enablementPath, { force: true });
	}
}, 60_000);

test("runs Files as the tenant while preserving platform isolation", () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const runtimeHome = "/home/clawdi";
	const runtimeUid = 10_001;
	const runtimeGid = 10_001;
	const openClawCommand = join(runtimeHome, ".local", "bin", "openclaw");
	const root = mkdtempSync("/var/lib/clawdi-real-filebrowser-systemd-");
	chmodSync(root, 0o755);
	const tenantExisting = join(runtimeHome, "files-tenant-existing.txt");
	writeFileSync(tenantExisting, "tenant-existing\n", { mode: 0o600 });
	chownSync(tenantExisting, runtimeUid, runtimeGid);
	const rootOwnedControl = join(runtimeHome, "files-root-owned-control.txt");
	writeFileSync(rootOwnedControl, "root-owned\n", { mode: 0o600 });
	const hermesConfig = join(runtimeHome, ".hermes", "config.yaml");
	mkdirSync(dirname(hermesConfig), { recursive: true, mode: 0o700 });
	chownSync(dirname(hermesConfig), runtimeUid, runtimeGid);
	writeFileSync(hermesConfig, "model: test\n", { mode: 0o600 });
	chownSync(hermesConfig, runtimeUid, runtimeGid);

	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = "clawdi";
	process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
	process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
	process.env.CLAWDI_RUNTIME_HOME = runtimeHome;
	delete process.env.CLAWDI_HOME;
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = "/run/systemd/system";
	process.env.CLAWDI_AUTH_TOKEN = "real-filebrowser-systemd-test-auth-token";
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	const openClawConfig = join(runtimeHome, ".openclaw", "openclaw.json");
	const openClawWorkspaceRoot = join(runtimeHome, ".openclaw", "workspace");
	mkdirSync(dirname(openClawConfig), { recursive: true, mode: 0o700 });
	chownSync(dirname(openClawConfig), runtimeUid, runtimeGid);
	writeFileSync(
		openClawConfig,
		`${JSON.stringify({
			agents: { defaults: { workspace: openClawWorkspaceRoot } },
		})}\n`,
		{ mode: 0o600 },
	);
	chownSync(openClawConfig, runtimeUid, runtimeGid);
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	const legacyEnvironmentRoot = join(runtimeHome, ".clawdi", "environments");
	mkdirSync(legacyEnvironmentRoot, { recursive: true });
	writeFileSync(
		join(legacyEnvironmentRoot, "openclaw.json"),
		`${JSON.stringify({
			id: "env_legacy_openclaw",
			agentType: "openclaw",
			managedBy: "clawdi runtime init",
		})}\n`,
	);
	const systemNpmCli = "/usr/local/lib/node_modules/clawdi/bin/clawdi.mjs";
	mkdirSync(dirname(systemNpmCli), { recursive: true });
	writeFileSync(systemNpmCli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	symlinkSync("../lib/node_modules/clawdi/bin/clawdi.mjs", "/usr/local/bin/clawdi");
	const tenantClawdi = () =>
		spawnSync(
			"runuser",
			[
				"-u",
				"clawdi",
				"--",
				"env",
				`HOME=${runtimeHome}`,
				"PATH=/usr/local/bin:/usr/bin:/bin",
				"/bin/sh",
				"-c",
				"command -v clawdi",
			],
			{ encoding: "utf8" },
		);
	expect(tenantClawdi().stdout.trim()).toBe("/usr/local/bin/clawdi");
	const globalServiceDropInRoot = join(paths.systemdSystemRoot, "service.d");
	mkdirSync(globalServiceDropInRoot, { recursive: true });
	writeFileSync(
		join(globalServiceDropInRoot, "zzz-lxc-service.conf"),
		"[Service]\nProcSubset=all\nProtectProc=default\nProtectControlGroups=no\nProtectKernelTunables=no\nNoNewPrivileges=no\nLoadCredential=\nPrivateNetwork=no\nImportCredential=\n",
	);
	rmSync(join(paths.systemdUserRoot, "openclaw-gateway.service"), {
		recursive: true,
		force: true,
	});
	const serviceCreated = join(runtimeHome, "files-service-created.txt");
	const tenantCreated = join(runtimeHome, "files-tenant-created.txt");
	const binary = `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '%s\n' '${FILE_BROWSER_VERSION} ${FILE_BROWSER_COMMIT.slice(0, 7)}'
  exit 0
fi
exec /usr/local/bin/node -e '
const fs = require("fs");
const http = require("http");
const config = fs.readFileSync(process.argv[1], "utf8");
const listen = config.match(/^\\s*listen:\\s*(\\S+)\\s*$/m)?.[1];
const port = Number(config.match(/^\\s*port:\\s*(\\d+)\\s*$/m)?.[1]);
if (!listen || !Number.isInteger(port)) process.exit(64);
const existing = fs.readFileSync(${JSON.stringify(tenantExisting)}, "utf8");
const hermes = fs.readFileSync(${JSON.stringify(hermesConfig)}, "utf8");
fs.writeFileSync(${JSON.stringify(hermesConfig)}, hermes);
try {
  fs.readFileSync(${JSON.stringify(rootOwnedControl)});
  process.exit(77);
} catch (error) {
  if (error?.code !== "EACCES") throw error;
}
fs.writeFileSync(${JSON.stringify(serviceCreated)}, existing);
fs.mkdirSync(${JSON.stringify(join(runtimeHome, "tmp", "thumbnails"))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(runtimeHome, "tmp", "thumbnails", "preview.jpg"))}, "preview\\n");
fs.mkdirSync(${JSON.stringify(join(paths.fileBrowserStateRoot, "cache"))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(paths.fileBrowserStateRoot, "filebrowser.db"))}, "service-state\\n");
http.createServer((request, response) => {
  if (request.url === "/read-new") {
    response.end(fs.readFileSync(${JSON.stringify(tenantCreated)}, "utf8"));
    return;
  }
  response.end("ok");
}).listen(port, listen);
' "$2"
`;
	const binarySha256 = createHash("sha256").update(binary).digest("hex");
	const release = `https://github.com/gtsteffaniak/filebrowser/releases/download/${FILE_BROWSER_VERSION}`;
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_real_filebrowser_systemd",
		environmentId: "env_real_filebrowser_systemd",
		instanceId: "hri_real_filebrowser_systemd",
		generation: 1,
		issuedAt: "2026-08-06T00:00:00.000Z",
		workspaceRoot: runtimeHome,
		projection: {
			sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
			system: {
				openclawControlUiAllowedOrigins: ["https://app-v2-18789.example.test"],
			},
			providers: {
				clawdi: {
					type: "custom_openai_compatible",
					managed_by: "clawdi",
					baseUrl: "https://ai-gateway.example.test/v1",
					model: "gpt-test",
					apiMode: "openai_chat",
					runtimeEnvName: "OPENAI_API_KEY",
					apiKeySecretRef: "secret://providers/clawdi/api-key",
				},
			},
		},
		openclawGatewayAuth: {
			mode: "token",
			tokenRef: "secret://runtime/openclaw/gateway-token",
			deviceAuthRequired: false,
			activation: { enabled: true, capability: "openclaw-native-auth-v1" },
		},
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		companions: {
			filebrowser: {
				version: FILE_BROWSER_VERSION,
				commit: FILE_BROWSER_COMMIT,
				listen: "0.0.0.0",
				port: 9120,
				baseURL: "/",
				healthPath: "/health",
				sourceRoot: runtimeHome,
				assets: {
					amd64: {
						url: `${release}/linux-amd64-filebrowser`,
						sha256: FILE_BROWSER_AMD64_SHA256,
					},
					arm64: {
						url: `${release}/linux-arm64-filebrowser`,
						sha256: FILE_BROWSER_ARM64_SHA256,
					},
				},
				auth: {
					method: "jwt",
					algorithm: "HS256",
					header: "X-JWT-Assertion",
					userIdentifier: "sub",
					groupsClaim: "groups",
					secret: "s".repeat(43),
					audience: "clawdi-files:hdep_real_filebrowser_systemd",
					subject: "deployment:hdep_real_filebrowser_systemd:owner",
					requiredGroup: `clawdi-files:hdep_real_filebrowser_systemd:${"a".repeat(64)}`,
					accessRevision: "a".repeat(64),
				},
			},
		},
		runtimes: {
			openclaw: {
				enabled: true,
				providerMode: "configured",
				provider_ids: ["clawdi"],
				primary_model: { provider_id: "clawdi", model: "gpt-test" },
				run: {
					command: openClawCommand,
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
			},
		},
		recovery: {},
	};
	// The production digest remains schema-pinned; this isolated executable is
	// injected only after constructing the already typed fixture.
	Reflect.set(manifest.companions?.filebrowser?.assets.amd64 ?? {}, "sha256", binarySha256);
	const load: RuntimeManifestLoad = {
		manifest,
		source: "remote-datasource",
		sourcePath: "real-filebrowser-systemd-fixture",
		offline: false,
		secretValues: {
			"secret://runtime/openclaw/gateway-token": "fixture-gateway-token",
			"secret://providers/clawdi/api-key": "sk-clawdi-provider",
		},
		applyContext: {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: manifest.generation,
				manifestETag: '"real-filebrowser-systemd-test"',
				applyReceiptId: "real-filebrowser-systemd-test-receipt",
				bootNonce: "real-filebrowser-systemd-test-boot",
			},
			cliPackageSpec: "clawdi@1.2.3",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_real_filebrowser_systemd",
				auth: { type: "bearer", token: "real-filebrowser-systemd-test-auth-token" },
			},
		},
	};
	const converge = () => {
		const before = readSystemdUnitSnapshot(paths);
		let failed = before;
		return convergeRuntimeManifest(load, paths, {
			fileBrowserInstallOptions: {
				download: (_url, destination) => writeFileSync(destination, binary),
			},
			systemdApply: {
				quiesce: () => {
					failed = readSystemdUnitSnapshot(paths);
					quiesceSystemdRuntimeCandidate(paths, failed);
				},
				activateEgressPrerequisite: () => ({
					applied: true,
					systemUnitsChanged: [],
					userUnitsChanged: [],
				}),
				activate: () => {
					failed = readSystemdUnitSnapshot(paths);
					return applySystemdRuntimeUpdate(paths, before, failed);
				},
				rollback: () => {
					applySystemdRuntimeUpdate(paths, failed, readSystemdUnitSnapshot(paths), {
						recoverFailedUnits: false,
					});
				},
			},
		});
	};
	const result = converge();
	expect(result.installErrors).toEqual([]);
	const gatewayEnv = readFileSync(
		join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
		"utf8",
	);
	expect(gatewayEnv).toContain('CLAWDI_OPENCLAW_API_KEY="clawdi-egress-placeholder"');
	expect(gatewayEnv).not.toMatch(/^OPENAI_API_KEY=/m);
	expect(gatewayEnv).not.toContain("sk-clawdi-provider");
	const projectedOpenClawConfig = JSON.parse(readFileSync(openClawConfig, "utf8")) as {
		models?: { providers?: Record<string, { baseUrl?: string; apiKey?: { id?: string } }> };
	};
	expect(projectedOpenClawConfig.models?.providers?.clawdi).toMatchObject({
		baseUrl: "https://ai-gateway.example.test/v1",
		apiKey: { id: "CLAWDI_OPENCLAW_API_KEY" },
	});
	expect(existsSync(join(runtimeHome, ".clawdi"))).toBe(false);
	expect(statSync(paths.clawdiHome).uid).toBe(runtimeUid);
	expect(statSync(paths.clawdiHome).gid).toBe(runtimeGid);
	expect(statSync(paths.clawdiHome).mode & 0o777).toBe(0o750);
	const tenantClawdiAfterConverge = tenantClawdi();
	expect(tenantClawdiAfterConverge.status).not.toBe(0);
	expect(tenantClawdiAfterConverge.stdout).toBe("");

	expect(spawnSync("getent", ["passwd", "clawdi-files"]).status).not.toBe(0);
	for (const config of [openClawConfig, hermesConfig]) {
		for (const access of ["-r", "-w"] as const) {
			expect(spawnSync("runuser", ["-u", "clawdi", "--", "test", access, config]).status).toBe(0);
		}
		expect(spawnSync("runuser", ["-u", "clawdi", "--", "test", "-x", dirname(config)]).status).toBe(
			0,
		);
	}
	expect(
		spawnSync("runuser", ["-u", "clawdi", "--", "test", "!", "-r", rootOwnedControl]).status,
	).toBe(0);

	const candidatesRoot = join(paths.fileBrowserInstallRoot, "candidates");
	const activeCandidate = join(candidatesRoot, binarySha256);
	const activeBinary = join(activeCandidate, "filebrowser");
	const receipt = paths.installReceipts;
	for (const path of [
		paths.fileBrowserInstallRoot,
		candidatesRoot,
		activeCandidate,
		activeBinary,
		receipt,
		paths.manifestLastGood,
	]) {
		expect(statSync(path).uid).toBe(0);
		expect(statSync(path).gid).toBe(0);
	}
	expect(statSync(paths.fileBrowserConfigRoot).uid).toBe(0);
	expect(statSync(paths.fileBrowserConfigRoot).gid).toBe(0);
	expect(statSync(paths.fileBrowserConfigRoot).mode & 0o777).toBe(0o700);
	expect(statSync(paths.fileBrowserConfig).uid).toBe(0);
	expect(statSync(paths.fileBrowserConfig).gid).toBe(runtimeGid);
	expect(statSync(paths.fileBrowserConfig).mode & 0o777).toBe(0o440);
	expect(statSync(paths.fileBrowserStateRoot).uid).toBe(runtimeUid);
	expect(statSync(paths.fileBrowserStateRoot).gid).toBe(runtimeGid);
	expect(statSync(paths.fileBrowserStateRoot).mode & 0o777).toBe(0o700);
	expect(statSync(receipt).mode & 0o777).toBe(0o600);
	expect(statSync(paths.manifestLastGood).mode & 0o777).toBe(0o600);
	expect(readFileSync(paths.manifestLastGood, "utf8")).toContain(`"secret": "${"s".repeat(43)}"`);
	const cache = join(paths.fileBrowserStateRoot, "cache");
	const database = join(paths.fileBrowserStateRoot, "filebrowser.db");
	for (const path of [cache, database]) {
		expect(statSync(path).uid).toBe(runtimeUid);
		expect(statSync(path).gid).toBe(runtimeGid);
	}
	expect(statSync(cache).mode & 0o777).toBe(0o700);
	expect(statSync(database).mode & 0o777).toBe(0o600);

	for (const path of [
		paths.fileBrowserConfigRoot,
		paths.fileBrowserConfig,
		receipt,
		paths.manifestLastGood,
	]) {
		const denied = spawnSync("runuser", ["-u", "clawdi", "--", "test", "!", "-r", path]);
		expect(denied.status).toBe(0);
	}
	for (const path of [
		paths.fileBrowserInstallRoot,
		candidatesRoot,
		activeCandidate,
		activeBinary,
		paths.fileBrowserConfig,
		receipt,
		paths.manifestLastGood,
		join(paths.systemdSystemRoot, "clawdi-files.service"),
	]) {
		const denied = spawnSync("runuser", ["-u", "clawdi", "--", "test", "!", "-w", path]);
		expect(denied.status).toBe(0);
	}
	const overwrite = spawnSync("runuser", [
		"-u",
		"clawdi",
		"--",
		"sh",
		"-c",
		'printf tamper > "$1"',
		"sh",
		activeBinary,
	]);
	expect(overwrite.status).not.toBe(0);

	const mainPidResult = spawnSync(
		"systemctl",
		["show", "clawdi-files.service", "--property=MainPID", "--value"],
		{ encoding: "utf8" },
	);
	expect(mainPidResult.status).toBe(0);
	const mainPid = Number.parseInt(mainPidResult.stdout.trim(), 10);
	expect(mainPid).toBeGreaterThan(1);
	expect(statSync(`/proc/${mainPid}`).uid).toBe(runtimeUid);
	const unitControl = spawnSync(
		"runuser",
		["-u", "clawdi", "--", "systemctl", "stop", "clawdi-files.service"],
		{ timeout: 5000 },
	);
	expect(unitControl.status).not.toBe(0);
	expect(spawnSync("systemctl", ["is-active", "--quiet", "clawdi-files.service"]).status).toBe(0);
	const effectiveUnit = spawnSync("systemctl", ["cat", "clawdi-files.service"], {
		encoding: "utf8",
	});
	expect(effectiveUnit.status).toBe(0);
	expect(effectiveUnit.stdout).toContain("/run/systemd/system/service.d/zzz-lxc-service.conf");
	expect(effectiveUnit.stdout).toContain("PrivatePIDs=true");
	expect(effectiveUnit.stdout).toContain(
		`BindReadOnlyPaths=${paths.fileBrowserConfig}:${dirname(paths.fileBrowserServiceBinary)}/filebrowser.yaml:norbind`,
	);
	expect(effectiveUnit.stdout).toContain("LoadCredential=");
	expect(existsSync("/run/credentials/clawdi-files.service/filebrowser.yaml")).toBe(false);
	const configMountPoint = join(dirname(paths.fileBrowserServiceBinary), "filebrowser.yaml");
	expect(statSync(configMountPoint).isFile()).toBe(true);
	expect(readFileSync(configMountPoint, "utf8")).toBe("");

	let readinessStatus: number | null = null;
	for (let attempt = 0; attempt < 50; attempt++) {
		readinessStatus = spawnSync("curl", ["-fsS", "http://127.0.0.1:9120/health"]).status;
		if (readinessStatus === 0) break;
		spawnSync("sleep", ["0.1"]);
	}
	expect(readinessStatus).toBe(0);
	const reconverged = converge();
	expect(reconverged.installErrors).toEqual([]);

	const tenantWrite = spawnSync("runuser", [
		"-u",
		"clawdi",
		"--",
		"sh",
		"-c",
		'umask 077; printf "tenant-created\\n" > "$1"',
		"sh",
		tenantCreated,
	]);
	expect(tenantWrite.status).toBe(0);
	const serviceRead = spawnSync("curl", ["-fsS", "http://127.0.0.1:9120/read-new"], {
		encoding: "utf8",
	});
	expect(serviceRead.status).toBe(0);
	expect(serviceRead.stdout).toBe("tenant-created\n");
	const tenantRead = spawnSync("runuser", ["-u", "clawdi", "--", "cat", serviceCreated], {
		encoding: "utf8",
	});
	expect(tenantRead.status).toBe(0);
	expect(tenantRead.stdout).toBe("tenant-existing\n");
}, 90_000);
