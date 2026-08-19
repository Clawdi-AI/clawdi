import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type TestConvergeOptions,
	withTestSystemdTransaction,
} from "../test-support/systemd-apply";
import { hostedOpenClawSkillDriver } from "./hosted-openclaw-skill";
import { readRuntimeInstallReceipts } from "./install-receipts";
import {
	convergeRuntimeManifest as convergeRuntimeManifestWithContext,
	type RuntimeManifest,
} from "./manifest";
import { manifestSecretRefs, type RuntimeManifestLoad } from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { type RuntimeRunSettings, runtimeRunConfigPath } from "./run-config";
import { ensureRuntimeStateDirs } from "./state";

const originalEnv = { ...process.env };
const originalConsoleWarn = console.warn;
const tempRoots: string[] = [];
const TEST_PROCESS_UID = process.getuid?.() ?? 1_000;
const TEST_PROCESS_GID = process.getgid?.() ?? 1_000;
const TEST_RUNTIME_USER = String(TEST_PROCESS_UID);
const HERMES_CONFIG_CLI_MOCK = fileURLToPath(
	new URL("../test-support/hermes-config-cli-mock.ts", import.meta.url),
);

function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: TestConvergeOptions = {},
) {
	ensureRuntimeStateDirs(paths);
	return convergeRuntimeManifestWithContext(
		{
			...load,
			applyContext: load.applyContext ?? {
				kind: "context-file",
				backend: "incus",
				identity: {
					generation: load.manifest.applyGeneration ?? load.manifest.generation,
					manifestETag: `"test-${load.manifest.generation}"`,
					applyReceiptId: "test-apply-receipt",
					bootNonce: "test-boot-nonce",
				},
				manifestSource: {
					type: "http",
					url: "https://runtime.test/v1/runtime/manifest?environment_id=env-test",
					auth: { type: "bearer", token: "test-token" },
				},
			},
		},
		paths,
		{
			...opts,
			systemdApply: opts.systemdApply ? withTestSystemdTransaction(opts.systemdApply) : undefined,
			hostedOpenClawSkillDriver: opts?.hostedOpenClawSkillDriver ?? {
				...hostedOpenClawSkillDriver,
				resolveWorkspace: () => join(paths.userHome, ".openclaw", "workspace"),
			},
			hostedRuntimeContract: opts?.hostedRuntimeContract ?? {
				expectedIdentity: {
					home: paths.userHome,
					user: TEST_RUNTIME_USER,
					uid: TEST_PROCESS_UID,
					gid: TEST_PROCESS_GID,
				},
				resolveUserIdentity: () => ({ uid: TEST_PROCESS_UID, gid: TEST_PROCESS_GID }),
			},
		},
	);
}

function tempRuntimePaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-manifest-service-test-"));
	chmodSync(root, 0o755);
	tempRoots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = TEST_RUNTIME_USER;
	process.env.CLAWDI_HOME = join(root, "clawdi-home");
	process.env.CLAWDI_AUTH_TOKEN = "test-token";
	return getRuntimePaths({ mode: "hosted" });
}

function runSettings(command: string, args: string[]): RuntimeRunSettings {
	return { command, args, env: {}, prependPath: [] };
}

function readUserServiceConfig(paths: RuntimePaths, name: string): string {
	const unit = join(paths.systemdUserRoot, `${name}.service`);
	const dropIn = join(paths.systemdUserRoot, `${name}.service.d`, "10-clawdi-hosted.conf");
	return [
		existsSync(unit) ? readFileSync(unit, "utf8") : "",
		existsSync(dropIn) ? readFileSync(dropIn, "utf8") : "",
	].join("\n");
}

function writeFakeGatewayCli(input: {
	path: string;
	logPath: string;
	runtime: "openclaw" | "hermes";
	unitPath: string;
	version?: string;
	hangVersion?: boolean;
	failInstall?: boolean;
	failUninstall?: boolean;
	requiredSystemdState?: {
		dropInPath: string;
		envPath: string;
		snapshotPrefix: string;
	};
}): void {
	const version =
		input.version ?? (input.runtime === "hermes" ? "Hermes Agent v0.18.0" : "OpenClaw 2026.7.29");
	const stateCheck = input.requiredSystemdState
		? `test -f '${input.requiredSystemdState.envPath}'
    test -f '${input.requiredSystemdState.dropInPath}'
    grep -Fx 'ConditionPathExists=${input.requiredSystemdState.envPath}' '${input.requiredSystemdState.dropInPath}' >/dev/null
    cp '${input.requiredSystemdState.envPath}' '${input.requiredSystemdState.snapshotPrefix}.env'
    cp '${input.requiredSystemdState.dropInPath}' '${input.requiredSystemdState.snapshotPrefix}.conf'
    printf '%s systemd state ready\\n' '${input.runtime}' >> '${input.logPath}'`
		: "";
	mkdirSync(dirname(input.path), { recursive: true });
	writeFileSync(
		input.path,
		`#!/usr/bin/env bash
	set -euo pipefail
	case "$*" in
	  "--version")
		${input.hangVersion ? "exec sleep 60" : `printf '%s\\n' '${version}'`}
		;;
  "gateway install --force --json"|"gateway install --force"|"gateway install")
	${stateCheck}
	printf '%s %s\\n' '${input.runtime}' "$*" >> '${input.logPath}'
	${
		input.failInstall
			? "exit 41"
			: `mkdir -p '${dirname(input.unitPath)}'
    rm -f '${input.unitPath}'
    cat > '${input.unitPath}' <<'EOF'
[Unit]
Description=Official gateway

[Service]
ExecStart=official gateway run
EOF
    chmod 0644 '${input.unitPath}'`
	}
	;;
  "gateway uninstall")
	printf '%s %s\\n' '${input.runtime}' "$*" >> '${input.logPath}'
	${input.failUninstall ? "exit 42" : `rm -f '${input.unitPath}'`}
	;;
  "config patch --stdin") cat >/dev/null ;;
  "config path"|"config get "*|"config set "*|"config unset "*)
    printf '%s %s\n' '${input.runtime}' "$*" >> '${input.logPath}'
    exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
    ;;
  *)
    printf 'unexpected ${input.runtime} command: %s\\n' "$*" >&2
    exit 64
    ;;
esac
`,
	);
	chmodSync(input.path, 0o700);
}

function installGateManifest(
	paths: RuntimePaths,
	runtime: "openclaw" | "hermes",
	command: string,
): RuntimeManifest {
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: `hdep_${runtime}_receipt`,
		environmentId: `env_${runtime}_receipt`,
		instanceId: `hri_${runtime}_receipt`,
		generation: 1,
		issuedAt: "2026-07-29T00:00:00.000Z",
		workspaceRoot: join(paths.userHome, "workspace"),
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: {
			[runtime]: {
				enabled: true,
				run: runSettings(command, ["gateway", "run"]),
				services: {},
			},
		},
		...(runtime === "openclaw"
			? {
					projection: {
						system: { home: paths.userHome, workspace: join(paths.userHome, "workspace") },
						channels: { discord: { token: "secret://channels/discord" } },
					},
				}
			: {}),
		recovery: {},
	};
}

function pluginInspectFixture(pluginSourcePath: string): Record<string, unknown> {
	return {
		plugin: {
			id: "discord",
			source: pluginSourcePath,
			origin: "global",
			status: "loaded",
			version: "1.2.3",
			enabled: true,
		},
		install: {
			source: "npm",
			spec: "@openclaw/discord",
			installPath: dirname(pluginSourcePath),
			resolvedName: "@openclaw/discord",
			resolvedVersion: "1.2.3",
			integrity: "sha512-test",
		},
	};
}

