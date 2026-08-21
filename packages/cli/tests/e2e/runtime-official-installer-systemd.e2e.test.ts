import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lchownSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	resolveOpenClawSdkExport as resolveSdk,
	OPENCLAW_SDK_EXPORT_PATHS as SDK_EXPORTS,
} from "../../src/lib/codex-oauth-native-store";
import { hostedAiProviderCatalog } from "../../src/runtime/hosted-provider-resolution";
import {
	buildOpenClawHostedProviderPatch,
	convergeRuntimeManifest,
} from "../../src/runtime/manifest";
import type { RuntimeManifest } from "../../src/runtime/manifest-contract";
import type { RuntimeManifestLoad } from "../../src/runtime/manifest-source";
import { CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID } from "../../src/runtime/openclaw-managed-provider-plugin";
import { getRuntimePaths } from "../../src/runtime/paths";
import { ensureRuntimeStateDirs } from "../../src/runtime/state";
import {
	applySystemdRuntimeUpdate,
	readSystemdUnitSnapshot,
	SystemdRuntimeTransaction,
} from "../../src/runtime/systemd-transaction";

const REAL_SYSTEMD_GATE = "CLAWDI_TEST_REAL_OPENCLAW_SYSTEMD";
const FILE_BROWSER_VERSION = "v1.5.0-stable";
const FILE_BROWSER_COMMIT = "79552f8adb27c3e29934c4001660eb98f4aab5d6";
const FILE_BROWSER_AMD64_SHA256 =
	"8d51d1718d576d22e73e1f41a5194b451d152ddab0df97697cabe839cf59524e";
const FILE_BROWSER_ARM64_SHA256 =
	"3e18838ae33750a25da434dc6156a359968bf7935e01bdd884711f47f08ad92f";

const OPENCLAW_PROVIDER_AUTH_E2E_HELPER = `
import { pathToFileURL } from "node:url";
const [sdkPath, action, rawTargets] = process.argv.slice(1);
const sdk = await import(pathToFileURL(sdkPath).href);
const targets = JSON.parse(rawTargets);
if (!Array.isArray(targets)) throw new Error("invalid provider-auth targets");
const observations = [];
for (const [index, target] of targets.entries()) {
  const agentDir = typeof target === "string" ? target : undefined;
  if (action === "seed") {
    const markerId = "clawdi:cleanup-e2e-marker-" + index;
    const realId = "clawdi:cleanup-e2e-real-" + index;
    const userId = "openai:cleanup-e2e-user-" + index;
    sdk.upsertAuthProfile({
      profileId: markerId,
      credential: { type: "api_key", provider: "clawdi", key: "CLAWDI_AI_API_KEY" },
      ...(agentDir ? { agentDir } : {}),
    });
    const result = await sdk.updateAuthProfileStoreWithLock({
      ...(agentDir ? { agentDir } : {}),
      updater: (store) => {
        store.profiles[markerId] = { type: "api_key", provider: "clawdi", key: "CLAWDI_AI_API_KEY" };
        store.profiles[realId] = { type: "api_key", provider: "clawdi", key: "sk-real-reserved-provider" };
        store.profiles[userId] = { type: "api_key", provider: "openai", key: "sk-preserve" };
        store.order = { ...(store.order || {}), clawdi: [realId, markerId], openai: [userId] };
        store.lastGood = { ...(store.lastGood || {}), clawdi: realId, openai: userId };
        store.usageStats = {
          ...(store.usageStats || {}),
          [markerId]: { lastUsed: 1 },
          [realId]: { lastUsed: 2 },
          [userId]: { lastUsed: 3 },
        };
        return true;
      },
    });
    if (result === null) {
      throw new Error(
        "provider-auth seed failed for target " + index + ": " + (agentDir ?? "default"),
      );
    }
  } else if (action === "inspect") {
    const store = sdk.ensureAuthProfileStoreForLocalUpdate(agentDir);
    observations.push({
      profiles: store.profiles,
      order: store.order,
      lastGood: store.lastGood,
      usageStats: store.usageStats,
    });
  } else {
    throw new Error("invalid provider-auth action");
  }
}
process.stdout.write(JSON.stringify(observations));
`;

