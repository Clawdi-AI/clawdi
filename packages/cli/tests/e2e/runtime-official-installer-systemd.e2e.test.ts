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
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRuntimeManifestLoad } from "../../src/commands/runtime";
import {
	resolveOpenClawSdkExport as resolveSdk,
	OPENCLAW_SDK_EXPORT_PATHS as SDK_EXPORTS,
} from "../../src/lib/codex-oauth-native-store";
import { getCliVersion } from "../../src/lib/version";
import { readRuntimeAppliedState } from "../../src/runtime/applied-state";
import { applyRuntimeBundleChannelsToManifestLoad } from "../../src/runtime/channels";
import { reconcilePendingRuntimeCliUpgrade } from "../../src/runtime/cli-update";
import { hostedAiProviderCatalog } from "../../src/runtime/hosted-provider-resolution";
import { prepareHostedSkillArchives } from "../../src/runtime/hosted-sourced-skill-archive";
import {
	buildOpenClawHostedProviderPatch,
	convergeRuntimeManifest,
} from "../../src/runtime/manifest";
import type { RuntimeManifest } from "../../src/runtime/manifest-contract";
import { runtimeCommandCurrentRevision } from "../../src/runtime/manifest-install";
import type { HostedSkillSource } from "../../src/runtime/manifest-resources";
import {
	HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
	hostedRuntimeBundleV2Schema,
	type RuntimeManifestLoad,
} from "../../src/runtime/manifest-source";
import { LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID } from "../../src/runtime/openclaw-legacy-provider-plugin";
import { openClawPluginCapabilityConsentArgs } from "../../src/runtime/openclaw-plugin-cli";
import { getRuntimePaths } from "../../src/runtime/paths";
import { HERMES_DASHBOARD_BUILD_REVISION_FILE } from "../../src/runtime/runtime-systemd-reconciliation";
import { ensureRuntimePlatformDirectory, ensureRuntimeStateDirs } from "../../src/runtime/state";
import {
	applySystemdRuntimeUpdate,
	readSystemdUnitSnapshot,
} from "../../src/runtime/systemd-transaction";

const REAL_SYSTEMD_GATE = "CLAWDI_TEST_REAL_OPENCLAW_SYSTEMD";
const VIRGIN_RUNTIME_INIT_TIMEOUT_MS = 540_000;
const VIRGIN_RUNTIME_PORT_TIMEOUT_MS = 60_000;
const VIRGIN_RUNTIME_TEST_TIMEOUT_MS = 600_000;
const FILE_BROWSER_VERSION = "v1.5.0-stable";
const FILE_BROWSER_COMMIT = "79552f8adb27c3e29934c4001660eb98f4aab5d6";
const FILE_BROWSER_AMD64_SHA256 =
	"8d51d1718d576d22e73e1f41a5194b451d152ddab0df97697cabe839cf59524e";
const FILE_BROWSER_ARM64_SHA256 =
	"3e18838ae33750a25da434dc6156a359968bf7935e01bdd884711f47f08ad92f";
const HERMES_CONFIG_CLI_MOCK = fileURLToPath(
	new URL("../../src/test-support/hermes-config-cli-mock.ts", import.meta.url),
);

function runOpenClawAsRuntimeUser(input: {
	commandPath: string;
	home: string;
	configPath: string;
	stateDir: string;
	args: string[];
}): ReturnType<typeof spawnSync> {
	return spawnSync(
		"runuser",
		[
			"-u",
			"clawdi",
			"--",
			"env",
			`HOME=${input.home}`,
			`OPENCLAW_CONFIG_PATH=${input.configPath}`,
			`OPENCLAW_STATE_DIR=${input.stateDir}`,
			input.commandPath,
			...input.args,
		],
		{ encoding: "utf8" },
	);
}

function installLegacyManagedProviderPlugin(input: {
	commandPath: string;
	home: string;
	configPath: string;
	stateDir: string;
	runtimeUid: number;
	runtimeGid: number;
}): { sourceDir: string; installDir: string } {
	const sourceDir = join(
		input.stateDir,
		"managed-sources",
		LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID,
	);
	const installDir = join(input.stateDir, "extensions", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID);
	mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
	chmodSync(dirname(sourceDir), 0o700);
	chownSync(dirname(sourceDir), input.runtimeUid, input.runtimeGid);
	writeFileSync(
		join(sourceDir, "index.js"),
		`export default { id: ${JSON.stringify(LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID)}, name: "Clawdi Managed Provider Metadata", register() {} };\n`,
		{ mode: 0o600 },
	);
	writeFileSync(
		join(sourceDir, "openclaw.plugin.json"),
		`${JSON.stringify(
			{
				id: LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID,
				enabledByDefault: true,
				activation: { onStartup: false },
				setup: {
					providers: [{ id: "clawdi", authMethods: ["api-key"], envVars: ["CLAWDI_AI_API_KEY"] }],
					requiresRuntime: false,
				},
				configSchema: { type: "object", additionalProperties: false, properties: {} },
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	writeFileSync(
		join(sourceDir, "package.json"),
		`${JSON.stringify(
			{
				name: "@clawdi/openclaw-managed-provider",
				version: "1.0.0",
				private: true,
				type: "module",
				openclaw: { extensions: ["./index.js"] },
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	chownTreeWithoutFollowingLinks(sourceDir, input.runtimeUid, input.runtimeGid);
	const run = (args: string[]) =>
		runOpenClawAsRuntimeUser({
			commandPath: input.commandPath,
			home: input.home,
			configPath: input.configPath,
			stateDir: input.stateDir,
			args,
		});
	const consentArgs = openClawPluginCapabilityConsentArgs("install", (args) => {
		const result = run(args);
		return {
			status: result.status,
			stdout: String(result.stdout ?? ""),
			stderr: String(result.stderr ?? ""),
		};
	});
	const installed = run(["plugins", "install", sourceDir, "--force", ...consentArgs]);
	expect(installed.status, installed.stderr).toBe(0);
	const inspected = run(["plugins", "inspect", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID, "--json"]);
	expect(inspected.status, inspected.stderr).toBe(0);
	expect(JSON.parse(String(inspected.stdout))).toMatchObject({
		plugin: { id: LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID },
		install: { source: "path", sourcePath: sourceDir, installPath: installDir },
	});
	return { sourceDir, installDir };
}

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

function filesystemTreeIdentity(root: string, relative = ""): Record<string, string> {
	const identity: Record<string, string> = {};
	for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
		const entryRelative = join(relative, entry.name);
		const path = join(root, entryRelative);
		const node = lstatSync(path);
		const metadata = `${node.uid}:${node.gid}:${node.mode & 0o777}`;
		if (entry.isDirectory()) {
			identity[entryRelative] = `directory:${metadata}`;
			Object.assign(identity, filesystemTreeIdentity(root, entryRelative));
		} else if (entry.isSymbolicLink()) {
			identity[entryRelative] = `symlink:${metadata}:${readlinkSync(path)}`;
		} else if (entry.isFile()) {
			identity[entryRelative] = `file:${metadata}:${createHash("sha256")
				.update(readFileSync(path))
				.digest("hex")}`;
		}
	}
	return identity;
}

function expectManagedSystemdTreeOwnership(
	root: string,
	runtimeUid: number,
	runtimeGid: number,
): void {
	const visit = (path: string): void => {
		const node = lstatSync(path);
		expect([node.uid, node.gid]).toEqual([runtimeUid, runtimeGid]);
		if (node.isSymbolicLink()) return;
		if (node.isDirectory()) {
			expect(node.mode & 0o500).toBe(0o500);
			for (const entry of readdirSync(path)) visit(join(path, entry));
			return;
		}
		if (node.isFile()) expect(node.mode & 0o400).toBe(0o400);
	};
	visit(root);
}

async function waitForTcpPort(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const listening = await new Promise<boolean>((resolve) => {
			const socket = createConnection({ host: "127.0.0.1", port });
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				resolve(value);
			};
			socket.setTimeout(250);
			socket.once("connect", () => finish(true));
			socket.once("error", () => finish(false));
			socket.once("timeout", () => finish(false));
		});
		if (listening) return;
		await Bun.sleep(100);
	}
	throw new Error(`port ${port} did not begin listening within ${timeoutMs}ms`);
}

function userUnitDiagnostics(unitName: string, runtimeHome: string, runtimeUid: number): string {
	const run = (...args: string[]) =>
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
				...args,
			],
			{ encoding: "utf8" },
		);
	const show = run(
		"systemctl",
		"--user",
		"show",
		unitName,
		"--property=LoadState",
		"--property=ActiveState",
		"--property=SubState",
		"--property=Result",
		"--property=MainPID",
		"--property=ExecMainCode",
		"--property=ExecMainStatus",
		"--property=NRestarts",
	);
	const status = run("systemctl", "--user", "status", unitName, "--no-pager", "--full");
	const journal = run("journalctl", "--user", "--unit", unitName, "--no-pager", "--lines=100");
	const processes = spawnSync("ps", ["-eo", "pid,ppid,etimes,state,args", "--forest"], {
		encoding: "utf8",
	});
	const sockets = spawnSync("ss", ["-ltnp"], { encoding: "utf8" });
	return [
		"--- systemctl show ---",
		show.stdout,
		show.stderr,
		"--- systemctl status ---",
		status.stdout,
		status.stderr,
		"--- journalctl ---",
		journal.stdout,
		journal.stderr,
		"--- process tree ---",
		processes.stdout,
		processes.stderr,
		"--- listening sockets ---",
		sockets.stdout,
		sockets.stderr,
	]
		.filter(Boolean)
		.join("\n");
}