function writeFakePluginCli(input: {
	path: string;
	installLogPath: string;
	inspectStatePath: string;
	pluginSourcePath: string;
	failInstallMarker: string;
	version?: string;
}): void {
	mkdirSync(dirname(input.path), { recursive: true });
	writeFileSync(
		input.path,
		`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
	  "--version") printf '%s\\n' '${input.version ?? "OpenClaw 2026.7.29"}' ;;
  "plugins inspect discord --json") cat '${input.inspectStatePath}' ;;
  "plugins install @openclaw/discord --force")
	mkdir -p '${dirname(input.inspectStatePath)}'
	printf '%s\\n' 'plugins install @openclaw/discord --force' >> '${input.installLogPath}'
	[ ! -f '${input.failInstallMarker}' ] || exit 73
	mkdir -p '${dirname(input.pluginSourcePath)}'
	printf '%s\\n' 'export const discordPlugin = true;' > '${input.pluginSourcePath}'
	chmod 0644 '${input.pluginSourcePath}'
	printf '%s\\n' '${JSON.stringify(pluginInspectFixture(input.pluginSourcePath))}' > '${input.inspectStatePath}'
	;;
  "plugins install @openclaw/discord")
	exit 1
	;;
  "config patch --stdin") cat >/dev/null ;;
  *) exit 64 ;;
esac
`,
	);
	chmodSync(input.path, 0o700);
}

interface InstallGateHarness {
	converge: (commitAuthority?: () => void) => ReturnType<typeof convergeRuntimeManifest>;
	drift: () => void;
	revise: () => void;
	failNextInstall: () => void;
	restoreInstaller: () => void;
	installCount: () => number;
	receipt: () => unknown;
}

interface OfficialServiceInstallHarness extends InstallGateHarness {
	addForeignDropIn: () => string;
	hangVersionProbe: () => void;
}

function officialServiceHarness(
	runtime: "openclaw" | "hermes" = "hermes",
): OfficialServiceInstallHarness {
	const paths = tempRuntimePaths();
	const logPath = join(paths.runRoot, "official-service-receipt.log");
	const command =
		runtime === "openclaw"
			? join(paths.userHome, ".local", "bin", "openclaw")
			: join(paths.userHome, ".local", "bin", "hermes");
	const unitPath = join(paths.systemdUserRoot, `${runtime}-gateway.service`);
	const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
	process.env.CLAWDI_SYSTEMCTL_PATH = systemctlCommand;
	writeFakeSystemctl({ path: systemctlCommand, logPath });
	const writeCli = (failInstall = false, version?: string) =>
		writeFakeGatewayCli({
			path: command,
			logPath,
			runtime,
			unitPath,
			version: version ?? (runtime === "hermes" ? "Hermes Agent v0.18.0" : "OpenClaw 2026.7.29"),
			failInstall,
		});
	writeCli();
	const manifest = installGateManifest(paths, runtime, command);
	if (runtime === "openclaw") delete manifest.projection;
	const load: RuntimeManifestLoad = {
		manifest,
		source: "remote-datasource",
		sourcePath: "inline-service-receipt",
		offline: false,
	};
	return {
		converge: (commitAuthority) =>
			convergeRuntimeManifest(load, paths, {
				...(commitAuthority ? { commitAuthority } : {}),
				executeOfficialServiceInstallers: true,
			}),
		drift: () => chmodSync(unitPath, 0o600),
		revise: () =>
			writeCli(false, runtime === "hermes" ? "Hermes Agent v0.18.1" : "OpenClaw 2026.7.30"),
		failNextInstall: () => writeCli(true),
		restoreInstaller: () => writeCli(),
		installCount: () =>
			readFileSync(logPath, "utf8").match(new RegExp(`${runtime} gateway install`, "g"))?.length ??
			0,
		receipt: () =>
			readRuntimeInstallReceipts(paths)?.officialServices[`${runtime}-gateway.service`],
		addForeignDropIn: () => {
			const path = join(
				paths.systemdUserRoot,
				`${runtime}-gateway.service.d`,
				"20-user-override.conf",
			);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "[Service]\nExecStart=\nExecStart=/usr/bin/false\n");
			return path;
		},
		hangVersionProbe: () =>
			writeFakeGatewayCli({ path: command, logPath, runtime, unitPath, hangVersion: true }),
	};
}

function channelPluginHarness(): InstallGateHarness {
	const paths = tempRuntimePaths();
	const command = join(paths.userHome, ".local", "bin", "openclaw");
	const installLogPath = join(paths.runRoot, "plugin-installs.log");
	const inspectStatePath = join(paths.runRoot, "plugin-inspect.json");
	const pluginSourcePath = join(paths.userHome, ".openclaw", "extensions", "discord", "index.js");
	const failInstallMarker = join(paths.runRoot, "fail-plugin-install");
	process.env.CLAWDI_SYSTEMD_APPLY = "0";
	writeFakePluginCli({
		path: command,
		installLogPath,
		inspectStatePath,
		pluginSourcePath,
		failInstallMarker,
	});
	const load: RuntimeManifestLoad = {
		manifest: installGateManifest(paths, "openclaw", command),
		source: "remote-datasource",
		sourcePath: "inline-plugin-receipt",
		offline: false,
		secretValues: {},
	};
	return {
		converge: (commitAuthority) =>
			convergeRuntimeManifest(load, paths, commitAuthority ? { commitAuthority } : {}),
		drift: () => writeFileSync(pluginSourcePath, "export const discordPlugin = false;\n"),
		revise: () =>
			writeFakePluginCli({
				path: command,
				installLogPath,
				inspectStatePath,
				pluginSourcePath,
				failInstallMarker,
				version: "OpenClaw 2026.7.30",
			}),
		failNextInstall: () => writeFileSync(failInstallMarker, "fail\n"),
		restoreInstaller: () => rmSync(failInstallMarker, { force: true }),
		installCount: () =>
			readFileSync(installLogPath, "utf8").match(/@openclaw\/discord/g)?.length ?? 0,
		receipt: () => readRuntimeInstallReceipts(paths)?.channelPlugins["openclaw:discord"],
	};
}

const installGateHarnesses = [
	["Hermes official service", () => officialServiceHarness("hermes")],
	["OpenClaw official service", () => officialServiceHarness("openclaw")],
	["channel plugin", channelPluginHarness],
] as const;

function writeFakeSystemctl(input: {
	path: string;
	logPath: string;
	exitCode?: number;
	resetFailedExitCode?: number;
}): void {
	mkdirSync(dirname(input.path), { recursive: true });
	writeFileSync(
		input.path,
		`#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> '${input.logPath}'
if [[ "$*" == "--user reset-failed "* ]]; then
  exit ${input.resetFailedExitCode ?? input.exitCode ?? 0}
fi
exit ${input.exitCode ?? 0}
`,
	);
	chmodSync(input.path, 0o700);
}