function directoryFileDigests(root: string, relative = ""): Record<string, string> {
	const digests: Record<string, string> = {};
	for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
		const entryRelative = join(relative, entry.name);
		if (entry.isDirectory()) {
			Object.assign(digests, directoryFileDigests(root, entryRelative));
		} else if (entry.isFile()) {
			digests[entryRelative] = createHash("sha256")
				.update(readFileSync(join(root, entryRelative)))
				.digest("hex");
		}
	}
	return digests;
}

function chownTreeWithoutFollowingLinks(path: string, uid: number, gid: number): void {
	const node = lstatSync(path);
	lchownSync(path, uid, gid);
	if (!node.isDirectory() || node.isSymbolicLink()) return;
	for (const entry of readdirSync(path)) {
		chownTreeWithoutFollowingLinks(join(path, entry), uid, gid);
	}
}

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
	const openClawStateDir = join(runtimeHome, ".openclaw");
	mkdirSync(openClawStateDir, { recursive: true });
	chownSync(openClawStateDir, runtimeUid, runtimeGid);
	chmodSync(openClawStateDir, 0o700);
	const openClawAgentsRoot = join(openClawStateDir, "agents");
	mkdirSync(openClawAgentsRoot, { recursive: true });
	chownSync(openClawAgentsRoot, runtimeUid, runtimeGid);
	chmodSync(openClawAgentsRoot, 0o700);
	const activeAgentDir = join(clawdiHome, "active-openclaw-agent");
	const secondaryAgentRoot = join(
		openClawAgentsRoot,
		`clawdi-auth-cleanup-${process.pid}-${Date.now()}`,
	);
	const secondaryAgentDir = join(secondaryAgentRoot, "agent");
	mkdirSync(secondaryAgentDir, { recursive: true });
	chownSync(secondaryAgentRoot, runtimeUid, runtimeGid);
	chownSync(secondaryAgentDir, runtimeUid, runtimeGid);
	const configPath = join(openClawStateDir, "openclaw.json");
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
		auth: {
			profiles: {
				"clawdi:default": { provider: "clawdi", mode: "api_key" },
				"clawdi:real-local": { provider: "ClAwDi", mode: "api_key" },
				"openai:user": { provider: "openai", mode: "api_key" },
			},
			order: {
				clawdi: ["clawdi:real-local", "clawdi:default"],
				openai: ["openai:user", "clawdi:default"],
			},
		},
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
	const previousProviderKey = process.env.CLAWDI_AI_API_KEY;
	const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
	const previousStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_CONFIG_PATH = configPath;
	process.env.OPENCLAW_AGENT_DIR = activeAgentDir;
	process.env.OPENCLAW_STATE_DIR = openClawStateDir;
	process.env.CLAWDI_AI_API_KEY = "clawdi-egress-placeholder";
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

	try {
		const providerAuthSdkPath = resolveSdk(runtimeHome, [commandPath], SDK_EXPORTS.providerAuth);
		expect(providerAuthSdkPath).not.toBeNull();
		if (!providerAuthSdkPath) throw new Error("official OpenClaw provider-auth SDK is unavailable");
		const authTargets = [null, activeAgentDir, secondaryAgentDir];
		const runProviderAuthHelper = (action: "seed" | "inspect") =>
			spawnSync(
				"runuser",
				[
					"-u",
					"clawdi",
					"--",
					"env",
					`HOME=${runtimeHome}`,
					`OPENCLAW_AGENT_DIR=${activeAgentDir}`,
					`OPENCLAW_STATE_DIR=${openClawStateDir}`,
					join(runtimeHome, ".local", "tools", "node", "bin", "node"),
					"--input-type=module",
					"--eval",
					OPENCLAW_PROVIDER_AUTH_E2E_HELPER,
					providerAuthSdkPath,
					action,
					JSON.stringify(authTargets),
				],
				{ encoding: "utf8" },
			);
		const seededAuth = runProviderAuthHelper("seed");
		expect(seededAuth.status, seededAuth.stderr).toBe(0);

		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_real_openclaw_size_drop",
			environmentId: "env_real_openclaw_size_drop",
			instanceId: "hri_real_openclaw_size_drop",
			generation: 1,
			issuedAt: "2026-08-11T23:08:17.000Z",
			workspaceRoot: runtimeHome,
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			openclawGatewayAuth: {
				mode: "token",
				tokenRef: "secret://runtime/openclaw/gateway-token",
				deviceAuthRequired: false,
				activation: { enabled: true, capability: "openclaw-native-auth-v1" },
			},
			projection: {
				sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
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
						apiMode: "openai_responses",
						runtimeEnvName: "CLAWDI_AI_API_KEY",
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
			secretValues: {
				"secret://providers/clawdi/api-key": "sk-size-drop-fixture",
				"secret://runtime/openclaw/gateway-token": "size-drop-gateway-token",
			},
			applyContext: {
				kind: "context-file",
				backend: "incus",
				identity: {
					generation: manifest.generation,
					manifestETag: '"real-size-drop-test"',
					applyReceiptId: "real-size-drop-test-receipt",
					bootNonce: "real-size-drop-test-boot",
				},
				manifestSource: {
					type: "http",
					url: "https://runtime.test/v1/runtime/manifest?environment_id=env_real_openclaw_size_drop",
					auth: { type: "bearer", token: "real-size-drop-test-auth-token" },
				},
			},
		};

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
				"CLAWDI_AI_API_KEY=clawdi-egress-placeholder",
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
		writeFileSync(
			configPath,
			`${JSON.stringify(
				{
					...existingConfig,
					agents: {
						...existingConfig.agents,
						list: [{ id: "main", workspace: null }],
					},
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
		chownSync(configPath, runtimeUid, runtimeGid);

		const convergence = convergeRuntimeManifest(load, paths, { cacheLastGood: false });
		expect(convergence.installErrors).toEqual([]);
		const pluginInspect = spawnSync(
			"runuser",
			[
				"-u",
				"clawdi",
				"--",
				"env",
				`HOME=${runtimeHome}`,
				`OPENCLAW_CONFIG_PATH=${configPath}`,
				`OPENCLAW_STATE_DIR=${openClawStateDir}`,
				commandPath,
				"plugins",
				"inspect",
				CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID,
				"--json",
			],
			{ encoding: "utf8" },
		);
		expect(pluginInspect.status, pluginInspect.stderr).toBe(0);
		expect(JSON.parse(pluginInspect.stdout)).toMatchObject({
			plugin: {
				id: CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID,
				enabled: true,
				status: "loaded",
			},
			install: { source: "path" },
		});
		const providerEnvVarsSdkPath = resolveSdk(
			runtimeHome,
			[commandPath],
			SDK_EXPORTS.providerEnvVars,
		);
		expect(providerEnvVarsSdkPath).not.toBeNull();
		if (!providerEnvVarsSdkPath) {
			throw new Error("official OpenClaw provider-env-vars SDK is unavailable");
		}
		const markerProbe = spawnSync(
			"runuser",
			[
				"-u",
				"clawdi",
				"--",
				"env",
				`HOME=${runtimeHome}`,
				`OPENCLAW_CONFIG_PATH=${configPath}`,
				`OPENCLAW_STATE_DIR=${openClawStateDir}`,
				join(runtimeHome, ".local", "tools", "node", "bin", "node"),
				"--input-type=module",
				"--eval",
				"const sdk = await import(process.argv[1]); process.stdout.write(JSON.stringify(sdk.listKnownProviderAuthEnvVarNames()));",
				pathToFileURL(providerEnvVarsSdkPath).href,
			],
			{ encoding: "utf8" },
		);
		expect(markerProbe.status, markerProbe.stderr).toBe(0);
		expect(JSON.parse(markerProbe.stdout)).toContain("CLAWDI_AI_API_KEY");
		const inspectedAuth = runProviderAuthHelper("inspect");
		expect(inspectedAuth.status, inspectedAuth.stderr).toBe(0);
		const authStores = JSON.parse(inspectedAuth.stdout) as Array<{
			profiles: Record<string, { provider?: string }>;
			order?: Record<string, string[]>;
			lastGood?: Record<string, string>;
			usageStats?: Record<string, unknown>;
		}>;
		expect(authStores).toHaveLength(3);
		for (const store of authStores) {
			expect(
				Object.values(store.profiles).some(
					(credential) => credential.provider?.toLowerCase() === "clawdi",
				),
			).toBe(false);
			expect(store.order?.clawdi).toBeUndefined();
			expect(store.lastGood?.clawdi).toBeUndefined();
			expect(
				Object.keys(store.usageStats ?? {}).some((profileId) =>
					profileId.startsWith("clawdi:cleanup-e2e-"),
				),
			).toBe(false);
		}
		for (let index = 0; index < authStores.length; index += 1) {
			expect(inspectedAuth.stdout).toContain(`openai:cleanup-e2e-user-${index}`);
		}
		const intendedConfig = JSON.parse(intendedPatch.content);
		const appliedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		expect(appliedConfig.models.mode).toBe("replace");
		expect(appliedConfig.models.providers.clawdi).toEqual(intendedConfig.models.providers.clawdi);
		expect(appliedConfig.models.providers.clawdi.models).toEqual(
			intendedConfig.models.providers.clawdi.models,
		);
		expect(appliedConfig.models.providers["user-owned"]).toEqual(userProvider);
		expect(appliedConfig.agents.defaults.workspace).toBe(existingConfig.agents.defaults.workspace);
		expect(appliedConfig.gateway).toEqual({
			mode: "local",
			port: 18_789,
			bind: "lan",
			auth: { mode: "token", token: "size-drop-gateway-token" },
		});
		expect(appliedConfig.logging).toEqual(existingConfig.logging);
		expect(appliedConfig.agents.list).toEqual([{ id: "main" }]);
		expect(appliedConfig.auth).toEqual({
			profiles: { "openai:user": { provider: "openai", mode: "api_key" } },
			order: { openai: ["openai:user"] },
		});
		expect(JSON.stringify(appliedConfig)).not.toContain("legacy-managed-");
		expect(Buffer.byteLength(readFileSync(configPath, "utf8"))).toBeLessThan(
			Math.floor(beforeBytes * 0.5),
		);
		const configStat = statSync(configPath);
		expect(configStat.uid).toBe(runtimeUid);
		expect(configStat.gid).toBe(runtimeGid);
		expect(configStat.mode & 0o777).toBe(0o600);

		const firstAppliedConfig = readFileSync(configPath, "utf8");
		const authStoreDirectories = [
			join(openClawAgentsRoot, "main", "agent"),
			activeAgentDir,
			secondaryAgentDir,
		];
		const firstAuthStoreFiles = authStoreDirectories.map((directory) =>
			directoryFileDigests(directory),
		);
		const repeated = convergeRuntimeManifest(load, paths, { cacheLastGood: false });
		expect(repeated.installErrors).toEqual([]);
		const idempotentAuth = runProviderAuthHelper("inspect");
		expect(idempotentAuth.status, idempotentAuth.stderr).toBe(0);
		expect(JSON.parse(idempotentAuth.stdout)).toEqual(authStores);
		expect(authStoreDirectories.map((directory) => directoryFileDigests(directory))).toEqual(
			firstAuthStoreFiles,
		);
		expect(readFileSync(configPath, "utf8")).toBe(firstAppliedConfig);
	} finally {
		if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
		else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
		if (previousProviderKey === undefined) delete process.env.CLAWDI_AI_API_KEY;
		else process.env.CLAWDI_AI_API_KEY = previousProviderKey;
		if (previousAgentDir === undefined) delete process.env.OPENCLAW_AGENT_DIR;
		else process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
		if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = previousStateDir;
		rmSync(secondaryAgentRoot, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);

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
	mkdirSync(dirname(openClawConfig), { recursive: true, mode: 0o700 });
	chownSync(dirname(openClawConfig), runtimeUid, runtimeGid);
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
					args: ["gateway", "run"],
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
		const dropIn = readFileSync(join(dropInRoot, "10-clawdi-hosted.conf"), "utf8");
		expect(dropIn).not.toContain("\nExecStart=");
		expect(dropIn).not.toContain("\nWorkingDirectory=");
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
}, 120_000);

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
	const tenantOwnershipDrift = join(runtimeHome, "files-root-owned-drift.txt");
	writeFileSync(tenantOwnershipDrift, "repair-to-tenant\n", { mode: 0o600 });
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
	const openClawStateDir = join(runtimeHome, ".openclaw");
	const openClawConfig = join(openClawStateDir, "openclaw.json");
	const openClawWorkspaceRoot = join(openClawStateDir, "workspace");
	mkdirSync(openClawStateDir, { recursive: true, mode: 0o700 });
	chownSync(openClawStateDir, runtimeUid, runtimeGid);
	process.env.OPENCLAW_STATE_DIR = openClawStateDir;
	process.env.OPENCLAW_CONFIG_PATH = openClawConfig;
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
	const rootOwnedControl = join(paths.systemdUserRoot, "files-root-owned-control");
	writeFileSync(rootOwnedControl, "root-owned\n", { mode: 0o600 });
	const platformDriftUnit = join(paths.systemdUserRoot, "legacy-platform-control.service");
	const platformDriftDropIn = join(`${platformDriftUnit}.d`, "10-legacy.conf");
	const platformDriftEnvironment = join(openClawStateDir, "gateway.systemd.env");
	mkdirSync(dirname(platformDriftDropIn), { recursive: true });
	writeFileSync(platformDriftUnit, "[Service]\nExecStart=/bin/true\n");
	writeFileSync(platformDriftDropIn, "[Service]\nEnvironment=LEGACY=1\n");
	writeFileSync(platformDriftEnvironment, "LEGACY_PLATFORM_ENV=1\n", { mode: 0o600 });
	for (const path of [
		paths.systemdUserRoot,
		platformDriftUnit,
		dirname(platformDriftDropIn),
		platformDriftDropIn,
		platformDriftEnvironment,
	]) {
		chownSync(path, runtimeUid, runtimeGid);
	}
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
					runtimeEnvName: "CLAWDI_AI_API_KEY",
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
					args: ["gateway", "run"],
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
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_real_filebrowser_systemd",
				auth: { type: "bearer", token: "real-filebrowser-systemd-test-auth-token" },
			},
		},
	};
	const converge = () => {
		const before = readSystemdUnitSnapshot(paths);
		const transaction = new SystemdRuntimeTransaction();
		return convergeRuntimeManifest(load, paths, {
			fileBrowserInstallOptions: {
				download: (_url, destination) => writeFileSync(destination, binary),
			},
			systemdApply: {
				transactionState: () => transaction.state,
				installOfficialService: (unit, install) =>
					transaction.installOfficialService(paths, unit, install),
				quiesce: (affectedUserUnits) => transaction.quiesce(paths, affectedUserUnits),
				activateEgressPrerequisite: () => ({
					applied: true,
					systemUnitsChanged: [],
					userUnitsChanged: [],
				}),
				activate: () => {
					return applySystemdRuntimeUpdate(paths, before, readSystemdUnitSnapshot(paths), {
						transaction,
						stage: "final-activation",
					});
				},
				rollback: () => transaction.rollback(paths),
			},
		});
	};
	const result = converge();
	expect(result.installErrors).toEqual([]);
	const gatewayEnv = readFileSync(
		join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
		"utf8",
	);
	expect(gatewayEnv).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
	expect(gatewayEnv).not.toMatch(/^OPENAI_API_KEY=/m);
	expect(gatewayEnv).not.toContain("sk-clawdi-provider");
	const projectedOpenClawConfig = JSON.parse(readFileSync(openClawConfig, "utf8")) as {
		models?: {
			providers?: Record<string, { auth?: string; baseUrl?: string; apiKey?: { id?: string } }>;
		};
	};
	expect(projectedOpenClawConfig.models?.providers?.clawdi).toMatchObject({
		baseUrl: "https://ai-gateway.example.test/v1",
		auth: "api-key",
		apiKey: { id: "CLAWDI_AI_API_KEY" },
	});
	expect(existsSync(join(runtimeHome, ".clawdi"))).toBe(false);
	expect(statSync(paths.clawdiHome).uid).toBe(runtimeUid);
	expect(statSync(paths.clawdiHome).gid).toBe(runtimeGid);
	expect(statSync(paths.clawdiHome).mode & 0o777).toBe(0o750);
	expect([statSync(tenantOwnershipDrift).uid, statSync(tenantOwnershipDrift).gid]).toEqual([
		runtimeUid,
		runtimeGid,
	]);
	for (const path of [
		paths.systemdUserRoot,
		platformDriftUnit,
		dirname(platformDriftDropIn),
		platformDriftDropIn,
		platformDriftEnvironment,
	]) {
		expect([statSync(path).uid, statSync(path).gid]).toEqual([0, 0]);
	}
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
	const gatewayMainPidResult = spawnSync(
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
			"show",
			"openclaw-gateway.service",
			"--property=MainPID",
			"--value",
		],
		{ encoding: "utf8" },
	);
	expect(gatewayMainPidResult.status).toBe(0);
	const gatewayMainPid = Number.parseInt(gatewayMainPidResult.stdout.trim(), 10);
	expect(gatewayMainPid).toBeGreaterThan(1);
	expect(statSync(`/proc/${gatewayMainPid}`).uid).toBe(runtimeUid);
	const activeUnits = readSystemdUnitSnapshot(paths);
	expect(
		applySystemdRuntimeUpdate(paths, activeUnits, activeUnits, {
			transaction: new SystemdRuntimeTransaction(),
			stage: "final-activation",
			activationScope: { systemUnits: [], userUnits: ["openclaw-gateway.service"] },
		}),
	).toEqual({ applied: true, systemUnitsChanged: [], userUnitsChanged: [] });
	const unitControl = spawnSync(
		"runuser",
		["-u", "clawdi", "--", "systemctl", "stop", "clawdi-files.service"],
		{ timeout: 5000 },
	);
	expect(unitControl.status).not.toBe(0);
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

	let health = spawnSync("curl", ["-fsS", "http://127.0.0.1:9120/health"], {
		encoding: "utf8",
	});
	for (let attempt = 0; attempt < 50; attempt++) {
		if (health.status === 0) break;
		spawnSync("sleep", ["0.1"]);
		health = spawnSync("curl", ["-fsS", "http://127.0.0.1:9120/health"], {
			encoding: "utf8",
		});
	}
	expect({
		unit: spawnSync("systemctl", ["is-active", "clawdi-files.service"], {
			encoding: "utf8",
		}).stdout.trim(),
		healthStatus: health.status,
		healthBody: health.stdout,
	}).toEqual({ unit: "active", healthStatus: 0, healthBody: "ok" });
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
}, 120_000);

test("repairs a live Hermes user-service ownership enclave without losing the unit", () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const runtimeHome = "/home/clawdi";
	const runtimeUid = 10_001;
	const runtimeGid = 10_001;
	const root = mkdtempSync(join(tmpdir(), "clawdi-live-hermes-enclave-"));
	chmodSync(root, 0o755);
	const hermesCommand = join(runtimeHome, ".local", "bin", "hermes");
	const installLog = join(root, "hermes-installer.log");
	writeFileSync(installLog, "");
	chownSync(installLog, runtimeUid, runtimeGid);
	const unitName = "hermes-gateway.service";
	const unitPath = join(runtimeHome, ".config", "systemd", "user", unitName);
	const dropInRoot = `${unitPath}.d`;
	const enablementPath = join(
		runtimeHome,
		".config",
		"systemd",
		"user",
		"default.target.wants",
		unitName,
	);
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

	for (const staleUnit of ["openclaw-gateway.service", unitName]) {
		runUserSystemctl("disable", "--now", staleUnit);
	}
	rmSync(dirname(unitPath), { recursive: true, force: true });
	mkdirSync(dirname(unitPath), { recursive: true });
	const initialReload = runUserSystemctl("daemon-reload");
	expect(initialReload.status, initialReload.stderr).toBe(0);
	mkdirSync(dirname(hermesCommand), { recursive: true });
	writeFileSync(
		hermesCommand,
		`#!/bin/sh
set -eu
case "$*" in
  "--version")
    printf '%s\\n' 'Hermes Agent v0.19.1'
    ;;
  "gateway install --force")
    printf '%s\\n' install >> ${JSON.stringify(installLog)}
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/${unitName}" <<'EOF'
[Unit]
Description=Hermes Gateway