function seedLocalCli(paths: ReturnType<typeof getRuntimePaths>): string {
	const version = getCliVersion();
	const prefix = join(paths.cliNpmPrefix, "packages", version);
	// Bootstrap establishes the private boundary before npm creates package content.
	ensureRuntimePlatformDirectory(paths, prefix, { mode: 0o700 });
	ensureRuntimePlatformDirectory(paths, dirname(paths.cliManagedBin), { mode: 0o700 });
	const install = spawnSync(
		"/bin/sh",
		[
			"-c",
			'umask 077; exec npm "$@"',
			"npm",
			"install",
			"--global",
			`--prefix=${prefix}`,
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"/usr/local/share/clawdi/bootstrap/clawdi-local.tgz",
		],
		{ encoding: "utf8" },
	);
	expect(install.status, install.stderr).toBe(0);
	const activeTarget = join(prefix, "bin", "clawdi");
	symlinkSync(activeTarget, paths.cliManagedBin);
	reconcilePendingRuntimeCliUpgrade(paths);
	return prefix;
}

test.each(["hermes", "openclaw"] as const)(
	"runs the complete virgin %s first boot from a cold user manager",
	async (runtime) => {
		if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

		expect(process.geteuid?.()).toBe(0);
		const runtimeHome = "/home/clawdi";
		const runtimeUid = 10_001;
		const runtimeGid = 10_001;
		const stockInstaller = "/opt/fixture/install-stock-runtime.sh";
		const root = mkdtempSync(join(tmpdir(), `clawdi-virgin-${runtime}-`));
		chmodSync(root, 0o755);
		const systemctlLog = join(root, "systemctl.log");
		const systemctlWrapper = join(root, "systemctl");
		const systemUnits = [
			"clawdi-runtime-watch.service",
			"clawdi-daemon.service",
			"clawdi-runtime-sidecar.service",
			"clawdi-files.service",
		];
		const allUserUnits = [
			"hermes-gateway.service",
			"clawdi-hermes-dashboard.service",
			"openclaw-gateway.service",
		];
		const environmentNames = [
			"CLAWDI_AUTH_TOKEN",
			"CLAWDI_CODEX_INSTALL_DISABLED",
			"CLAWDI_EGRESS_GID",
			"CLAWDI_EGRESS_UID",
			"CLAWDI_HOME",
			"CLAWDI_RUN_DIR",
			"CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS",
			"CLAWDI_RUNTIME_GID",
			"CLAWDI_RUNTIME_HOME",
			"CLAWDI_RUNTIME_MODE",
			"CLAWDI_RUNTIME_TEST_HERMES_INSTALLER",
			"CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER",
			"CLAWDI_RUNTIME_UID",
			"CLAWDI_RUNTIME_USER",
			"CLAWDI_SERVICE_STATE_DIR",
			"CLAWDI_SYSTEMCTL_PATH",
			"CLAWDI_SYSTEMD_APPLY",
			"CLAWDI_SYSTEMD_SYSTEM_ROOT",
			"CLAWDI_TEST_STOCK_RUNTIME",
		] as const;
		const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
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
		const waitForUserManager = () => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const active = spawnSync("systemctl", [
					"is-active",
					"--quiet",
					`user@${runtimeUid}.service`,
				]);
				if (active.status === 0 && existsSync(`/run/user/${runtimeUid}/bus`)) return;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
			}
			throw new Error(`user@${runtimeUid}.service did not expose its D-Bus socket`);
		};
		let previousUmask: number | null = null;
		let manifestServer: ReturnType<typeof Bun.serve> | null = null;
		let paths: ReturnType<typeof getRuntimePaths> | null = null;

		try {
			if (existsSync(`/run/user/${runtimeUid}/bus`)) {
				runUserSystemctl("stop", ...allUserUnits);
			}
			spawnSync("systemctl", ["stop", ...systemUnits]);
			spawnSync("systemctl", ["disable", "--runtime", ...systemUnits]);
			for (const unit of systemUnits) rmSync(join("/run/systemd/system", unit), { force: true });
			spawnSync("systemctl", ["daemon-reload"]);
			spawnSync("loginctl", ["disable-linger", "clawdi"]);
			const stopManager = spawnSync("systemctl", ["stop", `user@${runtimeUid}.service`], {
				encoding: "utf8",
			});
			expect(stopManager.status, stopManager.stderr).toBe(0);
			expect(
				spawnSync("systemctl", ["is-active", "--quiet", `user@${runtimeUid}.service`]).status,
			).not.toBe(0);

			rmSync(runtimeHome, { recursive: true, force: true });
			mkdirSync(runtimeHome, { mode: 0o700 });
			chownSync(runtimeHome, runtimeUid, runtimeGid);
			expect(existsSync(join(runtimeHome, ".config", "systemd", "user"))).toBe(false);

			const enableLinger = spawnSync("loginctl", ["enable-linger", "clawdi"], {
				encoding: "utf8",
			});
			expect(enableLinger.status, enableLinger.stderr).toBe(0);
			const startManager = spawnSync("systemctl", ["start", `user@${runtimeUid}.service`], {
				encoding: "utf8",
			});
			expect(startManager.status, startManager.stderr).toBe(0);
			waitForUserManager();

			Object.assign(process.env, {
				CLAWDI_AUTH_TOKEN: `virgin-${runtime}-auth-token`,
				CLAWDI_CODEX_INSTALL_DISABLED: "1",
				CLAWDI_EGRESS_GID: "10002",
				CLAWDI_EGRESS_UID: "10002",
				CLAWDI_HOME: join(root, "var", "lib", "clawdi-user"),
				CLAWDI_RUN_DIR: join(root, "run", "clawdi"),
				CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS: "1",
				CLAWDI_RUNTIME_GID: String(runtimeGid),
				CLAWDI_RUNTIME_HOME: runtimeHome,
				CLAWDI_RUNTIME_MODE: "hosted",
				CLAWDI_RUNTIME_UID: String(runtimeUid),
				CLAWDI_RUNTIME_USER: "clawdi",
				CLAWDI_SERVICE_STATE_DIR: join(root, "var", "lib", "clawdi"),
				CLAWDI_SYSTEMCTL_PATH: systemctlWrapper,
				CLAWDI_SYSTEMD_APPLY: "1",
				CLAWDI_SYSTEMD_SYSTEM_ROOT: "/run/systemd/system",
				CLAWDI_TEST_STOCK_RUNTIME: runtime,
			});
			delete process.env.CLAWDI_RUNTIME_TEST_HERMES_INSTALLER;
			delete process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER;
			process.env[
				runtime === "hermes"
					? "CLAWDI_RUNTIME_TEST_HERMES_INSTALLER"
					: "CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER"
			] = stockInstaller;

			previousUmask = process.umask(0o077);
			paths = getRuntimePaths({ mode: "hosted" });
			for (const path of [
				join(root, "etc"),
				join(root, "var"),
				join(root, "var", "lib"),
				join(root, "var", "cache"),
				join(root, "run"),
			]) {
				mkdirSync(path, { recursive: true, mode: 0o755 });
				chmodSync(path, 0o755);
				chownSync(path, 0, 0);
			}
			for (const [path, mode] of [
				[paths.configurationRoot, 0o700],
				[paths.serviceStateRoot, 0o700],
				[paths.cacheRoot, 0o700],
				[paths.runRoot, 0o711],
			] as const) {
				mkdirSync(path, { recursive: true, mode });
				chmodSync(path, mode);
				chownSync(path, 0, 0);
			}
			ensureRuntimeStateDirs(paths);
			writeFileSync(
				systemctlWrapper,
				`#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
exec /usr/bin/systemctl "$@"
				`,
				{ mode: 0o755 },
			);
			chmodSync(systemctlWrapper, 0o755);
			writeFileSync(systemctlLog, "", { mode: 0o666 });
			chmodSync(systemctlLog, 0o666);

			const cliPrefix = seedLocalCli(paths);

			const gatewayToken = `virgin-${runtime}-gateway-token`;
			const sourceRevision = createHash("sha256").update(`virgin-${runtime}-bundle`).digest("hex");
			const etag = `"sha256:${sourceRevision}"`;
			const hostedManifest = {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				runtime,
				deploymentId: `hdep_virgin_${runtime}`,
				environmentId: `env_virgin_${runtime}`,
				instanceId: `hri_virgin_${runtime}`,
				generation: 1,
				issuedAt: "2026-08-22T00:00:00.000Z",
				locale: { language: "en", timezone: "UTC" },
				system:
					runtime === "openclaw"
						? {
								openclawControlUiAllowedOrigins: ["https://agent.example.test"],
								openclawGatewayAuth: {
									mode: "token",
									tokenRef: "secret://runtime/openclaw/gateway-token",
									deviceAuthRequired: false,
									activation: { enabled: true, capability: "openclaw-native-auth-v1" },
								},
							}
						: {
								hermesDashboardAuth: {
									mode: "password",
									provider: "basic",
									username: "admin",
									passwordSecretRef: "secret://runtime/hermes/dashboard-password",
									sessionSecretRef: "secret://runtime/hermes/dashboard-session-secret",
									sessionTtlSeconds: 43_200,
									publicUrl: "https://agent.example.test/hermes",
									activation: { enabled: true, capability: "hermes-basic-auth-v1" },
								},
							},
				controlPlane: { cloudApiUrl: "https://cloud-api.example.test" },
				egressEngine: {
					type: "mitmproxy",
					version: "12.2.3",
					url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
					sha256: "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
				},
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: `clawdi@${getCliVersion()}`,
					registry: "https://registry.npmjs.org",
				},
				runtimes: {
					[runtime]: {
						enabled: true,
						providerMode: "unmanaged",
						provider_ids: [],
						install: { source: "official" },
						run: {
							args: ["gateway", "run"],
							...(runtime === "openclaw"
								? {
										secretEnv: {
											OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
										},
									}
								: {}),
						},
						services:
							runtime === "hermes"
								? {
										dashboard: {
											args: [
												"dashboard",
												"--host",
												"0.0.0.0",
												"--port",
												"9119",
												"--no-open",
												"--skip-build",
											],
										},
									}
								: {},
					},
				},
				skills: { entries: { clawdi: { enabled: true, version: 1 } } },
				providers: {},
				terminalTooling: {
					codex: {
						enabled: true,
						provider_id: "clawdi-terminal",
						primary_model: { provider_id: "clawdi-terminal", model: "gpt-test" },
						provider: {
							kind: "openai-compatible",
							type: "custom_openai_compatible",
							baseUrl: "https://provider.example.test/v1",
							apiMode: "openai_responses",
							managed_by: "clawdi",
							runtimeEnvName: "CLAWDI_AI_API_KEY",
							apiKeySecretRef: "secret://tool.codex.apiKey",
						},
					},
				},
				liveSync: { enabled: false, agents: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			};
			const bundle = {
				schemaVersion: "clawdi.hosted-runtime.bundle.v2",
				sourceRevision,
				applyGeneration: 1,
				manifest: hostedManifest,
				channelBindings: [],
				secretValues: {
					"secret://clawdi/auth-token": `virgin-${runtime}-daemon-token`,
					"secret://tool.codex.apiKey": `virgin-${runtime}-codex-key`,
					...(runtime === "openclaw"
						? { "secret://runtime/openclaw/gateway-token": gatewayToken }
						: {
								"secret://runtime/hermes/dashboard-password": "virgin-dashboard-password",
								"secret://runtime/hermes/dashboard-session-secret":
									"virgin-dashboard-session-secret",
							}),
				},
			};
			let manifestFetches = 0;
			manifestServer = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: (request) => {
					const url = new URL(request.url);
					if (url.pathname !== "/v1/runtime/manifest")
						return new Response("not found", { status: 404 });
					expect(request.headers.get("authorization")).toBe(`Bearer virgin-${runtime}-auth-token`);
					expect(request.headers.get("accept")).toBe(HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE);
					manifestFetches += 1;
					if (request.headers.get("if-none-match") === etag) {
						return new Response(null, { status: 304, headers: { etag } });
					}
					return Response.json(bundle, {
						headers: {
							"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
							etag,
						},
					});
				},
			});
			const manifestUrl = `http://127.0.0.1:${manifestServer.port}/v1/runtime/manifest`;
			writeFileSync(
				paths.runtimeContextFile,
				`${JSON.stringify({
					schemaVersion: "clawdi.runtimeContext.v3",
					backend: "incus",
					apply: {
						generation: 1,
						manifestETag: etag,
						applyReceiptId: `virgin-${runtime}-receipt-0001`,
						bootNonce: `virgin-${runtime}-boot-nonce-0001`,
					},
					manifestSource: {
						type: "http",
						url: manifestUrl,
						auth: { type: "bearer", token: `virgin-${runtime}-auth-token` },
					},
				})}\n`,
				{ mode: 0o600 },
			);

			const runManagedInit = async () => {
				const child = Bun.spawn(
					[
						"/usr/bin/setsid",
						paths.cliManagedBin,
						"runtime",
						"init",
						"--non-interactive",
						"--json",
					],
					{
						env: { ...process.env },
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				let timedOut = false;
				const timeout = setTimeout(() => {
					timedOut = true;
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {}
				}, VIRGIN_RUNTIME_INIT_TIMEOUT_MS);
				try {
					const [status, stdout, stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					return {
						status,
						stdout,
						stderr: timedOut
							? `${stderr}\nruntime init exceeded ${VIRGIN_RUNTIME_INIT_TIMEOUT_MS}ms`
							: stderr,
					};
				} finally {
					clearTimeout(timeout);
				}
			};
			const firstInit = await runManagedInit();
			expect(firstInit.status, `${firstInit.stdout}\n${firstInit.stderr}`).toBe(0);
			const firstStatus = JSON.parse(firstInit.stdout) as Record<string, unknown>;
			expect(firstStatus.status).toBe("ok");
			expect(firstStatus.stage).toBe("final");
			expect(firstStatus.exitCode).toBe(0);
			const firstAppliedState = readRuntimeAppliedState(paths);
			expect(firstAppliedState).not.toBeNull();
			const bundledSource = join(
				cliPrefix,
				"lib",
				"node_modules",
				"clawdi",
				"skills",
				"hosted-versions",
				"1",
				"clawdi",
				"SKILL.md",
			);
			const bundledTarget = join(
				runtimeHome,
				runtime === "hermes" ? ".hermes/skills/clawdi" : ".openclaw/workspace/skills/clawdi",
				"SKILL.md",
			);
			expect(statSync(paths.serviceStateRoot).mode & 0o777).toBe(0o700);
			expect(
				spawnSync("runuser", ["-u", "clawdi", "--", "test", "-r", bundledSource]).status,
			).not.toBe(0);
			expect(readFileSync(bundledTarget)).toEqual(readFileSync(bundledSource));
			expect([statSync(bundledTarget).uid, statSync(bundledTarget).gid]).toEqual([
				runtimeUid,
				runtimeGid,
			]);
			const clawdiHome = lstatSync(paths.clawdiHome);
			expect([clawdiHome.uid, clawdiHome.gid, clawdiHome.mode & 0o777]).toEqual([
				runtimeUid,
				runtimeGid,
				0o750,
			]);

			const unitNames =
				runtime === "hermes"
					? ["hermes-gateway.service", "clawdi-hermes-dashboard.service"]
					: ["openclaw-gateway.service"];
			const firstPids = new Map<string, number>();
			for (const unitName of unitNames) {
				const state = runUserSystemctl(
					"show",
					unitName,
					"--property=LoadState",
					"--property=ActiveState",
					"--property=MainPID",
					"--property=NeedDaemonReload",
				);
				expect(state.status, state.stderr).toBe(0);
				expect(state.stdout).toContain("LoadState=loaded");
				expect(state.stdout).toContain("ActiveState=active");
				expect(state.stdout).toContain("NeedDaemonReload=no");
				expect(runUserSystemctl("is-enabled", unitName).stdout.trim()).toBe("enabled");
				const mainPid = Number.parseInt(state.stdout.match(/^MainPID=(\d+)$/m)?.[1] ?? "0", 10);
				expect(mainPid).toBeGreaterThan(1);
				expect(statSync(`/proc/${mainPid}`).uid).toBe(runtimeUid);
				firstPids.set(unitName, mainPid);
				const managedEnvironment = readFileSync(
					join(paths.systemdEnvRoot, `${unitName}.env`),
					"utf8",
				);
				expect(managedEnvironment).toMatch(/^CLAWDI_MANAGED_CONTENT_DIGEST="[a-f0-9]{32}"$/m);
				const enablementPath = join(paths.systemdUserRoot, "default.target.wants", unitName);
				expect(realpathSync(enablementPath)).toBe(join(paths.systemdUserRoot, unitName));
			}
			for (const [port, unitName] of runtime === "hermes"
				? ([[9119, "clawdi-hermes-dashboard.service"]] as const)
				: ([[18789, "openclaw-gateway.service"]] as const)) {
				try {
					await waitForTcpPort(port, VIRGIN_RUNTIME_PORT_TIMEOUT_MS);
				} catch (error) {
					throw new Error(
						`${error instanceof Error ? error.message : String(error)}\n${userUnitDiagnostics(unitName, runtimeHome, runtimeUid)}`,
					);
				}
			}
			expectManagedSystemdTreeOwnership(paths.systemdUserRoot, runtimeUid, runtimeGid);
			const firstTree = filesystemTreeIdentity(paths.systemdUserRoot);
			const firstCalls = readFileSync(systemctlLog, "utf8").trim().split("\n");
			const firstMutations = firstCalls.filter((call) =>
				/^(?:--user )?(?:daemon-reload|enable|disable|start|stop|restart|reset-failed)\b/.test(
					call,
				),
			);
			expect(firstMutations.length).toBeGreaterThan(0);
			expect(firstMutations).toContain("enable --runtime clawdi-runtime-sidecar.service");

			await Bun.sleep(500);
			writeFileSync(systemctlLog, "", { mode: 0o666 });
			chmodSync(systemctlLog, 0o666);
			const secondInit = await runManagedInit();
			expect(secondInit.status, `${secondInit.stdout}\n${secondInit.stderr}`).toBe(0);
			const secondStatus = JSON.parse(secondInit.stdout) as Record<string, unknown>;
			expect(secondStatus.status).toBe("ok");
			expect(secondStatus.stage).toBe("final");
			await Bun.sleep(250);
			const secondMutations = readFileSync(systemctlLog, "utf8")
				.trim()
				.split("\n")
				.filter((call) =>
					/^(?:--user )?(?:daemon-reload|enable|disable|start|stop|restart|reset-failed)\b/.test(
						call,
					),
				);
			const secondTree = filesystemTreeIdentity(paths.systemdUserRoot);
			expect(secondMutations).toEqual([]);
			expect(secondTree).toEqual(firstTree);
			for (const [unitName, firstPid] of firstPids) {
				const state = runUserSystemctl("show", unitName, "--property=MainPID");
				expect(state.status, state.stderr).toBe(0);
				expect(Number.parseInt(state.stdout.match(/^MainPID=(\d+)$/m)?.[1] ?? "0", 10)).toBe(
					firstPid,
				);
			}
			expect(manifestFetches).toBeGreaterThanOrEqual(2);

			if (runtime === "openclaw") {
				const unitName = "openclaw-gateway.service";
				const unitPath = join(paths.systemdUserRoot, unitName);
				const installerLog = join(
					paths.statusRoot,
					"installer-logs",
					"openclaw-gateway-service.log",
				);
				const installedAt = statSync(installerLog).mtimeMs;
				const nativeUnit = `${readFileSync(unitPath, "utf8")}\n[Service]\nEnvironment=CLAWDI_TEST_NATIVE_REFRESH=1\n`;
				writeFileSync(unitPath, nativeUnit);
				expect(runUserSystemctl("show", unitName, "--property=NeedDaemonReload").stdout).toContain(
					"NeedDaemonReload=yes",
				);

				const refreshed = await runManagedInit();
				expect(refreshed.status, `${refreshed.stdout}\n${refreshed.stderr}`).toBe(0);
				expect(readFileSync(unitPath, "utf8")).toBe(nativeUnit);
				expect(statSync(installerLog).mtimeMs).toBe(installedAt);
				const pid = Number(
					runUserSystemctl("show", unitName, "--property=MainPID", "--value").stdout,
				);
				expect(pid).toBeGreaterThan(1);
				expect(pid).not.toBe(firstPids.get(unitName));
				expect(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")).toContain(
					"CLAWDI_TEST_NATIVE_REFRESH=1",
				);
				expect(runUserSystemctl("show", unitName, "--property=NeedDaemonReload").stdout).toContain(
					"NeedDaemonReload=no",
				);
				await waitForTcpPort(18789, VIRGIN_RUNTIME_PORT_TIMEOUT_MS);
			}
		} finally {
			manifestServer?.stop(true);
			if (previousUmask !== null) process.umask(previousUmask);
			if (existsSync(`/run/user/${runtimeUid}/bus`)) {
				runUserSystemctl("stop", ...allUserUnits);
			}
			spawnSync("systemctl", ["stop", ...systemUnits]);
			spawnSync("systemctl", ["disable", "--runtime", ...systemUnits]);
			for (const unit of systemUnits) rmSync(join("/run/systemd/system", unit), { force: true });
			spawnSync("systemctl", ["daemon-reload"]);
			rmSync(runtimeHome, { recursive: true, force: true });
			mkdirSync(runtimeHome, { mode: 0o700 });
			chownSync(runtimeHome, runtimeUid, runtimeGid);
			for (const stockHome of ["/opt/stock/base-home", "/opt/stock/openclaw-home"]) {
				const restore = spawnSync("cp", ["-a", `${stockHome}/.`, `${runtimeHome}/`], {
					encoding: "utf8",
				});
				expect(restore.status, restore.stderr).toBe(0);
			}
			for (const [name, value] of previousEnvironment) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
			spawnSync("loginctl", ["enable-linger", "clawdi"]);
			spawnSync("systemctl", ["start", `user@${runtimeUid}.service`]);
			waitForUserManager();
			const reload = runUserSystemctl("daemon-reload");
			expect(reload.status, reload.stderr).toBe(0);
		}
	},
	VIRGIN_RUNTIME_TEST_TIMEOUT_MS,
);