afterEach(() => {
	process.env = { ...originalEnv };
	console.warn = originalConsoleWarn;
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime manifest services", () => {
	test("enables invalid-config repair only for the hosted v2 workspace probe", () => {
		for (const [sourceBundleVersion, expected] of [
			[undefined, false],
			["clawdi.hosted-runtime.bundle.v2", true],
		] as const) {
			const paths = tempRuntimePaths();
			const command = join(paths.userHome, ".local", "bin", "openclaw");
			mkdirSync(dirname(command), { recursive: true });
			writeFileSync(command, "#!/bin/sh\nexit 0\n");
			chmodSync(command, 0o700);
			const manifest = installGateManifest(paths, "openclaw", command);
			manifest.projection = {
				...manifest.projection,
				...(sourceBundleVersion ? { sourceBundleVersion } : {}),
			};
			let repairInvalidConfig: boolean | undefined;

			expect(() =>
				convergeRuntimeManifest(
					{
						manifest,
						source: "remote-datasource",
						sourcePath: "inline-workspace-repair-gate",
						offline: false,
					},
					paths,
					{
						hostedOpenClawSkillDriver: {
							...hostedOpenClawSkillDriver,
							resolveWorkspace: (input) => {
								repairInvalidConfig = input.repairInvalidConfig;
								throw new Error("workspace probe captured");
							},
						},
					},
				),
			).toThrow("workspace probe captured");
			expect(repairInvalidConfig).toBe(expected);
		}
	});

	test("renders systemd runtime services without creating user command shims", () => {
		const paths = tempRuntimePaths();
		process.env.PATH = `${dirname(paths.cliManagedBin)}:${process.env.PATH ?? ""}`;
		process.env.BYOK_RUNTIME_SECRET = "stale-watcher-value";
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_test",
			environmentId: "env_test",
			instanceId: "hri_test",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			workspaceRoot: join(paths.userHome, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: {
						...runSettings("openclaw", ["gateway", "run"]),
						env: { NON_SECRET_RUNTIME_SETTING: "public-value" },
						secretEnv: { BYOK_RUNTIME_SECRET: "secret://runtime/openclaw" },
					},
					services: {},
				},
				hermes: {
					enabled: true,
					run: runSettings("hermes", ["gateway", "run"]),
					services: {
						dashboard: {
							...runSettings("hermes", [
								"dashboard",
								"--host",
								"127.0.0.1",
								"--port",
								"9119",
								"--no-open",
							]),
							secretEnv: { BYOK_SERVICE_SECRET: "secret://service/hermes-dashboard" },
						},
					},
				},
			},
			recovery: {},
		};
		const load: RuntimeManifestLoad = {
			manifest,
			source: "remote-datasource",
			sourcePath: "inline-test",
			offline: false,
			secretValues: {
				"secret://clawdi/auth-token": "test-token",
				"secret://runtime/openclaw": "runtime-byok-value",
				"secret://service/hermes-dashboard": "service-byok-value",
			},
		};

		const previousUmask = process.umask(0o077);
		let result: ReturnType<typeof convergeRuntimeManifest>;
		try {
			ensureRuntimeStateDirs(paths);
			result = convergeRuntimeManifest(load, paths);
		} finally {
			process.umask(previousUmask);
		}
		expect(result.installErrors).toEqual([]);
		expect(statSync(paths.runRoot).mode & 0o777).toBe(0o711);
		expect(statSync(paths.systemdRuntimeRoot).mode & 0o777).toBe(0o711);
		expect(statSync(paths.systemdEnvRoot).mode & 0o777).toBe(0o711);
		expect(result.outputs.runConfigs.map((path) => path.split("/").at(-1)).sort()).toEqual([
			"hermes+dashboard.json",
			"hermes.json",
			"openclaw.json",
		]);
		expect(result.outputs.processManager).toBe("systemd");
		expect(result.outputs.systemdSystemUnits.map((path) => path.split("/").at(-1))).toContain(
			"clawdi-runtime-watch.service",
		);
		expect(result.outputs.systemdUserUnits.map((path) => path.split("/").at(-1)).sort()).toEqual([
			"clawdi-hermes-dashboard.service",
			"hermes-gateway.service",
			"openclaw-gateway.service",
		]);

		const hermesUnit = readUserServiceConfig(paths, "hermes-gateway");
		expect(hermesUnit).not.toContain("\nExecStart=");
		expect(hermesUnit).not.toContain("\nWorkingDirectory=");
		const dashboardUnit = readFileSync(
			join(paths.systemdUserRoot, "clawdi-hermes-dashboard.service"),
			"utf8",
		);
		expect(dashboardUnit).toContain(
			'ExecStart="hermes" "dashboard" "--host" "127.0.0.1" "--port" "9119" "--no-open"',
		);
		expect(dashboardUnit).not.toContain("--skip-build");
		const openclawUnit = readUserServiceConfig(paths, "openclaw-gateway");
		expect(openclawUnit).toContain('Environment="XDG_RUNTIME_DIR=%t"');
		expect(openclawUnit).toContain('Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"');
		expect(openclawUnit).toContain(
			`EnvironmentFile=${join(paths.systemdEnvRoot, "openclaw-gateway.service.env")}`,
		);
		expect(openclawUnit).toContain(
			`ConditionPathExists=${join(paths.systemdEnvRoot, "openclaw-gateway.service.env")}`,
		);
		expect(openclawUnit).not.toContain("\nExecStart=");
		expect(openclawUnit).not.toContain("\nWorkingDirectory=");
		expect(hermesUnit).toContain(
			`ConditionPathExists=${join(paths.systemdEnvRoot, "hermes-gateway.service.env")}`,
		);
		expect(dashboardUnit).toContain(
			`ConditionPathExists=${join(paths.systemdEnvRoot, "clawdi-hermes-dashboard.service.env")}`,
		);
		const runtimeWatchUnit = readFileSync(
			join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
			"utf8",
		);
		const runtimeWatchEnv = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env"),
			"utf8",
		);
		expect(runtimeWatchUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "watch"`);
		expect(runtimeWatchUnit).toContain("ConfigurationDirectory=clawdi");
		expect(runtimeWatchUnit).toContain("ConfigurationDirectoryMode=0700");
		expect(runtimeWatchUnit).toContain("StateDirectory=clawdi");
		expect(runtimeWatchUnit).toContain("StateDirectoryMode=0700");
		expect(runtimeWatchUnit).toContain("CacheDirectory=clawdi");
		expect(runtimeWatchUnit).toContain("CacheDirectoryMode=0700");
		// The boot-level runtime root must outlive this generated watcher unit.
		expect(runtimeWatchUnit).not.toContain("\nRuntimeDirectory=");
		expect(runtimeWatchUnit).not.toContain("\nRuntimeDirectoryMode=");
		expect(runtimeWatchUnit).not.toContain("\nRuntimeDirectoryPreserve=");
		expect(runtimeWatchUnit).toContain("TasksMax=infinity");
		expect(runtimeWatchUnit).not.toContain("ConditionPathExists=");
		expect(runtimeWatchEnv).not.toContain("runtime-byok-value");
		expect(runtimeWatchEnv).not.toContain("service-byok-value");
		expect(runtimeWatchEnv).not.toContain("stale-watcher-value");
		expect(runtimeWatchEnv).not.toContain("BYOK_RUNTIME_SECRET");
		expect(runtimeWatchEnv).not.toContain("BYOK_SERVICE_SECRET");
		expect(runtimeWatchEnv).not.toContain("NON_SECRET_RUNTIME_SETTING");
		for (const unit of [hermesUnit, dashboardUnit, openclawUnit]) {
			expect(unit).not.toContain("clawdi run --");
			expect(unit).not.toContain("supervisord");
			expect(unit).not.toContain("test-token");
		}
		const openclawEnv = readFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			"utf8",
		);
		expect(openclawEnv).toContain('OPENCLAW_SYSTEMD_UNIT="openclaw-gateway.service"');
		expect(openclawEnv).toContain('CLAWDI_AUTH_TOKEN=""');
		for (const name of ["openclaw-gateway", "hermes-gateway", "clawdi-hermes-dashboard"]) {
			const env = readFileSync(join(paths.systemdEnvRoot, `${name}.service.env`), "utf8");
			expect(env).toContain(`CLAWDI_HOME="${paths.clawdiHome}"`);
			expect(env).not.toContain(dirname(paths.cliManagedBin));
		}
		expect(runtimeWatchEnv).toContain(`CLAWDI_HOME="${paths.clawdiHome}"`);

		const serviceConfig = JSON.parse(
			readFileSync(join(paths.runConfigRoot, "hermes+dashboard.json"), "utf8"),
		) as {
			runtime?: string;
			service?: string;
			defaultArgs?: string[];
			egressProfileBundlePath?: string | null;
		};
		expect(serviceConfig.runtime).toBe("hermes");
		expect(serviceConfig.service).toBe("dashboard");
		expect(serviceConfig.defaultArgs).toEqual([
			"dashboard",
			"--host",
			"127.0.0.1",
			"--port",
			"9119",
			"--no-open",
		]);
		expect(serviceConfig.egressProfileBundlePath).toBeNull();

		expect(existsSync(join(paths.serviceStateRoot, "bin", "hermes"))).toBe(false);
		expect(existsSync(join(paths.serviceStateRoot, "bin", "clawdi"))).toBe(false);
		expect(existsSync(join(paths.serviceStateRoot, "bin", ".clawdi-runtime-command-shim"))).toBe(
			false,
		);
		expect(existsSync(join(paths.serviceStateRoot, "bin", "hermes+dashboard"))).toBe(false);
	});

	test("renders the Hermes password dashboard directly", () => {
		const paths = tempRuntimePaths();
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		writeFakeGatewayCli({
			path: hermesCommand,
			logPath: join(paths.runRoot, "hermes-dashboard.log"),
			runtime: "hermes",
			unitPath: join(paths.systemdUserRoot, "hermes-gateway.service"),
		});
		process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD = "stale-dashboard-password";
		process.env.HERMES_DASHBOARD_BASIC_AUTH_SECRET = "stale-dashboard-session-secret";
		process.env.RUNTIME_SOURCE_TOKEN = "stale-runtime-source-token";
		process.env.UNRELATED_RUNTIME_SECRET = "must-not-be-exposed";
		const warnings: string[] = [];
		console.warn = (...values: unknown[]) => {
			warnings.push(values.map(String).join(" "));
		};
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			runtime: "hermes",
			deploymentId: "hdep_hermes_single",
			environmentId: "env_hermes_single",
			instanceId: "hri_hermes_single",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			workspaceRoot: join(paths.userHome, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
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
			runtimes: {
				hermes: {
					enabled: true,
					run: {
						...runSettings(hermesCommand, ["gateway", "run"]),
						secretEnv: {
							RUNTIME_TARGET_TOKEN: "secret://runtime/source-token",
							RUNTIME_BUNDLE_TOKEN: "secret://runtime/token",
						},
					},
					services: {
						dashboard: runSettings(hermesCommand, [
							"dashboard",
							"--host",
							"0.0.0.0",
							"--port",
							"9119",
							"--no-open",
						]),
					},
				},
			},
			recovery: {},
		};
		const applyContext = {
			kind: "context-file" as const,
			backend: "incus" as const,
			identity: {
				generation: 1,
				manifestETag: '"manifest-1"',
				applyReceiptId: "apply-receipt-0001",
				bootNonce: "boot-nonce-000001",
			},
			manifestSource: {
				type: "http" as const,
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env-test",
				auth: { type: "bearer" as const, token: "test-token" },
			},
		};
		const load: RuntimeManifestLoad = {
			manifest,
			source: "remote-datasource",
			sourcePath: "inline-hermes-single",
			offline: false,
			applyContext,
			secretValues: {
				"secret://clawdi/auth-token": "test-token",
				"secret://runtime/hermes/dashboard-password": "opaque-password-value",
				"secret://runtime/hermes/dashboard-session-secret": "opaque-session-value",
				"secret://runtime/source-token": "runtime-source-token",
				"secret://runtime/token": "bundle-runtime-token",
				"secret://unrelated": "unrelated-inline-secret",
			},
		};

		const result = convergeRuntimeManifest(load, paths);

		expect(result.installErrors).toEqual([]);
		expect(result.enabledRuntimes).toEqual(["hermes"]);
		expect(result.outputs.runConfigs.map((path) => path.split("/").at(-1)).sort()).toEqual([
			"hermes+dashboard.json",
			"hermes.json",
		]);
		expect(result.outputs.systemdUserUnits.map((path) => path.split("/").at(-1)).sort()).toEqual([
			"clawdi-hermes-dashboard.service",
			"hermes-gateway.service",
		]);
		expect(result.outputs.systemdSystemUnits.map((path) => path.split("/").at(-1)).sort()).toEqual([
			"clawdi-daemon.service",
			"clawdi-runtime-watch.service",
		]);
		expect(readUserServiceConfig(paths, "hermes-gateway")).not.toContain("\nExecStart=");
		const dashboardUnit = readFileSync(
			join(paths.systemdUserRoot, "clawdi-hermes-dashboard.service"),
			"utf8",
		);
		expect(dashboardUnit).toContain(
			`ExecStart="${hermesCommand}" "dashboard" "--host" "0.0.0.0" "--port" "9119" "--no-open"`,
		);
		expect(dashboardUnit).not.toContain("--skip-build");
		const dashboardEnv = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-hermes-dashboard.service.env"),
			"utf8",
		);
		const gatewayEnv = readFileSync(
			join(paths.systemdEnvRoot, "hermes-gateway.service.env"),
			"utf8",
		);
		const watchEnv = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env"),
			"utf8",
		);
		const watchUnitPath = join(paths.systemdSystemRoot, "clawdi-runtime-watch.service");
		const watchUnit = readFileSync(watchUnitPath, "utf8");
		const gatewayUnit = readUserServiceConfig(paths, "hermes-gateway");
		const watchEnvPath = join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env");
		const watchEnvStat = statSync(watchEnvPath);
		expect(dashboardEnv).toContain('HERMES_DASHBOARD_BASIC_AUTH_USERNAME="admin"');
		expect(dashboardEnv).toContain('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="opaque-password-value"');
		expect(dashboardEnv).toContain('HERMES_DASHBOARD_BASIC_AUTH_SECRET="opaque-session-value"');
		expect(dashboardEnv).toContain(
			'HERMES_DASHBOARD_PUBLIC_URL="https://agent.example.test/hermes"',
		);
		const dashboardRunConfig = JSON.parse(
			readFileSync(runtimeRunConfigPath("hermes", paths, "dashboard"), "utf8"),
		) as { env?: Record<string, string>; secretEnv?: Record<string, string> };
		expect(dashboardRunConfig.env).toMatchObject({
			HERMES_DASHBOARD_BASIC_AUTH_USERNAME: "admin",
			HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS: "43200",
			HERMES_DASHBOARD_PUBLIC_URL: "https://agent.example.test/hermes",
		});
		expect(dashboardRunConfig.secretEnv).toMatchObject({
			HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: "secret://runtime/hermes/dashboard-password",
			HERMES_DASHBOARD_BASIC_AUTH_SECRET: "secret://runtime/hermes/dashboard-session-secret",
		});
		expect(gatewayEnv).toContain('RUNTIME_TARGET_TOKEN="runtime-source-token"');
		expect(gatewayEnv).toContain('RUNTIME_BUNDLE_TOKEN="bundle-runtime-token"');
		expect(watchEnv).not.toContain("opaque-password-value");
		expect(watchEnv).not.toContain("opaque-session-value");
		expect(watchEnv).not.toContain("runtime-source-token");
		expect(watchEnv).not.toContain("bundle-runtime-token");
		expect(watchEnv).not.toContain("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD");
		expect(watchEnv).not.toContain("HERMES_DASHBOARD_BASIC_AUTH_SECRET");
		expect(watchEnv).not.toContain("RUNTIME_TARGET_TOKEN");
		expect(watchEnv).not.toContain("RUNTIME_BUNDLE_TOKEN");
		expect(watchEnv).not.toContain("RUNTIME_SOURCE_TOKEN");
		expect(watchEnv).not.toContain("must-not-be-exposed");
		expect(watchEnv).not.toContain("UNRELATED_RUNTIME_SECRET");
		expect(watchEnv).not.toContain("unrelated-inline-secret");
		expect(watchUnit).toContain(`EnvironmentFile=${watchEnvPath}`);
		for (const secret of [
			"opaque-password-value",
			"opaque-session-value",
			"runtime-source-token",
			"bundle-runtime-token",
		]) {
			expect(watchUnit).not.toContain(secret);
		}
		expect(watchEnvStat.mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(watchEnvStat.uid).toBe(0);
			expect(watchEnvStat.gid).toBe(0);
			if (process.platform === "linux") {
				const numericPrivilegeTool = ["set", "priv"].join("");
				const setpriv = spawnSync(numericPrivilegeTool, ["--version"], { encoding: "utf8" });
				if (!setpriv.error && setpriv.status === 0) {
					const nonRootRead = spawnSync(
						numericPrivilegeTool,
						["--reuid=65534", "--regid=65534", "--clear-groups", "cat", watchEnvPath],
						{ encoding: "utf8" },
					);
					expect(nonRootRead.status).not.toBe(0);
					expect(nonRootRead.stdout).not.toContain("opaque-password-value");
				}
			}
		}
		const convergenceDiagnostics = JSON.stringify(result);
		expect(convergenceDiagnostics).not.toContain("opaque-password-value");
		expect(convergenceDiagnostics).not.toContain("opaque-session-value");
		expect(convergenceDiagnostics).not.toContain("runtime-source-token");
		expect(convergenceDiagnostics).not.toContain("bundle-runtime-token");
		const hermesConfig = readFileSync(join(paths.userHome, ".hermes", "config.yaml"), "utf8");
		expect(hermesConfig).toContain("basic_auth:");
		expect(hermesConfig).toContain("username: admin");
		expect(hermesConfig).toContain("session_ttl_seconds: 43200");
		expect(hermesConfig).toContain("dashboard_auth/nous");
		expect(hermesConfig).toContain("dashboard_auth/self_hosted");
		expect(hermesConfig).not.toContain("dashboard_auth/basic\n");
		expect(hermesConfig).not.toContain("opaque-password-value");
		expect(hermesConfig).not.toContain("dashboard-session-secret");
		const configCommands = readFileSync(join(paths.runRoot, "hermes-dashboard.log"), "utf8");
		expect(configCommands).toContain("hermes config path");
		expect(configCommands).not.toContain("hermes config set --force dashboard.basic_auth");
		expect(configCommands).not.toContain("hermes config set --force plugins.disabled");
		expect(existsSync(runtimeRunConfigPath("openclaw", paths))).toBe(false);

		const rotated = convergeRuntimeManifest(
			{
				...load,
				secretValues: {
					...load.secretValues,
					"secret://runtime/hermes/dashboard-password": "rotated-dashboard-password",
					"secret://runtime/hermes/dashboard-session-secret": "rotated-dashboard-session-secret",
				},
			},
			paths,
		);
		expect(rotated.installErrors).toEqual([]);
		const rotatedDashboardUnit = readFileSync(
			join(paths.systemdUserRoot, "clawdi-hermes-dashboard.service"),
			"utf8",
		);
		const rotatedGatewayUnit = readUserServiceConfig(paths, "hermes-gateway");
		const rotatedWatchEnv = readFileSync(watchEnvPath, "utf8");
		const rotatedWatchUnit = readFileSync(watchUnitPath, "utf8");
		expect(rotatedWatchEnv).toBe(watchEnv);
		expect(rotatedDashboardUnit).not.toBe(dashboardUnit);
		expect(rotatedGatewayUnit).toBe(gatewayUnit);
		// The root watcher reloads the apply-context file on each tick, so neither
		// its environment nor its unit needs secret bytes.
		expect(rotatedWatchUnit).toBe(watchUnit);
		expect(rotatedWatchUnit).not.toContain("runtime-source-token");
		expect(rotatedWatchUnit).not.toContain("rotated-runtime-source-token");
		expect(rotatedWatchUnit).not.toContain("dashboard-password");
		expect(rotatedWatchUnit).not.toContain("rotated-dashboard-password");
		expect(warnings.join("\n")).not.toContain("runtime-source-token");
		expect(warnings.join("\n")).not.toContain("rotated-runtime-source-token");
		expect(warnings.join("\n")).not.toContain("dashboard-password");
		expect(warnings.join("\n")).not.toContain("rotated-dashboard-password");

		const sourceChangedManifest = structuredClone(manifest);
		const sourceChangedRun = sourceChangedManifest.runtimes.hermes?.run;
		if (!sourceChangedRun?.secretEnv) throw new Error("expected Hermes secret env");
		sourceChangedRun.secretEnv.RUNTIME_TARGET_TOKEN = "secret://runtime/next-source-token";
		const sourceChanged = convergeRuntimeManifest(
			{
				...load,
				manifest: sourceChangedManifest,
				secretValues: {
					...load.secretValues,
					"secret://runtime/next-source-token": "next-runtime-source-value",
				},
			},
			paths,
		);
		expect(sourceChanged.installErrors).toEqual([]);
		const sourceChangedWatchEnv = readFileSync(watchEnvPath, "utf8");
		const sourceChangedWatchUnit = readFileSync(watchUnitPath, "utf8");
		expect(sourceChangedWatchEnv).toBe(rotatedWatchEnv);
		// Secret source and value changes are resolved through the apply context
		// and do not alter the long-lived watcher's process environment.
		expect(sourceChangedWatchUnit).toBe(rotatedWatchUnit);
		expect(sourceChangedWatchUnit).not.toContain("next-runtime-source-value");
		expect(warnings.join("\n")).not.toContain("next-runtime-source-value");
	});

	test("enumerates only enabled schema-known secret consumers", () => {
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_secret_consumers",
			environmentId: "env_secret_consumers",
			instanceId: "hri_secret_consumers",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
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
			runtimes: {
				hermes: {
					enabled: true,
					providerMode: "configured",
					provider_ids: ["selected"],
					primary_model: { provider_id: "selected", model: "model-1" },
					run: {
						...runSettings("hermes", ["gateway", "run"]),
						secretEnv: { ACTIVE: "secret://runtime/active" },
					},
					services: {
						dashboard: {
							...runSettings("hermes", ["dashboard"]),
							secretEnv: { SERVICE: "secret://runtime/active-service" },
						},
					},
				},
				openclaw: {
					enabled: false,
					run: {
						...runSettings("openclaw", ["gateway", "run"]),
						secretEnv: { DISABLED: "secret://runtime/disabled" },
					},
					services: {},
				},
			},
			projection: {
				providers: {
					selected: {
						baseUrl: "https://provider.example.test/v1",
						managed_by: "user",
						apiKeySecretRef: "secret://providers/selected/api-key",
					},
					unselected: { apiKeySecretRef: "secret://providers/unselected/api-key" },
				},
				tools: { opaqueSecretRef: "secret://tools/opaque" },
			},
			egressProfiles: {
				profiles: [
					{
						id: "disabled-secret-profile",
						enabled: false,
						kind: "http",
						match: { host: "disabled.example.test", headers: {}, query: {} },
						rewrite: {
							upstreamBaseUrl: "https://disabled-upstream.example.test",
							preservePath: true,
							setHeaders: {
								authorization: {
									type: "secretRef",
									secretRef: "secret://disabled/profile",
									prefix: "Bearer ",
								},
							},
						},
						logging: { redactHeaders: [], redactUrlPatterns: [] },
						priority: 100,
					},
					{
						id: "active-secret-profile",
						enabled: true,
						kind: "http",
						match: { host: "active.example.test", headers: {}, query: {} },
						rewrite: {
							upstreamBaseUrl: "https://active-upstream.example.test",
							preservePath: true,
							setHeaders: {
								authorization: {
									type: "secretRef",
									secretRef: "secret://active/profile",
									prefix: "Bearer ",
								},
							},
						},
						logging: { redactHeaders: [], redactUrlPatterns: [] },
						priority: 100,
					},
				],
			},
			recovery: {},
		};

		expect(manifestSecretRefs(manifest)).toEqual([
			"secret://active/profile",
			"secret://providers/selected/api-key",
			"secret://runtime/active",
			"secret://runtime/active-service",
			"secret://runtime/hermes/dashboard-password",
			"secret://runtime/hermes/dashboard-session-secret",
		]);

		const inactiveManifest = structuredClone(manifest);
		const inactiveHermes = inactiveManifest.runtimes.hermes;
		if (!inactiveHermes) throw new Error("expected Hermes runtime");
		inactiveHermes.enabled = false;
		expect(manifestSecretRefs(inactiveManifest)).toEqual([]);
	});

	test("fails closed when an enabled consumer's canonical bundle secret is missing", () => {
		const paths = tempRuntimePaths();
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_watch_missing_secret",
			environmentId: "env_watch_missing_secret",
			instanceId: "hri_watch_missing_secret",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: {
						...runSettings("openclaw", ["gateway", "run"]),
						secretEnv: {
							RUNTIME_TARGET_SECRET: "secret://runtime/watch-required",
						},
					},
					services: {},
				},
			},
			recovery: {},
		};

		expect(() =>
			convergeRuntimeManifest(
				{
					manifest,
					source: "remote-datasource",
					sourcePath: "inline-watch-missing-secret",
					offline: false,
					secretValues: {},
				},
				paths,
			),
		).toThrow("Runtime secret secret://runtime/watch-required is unavailable.");
		expect(existsSync(join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env"))).toBe(false);
	});

	test("does not project colliding runtime secret destinations into the watcher environment", () => {
		const converge = (
			runtimeOrder: Array<"hermes" | "openclaw">,
			secretValues: Record<string, string>,
		) => {
			const paths = tempRuntimePaths();
			const runtimeSettings: RuntimeManifest["runtimes"] = {
				hermes: {
					enabled: true,
					run: {
						...runSettings("hermes", ["gateway", "run"]),
						secretEnv: { SHARED_RUNTIME_SECRET: "secret://runtime/hermes" },
					},
					services: {},
				},
				openclaw: {
					enabled: true,
					run: {
						...runSettings("openclaw", ["gateway", "run"]),
						secretEnv: { SHARED_RUNTIME_SECRET: "secret://runtime/openclaw" },
					},
					services: {},
				},
			};
			const runtimes = Object.fromEntries(
				runtimeOrder.map((runtime) => [runtime, runtimeSettings[runtime]]),
			) as RuntimeManifest["runtimes"];
			const manifest: RuntimeManifest = {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "hdep_conflicting_watch_secrets",
				environmentId: "env_conflicting_watch_secrets",
				instanceId: "hri_conflicting_watch_secrets",
				generation: 1,
				issuedAt: "2026-07-01T00:00:00.000Z",
				workspaceRoot: join(paths.userHome, "clawdi"),
				controlPlane: { apiUrl: "https://cloud-api.example.test" },
				runtimes,
				recovery: {},
			};
			return {
				paths,
				result: convergeRuntimeManifest(
					{
						manifest,
						source: "remote-datasource",
						sourcePath: "inline-conflicting-watch-secrets",
						offline: false,
						secretValues,
					},
					paths,
				),
			};
		};

		const conflictingValues = {
			"secret://clawdi/auth-token": "test-token",
			"secret://runtime/hermes": "hermes-secret",
			"secret://runtime/openclaw": "openclaw-secret",
		};
		for (const runtimeOrder of [
			["hermes", "openclaw"],
			["openclaw", "hermes"],
		] as const) {
			const converged = converge([...runtimeOrder], conflictingValues);
			expect(converged.result.installErrors).toEqual([]);
			const watchEnv = readFileSync(
				join(converged.paths.systemdEnvRoot, "clawdi-runtime-watch.service.env"),
				"utf8",
			);
			expect(watchEnv).not.toContain("SHARED_RUNTIME_SECRET");
			expect(watchEnv).not.toContain("hermes-secret");
			expect(watchEnv).not.toContain("openclaw-secret");
		}
	});

	test("upgrades legacy hosted drop-ins before official installers restart units", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".local", "bin", "openclaw");
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlCommand;
		writeFakeSystemctl({ path: systemctlCommand, logPath });
		for (const [runtime, command] of [
			["openclaw", openclawCommand],
			["hermes", hermesCommand],
		] as const) {
			const name = `${runtime}-gateway`;
			const dropInPath = join(paths.systemdUserRoot, `${name}.service.d`, "10-clawdi-hosted.conf");
			const envPath = join(paths.systemdEnvRoot, `${name}.service.env`);
			mkdirSync(dirname(dropInPath), { recursive: true });
			writeFileSync(
				dropInPath,
				`[Service]\nEnvironmentFile=${envPath}\nWorkingDirectory=/legacy/clawdi\nExecStart=\nExecStart=/legacy/clawdi gateway run\n`,
			);
			writeFakeGatewayCli({
				path: command,
				logPath,
				runtime,
				unitPath: join(paths.systemdUserRoot, `${name}.service`),
				requiredSystemdState: {
					dropInPath,
					envPath,
					snapshotPrefix: join(paths.runRoot, `${name}-installer-state`),
				},
			});
		}
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_installer_order",
			environmentId: "env_installer_order",
			instanceId: "hri_installer_order",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			workspaceRoot: join(paths.userHome, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: runSettings(openclawCommand, ["gateway", "run"]),
					services: {},
				},
				hermes: {
					enabled: true,
					run: runSettings(hermesCommand, ["gateway", "run"]),
					services: {},
				},
			},
			recovery: {},
		};

		let prerequisiteActivations = 0;
		let finalActivations = 0;
		const result = convergeRuntimeManifest(
			{
				manifest,
				source: "remote-datasource",
				sourcePath: "inline-installer-order",
				offline: false,
			},
			paths,
			{
				systemdApply: {
					quiesce: () => {},
					activateEgressPrerequisite: () => {
						prerequisiteActivations += 1;
						return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
					},
					activate: () => {
						finalActivations += 1;
						return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
					},
					rollback: () => {},
				},
			},
		);

		expect(result.installErrors).toEqual([]);
		expect(prerequisiteActivations).toBe(0);
		expect(finalActivations).toBe(1);
		expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
			"systemctl --user daemon-reload",
			"systemctl --user reset-failed hermes-gateway.service",
			"hermes systemd state ready",
			"hermes gateway install --force",
			"systemctl --user daemon-reload",
			"systemctl --user reset-failed openclaw-gateway.service",
			"openclaw systemd state ready",
			"openclaw gateway install --force --json",
		]);
		for (const name of ["openclaw-gateway", "hermes-gateway"]) {
			const envPath = join(paths.systemdEnvRoot, `${name}.service.env`);
			expect(readFileSync(join(paths.runRoot, `${name}-installer-state.env`), "utf8")).toBe(
				readFileSync(envPath, "utf8"),
			);
			const installerDropIn = readFileSync(
				join(paths.runRoot, `${name}-installer-state.conf`),
				"utf8",
			);
			expect(installerDropIn).toBe(
				readFileSync(
					join(paths.systemdUserRoot, `${name}.service.d`, "10-clawdi-hosted.conf"),
					"utf8",
				),
			);
			expect(installerDropIn).not.toContain("\nExecStart=");
			expect(installerDropIn).not.toContain("\nWorkingDirectory=");
			expect(installerDropIn).toContain(`ConditionPathExists=${envPath}`);
			expect(installerDropIn).toContain(`EnvironmentFile=${envPath}`);
		}
	});

	test.each(
		installGateHarnesses,
	)("gates %s installs on a verified no-op and fails closed on drift", (_name, createHarness) => {
		const harness = createHarness();
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(1);
		expect(harness.receipt()).toBeDefined();

		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(1);

		harness.drift();
		const receiptBeforeFailure = harness.receipt();
		harness.failNextInstall();
		expect(harness.converge().installErrors.join("\n")).toContain("install failed");
		expect(harness.installCount()).toBe(2);
		expect(harness.receipt()).toEqual(receiptBeforeFailure);

		harness.restoreInstaller();
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(3);
	});

	test.each(
		installGateHarnesses,
	)("reconciles a real %s command revision change exactly once", (_name, createHarness) => {
		const harness = createHarness();
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(1);

		harness.revise();
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(2);
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(2);
	});

	test.each(
		installGateHarnesses,
	)("rolls back the %s receipt when authority commit fails", (_name, createHarness) => {
		const harness = createHarness();
		const failed = harness.converge(() => {
			throw new Error("authority commit rejected");
		});

		expect(failed.installErrors.join("\n")).toContain("authority commit rejected");
		expect(harness.installCount()).toBe(1);
		expect(harness.receipt()).toBeUndefined();

		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(2);
		expect(harness.receipt()).toBeDefined();
	});

	test.each(
		installGateHarnesses,
	)("restores the prior %s receipt when replacement authority fails", (_name, createHarness) => {
		const harness = createHarness();
		expect(harness.converge().installErrors).toEqual([]);
		const previousReceipt = harness.receipt();
		expect(previousReceipt).toBeDefined();

		harness.revise();
		const failed = harness.converge(() => {
			throw new Error("replacement authority rejected");
		});

		expect(failed.installErrors.join("\n")).toContain("replacement authority rejected");
		expect(harness.installCount()).toBe(2);
		expect(harness.receipt()).toEqual(previousReceipt);

		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(3);
		expect(harness.receipt()).not.toEqual(previousReceipt);
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(3);
	});

	test.each(installGateHarnesses)("does not bless post-commit %s drift", (_name, createHarness) => {
		const harness = createHarness();
		expect(harness.converge(harness.drift).installErrors).toEqual([]);
		expect(harness.installCount()).toBe(1);
		expect(harness.receipt()).toBeDefined();

		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(2);
		expect(harness.receipt()).toBeDefined();
	});

	test.each([
		["Hermes", "hermes"],
		["OpenClaw", "openclaw"],
	] as const)("reports foreign %s gateway drop-ins without deleting them", (_name, runtime) => {
		const harness = officialServiceHarness(runtime);
		expect(harness.converge().installErrors).toEqual([]);
		const receipt = harness.receipt();
		const foreignDropIn = harness.addForeignDropIn();
		const foreignContents = readFileSync(foreignDropIn, "utf8");

		const drifted = harness.converge();

		expect(drifted.installErrors).toEqual([
			expect.stringContaining(
				`foreign systemd drop-in drift detected for ${runtime}-gateway.service`,
			),
		]);
		expect(drifted.installErrors.join("\n")).toContain(foreignDropIn);
		expect(drifted.outputs.systemdUserUnits).toEqual([]);
		expect(harness.installCount()).toBe(1);
		expect(harness.receipt()).toEqual(receipt);
		expect(readFileSync(foreignDropIn, "utf8")).toBe(foreignContents);
	});

	test("turns a hanging runtime version probe into a bounded convergence error", () => {
		const harness = officialServiceHarness("openclaw");
		expect(harness.converge().installErrors).toEqual([]);
		harness.hangVersionProbe();
		const startedAt = Date.now();

		const result = harness.converge();

		expect(Date.now() - startedAt).toBeLessThan(15_000);
		expect(result.installErrors.join("\n")).toContain("runtime --version probe for");
		expect(result.installErrors.join("\n")).toContain("timed out after 10000ms");
	}, 15_000);

	test("uninstalls stale official gateway services when manifest disables them", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".local", "bin", "openclaw");
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlCommand;
		writeFakeSystemctl({ path: systemctlCommand, logPath, resetFailedExitCode: 37 });
		writeFakeGatewayCli({
			path: openclawCommand,
			logPath,
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
		writeFakeGatewayCli({
			path: hermesCommand,
			logPath,
			runtime: "hermes",
			unitPath: join(paths.systemdUserRoot, "hermes-gateway.service"),
		});
		const enabledManifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_uninstall",
			environmentId: "env_uninstall",
			instanceId: "hri_uninstall",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			workspaceRoot: join(paths.userHome, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: runSettings(openclawCommand, ["gateway", "run"]),
					services: {},
				},
				hermes: {
					enabled: true,
					run: runSettings(hermesCommand, ["gateway", "run"]),
					services: {},
				},
			},
			recovery: {},
		};
		const disabledManifest: RuntimeManifest = {
			...enabledManifest,
			generation: 2,
			runtimes: {
				openclaw: { ...enabledManifest.runtimes.openclaw, enabled: false },
				hermes: { ...enabledManifest.runtimes.hermes, enabled: false },
			},
		};

		const enabled = convergeRuntimeManifest(
			{
				manifest: enabledManifest,
				source: "remote-datasource",
				sourcePath: "inline-enabled",
				offline: false,
			},
			paths,
			{ executeOfficialServiceInstallers: true },
		);
		const disabled = convergeRuntimeManifest(
			{
				manifest: disabledManifest,
				source: "remote-datasource",
				sourcePath: "inline-disabled",
				offline: false,
			},
			paths,
			{ executeOfficialServiceInstallers: true },
		);

		expect(enabled.installErrors).toEqual([]);
		expect(disabled.installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
			"systemctl --user daemon-reload",
			"systemctl --user reset-failed hermes-gateway.service",
			"hermes gateway install --force",
			"systemctl --user daemon-reload",
			"systemctl --user reset-failed openclaw-gateway.service",
			"openclaw gateway install --force --json",
			"systemctl --user daemon-reload",
			"hermes gateway uninstall",
			"openclaw gateway uninstall",
		]);
		for (const unit of ["openclaw-gateway", "hermes-gateway"]) {
			expect(existsSync(join(paths.systemdUserRoot, `${unit}.service`))).toBe(false);
			expect(
				existsSync(join(paths.systemdUserRoot, `${unit}.service.d`, "10-clawdi-hosted.conf")),
			).toBe(false);
			expect(existsSync(join(paths.systemdEnvRoot, `${unit}.service.env`))).toBe(false);
		}
		expect(disabled.outputs.systemdUserUnits).toEqual([]);
	});

	test("skips official installers when systemd apply is disabled", () => {
		// Official gateway installers need a live systemd user bus, so a
		// container without systemd (CLAWDI_SYSTEMD_APPLY=0 — headless CI,
		// image smokes) must skip them instead of failing the whole
		// convergence. Drop-ins are still written; the next convergence
		// under real systemd retries the official install.
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".local", "bin", "openclaw");
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		writeFakeGatewayCli({
			path: openclawCommand,
			logPath,
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
		writeFakeGatewayCli({
			path: hermesCommand,
			logPath,
			runtime: "hermes",
			unitPath: join(paths.systemdUserRoot, "hermes-gateway.service"),
		});
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_no_systemd",
			environmentId: "env_no_systemd",
			instanceId: "hri_no_systemd",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			workspaceRoot: join(paths.userHome, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: runSettings(openclawCommand, ["gateway", "run"]),
					services: {},
				},
				hermes: {
					enabled: true,
					run: runSettings(hermesCommand, ["gateway", "run"]),
					services: {},
				},
			},
			recovery: {},
		};

		const result = convergeRuntimeManifest(
			{
				manifest,
				source: "remote-datasource",
				sourcePath: "inline-no-systemd",
				offline: false,
			},
			paths,
		);

		expect(result.installErrors).toEqual([]);
		expect(existsSync(logPath)).toBe(false);
		expect(result.outputs.systemdUserUnits.map((path) => path.split("/").at(-1)).sort()).toEqual([
			"hermes-gateway.service",
			"openclaw-gateway.service",
		]);
		for (const unit of ["openclaw-gateway", "hermes-gateway"]) {
			// No official install ran, so no base unit — only the hosted drop-in.
			expect(existsSync(join(paths.systemdUserRoot, `${unit}.service`))).toBe(false);
			expect(
				existsSync(join(paths.systemdUserRoot, `${unit}.service.d`, "10-clawdi-hosted.conf")),
			).toBe(true);
		}
	});

	test("applies locale config without a systemd user manager when systemd apply is disabled", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "openclaw-config.log");
		const openclawCommand = join(paths.userHome, ".local", "bin", "openclaw");
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		mkdirSync(dirname(openclawCommand), { recursive: true });
		writeFileSync(
			openclawCommand,
			`#!/usr/bin/env bash
set -euo pipefail
test "$*" = "config patch --stdin"
cat > '${logPath}'
`,
		);
		chmodSync(openclawCommand, 0o700);
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_locale_no_systemd",
			environmentId: "env_locale_no_systemd",
			instanceId: "hri_locale_no_systemd",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			workspaceRoot: join(paths.userHome, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			locale: { language: "en", timezone: "UTC" },
			runtimes: {
				openclaw: {
					enabled: true,
					install: {
						authority: "official",
						method: "official-installer",
						url: "https://openclaw.ai/install-cli.sh",
						home: paths.userHome,
						args: [],
					},
					run: runSettings(openclawCommand, ["gateway", "run"]),
					services: {},
				},
			},
			recovery: {},
		};

		const result = convergeRuntimeManifest(
			{
				manifest,
				source: "remote-datasource",
				sourcePath: "inline-locale-no-systemd",
				offline: false,
			},
			paths,
		);

		expect(result.installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(logPath, "utf8"))).toEqual({
			agents: { defaults: { userTimezone: "UTC" } },
			gateway: { mode: "local" },
		});
	});

	test("leaves hosted drop-ins for forward convergence when official install fails", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".local", "bin", "openclaw");
		const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		const dropInPath = join(
			paths.systemdUserRoot,
			"openclaw-gateway.service.d",
			"10-clawdi-hosted.conf",
		);
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlCommand;
		writeFakeSystemctl({ path: systemctlCommand, logPath });
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_install_failure",
			environmentId: "env_install_failure",
			instanceId: "hri_install_failure",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			workspaceRoot: join(paths.userHome, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: runSettings(openclawCommand, ["gateway", "run"]),
					services: {},
				},
			},
			recovery: {},
		};
		const load = (sourcePath: string, generation: number): RuntimeManifestLoad => ({
			manifest: { ...manifest, generation },
			source: "remote-datasource",
			sourcePath,
			offline: false,
		});

		const installerToken = "official-installer-token-must-not-leak";
		process.env.OFFICIAL_INSTALLER_TEST_TOKEN = installerToken;
		mkdirSync(dirname(openclawCommand), { recursive: true });
		writeFileSync(
			openclawCommand,
			`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "gateway install --force --json")
    printf '%s' '{"ok":false,"error":"official stdout marker official-installer-token-must-not-leak","manifest":{"secretValues":{"hidden":"manifest-secret-must-not-leak"}}}'
    printf 'discarded-stderr-prefix' >&2
    printf '%5000s' '' | tr ' ' x >&2
    printf '\\x1b[31mofficial stderr marker\\x1b[0m OFFICIAL_INSTALLER_TEST_TOKEN=%s VISIBLE_ENV=environment-value-must-not-leak Bearer %s https://diagnostic-user:url-password-must-not-leak@example.test/path?token=query-token-must-not-leak\n' "$OFFICIAL_INSTALLER_TEST_TOKEN" "$OFFICIAL_INSTALLER_TEST_TOKEN" >&2
    exit 41
    ;;
  *) exit 64 ;;
