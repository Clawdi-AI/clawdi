import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convergeRuntimeManifest, type RuntimeManifest } from "./manifest";
import type { RuntimeManifestLoad } from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { type RuntimeRunSettings, runtimeRunConfigPath } from "./run-config";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];

function tempRuntimePaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-manifest-service-test-"));
	tempRoots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	process.env.CLAWDI_HOME = join(root, "clawdi-home");
	process.env.CLAWDI_AUTH_TOKEN = "test-token";
	process.env.CLAWDI_RUNTIME_AUTH_ENV = "CLAWDI_AUTH_TOKEN";
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
	failInstall?: boolean;
	failUninstall?: boolean;
	requiredSystemdState?: {
		dropInPath: string;
		envPath: string;
		snapshotPrefix: string;
	};
}): void {
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
  "gateway install --force --json"|"gateway install --force"|"gateway install")
	${stateCheck}
	printf '%s %s\\n' '${input.runtime}' "$*" >> '${input.logPath}'
	${
		input.failInstall
			? "exit 41"
			: `mkdir -p '${dirname(input.unitPath)}'
    cat > '${input.unitPath}' <<'EOF'
[Unit]
Description=Official gateway

[Service]
ExecStart=official gateway run
EOF`
	}
	;;
  "gateway uninstall")
	printf '%s %s\\n' '${input.runtime}' "$*" >> '${input.logPath}'
	${input.failUninstall ? "exit 42" : `rm -f '${input.unitPath}'`}
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
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime manifest services", () => {
	test("renders systemd runtime services without creating user command shims", () => {
		const paths = tempRuntimePaths();
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
					run: runSettings("openclaw", ["gateway", "run"]),
					services: {},
				},
				hermes: {
					enabled: true,
					run: runSettings("hermes", ["gateway", "run"]),
					services: {
						dashboard: runSettings("hermes", [
							"dashboard",
							"--host",
							"127.0.0.1",
							"--port",
							"9119",
							"--no-open",
						]),
					},
				},
			},
			recovery: {},
		};
		const load: RuntimeManifestLoad = {
			manifest,
			source: "fixture-file",
			sourcePath: "inline-test",
			offline: false,
		};

		const result = convergeRuntimeManifest(load, paths);
		expect(result.installErrors).toEqual([]);
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
		expect(hermesUnit).toContain('ExecStart="hermes" "gateway" "run"');
		const dashboardUnit = readFileSync(
			join(paths.systemdUserRoot, "clawdi-hermes-dashboard.service"),
			"utf8",
		);
		expect(dashboardUnit).toContain(
			'ExecStart="hermes" "dashboard" "--host" "127.0.0.1" "--port" "9119" "--no-open"',
		);
		const openclawUnit = readUserServiceConfig(paths, "openclaw-gateway");
		expect(openclawUnit).toContain('Environment="XDG_RUNTIME_DIR=%t"');
		expect(openclawUnit).toContain('Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"');
		expect(openclawUnit).toContain(
			`EnvironmentFile=${join(paths.systemdEnvRoot, "openclaw-gateway.service.env")}`,
		);
		expect(openclawUnit).toContain(
			`ConditionPathExists=${join(paths.systemdEnvRoot, "openclaw-gateway.service.env")}`,
		);
		expect(openclawUnit).toContain('ExecStart="openclaw" "gateway" "run"');
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
		expect(runtimeWatchUnit).not.toContain("ConditionPathExists=");
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
		expect(existsSync(join(paths.serviceStateRoot, "bin", ".clawdi-runtime-command-shim"))).toBe(
			false,
		);
		expect(existsSync(join(paths.serviceStateRoot, "bin", "hermes+dashboard"))).toBe(false);
	});

	test("renders the Hermes single-runtime gateway, dashboard service, and bridge surface", () => {
		const paths = tempRuntimePaths();
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
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
			runtimes: {
				hermes: {
					enabled: true,
					run: runSettings("hermes", ["gateway", "run", "--replace"]),
					services: {
						dashboard: runSettings("hermes", [
							"dashboard",
							"--host",
							"127.0.0.1",
							"--port",
							"9119",
							"--no-open",
						]),
					},
				},
			},
			bridge: {
				surfaces: [
					{
						name: "hermes",
						kind: "control-ui",
						listenPort: 28793,
						upstreamHost: "127.0.0.1",
						upstreamPort: 9119,
					},
				],
			},
			recovery: {},
		};
		const load: RuntimeManifestLoad = {
			manifest,
			source: "fixture-file",
			sourcePath: "inline-hermes-single",
			offline: false,
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
			"clawdi-runtime-sidecar.service",
			"clawdi-runtime-watch.service",
		]);
		expect(readUserServiceConfig(paths, "hermes-gateway")).toContain(
			'ExecStart="hermes" "gateway" "run" "--replace"',
		);
		const dashboardUnit = readFileSync(
			join(paths.systemdUserRoot, "clawdi-hermes-dashboard.service"),
			"utf8",
		);
		expect(dashboardUnit).toContain(
			'ExecStart="hermes" "dashboard" "--host" "127.0.0.1" "--port" "9119" "--no-open"',
		);
		const sidecarEnv = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-runtime-sidecar.service.env"),
			"utf8",
		);
		expect(sidecarEnv).toContain("CLAWDI_RUNTIME_BRIDGE_SURFACES=");
		expect(sidecarEnv).toContain('\\"name\\":\\"hermes\\"');
		expect(sidecarEnv).toContain('\\"listenPort\\":28793');
		expect(sidecarEnv).not.toContain('\\"name\\":\\"openclaw\\"');
		expect(existsSync(runtimeRunConfigPath("openclaw", paths))).toBe(false);
	});

	test("converges official service state before installers restart units", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "1";
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
			writeFileSync(dropInPath, `[Service]\nEnvironmentFile=${envPath}\n`);
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

		const result = convergeRuntimeManifest(
			{
				manifest,
				source: "fixture-file",
				sourcePath: "inline-installer-order",
				offline: false,
			},
			paths,
		);

		expect(result.installErrors).toEqual([]);
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
			expect(readFileSync(join(paths.runRoot, `${name}-installer-state.env`), "utf8")).toBe(
				readFileSync(join(paths.systemdEnvRoot, `${name}.service.env`), "utf8"),
			);
			expect(readFileSync(join(paths.runRoot, `${name}-installer-state.conf`), "utf8")).toBe(
				readFileSync(
					join(paths.systemdUserRoot, `${name}.service.d`, "10-clawdi-hosted.conf"),
					"utf8",
				),
			);
		}
	});

	test("uninstalls stale official gateway services when manifest disables them", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "1";
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
				source: "fixture-file",
				sourcePath: "inline-enabled",
				offline: false,
			},
			paths,
		);
		const disabled = convergeRuntimeManifest(
			{
				manifest: disabledManifest,
				source: "fixture-file",
				sourcePath: "inline-disabled",
				offline: false,
			},
			paths,
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
		const openclawCommand = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "1";
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
				source: "fixture-file",
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
		const openclawCommand = join(paths.userHome, ".openclaw", "bin", "openclaw");
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
				source: "fixture-file",
				sourcePath: "inline-locale-no-systemd",
				offline: false,
			},
			paths,
		);

		expect(result.installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(logPath, "utf8"))).toEqual({
			agents: { defaults: { userTimezone: "UTC" } },
		});
	});

	test("skips hosted drop-ins when official install fails without a base unit", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		const dropInPath = join(
			paths.systemdUserRoot,
			"openclaw-gateway.service.d",
			"10-clawdi-hosted.conf",
		);
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "1";
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
			source: "fixture-file",
			sourcePath,
			offline: false,
		});

		writeFakeGatewayCli({
			path: openclawCommand,
			logPath,
			runtime: "openclaw",
			unitPath,
			failInstall: true,
		});
		const failedFirstInstall = convergeRuntimeManifest(load("inline-install-failure", 1), paths);
		expect(failedFirstInstall.installErrors.join("\n")).toContain(
			"official openclaw-gateway service install failed",
		);
		expect(existsSync(paths.managedConfig)).toBe(false);
		expect(existsSync(manifest.workspaceRoot ?? "")).toBe(false);
		expect(existsSync(dropInPath)).toBe(false);
		expect(
			failedFirstInstall.outputs.systemdUserUnits.map((path) => path.split("/").at(-1)),
		).not.toContain("openclaw-gateway.service");

		writeFakeGatewayCli({
			path: openclawCommand,
			logPath,
			runtime: "openclaw",
			unitPath,
		});
		const installed = convergeRuntimeManifest(load("inline-install-recovered", 2), paths);
		expect(installed.installErrors).toEqual([]);
		expect(existsSync(unitPath)).toBe(true);
		expect(existsSync(dropInPath)).toBe(true);
		const previousManagedConfig = readFileSync(paths.managedConfig, "utf-8");
		const previousDropIn = readFileSync(dropInPath, "utf-8");

		writeFakeGatewayCli({
			path: openclawCommand,
			logPath,
			runtime: "openclaw",
			unitPath,
			failInstall: true,
		});
		const failedReinstall = convergeRuntimeManifest(load("inline-reinstall-failure", 3), paths);
		expect(failedReinstall.installErrors.join("\n")).toContain(
			"official openclaw-gateway service install failed",
		);
		expect(existsSync(unitPath)).toBe(true);
		expect(existsSync(dropInPath)).toBe(true);
		expect(readFileSync(paths.managedConfig, "utf-8")).toBe(previousManagedConfig);
		expect(readFileSync(dropInPath, "utf-8")).toBe(previousDropIn);
		expect(failedReinstall.outputs.systemdUserUnits).toEqual([]);
	});

	test("keeps stale official gateway drop-ins when official uninstall fails", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "1";
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
				source: "fixture-file",
				sourcePath: "inline-enabled-failure",
				offline: false,
			},
			paths,
		);
		const previousManagedConfig = readFileSync(paths.managedConfig, "utf-8");
		const disabled = convergeRuntimeManifest(
			{
				manifest: disabledManifest,
				source: "fixture-file",
				sourcePath: "inline-disabled-failure",
				offline: false,
			},
			paths,
		);

		expect(enabled.installErrors).toEqual([]);
		expect(disabled.installErrors.join("\n")).toContain(
			"official openclaw-gateway.service uninstall failed",
		);
		expect(readFileSync(paths.managedConfig, "utf-8")).toBe(previousManagedConfig);
		expect(disabled.outputs.systemdUserUnits).toEqual([]);
		expect(existsSync(join(paths.systemdUserRoot, "openclaw-gateway.service"))).toBe(true);
		expect(
			existsSync(
				join(paths.systemdUserRoot, "openclaw-gateway.service.d", "10-clawdi-hosted.conf"),
			),
		).toBe(true);
		expect(existsSync(join(paths.systemdEnvRoot, "openclaw-gateway.service.env"))).toBe(true);
	});
});
