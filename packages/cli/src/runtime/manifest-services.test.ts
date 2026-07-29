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
import { readRuntimeInstallReceipts, writeRuntimeInstallReceipts } from "./install-receipts";
import { convergeRuntimeManifest, type RuntimeManifest } from "./manifest";
import { manifestSecretRefs, type RuntimeManifestLoad } from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { type RuntimeRunSettings, runtimeRunConfigPath } from "./run-config";

const originalEnv = { ...process.env };
const originalConsoleWarn = console.warn;
const tempRoots: string[] = [];

function tempRuntimePaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-manifest-service-test-"));
	chmodSync(root, 0o755);
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
	version?: string;
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
	${
		input.version
			? `"--version")
	printf '%s\\n' '${input.version}'
	;;`
			: ""
	}
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
  *)
    printf 'unexpected ${input.runtime} command: %s\\n' "$*" >&2
    exit 64
    ;;
esac
`,
	);
	chmodSync(input.path, 0o700);
}

function openClawPluginInspectFixture(
	pluginSourcePath: string,
	version = "1.2.3",
): Record<string, unknown> {
	return {
		plugin: {
			id: "discord",
			name: "Discord",
			source: pluginSourcePath,
			origin: "global",
			status: "loaded",
			version,
			enabled: true,
		},
		install: {
			source: "npm",
			spec: "@openclaw/discord",
			installPath: dirname(pluginSourcePath),
			resolvedName: "@openclaw/discord",
			resolvedVersion: version,
			resolvedSpec: `@openclaw/discord@${version}`,
			integrity: "sha512-test",
		},
	};
}

function writeFakeOpenClawPluginCli(input: {
	path: string;
	installLogPath: string;
	inspectStatePath: string;
	pluginSourcePath: string;
	failInstallMarker: string;
	runtimeVersion: string;
	pluginVersion?: string;
}): void {
	mkdirSync(dirname(input.path), { recursive: true });
	writeFileSync(
		input.path,
		`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "--version")
	printf '%s\\n' '${input.runtimeVersion}'
	;;
  "plugins inspect discord --json")
	cat '${input.inspectStatePath}'
	;;
  "plugins install @openclaw/discord")
	printf '%s\\n' '@openclaw/discord' >> '${input.installLogPath}'
	if [ -f '${input.failInstallMarker}' ]; then
		exit 73
	fi
	mkdir -p '${dirname(input.inspectStatePath)}'
	mkdir -p '${dirname(input.pluginSourcePath)}'
	printf '%s\\n' 'export const discordPlugin = true;' > '${input.pluginSourcePath}'
	chmod 0644 '${input.pluginSourcePath}'
	cat > '${input.inspectStatePath}' <<'EOF'
${JSON.stringify(openClawPluginInspectFixture(input.pluginSourcePath, input.pluginVersion))}
EOF
	;;
  "config patch --stdin")
	cat >/dev/null
	;;
  *)
	printf 'unexpected openclaw command: %s\\n' "$*" >&2
	exit 64
	;;