esac
`,
		);
		chmodSync(openclawCommand, 0o700);
		let authorityCommits = 0;
		let finalActivations = 0;
		const failedFirstInstall = convergeRuntimeManifest(load("inline-install-failure", 1), paths, {
			executeOfficialServiceInstallers: true,
			commitAuthority: () => {
				authorityCommits += 1;
			},
			systemdApply: {
				quiesce: () => {},
				activateEgressPrerequisite: () => ({
					applied: true,
					systemUnitsChanged: [],
					userUnitsChanged: [],
				}),
				activate: () => {
					finalActivations += 1;
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: () => {},
			},
		});
		const firstInstallError = failedFirstInstall.installErrors.join("\n");
		expect(firstInstallError).toContain("official openclaw-gateway service install failed");
		expect(firstInstallError).toContain("exit code 41");
		expect(firstInstallError).toContain("stdout tail:");
		expect(firstInstallError).toContain("official stdout marker <redacted>");
		expect(firstInstallError).toContain("stderr tail:");
		expect(firstInstallError).toContain("official stderr marker");
		expect(firstInstallError).toContain("OFFICIAL_INSTALLER_TEST_TOKEN=<redacted>");
		expect(firstInstallError).toContain("VISIBLE_ENV=<redacted>");
		expect(firstInstallError).not.toContain(installerToken);
		expect(firstInstallError).not.toContain("manifest-secret-must-not-leak");
		expect(firstInstallError).not.toContain("environment-value-must-not-leak");
		expect(firstInstallError).not.toContain("url-password-must-not-leak");
		expect(firstInstallError).not.toContain("query-token-must-not-leak");
		expect(firstInstallError).not.toContain("discarded-stderr-prefix");
		expect(firstInstallError).not.toContain("\u001b");
		expect(firstInstallError.length).toBeLessThan(5000);
		expect(existsSync(paths.managedConfig)).toBe(false);
		expect(existsSync(manifest.workspaceRoot ?? "")).toBe(false);
		expect(existsSync(dropInPath)).toBe(false);
		expect(authorityCommits).toBe(0);
		expect(finalActivations).toBe(0);
		expect(
			failedFirstInstall.outputs.systemdUserUnits.map((path) => path.split("/").at(-1)),
		).not.toContain("openclaw-gateway.service");

		writeFakeGatewayCli({
			path: openclawCommand,
			logPath,
			runtime: "openclaw",
			unitPath,
		});
		const installed = convergeRuntimeManifest(load("inline-install-recovered", 2), paths, {
			executeOfficialServiceInstallers: true,
		});
		expect(installed.installErrors).toEqual([]);
		expect(existsSync(unitPath)).toBe(true);
		expect(existsSync(dropInPath)).toBe(true);
		const previousManagedConfig = readFileSync(paths.managedConfig, "utf-8");

		writeFakeGatewayCli({
			path: openclawCommand,
			logPath,
			runtime: "openclaw",
			unitPath,
			failInstall: true,
		});
		const failedReinstall = convergeRuntimeManifest(load("inline-reinstall-failure", 3), paths, {
			executeOfficialServiceInstallers: true,
		});
		expect(failedReinstall.installErrors.join("\n")).toContain(
			"official openclaw-gateway service install failed",
		);
		expect(existsSync(unitPath)).toBe(true);
		expect(existsSync(dropInPath)).toBe(true);
		expect(readFileSync(paths.managedConfig, "utf-8")).toBe(previousManagedConfig);
		expect(failedReinstall.outputs.systemdUserUnits).toEqual([]);
	});

	test("commits disabled authority before deferring a failed official uninstall", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".local", "bin", "openclaw");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlCommand;
		writeFakeSystemctl({ path: systemctlCommand, logPath });
		writeFakeGatewayCli({
			path: openclawCommand,
			logPath,
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
			failUninstall: true,
		});
		const enabledManifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_uninstall_failure",
			environmentId: "env_uninstall_failure",
			instanceId: "hri_uninstall_failure",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			workspaceRoot: join(paths.userHome, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: runSettings(openclawCommand, ["gateway", "run"]),
					services: {},
				},
			},
			recovery: {},
		};
		const disabledManifest: RuntimeManifest = {
			...enabledManifest,
			generation: 2,
			runtimes: {
				openclaw: { ...enabledManifest.runtimes.openclaw, enabled: false },
			},
		};

		const enabled = convergeRuntimeManifest(
			{
				manifest: enabledManifest,
				source: "remote-datasource",
				sourcePath: "inline-enabled-failure",
				offline: false,
			},
			paths,
			{ executeOfficialServiceInstallers: true },
		);
		const warnings: string[] = [];
		console.warn = (message?: unknown) => warnings.push(String(message));
		let disabledCommits = 0;
		const disabled = convergeRuntimeManifest(
			{
				manifest: disabledManifest,
				source: "remote-datasource",
				sourcePath: "inline-disabled-failure",
				offline: false,
			},
			paths,
			{
				commitAuthority: () => disabledCommits++,
				executeOfficialServiceInstallers: true,
			},
		);

		expect(enabled.installErrors).toEqual([]);
		expect(disabled.installErrors).toEqual([]);
		expect(disabledCommits).toBe(1);
		expect(JSON.parse(readFileSync(paths.managedConfig, "utf-8"))).toMatchObject({
			generation: 2,
		});
		expect(warnings.join("\n")).toContain("post-commit official runtime service cleanup deferred");
		expect(disabled.outputs.systemdUserUnits).toEqual([]);
		expect(existsSync(join(paths.systemdUserRoot, "openclaw-gateway.service"))).toBe(true);
		expect(
			existsSync(
				join(paths.systemdUserRoot, "openclaw-gateway.service.d", "10-clawdi-hosted.conf"),
			),
		).toBe(false);
		expect(existsSync(join(paths.systemdEnvRoot, "openclaw-gateway.service.env"))).toBe(false);
	});
});