test("rejects a non-file native unit before invoking the official OpenClaw installer", () => {
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
	rmSync(enablementPath, { force: true });
	const openClawConfig = join(runtimeHome, ".openclaw", "openclaw.json");
	const gatewayEnvironment = join(runtimeHome, ".openclaw", "gateway.systemd.env");
	expect(existsSync(unitPath)).toBe(false);
	expect(existsSync(openClawConfig)).toBe(false);
	expect(existsSync(gatewayEnvironment)).toBe(false);
	const openClawWorkspaceRoot = join(runtimeHome, ".openclaw", "workspace");
	const initialOpenClawConfig = `${JSON.stringify({
		agents: { defaults: { workspace: openClawWorkspaceRoot } },
		gateway: { mode: "local" },
	})}\n`;
	mkdirSync(dirname(openClawConfig), { recursive: true, mode: 0o700 });
	chownSync(dirname(openClawConfig), runtimeUid, runtimeGid);
	writeFileSync(openClawConfig, initialOpenClawConfig, { mode: 0o600 });
	chownSync(openClawConfig, runtimeUid, runtimeGid);
	writeFileSync(gatewayEnvironment, "PRESERVED_ENV=before\n", { mode: 0o600 });
	chownSync(gatewayEnvironment, runtimeUid, runtimeGid);
	mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
	for (const path of [
		join(runtimeHome, ".config"),
		join(runtimeHome, ".config", "systemd"),
		dirname(unitPath),
	]) {
		chmodSync(path, 0o700);
		chownSync(path, runtimeUid, runtimeGid);
	}
	mkdirSync(unitPath, { recursive: false });
	writeFileSync(unitSentinel, "preserve directory target\n");
	chownTreeWithoutFollowingLinks(paths.systemdUserRoot, runtimeUid, runtimeGid);

	const workspaceRoot = join(runtimeHome, "clawdi-systemd-test-workspace");
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_real_openclaw_systemd",
		environmentId: "env_real_openclaw_systemd",
		instanceId: "hri_real_openclaw_systemd",
		generation: 1,
		issuedAt: "2026-08-02T00:00:00.000Z",
		workspaceRoot,
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
		secretValues: {
			"secret://runtime/openclaw/gateway-token": "fixture-gateway-token",
		},
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
	const installerOutputLog = join(
		paths.statusRoot,
		"installer-logs",
		"openclaw-gateway-service.log",
	);
	expect(detail).toContain("official openclaw-gateway.service unit is not a regular file");
	expect(detail).not.toContain("Gateway install failed:");
	expect(detail).not.toContain("EISDIR");
	expect(existsSync(installerOutputLog)).toBe(false);
	expect(authorityCommits).toBe(0);
	expect(statSync(unitPath).isDirectory()).toBe(true);
	expect(readFileSync(unitSentinel, "utf8")).toBe("preserve directory target\n");
	expect(readFileSync(openClawConfig, "utf8")).not.toBe(initialOpenClawConfig);
	for (const path of [unitPath, gatewayEnvironment]) {
		const stat = statSync(path);
		expect(stat.uid).toBe(runtimeUid);
		expect(stat.gid).toBe(runtimeGid);
	}
	expect(statSync(openClawConfig).uid).toBe(runtimeUid);
	expect(statSync(openClawConfig).gid).toBe(runtimeGid);
	expect(statSync(openClawConfig).mode & 0o777).toBe(0o600);
	expect(statSync(gatewayEnvironment).mode & 0o777).toBe(0o600);
	expect(existsSync(dropInPath)).toBe(false);
	expect(existsSync(paths.manifestLastGood)).toBe(false);
	expect(existsSync(workspaceRoot)).toBe(true);
	rmSync(unitPath, { recursive: true, force: true });
	rmSync(`${unitPath}.bak`, { recursive: true, force: true });
	rmSync(dirname(dropInPath), { recursive: true, force: true });
	rmSync(enablementPath, { force: true });
	rmSync(workspaceRoot, { recursive: true, force: true });
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
		expect(resolveSdk(runtimeHome, [commandPath], SDK_EXPORTS.sessionTranscript)).not.toBeNull();
		const legacyProviderPlugin = installLegacyManagedProviderPlugin({
			commandPath,
			home: runtimeHome,
			configPath,
			stateDir: openClawStateDir,
			runtimeUid,
			runtimeGid,
		});
		const configWithLegacyProviderPlugin = JSON.parse(readFileSync(configPath, "utf8"));
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
		const configMutationSdkPath = resolveSdk(
			runtimeHome,
			[commandPath],
			SDK_EXPORTS.configMutation,
		);
		expect(configMutationSdkPath).not.toBeNull();
		if (!configMutationSdkPath) {
			throw new Error("official OpenClaw config-mutation SDK is unavailable");
		}
		writeFileSync(
			configPath,
			`${JSON.stringify(
				{
					...configWithLegacyProviderPlugin,
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
		const beforeBytes = Buffer.byteLength(readFileSync(configPath, "utf8"));
		expect(beforeBytes).toBeGreaterThan(5_000);
		expect(existsSync(legacyProviderPlugin.sourceDir)).toBe(true);
		expect(existsSync(legacyProviderPlugin.installDir)).toBe(true);

		const convergence = convergeRuntimeManifest(load, paths, { cacheLastGood: false });
		expect(convergence.installErrors).toEqual([]);
		const removedPlugin = runOpenClawAsRuntimeUser({
			commandPath,
			home: runtimeHome,
			configPath,
			stateDir: openClawStateDir,
			args: ["plugins", "inspect", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID, "--json"],
		});
		expect(removedPlugin.status).not.toBe(0);
		expect(existsSync(legacyProviderPlugin.sourceDir)).toBe(false);
		expect(existsSync(legacyProviderPlugin.installDir)).toBe(false);
		const doctor = runOpenClawAsRuntimeUser({
			commandPath,
			home: runtimeHome,
			configPath,
			stateDir: openClawStateDir,
			args: ["doctor", "--fix", "--non-interactive"],
		});
		expect(doctor.status, doctor.stderr).toBe(0);
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
		if (appliedConfig.agents.list !== undefined) {
			expect(appliedConfig.agents.list).toEqual([{ id: "main" }]);
		}
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
	const rootOwnedSentinel = join(runtimeHome, "files-root-owned-sentinel.txt");
	writeFileSync(rootOwnedSentinel, "preserve root ownership\n", { mode: 0o600 });
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
	const rootOwnedControl = join(paths.statusRoot, "files-root-owned-control");
	writeFileSync(rootOwnedControl, "root-owned\n", { mode: 0o600 });
	const legacyEnvironmentRoot = join(runtimeHome, ".clawdi", "environments");
	const legacyEnvironmentPath = join(legacyEnvironmentRoot, "openclaw.json");
	const legacyEnvironmentContent = `${JSON.stringify({
		id: "env_legacy_openclaw",
		agentType: "openclaw",
		managedBy: "clawdi runtime init",
	})}\n`;
	mkdirSync(legacyEnvironmentRoot, { recursive: true });
	writeFileSync(legacyEnvironmentPath, legacyEnvironmentContent);
	chownTreeWithoutFollowingLinks(join(runtimeHome, ".clawdi"), runtimeUid, runtimeGid);
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
		return convergeRuntimeManifest(load, paths, {
			fileBrowserInstallOptions: {
				download: (_url, destination) => writeFileSync(destination, binary),
			},
			systemdApply: {
				activateEgressPrerequisite: () => ({
					applied: true,
					systemUnitsChanged: [],
					userUnitsChanged: [],
				}),
				activate: () => {
					return applySystemdRuntimeUpdate(paths, before, readSystemdUnitSnapshot(paths), {});
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
	expect(readFileSync(legacyEnvironmentPath, "utf8")).toBe(legacyEnvironmentContent);
	expect(statSync(paths.clawdiHome).uid).toBe(runtimeUid);
	expect(statSync(paths.clawdiHome).gid).toBe(runtimeGid);
	expect(statSync(paths.clawdiHome).mode & 0o777).toBe(0o750);
	expect([statSync(rootOwnedSentinel).uid, statSync(rootOwnedSentinel).gid]).toEqual([0, 0]);
	expect([statSync(rootOwnedControl).uid, statSync(rootOwnedControl).gid]).toEqual([0, 0]);
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
	for (const path of [
		paths.fileBrowserInstallRoot,
		candidatesRoot,
		activeCandidate,
		activeBinary,
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
	const cache = join(paths.fileBrowserStateRoot, "cache");
	const database = join(paths.fileBrowserStateRoot, "filebrowser.db");
	for (const path of [cache, database]) {
		expect(statSync(path).uid).toBe(runtimeUid);
		expect(statSync(path).gid).toBe(runtimeGid);
	}
	expect(statSync(cache).mode & 0o777).toBe(0o700);
	expect(statSync(database).mode & 0o777).toBe(0o600);

	for (const path of [paths.fileBrowserConfigRoot, paths.fileBrowserConfig]) {
		const denied = spawnSync("runuser", ["-u", "clawdi", "--", "test", "!", "-r", path]);
		expect(denied.status).toBe(0);
	}
	for (const path of [
		paths.fileBrowserInstallRoot,
		candidatesRoot,
		activeCandidate,
		activeBinary,
		paths.fileBrowserConfig,
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
	const activeGatewayHash = activeUnits.user.get("openclaw-gateway.service");
	if (!activeGatewayHash) throw new Error("active OpenClaw gateway hash is missing");
	expect(
		applySystemdRuntimeUpdate(paths, activeUnits, activeUnits, {
			activationScope: { systemUnits: [], userUnits: ["openclaw-gateway.service"] },
		}),
	).toEqual({
		applied: true,
		activated: { "openclaw-gateway.service": activeGatewayHash },
		systemUnitsChanged: [],
		userUnitsChanged: ["openclaw-gateway.service"],
	});
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

test("0.14.18 keeps tenant-owned Hermes state writable without chowning tenant home", async () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const runtimeHome = "/home/clawdi";
	const runtimeUid = 10_001;
	const runtimeGid = 10_001;
	const root = mkdtempSync(join(tmpdir(), "clawdi-live-hermes-ownership-"));
	chmodSync(root, 0o755);
	const hermesCommand = join(runtimeHome, ".local", "bin", "hermes");
	const installLog = join(root, "hermes-installer.log");
	const rootOwnedSentinel = join(runtimeHome, "root-owned-sentinel");
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
	ensureBehavioralGuardUserManager();
	const runUserSystemctl = runBehavioralGuardUserSystemctl;

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
  "config path"|"config get "*|"config set "*|"config unset "*)
	exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
    ;;
  "gateway install --force --no-start-now")
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
  "config path") printf '%s\\n' "$HOME/.hermes/config.yaml" ;;
  *) exit 64 ;;
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
	const converge = async () => {
		const result = await applyRuntimeManifestLoad(load, paths);
		if (result.kind !== "converged") throw new Error(`unexpected apply result: ${result.kind}`);
		return result.convergence;
	};
	mkdirSync(dropInRoot, { recursive: true });
	mkdirSync(dirname(enablementPath), { recursive: true });
	writeFileSync(
		unitPath,
		`[Unit]
Description=Existing Hermes Gateway

[Service]
Type=simple
ExecStart=${hermesCommand} gateway run
Restart=always

[Install]
WantedBy=default.target
`,
		{ mode: 0o600 },
	);
	writeFileSync(join(dropInRoot, "10-clawdi-hosted.conf"), "[Service]\nEnvironment=LEGACY=1\n", {
		mode: 0o600,
	});
	symlinkSync("../hermes-gateway.service", enablementPath);
	chownTreeWithoutFollowingLinks(paths.systemdUserRoot, runtimeUid, runtimeGid);
	for (const path of [paths.systemdUserRoot, dropInRoot, dirname(enablementPath)]) {
		chmodSync(path, 0o700);
	}
	writeFileSync(rootOwnedSentinel, "preserve root ownership\n", { mode: 0o600 });

	try {
		expect((await converge()).installErrors).toEqual([]);
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
		for (const path of [paths.systemdUserRoot, unitPath, dropInRoot, enablementPath]) {
			const node = lstatSync(path);
			expect([node.uid, node.gid]).toEqual([runtimeUid, runtimeGid]);
		}
		expect([statSync(rootOwnedSentinel).uid, statSync(rootOwnedSentinel).gid]).toEqual([0, 0]);
		const declaredUnit = readFileSync(unitPath, "utf8");
		expect(declaredUnit).toContain("Existing Hermes Gateway");

		const idempotent = await converge();
		expect(idempotent.installErrors).toEqual([]);
		expect(readFileSync(installLog, "utf8")).toBe("");
		for (const path of [paths.systemdUserRoot, unitPath, dropInRoot, enablementPath]) {
			const node = lstatSync(path);
			expect([node.uid, node.gid]).toEqual([runtimeUid, runtimeGid]);
		}
		const idempotentState = runUserSystemctl(
			"show",
			unitName,
			"--property=LoadState",
			"--property=ActiveState",
			"--property=MainPID",
		);
		expect(idempotentState.status, idempotentState.stderr).toBe(0);
		expect(idempotentState.stdout).toContain("LoadState=loaded");
		expect(idempotentState.stdout).toContain("ActiveState=active");
		const idempotentPid = Number.parseInt(
			idempotentState.stdout.match(/^MainPID=(\d+)$/m)?.[1] ?? "0",
			10,
		);
		expect(idempotentPid).toBe(initialPid);
		expect(runUserSystemctl("is-enabled", unitName).stdout.trim()).toBe("enabled");

		const tamper = spawnSync(
			"runuser",
			["-u", "clawdi", "--", "sh", "-c", 'printf "\\n# tenant drift\\n" >> "$1"', "sh", unitPath],
			{ encoding: "utf8" },
		);
		expect(tamper.status, tamper.stderr).toBe(0);
		expect(runUserSystemctl("daemon-reload").status).toBe(0);
		expect(runUserSystemctl("restart", unitName).status).toBe(0);
		const tamperedState = runUserSystemctl("show", unitName, "--property=MainPID");
		const tamperedPid = Number.parseInt(
			tamperedState.stdout.match(/^MainPID=(\d+)$/m)?.[1] ?? "0",
			10,
		);
		expect(tamperedPid).toBeGreaterThan(1);
		expect(tamperedPid).not.toBe(initialPid);

		const repaired = await converge();
		expect(repaired.installErrors).toEqual([]);
		expect(readFileSync(unitPath, "utf8")).toContain("Existing Hermes Gateway");
		expect(readFileSync(unitPath, "utf8")).toContain("# tenant drift");
		expect(readFileSync(installLog, "utf8")).toBe("");
		expect([statSync(unitPath).uid, statSync(unitPath).gid]).toEqual([runtimeUid, runtimeGid]);
		expect([statSync(rootOwnedSentinel).uid, statSync(rootOwnedSentinel).gid]).toEqual([0, 0]);
		const repairedState = runUserSystemctl(
			"show",
			unitName,
			"--property=ActiveState",
			"--property=MainPID",
		);
		expect(repairedState.stdout).toContain("ActiveState=active");
		const repairedPid = Number.parseInt(
			repairedState.stdout.match(/^MainPID=(\d+)$/m)?.[1] ?? "0",
			10,
		);
		expect(repairedPid).toBeGreaterThan(1);
		// Native unit adoption does not bypass proof that changed content was activated.
		expect(repairedPid).not.toBe(tamperedPid);
		expect((await converge()).installErrors).toEqual([]);
		expect(runUserSystemctl("show", unitName, "--property=MainPID").stdout.trim()).toBe(
			`MainPID=${repairedPid}`,
		);
		expect(readFileSync(installLog, "utf8")).toBe("");
	} finally {
		runUserSystemctl("disable", "--now", unitName);
		rmSync(unitPath, { force: true });
		rmSync(dropInRoot, { recursive: true, force: true });
		rmSync(enablementPath, { force: true });
		rmSync(rootOwnedSentinel, { force: true });
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);

const BEHAVIORAL_GUARD_ENVIRONMENT = [
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_CODEX_INSTALL_DISABLED",
	"CLAWDI_EGRESS_GID",
	"CLAWDI_EGRESS_UID",
	"CLAWDI_HOME",
	"CLAWDI_RUN_DIR",
	"CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS",
	"CLAWDI_RUNTIME_GID",
	"CLAWDI_RUNTIME_HOME",
	"CLAWDI_RUNTIME_MODE",
	"CLAWDI_RUNTIME_TEST_HERMES_INSTALLER",
	"CLAWDI_RUNTIME_UID",
	"CLAWDI_RUNTIME_USER",
	"CLAWDI_SERVICE_STATE_DIR",
	"CLAWDI_SYSTEMCTL_PATH",
	"CLAWDI_SYSTEMD_APPLY",
	"CLAWDI_SYSTEMD_SYSTEM_ROOT",
] as const;

function configureBehavioralGuardEnvironment(root: string, systemctl = "/usr/bin/systemctl") {
	const previous = new Map(BEHAVIORAL_GUARD_ENVIRONMENT.map((name) => [name, process.env[name]]));
	Object.assign(process.env, {
		CLAWDI_CODEX_INSTALL_DISABLED: "1",
		CLAWDI_EGRESS_GID: "10002",
		CLAWDI_EGRESS_UID: "10002",
		CLAWDI_HOME: join(root, "clawdi-home"),
		CLAWDI_RUN_DIR: join(root, "run"),
		CLAWDI_RUNTIME_GID: "10001",
		CLAWDI_RUNTIME_HOME: "/home/clawdi",
		CLAWDI_RUNTIME_MODE: "hosted",
		CLAWDI_RUNTIME_UID: "10001",
		CLAWDI_RUNTIME_USER: "clawdi",
		CLAWDI_SERVICE_STATE_DIR: join(root, "state"),
		CLAWDI_SYSTEMCTL_PATH: systemctl,
		CLAWDI_SYSTEMD_APPLY: "1",
		CLAWDI_SYSTEMD_SYSTEM_ROOT: "/run/systemd/system",
	});
	delete process.env.CLAWDI_AUTH_TOKEN;
	delete process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS;
	delete process.env.CLAWDI_RUNTIME_TEST_HERMES_INSTALLER;
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

function runBehavioralGuardUserSystemctl(...args: string[]) {
	return spawnSync(
		"runuser",
		[
			"-u",
			"clawdi",
			"--",
			"env",
			"HOME=/home/clawdi",
			"XDG_RUNTIME_DIR=/run/user/10001",
			"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/10001/bus",
			"/usr/bin/systemctl",
			"--user",
			...args,
		],
		{ encoding: "utf8" },
	);
}

function ensureBehavioralGuardUserManager(): void {
	const linger = spawnSync("loginctl", ["enable-linger", "clawdi"], { encoding: "utf8" });
	if (linger.status !== 0) throw new Error(linger.stderr);
	const start = spawnSync("systemctl", ["start", "user@10001.service"], { encoding: "utf8" });
	if (start.status !== 0) throw new Error(start.stderr);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (
			existsSync("/run/user/10001/bus") &&
			spawnSync("systemctl", ["is-active", "--quiet", "user@10001.service"]).status === 0
		) {
			return;
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
	}
	throw new Error("user@10001.service did not expose its D-Bus socket");
}

function cleanBehavioralGuardUnits(paths: ReturnType<typeof getRuntimePaths>): void {
	const units = ["hermes-gateway.service", "clawdi-hermes-dashboard.service"];
	spawnSync("/usr/bin/systemctl", ["disable", "--now", "clawdi-runtime-sidecar.service"]);
	rmSync(join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"), { force: true });
	rmSync(join(paths.systemdEnvRoot, "clawdi-runtime-sidecar.service.env"), { force: true });
	spawnSync("/usr/bin/systemctl", ["daemon-reload"]);
	const loadedUnits = units.filter(
		(unit) =>
			runBehavioralGuardUserSystemctl(
				"show",
				unit,
				"--property=LoadState",
				"--value",
			).stdout.trim() === "loaded",
	);
	if (loadedUnits.length > 0) {
		const stopped = runBehavioralGuardUserSystemctl("stop", ...loadedUnits);
		if (stopped.status !== 0) throw new Error(stopped.stderr);
		const reset = runBehavioralGuardUserSystemctl("reset-failed", ...loadedUnits);
		if (reset.status !== 0) throw new Error(reset.stderr);
		for (const unit of loadedUnits) {
			const state = runBehavioralGuardUserSystemctl(
				"show",
				unit,
				"--property=ActiveState",
				"--property=MainPID",
				"--property=ControlPID",
			);
			if (state.status !== 0 || !/^ActiveState=inactive$/m.test(state.stdout)) {
				throw new Error(`could not stop ${unit}: ${state.stdout}${state.stderr}`);
			}
			if (!/^MainPID=0$/m.test(state.stdout) || !/^ControlPID=0$/m.test(state.stdout)) {
				throw new Error(`processes remain for ${unit}: ${state.stdout}`);
			}
		}
		const disabled = runBehavioralGuardUserSystemctl("disable", ...loadedUnits);
		if (disabled.status !== 0) throw new Error(disabled.stderr);
	}
	for (const unit of units) {
		rmSync(join(paths.systemdUserRoot, unit), { force: true });
		rmSync(join(paths.systemdUserRoot, `${unit}.d`), { recursive: true, force: true });
		rmSync(join(paths.systemdUserRoot, "default.target.wants", unit), { force: true });
	}
	runBehavioralGuardUserSystemctl("daemon-reload");
}

function installBehavioralGuardHermesRuntime(): void {
	rmSync("/home/clawdi/.hermes", { recursive: true, force: true });
	rmSync("/home/clawdi/.local/bin/hermes", { force: true });
	const install = spawnSync(
		"runuser",
		[
			"-u",
			"clawdi",
			"--",
			"env",
			"HOME=/home/clawdi",
			"CLAWDI_TEST_STOCK_RUNTIME=hermes",
			"/opt/fixture/install-stock-runtime.sh",
		],
		{ encoding: "utf8" },
	);
	if (install.status !== 0) throw new Error(install.stderr);
	const dashboardRoot = "/home/clawdi/.hermes/hermes-agent/hermes_cli/web_dist";
	mkdirSync(join(dashboardRoot, "assets"), { recursive: true });
	writeFileSync(join(dashboardRoot, "index.html"), "<html>Hermes dashboard</html>\n");
	const commandRevision = runtimeCommandCurrentRevision(
		"/home/clawdi/.local/bin/hermes",
		"/home/clawdi",
		"/home/clawdi",
	);
	if (!commandRevision) throw new Error("could not resolve the behavioral Hermes revision");
	writeFileSync(join(dashboardRoot, HERMES_DASHBOARD_BUILD_REVISION_FILE), `${commandRevision}\n`);
	chownTreeWithoutFollowingLinks(dashboardRoot, 10_001, 10_001);
}

function behavioralGuardSkill(
	root: string,
	commit: string,
	content: string,
): { archive: Buffer; archiveUrl: string; source: HostedSkillSource } {
	const skillId = "lean-replay-guard";
	const source: HostedSkillSource = {
		type: "github",
		url: "https://github.com/Clawdi-AI/store",
		path: `skills/${skillId}`,
		commit,
	};
	const repositoryRoot = `store-${commit}`;
	const skillRoot = join(root, repositoryRoot, "skills", skillId);
	mkdirSync(skillRoot, { recursive: true });
	writeFileSync(join(skillRoot, "SKILL.md"), content);
	const packed = spawnSync("tar", ["-czf", "-", "-C", root, repositoryRoot]);
	if (packed.status !== 0 || !Buffer.isBuffer(packed.stdout)) {
		throw new Error(`could not build behavioral guard Skill archive: ${packed.stderr}`);
	}
	return {
		archive: packed.stdout,
		archiveUrl: `https://codeload.github.com/Clawdi-AI/store/tar.gz/${commit}`,
		source,
	};
}

function behavioralGuardLoad(input: {
	generation: number;
	timezone: string;
	dashboardSecret: string;
	skillSource?: HostedSkillSource;
}): RuntimeManifestLoad {
	const sourceRevision = createHash("sha256")
		.update(`behavioral-e2e-generation-${input.generation}`)
		.digest("hex");
	const dashboardPasswordRef = "secret://runtime/hermes/dashboard-password";
	const dashboardSessionRef = "secret://runtime/hermes/dashboard-session-secret";
	const codexApiKeyRef = "secret://tool.codex.apiKey";
	const secretValues = {
		[dashboardPasswordRef]: `behavioral-e2e-dashboard-password-${input.dashboardSecret}`,
		[dashboardSessionRef]: `behavioral-e2e-dashboard-session-${input.dashboardSecret}`,
		[codexApiKeyRef]: "behavioral-e2e-codex-api-key",
	};
	const parsed = hostedRuntimeBundleV2Schema.parse({
		schemaVersion: "clawdi.hosted-runtime.bundle.v2",
		sourceRevision,
		manifest: {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			runtime: "hermes",
			deploymentId: "hdep_behavioral_e2e_guards",
			environmentId: "env_behavioral_e2e_guards",
			instanceId: "hri_behavioral_e2e_guards",
			generation: input.generation,
			issuedAt: `2026-08-23T00:00:0${input.generation}.000Z`,
			locale: { language: "en", timezone: input.timezone },
			system: {
				hermesDashboardAuth: {
					mode: "password",
					provider: "basic",
					username: "admin",
					passwordSecretRef: dashboardPasswordRef,
					sessionSecretRef: dashboardSessionRef,
					sessionTtlSeconds: 43_200,
					publicUrl: "https://agent.example.test/hermes",
					activation: { enabled: true, capability: "hermes-basic-auth-v1" },
				},
			},
			controlPlane: { cloudApiUrl: "https://cloud-api.example.test" },
			egressEngine: {
				type: "mitmproxy",
				version: "12.2.3",
				url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
				sha256: "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
			},
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: `clawdi@${getCliVersion()}`,
				registry: "https://registry.npmjs.org",
			},
			runtimes: {
				hermes: {
					enabled: true,
					providerMode: "unmanaged",
					provider_ids: [],
					install: { source: "official" },
					run: { args: ["gateway", "run"] },
					services: {
						dashboard: {
							args: [
								"dashboard",
								"--host",
								"0.0.0.0",
								"--port",
								"9119",
								"--no-open",
								"--skip-build",
							],
						},
					},
				},
			},
			providers: {},
			terminalTooling: {
				codex: {
					enabled: true,
					provider_id: "clawdi-terminal",
					primary_model: { provider_id: "clawdi-terminal", model: "gpt-test" },
					provider: {
						kind: "openai-compatible",
						type: "custom_openai_compatible",
						baseUrl: "https://provider.example.test/v1",
						apiMode: "openai_responses",
						managed_by: "clawdi",
						runtimeEnvName: "CLAWDI_AI_API_KEY",
						apiKeySecretRef: codexApiKeyRef,
					},
				},
			},
			liveSync: { enabled: false, agents: [] },
			...(input.skillSource
				? {
						skills: {
							entries: {
								"lean-replay-guard": { enabled: true, source: input.skillSource },
							},
						},
					}
				: {}),
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		},
		channelBindings: [],
		secretValues,
	});
	return applyRuntimeBundleChannelsToManifestLoad({
		manifest: parsed.manifest,
		sourceBundle: parsed.sourceBundle,
		source: "remote-datasource",
		sourcePath: `behavioral-e2e-generation-${input.generation}`,
		offline: false,
		secretValues: parsed.secretValues,
		sourceRevision: parsed.sourceRevision,
		channelBindings: parsed.channelBindings,
		applyContext: {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: input.generation,
				manifestETag: `"sha256:${sourceRevision}"`,
				applyReceiptId: `behavioral-e2e-receipt-${input.generation}`,
				bootNonce: `behavioral-e2e-boot-nonce-${input.generation}`,
			},
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_behavioral_e2e_guards",
				auth: { type: "bearer", token: "behavioral-e2e-auth-token" },
			},
		},
	});
}