esac
`,
	);
	chmodSync(input.path, 0o700);
}

function openClawDiscordManifest(
	paths: RuntimePaths,
	command: string,
	generation: number,
	tokenRef: string,
): RuntimeManifest {
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_plugin_receipt",
		environmentId: "env_plugin_receipt",
		instanceId: "hri_plugin_receipt",
		generation,
		issuedAt: "2026-07-29T00:00:00.000Z",
		workspaceRoot: join(paths.userHome, "workspace"),
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: {
			openclaw: {
				enabled: true,
				run: runSettings(command, ["gateway", "run"]),
				services: {},
			},
		},
		projection: {
			system: { home: paths.userHome, workspace: join(paths.userHome, "workspace") },
			channels: { discord: { token: tokenRef } },
		},
		recovery: {},
	};
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
	console.warn = originalConsoleWarn;
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime manifest services", () => {
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
			source: "fixture-file",
			sourcePath: "inline-test",
			offline: false,
			secretValues: {
				"secret://runtime/openclaw": "runtime-byok-value",
				"secret://service/hermes-dashboard": "service-byok-value",
			},
		};

		const previousUmask = process.umask(0o077);
		let result: ReturnType<typeof convergeRuntimeManifest>;
		try {
			result = convergeRuntimeManifest(load, paths);
		} finally {
			process.umask(previousUmask);
		}
		expect(result.installErrors).toEqual([]);
		expect(statSync(dirname(paths.systemdEnvRoot)).mode & 0o777).toBe(0o755);
		expect(statSync(paths.systemdEnvRoot).mode & 0o777).toBe(0o755);
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
		const runtimeWatchEnv = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env"),
			"utf8",
		);
		expect(runtimeWatchUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "watch"`);
		expect(runtimeWatchUnit).not.toContain("ConditionPathExists=");
		expect(runtimeWatchEnv).toContain('BYOK_RUNTIME_SECRET="runtime-byok-value"');
		expect(runtimeWatchEnv).toContain('BYOK_SERVICE_SECRET="service-byok-value"');
		expect(runtimeWatchEnv).not.toContain("stale-watcher-value");
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
			expect(env).not.toContain(dirname(paths.cliManagedBin));
		}

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
		process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD = "dashboard-password";
		process.env.HERMES_DASHBOARD_BASIC_AUTH_SECRET = "dashboard-session-secret";
		process.env.RUNTIME_SOURCE_TOKEN = "runtime-source-token";
		process.env.UNRELATED_RUNTIME_SECRET = "must-not-be-exposed";
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
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
				passwordSecretRef: "env://HERMES_DASHBOARD_BASIC_AUTH_PASSWORD",
				sessionSecretRef: "env://HERMES_DASHBOARD_BASIC_AUTH_SECRET",
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
						...runSettings("hermes", ["gateway", "run", "--replace"]),
						secretEnv: {
							RUNTIME_TARGET_TOKEN: "env://RUNTIME_SOURCE_TOKEN",
							RUNTIME_BUNDLE_TOKEN: "secret://runtime/token",
						},
					},
					services: {
						dashboard: runSettings("hermes", [
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
		const load: RuntimeManifestLoad = {
			manifest,
			source: "fixture-file",
			sourcePath: "inline-hermes-single",
			offline: false,
			secretValues: {
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
		expect(readUserServiceConfig(paths, "hermes-gateway")).toContain(
			'ExecStart="hermes" "gateway" "run" "--replace"',
		);
		const dashboardUnit = readFileSync(
			join(paths.systemdUserRoot, "clawdi-hermes-dashboard.service"),
			"utf8",
		);
		expect(dashboardUnit).toContain(
			'ExecStart="hermes" "dashboard" "--host" "0.0.0.0" "--port" "9119" "--no-open"',
		);
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
		const watchEnvPath = join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env");
		const watchEnvStat = statSync(watchEnvPath);
		expect(dashboardEnv).toContain('HERMES_DASHBOARD_BASIC_AUTH_USERNAME="admin"');
		expect(dashboardEnv).toContain('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="dashboard-password"');
		expect(dashboardEnv).toContain('HERMES_DASHBOARD_BASIC_AUTH_SECRET="dashboard-session-secret"');
		expect(dashboardEnv).toContain(
			'HERMES_DASHBOARD_PUBLIC_URL="https://agent.example.test/hermes"',
		);
		expect(gatewayEnv).toContain('RUNTIME_TARGET_TOKEN="runtime-source-token"');
		expect(gatewayEnv).toContain('RUNTIME_BUNDLE_TOKEN="bundle-runtime-token"');
		expect(watchEnv).toContain('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="dashboard-password"');
		expect(watchEnv).toContain('HERMES_DASHBOARD_BASIC_AUTH_SECRET="dashboard-session-secret"');
		expect(watchEnv).toContain('RUNTIME_TARGET_TOKEN="runtime-source-token"');
		expect(watchEnv).toContain('RUNTIME_BUNDLE_TOKEN="bundle-runtime-token"');
		expect(watchEnv).not.toContain("RUNTIME_SOURCE_TOKEN");
		expect(watchEnv).not.toContain("must-not-be-exposed");
		expect(watchEnv).not.toContain("UNRELATED_RUNTIME_SECRET");
		expect(watchEnv).not.toContain("unrelated-inline-secret");
		expect(watchUnit).toContain(`EnvironmentFile=${watchEnvPath}`);
		for (const secret of [
			"dashboard-password",
			"dashboard-session-secret",
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
				const setpriv = spawnSync("setpriv", ["--version"], { encoding: "utf8" });
				if (!setpriv.error && setpriv.status === 0) {
					const nonRootRead = spawnSync(
						"setpriv",
						["--reuid=65534", "--regid=65534", "--clear-groups", "cat", watchEnvPath],
						{ encoding: "utf8" },
					);
					expect(nonRootRead.status).not.toBe(0);
					expect(nonRootRead.stdout).not.toContain("dashboard-password");
				}
			}
		}
		const convergenceDiagnostics = JSON.stringify(result);
		expect(convergenceDiagnostics).not.toContain("dashboard-password");
		expect(convergenceDiagnostics).not.toContain("dashboard-session-secret");
		expect(convergenceDiagnostics).not.toContain("runtime-source-token");
		expect(convergenceDiagnostics).not.toContain("bundle-runtime-token");
		const hermesConfig = readFileSync(join(paths.userHome, ".hermes", "config.yaml"), "utf8");
		expect(hermesConfig).toContain("basic_auth:");
		expect(hermesConfig).toContain("username: admin");
		expect(hermesConfig).toContain("session_ttl_seconds: 43200");
		expect(hermesConfig).toContain("dashboard_auth/nous");
		expect(hermesConfig).toContain("dashboard_auth/self_hosted");
		expect(hermesConfig).not.toContain("dashboard_auth/basic\n");
		expect(hermesConfig).not.toContain("dashboard-password");
		expect(hermesConfig).not.toContain("dashboard-session-secret");
		expect(existsSync(runtimeRunConfigPath("openclaw", paths))).toBe(false);

		// Changing process.env here models platform reinjection before a watcher
		// restart. A running watcher cannot acquire a newly injected or rotated
		// source variable by rewriting its EnvironmentFile.
		process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD = "rotated-dashboard-password";
		process.env.HERMES_DASHBOARD_BASIC_AUTH_SECRET = "rotated-dashboard-session-secret";
		process.env.RUNTIME_SOURCE_TOKEN = "rotated-runtime-source-token";
		const rotated = convergeRuntimeManifest(load, paths);
		expect(rotated.installErrors).toEqual([]);
		const rotatedWatchEnv = readFileSync(watchEnvPath, "utf8");
		const rotatedWatchUnit = readFileSync(watchUnitPath, "utf8");
		expect(rotatedWatchEnv).toContain(
			'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="rotated-dashboard-password"',
		);
		expect(rotatedWatchEnv).toContain(
			'HERMES_DASHBOARD_BASIC_AUTH_SECRET="rotated-dashboard-session-secret"',
		);
		expect(rotatedWatchEnv).toContain('RUNTIME_TARGET_TOKEN="rotated-runtime-source-token"');
		expect(rotatedWatchEnv).toContain('RUNTIME_BUNDLE_TOKEN="bundle-runtime-token"');
		expect(rotatedWatchEnv).not.toContain(
			'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="dashboard-password"',
		);
		expect(rotatedWatchEnv).not.toContain(
			'HERMES_DASHBOARD_BASIC_AUTH_SECRET="dashboard-session-secret"',
		);
		expect(rotatedWatchEnv).not.toContain('RUNTIME_TARGET_TOKEN="runtime-source-token"');
		// Value-only rotation must not alter the public unit or its revision.
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
		process.env.NEXT_RUNTIME_SOURCE_TOKEN = "next-runtime-source-value";
		sourceChangedRun.secretEnv.RUNTIME_TARGET_TOKEN = "env://NEXT_RUNTIME_SOURCE_TOKEN";
		const sourceChanged = convergeRuntimeManifest(
			{ ...load, manifest: sourceChangedManifest },
			paths,
		);
		expect(sourceChanged.installErrors).toEqual([]);
		const sourceChangedWatchEnv = readFileSync(watchEnvPath, "utf8");
		const sourceChangedWatchUnit = readFileSync(watchUnitPath, "utf8");
		expect(sourceChangedWatchEnv).toContain('RUNTIME_TARGET_TOKEN="next-runtime-source-value"');
		expect(sourceChangedWatchEnv).not.toContain("NEXT_RUNTIME_SOURCE_TOKEN");
		// The public unit binds only destination names. Source and value changes
		// stay in the root-only EnvironmentFile instead of creating a verifier.
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
				passwordSecretRef: "env://HERMES_DASHBOARD_BASIC_AUTH_PASSWORD",
				sessionSecretRef: "env://HERMES_DASHBOARD_BASIC_AUTH_SECRET",
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
						secretEnv: { ACTIVE: "env://ACTIVE_RUNTIME_SECRET" },
					},
					services: {
						dashboard: {
							...runSettings("hermes", ["dashboard"]),
							secretEnv: { SERVICE: "env://ACTIVE_SERVICE_SECRET" },
						},
					},
				},
				openclaw: {
					enabled: false,
					run: {
						...runSettings("openclaw", ["gateway", "run"]),
						secretEnv: { DISABLED: "env://DISABLED_RUNTIME_SECRET" },
					},
					services: {},
				},
			},
			projection: {
				providers: {
					selected: {
						baseUrl: "https://provider.example.test/v1",
						managed_by: "user",
						apiKeySecretRef: "env://SELECTED_PROVIDER_SECRET",
					},
					unselected: { apiKeySecretRef: "env://UNSELECTED_PROVIDER_SECRET" },
				},
				tools: { opaqueSecretRef: "env://OPAQUE_PROJECTION_SECRET" },
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
			"env://ACTIVE_RUNTIME_SECRET",
			"env://ACTIVE_SERVICE_SECRET",
			"env://HERMES_DASHBOARD_BASIC_AUTH_PASSWORD",
			"env://HERMES_DASHBOARD_BASIC_AUTH_SECRET",
			"env://SELECTED_PROVIDER_SECRET",
			"secret://active/profile",
		]);

		const inactiveManifest = structuredClone(manifest);
		const inactiveHermes = inactiveManifest.runtimes.hermes;
		if (!inactiveHermes) throw new Error("expected Hermes runtime");
		inactiveHermes.enabled = false;
		expect(manifestSecretRefs(inactiveManifest)).toEqual([]);
	});

	test("fails closed when an enabled consumer's env secret source is missing", () => {
		const paths = tempRuntimePaths();
		delete process.env.RUNTIME_WATCH_REQUIRED_SECRET;
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
							RUNTIME_TARGET_SECRET: "env://RUNTIME_WATCH_REQUIRED_SECRET",
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
					source: "fixture-file",
					sourcePath: "inline-watch-missing-secret",
					offline: false,
					secretValues: {
						"env://RUNTIME_WATCH_REQUIRED_SECRET": "must-not-substitute-bundle-value",
					},
				},
				paths,
			),
		).toThrow(
			"Runtime secret env://RUNTIME_WATCH_REQUIRED_SECRET for RUNTIME_TARGET_SECRET is unavailable.",
		);
		expect(existsSync(join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env"))).toBe(false);
	});

	test("merges watcher secret environments deterministically and fails closed on conflicts", () => {
		const converge = (
			runtimeOrder: Array<"hermes" | "openclaw">,
			secretValues: Record<string, string>,
		) => {
			const paths = tempRuntimePaths();
			process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
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
						source: "fixture-file",
						sourcePath: "inline-conflicting-watch-secrets",
						offline: false,
						secretValues,
					},
					paths,
				),
			};
		};

		const conflictingValues = {
			"secret://runtime/hermes": "hermes-secret",
			"secret://runtime/openclaw": "openclaw-secret",
		};
		const forward = converge(["hermes", "openclaw"], conflictingValues).result;
		const reverse = converge(["openclaw", "hermes"], conflictingValues).result;
		const expectedError =
			"runtime apply failed: Runtime watch secret environment SHARED_RUNTIME_SECRET conflicts between hermes-gateway and openclaw-gateway.";

		expect(forward.installErrors).toEqual([expectedError]);
		expect(reverse.installErrors).toEqual([expectedError]);
		expect(forward.outputs.systemdSystemUnits).toEqual([]);
		expect(reverse.outputs.systemdSystemUnits).toEqual([]);
		expect(expectedError).not.toContain("hermes-secret");
		expect(expectedError).not.toContain("openclaw-secret");

		const deduplicated = converge(["openclaw", "hermes"], {
			"secret://runtime/hermes": "shared-secret",
			"secret://runtime/openclaw": "shared-secret",
		});
		expect(deduplicated.result.installErrors).toEqual([]);
		const watchEnv = readFileSync(
			join(deduplicated.paths.systemdEnvRoot, "clawdi-runtime-watch.service.env"),
			"utf8",
		);
		expect(watchEnv.match(/^SHARED_RUNTIME_SECRET="shared-secret"$/gm)).toHaveLength(1);
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

	test("gates official service installs on installer contract and current base service identity", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-receipt.log");
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const unitPath = join(paths.systemdUserRoot, "hermes-gateway.service");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlCommand;
		writeFakeSystemctl({ path: systemctlCommand, logPath });
		writeFakeGatewayCli({
			path: hermesCommand,
			logPath,
			runtime: "hermes",
			unitPath,
			version: "Hermes Agent v0.18.0",
		});
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_service_receipt",
			environmentId: "env_service_receipt",
			instanceId: "hri_service_receipt",
			generation: 1,
			issuedAt: "2026-07-29T00:00:00.000Z",
			workspaceRoot: join(paths.userHome, "workspace"),
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				hermes: {
					enabled: true,
					providerMode: "configured",
					provider_ids: ["provider-a"],
					primary_model: { provider_id: "provider-a", model: "model-a" },
					run: {
						...runSettings(hermesCommand, ["gateway", "run"]),
						secretEnv: { HERMES_RUNTIME_SECRET: "secret://runtime/hermes-a" },
					},
					services: {},
				},
			},
			projection: {
				providers: {
					"provider-a": {
						kind: "openai-compatible",
						baseUrl: "https://provider-a.example.test/v1",
						model: "model-a",
						models: [{ id: "model-a" }],
						apiMode: "openai_chat_completions",
						managed_by: "user",
						runtimeEnvName: "OPENAI_API_KEY",
						apiKeySecretRef: "secret://provider/a",
					},
				},
			},
			recovery: {},
		};
		const converge = (desired: RuntimeManifest, secretValues: Record<string, string>) =>
			convergeRuntimeManifest(
				{
					manifest: desired,
					source: "fixture-file",
					sourcePath: "inline-service-receipt",
					offline: false,
					secretValues,
				},
				paths,
			);
		const initialSecrets = {
			"secret://runtime/hermes-a": "runtime-secret-a",
			"secret://provider/a": "provider-secret-a",
		};

		expect(converge(manifest, initialSecrets).installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8").match(/hermes gateway install --force/g)).toHaveLength(1);
		expect(
			statSync(join(paths.serviceStateRoot, "status", "runtime-install-receipts.json")).mode &
				0o777,
		).toBe(0o600);

		writeFileSync(logPath, "");
		expect(converge(manifest, initialSecrets).installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8")).toBe("");
		const receiptPath = join(paths.serviceStateRoot, "status", "runtime-install-receipts.json");
		chmodSync(receiptPath, 0o644);
		expect(converge(manifest, initialSecrets).installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8")).toContain("hermes gateway install --force");
		expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
		writeFileSync(logPath, "");

		const rotatedSecrets = {
			"secret://runtime/hermes-a": "runtime-secret-rotated",
			"secret://provider/a": "provider-secret-rotated",
		};
		expect(converge(manifest, rotatedSecrets).installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8")).toBe("");

		const changedRuntimeMaterial = structuredClone(manifest);
		changedRuntimeMaterial.generation = 2;
		changedRuntimeMaterial.runtimes.hermes = {
			...changedRuntimeMaterial.runtimes.hermes,
			run: {
				...runSettings(hermesCommand, ["gateway", "run", "--replace"]),
				secretEnv: { HERMES_RUNTIME_SECRET: "secret://runtime/hermes-b" },
			},
		};
		changedRuntimeMaterial.projection = {
			providers: {
				"provider-a": {
					kind: "openai-compatible",
					baseUrl: "https://provider-b.example.test/v1",
					model: "model-b",
					models: [{ id: "model-b" }],
					apiMode: "openai_responses",
					managed_by: "user",
					runtimeEnvName: "OPENAI_API_KEY",
					apiKeySecretRef: "secret://provider/b",
				},
			},
		};
		const changedSecrets = {
			"secret://runtime/hermes-b": "runtime-secret-b",
			"secret://provider/b": "provider-secret-b",
		};
		expect(converge(changedRuntimeMaterial, changedSecrets).installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8")).toBe("");

		chmodSync(unitPath, 0o600);
		expect(converge(changedRuntimeMaterial, changedSecrets).installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8")).toContain("hermes gateway install --force");
		expect(statSync(unitPath).mode & 0o777).toBe(0o644);

		writeFileSync(logPath, "");
		writeFakeGatewayCli({
			path: hermesCommand,
			logPath,
			runtime: "hermes",
			unitPath,
			version: "Hermes Agent v0.19.0",
		});
		expect(converge(changedRuntimeMaterial, changedSecrets).installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8")).toContain("hermes gateway install --force");

		const receipts = readRuntimeInstallReceipts(paths);
		if (!receipts) throw new Error("expected official service install receipt");
		receipts.officialServices["hermes-gateway.service"] = {
			...receipts.officialServices["hermes-gateway.service"],
			desiredRevision: "0".repeat(64),
		};
		writeRuntimeInstallReceipts(receipts, paths);
		writeFileSync(logPath, "");
		expect(converge(changedRuntimeMaterial, changedSecrets).installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8")).toContain("hermes gateway install --force");

		const receiptBeforeFailure = readRuntimeInstallReceipts(paths);
		writeFakeGatewayCli({
			path: hermesCommand,
			logPath,
			runtime: "hermes",
			unitPath,
			version: "Hermes Agent v0.20.0",
			failInstall: true,
		});
		writeFileSync(logPath, "");
		const failed = converge(changedRuntimeMaterial, changedSecrets);
		expect(failed.installErrors.join("\n")).toContain(
			"official hermes-gateway service install failed",
		);
		expect(readRuntimeInstallReceipts(paths)).toEqual(receiptBeforeFailure);

		writeFakeGatewayCli({
			path: hermesCommand,
			logPath,
			runtime: "hermes",
			unitPath,
			version: "Hermes Agent v0.20.0",
		});
		writeFileSync(logPath, "");
		expect(converge(changedRuntimeMaterial, changedSecrets).installErrors).toEqual([]);
		expect(readFileSync(logPath, "utf8")).toContain("hermes gateway install --force");
	});

	test("gates OpenClaw channel plugin installs on plugin contract and inspected current identity", () => {
		const paths = tempRuntimePaths();
		const command = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const installLogPath = join(paths.runRoot, "plugin-installs.log");
		const inspectStatePath = join(paths.runRoot, "plugin-inspect.json");
		const pluginSourcePath = join(paths.userHome, ".openclaw", "extensions", "discord", "index.js");
		const failInstallMarker = join(paths.runRoot, "fail-plugin-install");
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		writeFakeOpenClawPluginCli({
			path: command,
			installLogPath,
			inspectStatePath,
			pluginSourcePath,
			failInstallMarker,
			runtimeVersion: "OpenClaw 2026.7.29",
		});
		const converge = (manifest: RuntimeManifest) =>
			convergeRuntimeManifest(
				{
					manifest,
					source: "fixture-file",
					sourcePath: "inline-plugin-receipt",
					offline: false,
					secretValues: {},
				},
				paths,
			);
		const initial = openClawDiscordManifest(
			paths,
			command,
			1,
			"secret://channels/discord/account-a",
		);

		expect(converge(initial).installErrors).toEqual([]);
		expect(readFileSync(installLogPath, "utf8").trim().split("\n")).toEqual(["@openclaw/discord"]);
		expect(converge(initial).installErrors).toEqual([]);
		expect(readFileSync(installLogPath, "utf8").trim().split("\n")).toHaveLength(1);

		const accountChanged = openClawDiscordManifest(
			paths,
			command,
			2,
			"secret://channels/discord/account-b",
		);
		expect(converge(accountChanged).installErrors).toEqual([]);
		expect(readFileSync(installLogPath, "utf8").trim().split("\n")).toHaveLength(1);

		writeFileSync(pluginSourcePath, "export const discordPlugin = false;\n");
		expect(converge(accountChanged).installErrors).toEqual([]);
		expect(readFileSync(installLogPath, "utf8").trim().split("\n")).toHaveLength(2);

		writeFileSync(
			inspectStatePath,
			JSON.stringify(openClawPluginInspectFixture(pluginSourcePath, "9.9.9")),
		);
		expect(converge(accountChanged).installErrors).toEqual([]);
		expect(readFileSync(installLogPath, "utf8").trim().split("\n")).toHaveLength(3);

		const installRecordDrift = openClawPluginInspectFixture(pluginSourcePath);
		const installRecord = installRecordDrift.install;
		if (typeof installRecord !== "object" || installRecord === null) {
			throw new Error("expected plugin install fixture");
		}
		installRecordDrift.install = { ...installRecord, spec: "@openclaw/other" };
		writeFileSync(inspectStatePath, JSON.stringify(installRecordDrift));
		expect(converge(accountChanged).installErrors).toEqual([]);
		expect(readFileSync(installLogPath, "utf8").trim().split("\n")).toHaveLength(4);

		const receipts = readRuntimeInstallReceipts(paths);
		if (!receipts) throw new Error("expected channel plugin install receipt");
		receipts.channelPlugins["openclaw:discord"] = {
			...receipts.channelPlugins["openclaw:discord"],
			desiredRevision: "0".repeat(64),
		};
		writeRuntimeInstallReceipts(receipts, paths);
		expect(converge(accountChanged).installErrors).toEqual([]);
		expect(readFileSync(installLogPath, "utf8").trim().split("\n")).toHaveLength(5);

		writeFakeOpenClawPluginCli({
			path: command,
			installLogPath,
			inspectStatePath,
			pluginSourcePath,
			failInstallMarker,
			runtimeVersion: "OpenClaw 2026.7.30",
		});
		expect(converge(accountChanged).installErrors).toEqual([]);
		expect(readFileSync(installLogPath, "utf8").trim().split("\n")).toHaveLength(6);
	});

	test("fails closed on unsupported plugin inspection without blessing a failed install", () => {
		const paths = tempRuntimePaths();
		const command = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const installLogPath = join(paths.runRoot, "plugin-installs.log");
		const inspectStatePath = join(paths.runRoot, "plugin-inspect.json");
		const pluginSourcePath = join(paths.userHome, ".openclaw", "extensions", "discord", "index.js");
		const failInstallMarker = join(paths.runRoot, "fail-plugin-install");
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		writeFakeOpenClawPluginCli({
			path: command,
			installLogPath,
			inspectStatePath,
			pluginSourcePath,
			failInstallMarker,
			runtimeVersion: "OpenClaw 2026.7.29",
		});
		const manifest = openClawDiscordManifest(
			paths,
			command,
			1,
			"secret://channels/discord/account-a",
		);
		const converge = () =>
			convergeRuntimeManifest(
				{
					manifest,
					source: "fixture-file",
					sourcePath: "inline-plugin-fail-closed",
					offline: false,
					secretValues: {},
				},
				paths,
			);

		expect(converge().installErrors).toEqual([]);
		const receiptBeforeFailure = readRuntimeInstallReceipts(paths);
		writeFileSync(
			inspectStatePath,
			JSON.stringify({
				plugin: {
					id: "discord",
					source: pluginSourcePath,
					origin: "global",
					status: "loaded",
					version: "1.2.3",
				},
				install: { source: "npm", spec: "@openclaw/discord", version: "1.2.3" },
			}),
		);
		writeFileSync(failInstallMarker, "fail\n");
		const failed = converge();
		expect(failed.installErrors.join("\n")).toContain(
			"runtime openclaw channel plugin install failed",
		);
		expect(readRuntimeInstallReceipts(paths)).toEqual(receiptBeforeFailure);

		rmSync(failInstallMarker);
		expect(converge().installErrors).toEqual([]);
		expect(readFileSync(installLogPath, "utf8").trim().split("\n")).toHaveLength(3);
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