[Service]
Type=simple
ExecStart=${hermesCommand} gateway run
Restart=always

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable ${unitName}
    ;;
  "gateway uninstall")
    systemctl --user disable --now ${unitName} || true
    rm -f "$HOME/.config/systemd/user/${unitName}"
    systemctl --user daemon-reload
    ;;
  "gateway run")
    exec /bin/sleep infinity
    ;;
  *)
    exit 64
    ;;
esac
`,
		{ mode: 0o755 },
	);
	chownSync(hermesCommand, runtimeUid, runtimeGid);

	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = "clawdi";
	process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
	process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
	process.env.CLAWDI_RUNTIME_HOME = runtimeHome;
	process.env.CLAWDI_HOME = join(root, "clawdi-home");
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = "/run/systemd/system";
	process.env.CLAWDI_AUTH_TOKEN = "live-hermes-enclave-test-auth-token";
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_live_hermes_enclave",
		environmentId: "env_live_hermes_enclave",
		instanceId: "hri_live_hermes_enclave",
		generation: 1,
		issuedAt: "2026-08-21T00:00:00.000Z",
		workspaceRoot: join(runtimeHome, "clawdi-live-hermes-workspace"),
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: {
			hermes: {
				enabled: true,
				run: {
					command: hermesCommand,
					args: ["gateway", "run"],
					env: {},
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
		sourcePath: "live-hermes-enclave-fixture",
		offline: false,
		applyContext: {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: manifest.generation,
				manifestETag: '"live-hermes-enclave-test"',
				applyReceiptId: "live-hermes-enclave-test-receipt",
				bootNonce: "live-hermes-enclave-test-boot",
			},
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_live_hermes_enclave",
				auth: { type: "bearer", token: "live-hermes-enclave-test-auth-token" },
			},
		},
	};
	const converge = () => {
		const before = readSystemdUnitSnapshot(paths);
		const transaction = new SystemdRuntimeTransaction();
		return convergeRuntimeManifest(load, paths, {
			cacheLastGood: false,
			systemdApply: {
				transactionState: () => transaction.state,
				installOfficialService: (unit, install) =>
					transaction.installOfficialService(paths, unit, install),
				quiesce: (affectedUserUnits) => transaction.quiesce(paths, affectedUserUnits),
				activateEgressPrerequisite: () => ({
					applied: true,
					systemUnitsChanged: [],
					userUnitsChanged: [],
				}),
				activate: () =>
					applySystemdRuntimeUpdate(paths, before, readSystemdUnitSnapshot(paths), {
						transaction,
						stage: "final-activation",
					}),
				rollback: () => transaction.rollback(paths),
			},
		});
	};

	try {
		expect(converge().installErrors).toEqual([]);
		const initialState = runUserSystemctl(
			"show",
			unitName,
			"--property=LoadState",
			"--property=ActiveState",
			"--property=MainPID",
		);
		expect(initialState.status, initialState.stderr).toBe(0);
		expect(initialState.stdout).toContain("LoadState=loaded");
		expect(initialState.stdout).toContain("ActiveState=active");
		const initialPid = Number.parseInt(
			initialState.stdout.match(/^MainPID=(\d+)$/m)?.[1] ?? "0",
			10,
		);
		expect(initialPid).toBeGreaterThan(1);
		expect(runUserSystemctl("is-enabled", unitName).stdout.trim()).toBe("enabled");

		chmodSync(unitPath, 0o600);
		chownTreeWithoutFollowingLinks(paths.systemdUserRoot, runtimeUid, runtimeGid);
		for (const path of [paths.systemdUserRoot, unitPath, dropInRoot, enablementPath]) {
			const node = lstatSync(path);
			expect([node.uid, node.gid]).toEqual([runtimeUid, runtimeGid]);
		}

		const repaired = converge();
		expect(repaired.installErrors).toEqual([]);
		expect(readFileSync(installLog, "utf8").trim().split("\n")).toEqual(["install", "install"]);
		for (const path of [paths.systemdUserRoot, unitPath, dropInRoot, enablementPath]) {
			const node = lstatSync(path);
			expect([node.uid, node.gid]).toEqual([0, 0]);
		}
		const repairedState = runUserSystemctl(
			"show",
			unitName,
			"--property=LoadState",
			"--property=ActiveState",
			"--property=MainPID",
		);
		expect(repairedState.status, repairedState.stderr).toBe(0);
		expect(repairedState.stdout).toContain("LoadState=loaded");
		expect(repairedState.stdout).toContain("ActiveState=active");
		const repairedPid = Number.parseInt(
			repairedState.stdout.match(/^MainPID=(\d+)$/m)?.[1] ?? "0",
			10,
		);
		expect(repairedPid).toBe(initialPid);
		expect(runUserSystemctl("is-enabled", unitName).stdout.trim()).toBe("enabled");
		expect(runUserSystemctl("enable", unitName).status).toBe(0);
	} finally {
		runUserSystemctl("disable", "--now", unitName);
		rmSync(unitPath, { force: true });
		rmSync(dropInRoot, { recursive: true, force: true });
		rmSync(enablementPath, { force: true });
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);