async function convergeBehavioralGuard(
	load: RuntimeManifestLoad,
	paths: ReturnType<typeof getRuntimePaths>,
	fixture: ReturnType<typeof behavioralGuardSkill> | null,
) {
	const preparedHostedSourcedSkills = fixture
		? await prepareHostedSkillArchives(load.manifest, paths, {
				fetcher: async (input) => {
					if (String(input) !== fixture.archiveUrl) {
						throw new Error(`unexpected behavioral guard Skill request: ${String(input)}`);
					}
					return new Response(Uint8Array.from(fixture.archive), {
						status: 200,
						headers: { "content-length": String(fixture.archive.byteLength) },
					});
				},
			})
		: undefined;
	let result = await applyRuntimeManifestLoad(load, paths, { preparedHostedSourcedSkills });
	if (result.kind === "cli_handoff") {
		result = await applyRuntimeManifestLoad(load, paths, { preparedHostedSourcedSkills });
	}
	if (result.kind !== "converged") {
		throw new Error(`unexpected behavioral guard apply result: ${result.kind}`);
	}
	return result.convergence;
}

function behavioralGuardUnitState(unit: string): {
	ActiveState: string;
	InvocationID: string;
	MainPID: string;
} {
	const result = runBehavioralGuardUserSystemctl(
		"show",
		unit,
		"--property=ActiveState",
		"--property=InvocationID",
		"--property=MainPID",
	);
	if (result.status !== 0) throw new Error(result.stderr);
	return Object.fromEntries(
		result.stdout
			.trim()
			.split("\n")
			.map((line) => line.split("=", 2)),
	) as { ActiveState: string; InvocationID: string; MainPID: string };
}

function stableBehavioralGuardAppliedState(paths: ReturnType<typeof getRuntimePaths>) {
	const applied = readRuntimeAppliedState(paths);
	if (!applied) throw new Error("behavioral guard applied-state is missing");
	const { appliedAt: _appliedAt, ...stable } = applied;
	return stable;
}

function behavioralGuardObservableState(
	paths: ReturnType<typeof getRuntimePaths>,
	skillRoot: string,
) {
	return {
		systemdTree: directoryFileDigests(paths.systemdUserRoot),
		userUnits: Object.fromEntries(
			[...readSystemdUnitSnapshot(paths).user.entries()].sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
		environmentFiles: directoryFileDigests(paths.systemdEnvRoot),
		skillTree: filesystemTreeIdentity(skillRoot),
		lastGood: hostedRuntimeBundleV2Schema.parse(
			JSON.parse(readFileSync(paths.manifestLastGood, "utf8")),
		).sourceBundle.manifest,
		appliedState: stableBehavioralGuardAppliedState(paths),
		services: {
			gateway: behavioralGuardUnitState("hermes-gateway.service"),
			dashboard: behavioralGuardUnitState("clawdi-hermes-dashboard.service"),
		},
	};
}

test("replays last-good declarative state after a failed candidate and advances afterward", async () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const root = mkdtempSync(join(tmpdir(), "clawdi-lean-replay-guard-"));
	chmodSync(root, 0o755);
	const failureMarker = join(root, "activation-validation.marker");
	const systemctlWrapper = join(root, "systemctl-replay-guard");
	writeFileSync(failureMarker, "idle\n", { mode: 0o666 });
	chmodSync(failureMarker, 0o666);
	writeFileSync(
		systemctlWrapper,
		`#!/bin/sh
set -eu
state="$(cat ${JSON.stringify(failureMarker)})"
if [ "$state" = "armed" ] && [ "\${1:-}" = "--user" ] && [ "\${2:-}" = "restart" ]; then
  /usr/bin/systemctl "$@"
  printf '%s\\n' verify > ${JSON.stringify(failureMarker)}
  exit 0
fi
if [ "$state" = "verify" ] && [ "\${1:-}" = "--user" ] && [ "\${2:-}" = "show" ]; then
  printf '%s\\n' consumed > ${JSON.stringify(failureMarker)}
  printf '%s\\n' 'injected post-activation validation failure' >&2
  exit 1
fi
exec /usr/bin/systemctl "$@"
`,
		{ mode: 0o755 },
	);
	chmodSync(systemctlWrapper, 0o755);
	const restoreEnvironment = configureBehavioralGuardEnvironment(root, systemctlWrapper);
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	seedLocalCli(paths);
	ensureBehavioralGuardUserManager();
	installBehavioralGuardHermesRuntime();
	const skillRoot = join("/home/clawdi", ".hermes", "skills", "lean-replay-guard");
	const generationOneSkill = behavioralGuardSkill(root, "a".repeat(40), "generation one\n");
	const generationTwoSkill = behavioralGuardSkill(root, "b".repeat(40), "broken candidate\n");
	const generationThreeSkill = behavioralGuardSkill(root, "c".repeat(40), "generation three\n");
	const generationOne = behavioralGuardLoad({
		generation: 1,
		timezone: "UTC",
		dashboardSecret: "generation-one",
		skillSource: generationOneSkill.source,
	});
	const generationTwo = behavioralGuardLoad({
		generation: 2,
		timezone: "Europe/Berlin",
		dashboardSecret: "generation-two",
		skillSource: generationTwoSkill.source,
	});
	const generationThree = behavioralGuardLoad({
		generation: 3,
		timezone: "Asia/Tokyo",
		dashboardSecret: "generation-three",
		skillSource: generationThreeSkill.source,
	});

	try {
		cleanBehavioralGuardUnits(paths);
		rmSync(skillRoot, { recursive: true, force: true });
		const initial = await convergeBehavioralGuard(generationOne, paths, generationOneSkill);
		expect([...initial.installErrors, ...initial.resourceProjectionErrors]).toEqual([]);
		expect(behavioralGuardUnitState("hermes-gateway.service").ActiveState).toBe("active");
		expect(behavioralGuardUnitState("clawdi-hermes-dashboard.service").ActiveState).toBe("active");
		expect(readRuntimeAppliedState(paths)?.generation).toBe(1);
		const initialState = behavioralGuardObservableState(paths, skillRoot);
		const initialGatewayEnvironment = readFileSync(
			join(paths.systemdEnvRoot, "hermes-gateway.service.env"),
			"utf8",
		);
		const initialDashboardEnvironment = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-hermes-dashboard.service.env"),
			"utf8",
		);

		writeFileSync(failureMarker, "armed\n");
		const failed = await convergeBehavioralGuard(generationTwo, paths, generationTwoSkill);
		expect(failed.installErrors.length).toBeGreaterThan(0);
		expect(readFileSync(failureMarker, "utf8").trim()).toBe("consumed");
		const failedFinalState = behavioralGuardObservableState(paths, skillRoot);
		expect(failedFinalState.appliedState.generation).toBe(1);
		expect(failedFinalState.lastGood.generation).toBe(1);
		expect(failedFinalState.skillTree["SKILL.md"]).toContain(
			createHash("sha256").update("generation one\n").digest("hex"),
		);
		expect(readFileSync(join(paths.systemdEnvRoot, "hermes-gateway.service.env"), "utf8")).toBe(
			initialGatewayEnvironment,
		);
		expect(failedFinalState.systemdTree).toEqual(initialState.systemdTree);
		expect(failedFinalState.userUnits).toEqual(initialState.userUnits);
		expect(failedFinalState.environmentFiles).toEqual(initialState.environmentFiles);
		expect(failedFinalState.skillTree).toEqual(initialState.skillTree);
		expect(failedFinalState.lastGood).toEqual(initialState.lastGood);
		expect(failedFinalState.appliedState).toEqual(initialState.appliedState);
		expect(failedFinalState.services.gateway.ActiveState).toBe("active");
		expect(failedFinalState.services.dashboard.ActiveState).toBe("active");

		const replayed = await convergeBehavioralGuard(generationOne, paths, generationOneSkill);
		expect([...replayed.installErrors, ...replayed.resourceProjectionErrors]).toEqual([]);
		expect(failedFinalState).toEqual(behavioralGuardObservableState(paths, skillRoot));

		const repaired = await convergeBehavioralGuard(generationThree, paths, generationThreeSkill);
		expect([...repaired.installErrors, ...repaired.resourceProjectionErrors]).toEqual([]);
		expect(readRuntimeAppliedState(paths)?.generation).toBe(3);
		expect(
			hostedRuntimeBundleV2Schema.parse(JSON.parse(readFileSync(paths.manifestLastGood, "utf8")))
				.manifest.generation,
		).toBe(3);
		expect(readFileSync(join(skillRoot, "SKILL.md"), "utf8")).toBe("generation three\n");
		expect(readFileSync(join(paths.systemdEnvRoot, "hermes-gateway.service.env"), "utf8")).not.toBe(
			initialGatewayEnvironment,
		);
		expect(
			readFileSync(join(paths.systemdEnvRoot, "clawdi-hermes-dashboard.service.env"), "utf8"),
		).not.toBe(initialDashboardEnvironment);
		expect(behavioralGuardUnitState("hermes-gateway.service").ActiveState).toBe("active");
		expect(behavioralGuardUnitState("clawdi-hermes-dashboard.service").ActiveState).toBe("active");
	} finally {
		cleanBehavioralGuardUnits(paths);
		rmSync(skillRoot, { recursive: true, force: true });
		restoreEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
}, 300_000);

test("restarts only rendered-but-unactivated services after a write-side crash", async () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const root = mkdtempSync(join(tmpdir(), "clawdi-lean-crash-guard-"));
	chmodSync(root, 0o755);
	const pauseMarker = join(root, "activation-mutation.marker");
	const systemctlWrapper = join(root, "systemctl-crash-guard");
	writeFileSync(pauseMarker, "", { mode: 0o666 });
	chmodSync(pauseMarker, 0o666);
	writeFileSync(
		systemctlWrapper,
		`#!/bin/sh
set -eu
if [ "\${CLAWDI_E2E_CRASH_ARMED:-}" = "1" ] \
  && [ "\${1:-}" = "--user" ] \
  && { [ "\${2:-}" = "start" ] || [ "\${2:-}" = "restart" ] || [ "\${2:-}" = "stop" ]; }; then
  printf '%s\\n' ready > ${JSON.stringify(pauseMarker)}
  while :; do sleep 1; done
fi
exec /usr/bin/systemctl "$@"
`,
		{ mode: 0o755 },
	);
	chmodSync(systemctlWrapper, 0o755);
	const restoreEnvironment = configureBehavioralGuardEnvironment(root, systemctlWrapper);
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	seedLocalCli(paths);
	ensureBehavioralGuardUserManager();
	installBehavioralGuardHermesRuntime();
	const generationOne = behavioralGuardLoad({
		generation: 1,
		timezone: "UTC",
		dashboardSecret: "unchanged-dashboard",
	});
	const generationTwo = behavioralGuardLoad({
		generation: 2,
		timezone: "Europe/Berlin",
		dashboardSecret: "unchanged-dashboard",
	});
	let child: ReturnType<typeof Bun.spawn> | null = null;

	try {
		cleanBehavioralGuardUnits(paths);
		const initial = await convergeBehavioralGuard(generationOne, paths, null);
		expect([...initial.installErrors, ...initial.resourceProjectionErrors]).toEqual([]);
		const gatewayBefore = behavioralGuardUnitState("hermes-gateway.service");
		const dashboardBefore = behavioralGuardUnitState("clawdi-hermes-dashboard.service");
		expect(gatewayBefore.ActiveState).toBe("active");
		expect(dashboardBefore.ActiveState).toBe("active");
		expect(gatewayBefore.InvocationID).toMatch(/^[a-f0-9]{32}$/);
		expect(dashboardBefore.InvocationID).toMatch(/^[a-f0-9]{32}$/);
		const gatewayEnvironmentBefore = readFileSync(
			join(paths.systemdEnvRoot, "hermes-gateway.service.env"),
		);
		const dashboardEnvironmentBefore = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-hermes-dashboard.service.env"),
		);
		const candidateLoad = join(root, "generation-two-load.json");
		writeFileSync(candidateLoad, `${JSON.stringify(generationTwo)}\n`, { mode: 0o600 });

		const crashChild = join(process.cwd(), "packages/cli/tests/e2e/runtime-systemd-crash-child.ts");
		child = Bun.spawn(["/usr/bin/setsid", process.execPath, crashChild], {
			cwd: process.cwd(),
			env: {
				...process.env,
				CLAWDI_E2E_CRASH_ARMED: "1",
				CLAWDI_E2E_CRASH_LOAD: candidateLoad,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		for (let attempt = 0; attempt < 2400; attempt += 1) {
			if (readFileSync(pauseMarker, "utf8").trim() === "ready") break;
			await Bun.sleep(25);
		}
		if (readFileSync(pauseMarker, "utf8").trim() !== "ready") {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
			const [status, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			throw new Error(
				`crash child did not reach an activation mutation (${status}): ${stdout}${stderr}`,
			);
		}

		const renderedGatewayEnvironment = readFileSync(
			join(paths.systemdEnvRoot, "hermes-gateway.service.env"),
		);
		expect(renderedGatewayEnvironment).not.toEqual(gatewayEnvironmentBefore);
		expect(readFileSync(join(paths.systemdEnvRoot, "clawdi-hermes-dashboard.service.env"))).toEqual(
			dashboardEnvironmentBefore,
		);
		expect(readRuntimeAppliedState(paths)?.generation).toBe(1);
		const gatewayDuringCrash = behavioralGuardUnitState("hermes-gateway.service");
		expect(
			gatewayDuringCrash.InvocationID,
			userUnitDiagnostics("hermes-gateway.service", "/home/clawdi", 10_001),
		).toBe(gatewayBefore.InvocationID);
		const dashboardDuringCrash = behavioralGuardUnitState("clawdi-hermes-dashboard.service");
		expect(
			dashboardDuringCrash.InvocationID,
			userUnitDiagnostics("clawdi-hermes-dashboard.service", "/home/clawdi", 10_001),
		).toBe(dashboardBefore.InvocationID);

		process.kill(-child.pid, "SIGKILL");
		const childStatus = await child.exited;
		expect(childStatus).not.toBe(0);
		child = null;

		const recovered = await convergeBehavioralGuard(generationTwo, paths, null);
		expect([...recovered.installErrors, ...recovered.resourceProjectionErrors]).toEqual([]);
		const gatewayAfter = behavioralGuardUnitState("hermes-gateway.service");
		const dashboardAfter = behavioralGuardUnitState("clawdi-hermes-dashboard.service");
		expect(gatewayAfter.ActiveState).toBe("active");
		expect(dashboardAfter.ActiveState).toBe("active");
		expect(gatewayAfter.InvocationID).not.toBe(gatewayBefore.InvocationID);
		expect(dashboardAfter.InvocationID).toBe(dashboardBefore.InvocationID);
		expect(readFileSync(join(paths.systemdEnvRoot, "clawdi-hermes-dashboard.service.env"))).toEqual(
			dashboardEnvironmentBefore,
		);
		expect(readRuntimeAppliedState(paths)?.generation).toBe(2);
		expect(
			hostedRuntimeBundleV2Schema.parse(JSON.parse(readFileSync(paths.manifestLastGood, "utf8")))
				.manifest.generation,
		).toBe(2);
	} finally {
		if (child) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
			await child.exited;
		}
		cleanBehavioralGuardUnits(paths);
		restoreEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
}, 300_000);
