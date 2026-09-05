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
import { commitRuntimeAppliedState } from "../commands/runtime";
import { ensureTestOpenClawWorkspaceCli } from "../test-support/runtime-workspace";
import {
	convergeRuntimeManifest as convergeRuntimeManifestWithContext,
	type RuntimeConvergenceOptions,
	type RuntimeManifest,
} from "./manifest";
import { OFFICIAL_INSTALL_URLS, officialInstallArgs } from "./manifest-contract";
import {
	observeRuntimeInstall,
	runtimeCommandCurrentRevision,
	writeRuntimeInstallerLog,
} from "./manifest-install";
import { manifestSecretRefs, type RuntimeManifestLoad } from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { type RuntimeRunSettings, runtimeRunConfigPath } from "./run-config";
import {
	HERMES_DASHBOARD_BUILD_REVISION_FILE,
	planOfficialRuntimeServices,
	prepareOfficialRuntimeServiceDependencies,
	type RuntimeSystemdUserProgram,
} from "./runtime-systemd-reconciliation";
import { ensureRuntimeStateDirs } from "./state";
import { RUNTIME_SYSTEMD_DROP_IN_FILE } from "./systemd";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

const originalEnv = { ...process.env };
const originalConsoleWarn = console.warn;
const tempRoots: string[] = [];
const TEST_PROCESS_UID = process.getuid?.() ?? 1_000;
const TEST_PROCESS_GID = process.getgid?.() ?? 1_000;
const TEST_RUNTIME_USER = String(TEST_PROCESS_UID);
const HERMES_CONFIG_CLI_MOCK = fileURLToPath(
	new URL("../test-support/hermes-config-cli-mock.ts", import.meta.url),
);

test("reuses a runtime version until its executable revision changes", () => {
	const paths = tempRuntimePaths();
	mkdirSync(paths.runRoot, { recursive: true });
	mkdirSync(paths.userHome, { recursive: true });
	const command = join(paths.runRoot, "versioned-runtime");
	const log = join(paths.runRoot, "version-probes.log");
	const writeCommand = (version: string) => {
		writeFileSync(
			command,
			`#!/bin/sh
printf '%s\n' "$*" >> '${log}'
printf '%s\n' '${version}'
`,
			{ mode: 0o755 },
		);
	};
	writeCommand("runtime 1.0.0");

	const first = runtimeCommandCurrentRevision(command, paths.userHome, paths.userHome);
	expect(runtimeCommandCurrentRevision(command, paths.userHome, paths.userHome)).toBe(first);
	expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["--version"]);

	writeCommand("runtime 1.0.1");
	const revised = runtimeCommandCurrentRevision(command, paths.userHome, paths.userHome);
	expect(revised).not.toBe(first);
	expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["--version", "--version"]);
});

test("adopts a persisted native Hermes service in a fresh process without reinstalling", () => {
	const paths = tempRuntimePaths();
	const command = join(paths.userHome, ".local", "bin", "hermes");
	const unitPath = join(paths.systemdUserRoot, "hermes-gateway.service");
	writeFakeGatewayCli({
		path: command,
		logPath: join(paths.runRoot, "commands.log"),
		runtime: "hermes",
		unitPath,
	});
	mkdirSync(dirname(unitPath), { recursive: true });
	writeFileSync(unitPath, "[Service]\nExecStart=hermes gateway run\n");
	const program: RuntimeSystemdUserProgram = {
		programKind: "runtime",
		runtime: "hermes",
		service: null,
		command,
		args: ["gateway", "run"],
		cwd: paths.userHome,
		env: {},
		resolvedSecretEnv: {},
	};
	const adopted = planOfficialRuntimeServices([program], paths, true);
	expect(adopted.pending).toEqual([]);
	const modulePath = fileURLToPath(new URL("./runtime-systemd-reconciliation.ts", import.meta.url));
	const child = spawnSync(
		process.execPath,
		[
			"--eval",
			`import { planOfficialRuntimeServices } from ${JSON.stringify(modulePath)};
const { program, paths } = JSON.parse(process.argv[1]);
console.log(JSON.stringify(planOfficialRuntimeServices([program], paths, true)));`,
			JSON.stringify({ program, paths }),
		],
		{ encoding: "utf8", timeout: 15_000 },
	);
	expect(child.status).toBe(0);
	expect(child.stderr).toBe("");
	expect(JSON.parse(child.stdout)).toEqual(adopted);
});

test("rechecks Hermes dashboard dependencies even when its launcher has not changed", () => {
	const paths = tempRuntimePaths();
	mkdirSync(paths.runRoot, { recursive: true });
	const command = join(paths.userHome, ".local", "bin", "hermes");
	const python = join(paths.userHome, ".hermes", "hermes-agent", "venv", "bin", "python");
	const log = join(paths.runRoot, "dashboard-capability.log");
	const dependencyError = join(paths.runRoot, "dependency-error");
	for (const executable of [command, python]) {
		mkdirSync(dirname(executable), { recursive: true });
		writeFileSync(
			executable,
			`#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ -f '${dependencyError}' ]; then
  printf '%s\\n' 'dependency unavailable' >&2
  exit 1
fi
`,
			{
				mode: 0o755,
			},
		);
	}
	const runtime: RuntimeManifest["runtimes"][string] = {
		enabled: true,
		install: {
			authority: "official",
			method: "official-installer",
			url: OFFICIAL_INSTALL_URLS.hermes,
			home: paths.userHome,
			args: officialInstallArgs("hermes", paths.userHome),
		},
		services: { dashboard: runSettings(command, ["dashboard"]) },
	};
	const observe = () =>
		observeRuntimeInstall("hermes", runtime, paths.userHome, paths, {
			uid: TEST_PROCESS_UID,
			gid: TEST_PROCESS_GID,
		});

	expect(observe().error).toBeNull();
	writeFileSync(dependencyError, "dependency changed without replacing Python\n");
	expect(observe().error).toContain("dependency unavailable");
});

test("reuses a Hermes dashboard build until its runtime revision changes", () => {
	const paths = tempRuntimePaths();
	process.env.CLAWDI_RUNTIME_USER = "root";
	const appRoot = join(paths.userHome, ".hermes", "hermes-agent");
	const command = join(paths.userHome, ".local", "bin", "hermes");
	const bin = join(paths.runRoot, "bin");
	const npm = join(bin, "npm");
	const log = join(paths.runRoot, "npm.log");
	const writeCommand = (version: string) => {
		mkdirSync(dirname(command), { recursive: true });
		writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
	};
	mkdirSync(join(appRoot, "web"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		npm,
		`#!/bin/sh
set -eu
printf '%s\n' "$*" >> '${log}'
if [ "$*" = 'run build' ]; then
  mkdir -p ../hermes_cli/web_dist
  printf '%s\n' '<html>dashboard</html>' > ../hermes_cli/web_dist/index.html
fi
`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
	writeCommand("Hermes Agent v1");

	const gateway: RuntimeSystemdUserProgram = {
		programKind: "runtime",
		runtime: "hermes",
		service: null,
		command,
		args: ["gateway", "run"],
		cwd: paths.userHome,
		env: {},
		resolvedSecretEnv: {},
	};
	const dashboard: RuntimeSystemdUserProgram = {
		...gateway,
		service: "dashboard",
		args: ["dashboard", "--skip-build"],
	};
	const plan = {
		pending: [{ unitName: "hermes-gateway.service", program: gateway, serviceRevision: null }],
		serviceRevisions: {},
	};
	const prepare = () =>
		prepareOfficialRuntimeServiceDependencies([gateway, dashboard], plan, paths);

	expect(prepare()).toBeNull();
	expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
		"ci --include=dev --workspace web",
		"run build",
	]);
	const revisionFile = join(
		appRoot,
		"hermes_cli",
		"web_dist",
		HERMES_DASHBOARD_BUILD_REVISION_FILE,
	);
	const commandRevision = runtimeCommandCurrentRevision(command, paths.userHome, paths.userHome);
	if (!commandRevision) throw new Error("Hermes command revision is missing");
	expect(readFileSync(revisionFile, "utf8").trim()).toBe(commandRevision);

	expect(prepare()).toBeNull();
	expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);

	writeCommand("Hermes Agent v2");
	expect(prepare()).toBeNull();
	expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(4);
});

function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: RuntimeConvergenceOptions = {},
) {
	ensureTestOpenClawWorkspaceCli(load.manifest, paths);
	ensureRuntimeStateDirs(paths);
	const openclaw = load.manifest.runtimes.openclaw;
	const hostedLoad: RuntimeManifestLoad = openclaw
		? {
				...load,
				manifest: {
					...load.manifest,
					openclawGatewayAuth: load.manifest.openclawGatewayAuth ?? {
						mode: "token",
						tokenRef: "secret://runtime/openclaw/gateway-token",
						deviceAuthRequired: false,
						activation: { enabled: true, capability: "openclaw-native-auth-v1" },
					},
					runtimes: {
						...load.manifest.runtimes,
						openclaw: {
							...openclaw,
							run: openclaw.run
								? {
										...openclaw.run,
										secretEnv: {
											OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
											...openclaw.run.secretEnv,
										},
									}
								: undefined,
						},
					},
				},
				secretValues: {
					"secret://runtime/openclaw/gateway-token": "test-gateway-token",
					...load.secretValues,
				},
			}
		: load;
	return convergeRuntimeManifestWithContext(
		{
			...hostedLoad,
			applyContext: hostedLoad.applyContext ?? {
				kind: "context-file",
				backend: "incus",
				identity: {
					generation: hostedLoad.manifest.applyGeneration ?? hostedLoad.manifest.generation,
					manifestETag: `"test-${hostedLoad.manifest.generation}"`,
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
			systemdApply: opts.systemdApply,
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

function readSystemdEnvironment(paths: RuntimePaths, name: string): Record<string, string> {
	const content = readFileSync(join(paths.systemdEnvRoot, `${name}.service.env`), "utf8");
	return Object.fromEntries(
		content
			.split(/\r?\n/)
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => {
				const separator = line.indexOf("=");
				return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as string];
			}),
	);
}

function writeFakeGatewayCli(input: {
	path: string;
	logPath: string;
	runtime: "openclaw" | "hermes";
	unitPath: string;
	version?: string;
	hangVersion?: boolean;
	failVersion?: boolean;
	failInstall?: boolean;
	failUninstall?: boolean;
	requiredSystemdState?: {
		dropInPath: string;
		envPath: string;
		snapshotPrefix: string;
	};
	forbiddenDropInPath?: string;
}): void {
	const version =
		input.version ?? (input.runtime === "hermes" ? "Hermes Agent v0.18.0" : "OpenClaw 2026.7.29");
	const home = dirname(dirname(dirname(input.path)));
	const stateCheck = input.requiredSystemdState
		? `test -f '${input.requiredSystemdState.envPath}'
    test -f '${input.requiredSystemdState.dropInPath}'
    grep -Fx 'ConditionPathExists=${input.requiredSystemdState.envPath}' '${input.requiredSystemdState.dropInPath}' >/dev/null
    cp '${input.requiredSystemdState.envPath}' '${input.requiredSystemdState.snapshotPrefix}.env'
    cp '${input.requiredSystemdState.dropInPath}' '${input.requiredSystemdState.snapshotPrefix}.conf'
    printf '%s systemd state ready\\n' '${input.runtime}' >> '${input.logPath}'`
		: input.forbiddenDropInPath
			? `test ! -e '${input.forbiddenDropInPath}'
    printf '%s drop-in absent\n' '${input.runtime}' >> '${input.logPath}'`
			: "";
	mkdirSync(dirname(input.path), { recursive: true });
	writeFileSync(
		input.path,
		`#!/usr/bin/env bash
	set -euo pipefail
	case "$*" in
	  "--version")
		${input.hangVersion ? "exec sleep 60" : input.failVersion ? "exit 1" : `printf '%s\\n' '${version}'`}
		;;
  "gateway install --force --json"|"gateway install --force --no-start-now"|"gateway install")
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
    HOME='${home}' exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
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
						system: {
							home: paths.userHome,
							workspace: join(paths.userHome, "workspace"),
						},
					},
				}
			: {}),
		recovery: {},
	};
}

interface InstallGateHarness {
	converge: (commitAuthority?: () => void) => ReturnType<typeof convergeRuntimeManifest>;
	drift: () => void;
	revise: () => void;
	failNextInstall: () => void;
	restoreInstaller: () => void;
	installCount: () => number;
}

interface OfficialServiceInstallHarness extends InstallGateHarness {
	addForeignDropIn: () => string;
	driftMetadata: () => void;
	hangVersionProbe: () => void;
	failVersionProbe: () => void;
	managedDropIn: () => string;
	removeUnit: () => void;
	unitContents: () => string;
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
	const load: RuntimeManifestLoad = {
		manifest,
		source: "remote-datasource",
		sourcePath: "inline-service-receipt",
		offline: false,
	};
	const converge = (afterCommit?: () => void) =>
		convergeRuntimeManifest(load, paths, {
			commitAuthority: (convergence, authority) => {
				commitRuntimeAppliedState({
					load,
					paths,
					etag: '"official-service-test"',
					sourceRevision: "a".repeat(64),
					convergence,
					applyIdentity: null,
					officialServiceCommandRevisions: authority.officialServiceCommandRevisions,
				});
				afterCommit?.();
			},
			executeOfficialServiceInstallers: true,
		});
	converge();
	const appliedStateWithoutRevision = JSON.parse(
		readFileSync(paths.appliedState, "utf8"),
	) as Record<string, unknown>;
	delete appliedStateWithoutRevision.officialServiceCommandRevisions;
	writeFileSync(paths.appliedState, `${JSON.stringify(appliedStateWithoutRevision)}\n`);
	return {
		converge,
		drift: () => writeFileSync(unitPath, `${readFileSync(unitPath, "utf8")}# upstream drift\n`),
		revise: () =>
			writeCli(false, runtime === "hermes" ? "Hermes Agent v0.18.1" : "OpenClaw 2026.7.30"),
		failNextInstall: () => writeCli(true),
		restoreInstaller: () => writeCli(),
		installCount: () =>
			readFileSync(logPath, "utf8").match(new RegExp(`${runtime} gateway install`, "g"))?.length ??
			0,
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
		driftMetadata: () => chmodSync(unitPath, 0o600),
		hangVersionProbe: () =>
			writeFakeGatewayCli({ path: command, logPath, runtime, unitPath, hangVersion: true }),
		failVersionProbe: () =>
			writeFakeGatewayCli({ path: command, logPath, runtime, unitPath, failVersion: true }),
		managedDropIn: () =>
			readFileSync(
				join(paths.systemdUserRoot, `${runtime}-gateway.service.d`, RUNTIME_SYSTEMD_DROP_IN_FILE),
				"utf8",
			),
		removeUnit: () => rmSync(unitPath),
		unitContents: () => readFileSync(unitPath, "utf8"),
	};
}

const installGateHarnesses = [
	["OpenClaw official service", () => officialServiceHarness("openclaw")],
] as const;

function writeFakeSystemctl(input: { path: string; logPath: string; exitCode?: number }): void {
	mkdirSync(dirname(input.path), { recursive: true });
	writeFileSync(
		input.path,
		`#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> '${input.logPath}'
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
	test("enables invalid-config repair for the hosted workspace probe", () => {
		const paths = tempRuntimePaths();
		const command = join(paths.userHome, ".local", "bin", "openclaw");
		const commandLog = join(paths.userHome, "workspace-probe.log");
		mkdirSync(dirname(command), { recursive: true });
		writeFileSync(
			command,
			`#!/bin/sh
printf '%s\n' "$*" >> '${commandLog}'
case "$*" in
  "--version") printf '%s\n' 'OpenClaw test-version' ;;
  "agents list --json") exit 2 ;;
  "config validate --json")
    printf '%s\n' '{"valid":false,"path":"/tmp/openclaw.json","issues":[{"path":"x","message":"x"}]}'
    exit 1
    ;;
  "doctor --fix --non-interactive") exit 0 ;;
  *) exit 64 ;;
esac
`,
		);
		chmodSync(command, 0o700);
		const manifest = installGateManifest(paths, "openclaw", command);

		expect(() =>
			convergeRuntimeManifest(
				{
					manifest,
					source: "remote-datasource",
					sourcePath: "inline-workspace-repair-gate",
					offline: false,
				},
				paths,
			),
		).toThrow("OpenClaw official agent workspace roster is unavailable");
		const commands = readFileSync(commandLog, "utf8").trim().split("\n");
		expect(commands).toContain("config validate --json");
	});

	test("repairs managed OpenClaw channel config drift", () => {
		const paths = tempRuntimePaths();
		const command = join(paths.userHome, ".local", "bin", "openclaw");
		const configPath = join(paths.userHome, ".openclaw", "openclaw.json");
		const patchPath = join(paths.runRoot, "openclaw-config-patch.json");
		const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
		mkdirSync(dirname(command), { recursive: true });
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, "{}\n");
		writeFileSync(
			command,
			`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "--version") printf '%s\n' 'OpenClaw 2026.7.29' ;;
  "config patch --stdin"*)
    cat > '${patchPath}'
    '${process.execPath}' - '${configPath}' '${patchPath}' <<'NODE'
const fs = require("node:fs");
const [configPath, patchPath] = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const merge = (currentValue, patchValue) => {
  if (!isRecord(patchValue)) return patchValue;
  const next = isRecord(currentValue) ? { ...currentValue } : {};
  for (const [key, value] of Object.entries(patchValue)) {
    if (value === null) delete next[key];
    else next[key] = merge(next[key], value);
  }
  return next;
};
fs.writeFileSync(configPath, JSON.stringify(merge(current, patch)) + "\\n");
NODE
    ;;
  "gateway install --force --json"|"gateway install --force --no-start-now"|"gateway install")
    mkdir -p '${dirname(unitPath)}'
    printf '%s\n' '[Service]' 'ExecStart=openclaw gateway run' > '${unitPath}'
    ;;
  *) exit 0 ;;
esac
`,
		);
		chmodSync(command, 0o700);
		const manifest = installGateManifest(paths, "openclaw", command);
		manifest.projection = { channels: { telegram: { enabled: true } } };
		const load: RuntimeManifestLoad = {
			manifest,
			source: "remote-datasource",
			sourcePath: "inline-openclaw-channel-drift",
			offline: false,
		};
		const converge = () =>
			convergeRuntimeManifest(load, paths, {
				commitAuthority: (convergence, authority) =>
					commitRuntimeAppliedState({
						load,
						paths,
						etag: '"openclaw-channel-drift"',
						sourceRevision: "a".repeat(64),
						convergence,
						applyIdentity: null,
						activated: authority.activated,
						officialServiceCommandRevisions: authority.officialServiceCommandRevisions,
					}),
				systemdApply: {
					activateEgressPrerequisite: () => ({
						applied: true,
						systemUnitsChanged: [],
						userUnitsChanged: [],
					}),
					activate: () => ({ applied: true, systemUnitsChanged: [], userUnitsChanged: [] }),
				},
			});

		expect(converge().installErrors).toEqual([]);
		expect(converge().installErrors).toEqual([]);
		const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		delete config.channels;
		writeFileSync(configPath, `${JSON.stringify(config)}\n`);

		expect(converge().installErrors).toEqual([]);

		manifest.projection = { channels: {} };
		writeFileSync(configPath, "{}\n");
		expect(converge().installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			gateway: {
				mode: "local",
				port: 18789,
				bind: "lan",
				auth: { mode: "token", token: "test-gateway-token" },
			},
		});
	});

	test("renders systemd runtime services without creating user command shims", () => {
		const paths = tempRuntimePaths();
		process.env.PATH = `${dirname(paths.cliManagedBin)}:${process.env.PATH ?? ""}`;
		process.env.BYOK_RUNTIME_SECRET = "stale-watcher-value";
		const runtimeCommandRoot = join(paths.userHome, ".upstream", "bin");
		const fakeCommandLog = join(paths.runRoot, "runtime-command.log");
		for (const runtime of ["hermes", "openclaw"] as const) {
			writeFakeGatewayCli({
				path: join(runtimeCommandRoot, runtime),
				logPath: fakeCommandLog,
				runtime,
				unitPath: join(paths.systemdUserRoot, `${runtime}-gateway.service`),
			});
		}
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
						...runSettings(join(runtimeCommandRoot, "openclaw"), ["gateway", "run"]),
						env: { NON_SECRET_RUNTIME_SETTING: "public-value" },
						secretEnv: { BYOK_RUNTIME_SECRET: "secret://runtime/openclaw" },
					},
					services: {},
				},
				hermes: {
					enabled: true,
					run: runSettings(join(runtimeCommandRoot, "hermes"), ["gateway", "run"]),
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
		expect(hermesUnit).toContain("UnsetEnvironment=CLAWDI_AUTH_TOKEN");
		const dashboardUnit = readFileSync(
			join(paths.systemdUserRoot, "clawdi-hermes-dashboard.service"),
			"utf8",
		);
		expect(dashboardUnit).toContain(
			`ExecStart="${join(runtimeCommandRoot, "hermes")}" "dashboard" "--host" "127.0.0.1" "--port" "9119" "--no-open"`,
		);
		expect(dashboardUnit).not.toContain("--skip-build");
		expect(dashboardUnit).toContain("UnsetEnvironment=CLAWDI_AUTH_TOKEN");
		const openclawUnit = readUserServiceConfig(paths, "openclaw-gateway");
		expect(openclawUnit).toContain(
			`EnvironmentFile=${join(paths.systemdEnvRoot, "openclaw-gateway.service.env")}`,
		);
		expect(openclawUnit).toContain(
			`ConditionPathExists=${join(paths.systemdEnvRoot, "openclaw-gateway.service.env")}`,
		);
		expect(openclawUnit).not.toContain("\nExecStart=");
		expect(openclawUnit).not.toContain("\nWorkingDirectory=");
		expect(openclawUnit).toContain("UnsetEnvironment=CLAWDI_AUTH_TOKEN");
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
		const revision = expect.stringMatching(/^[a-f0-9]{32}$/);
		expect(readSystemdEnvironment(paths, "openclaw-gateway")).toEqual({
			BYOK_RUNTIME_SECRET: "runtime-byok-value",
			CLAWDI_MANAGED_CONTENT_DIGEST: revision,
			NON_SECRET_RUNTIME_SETTING: "public-value",
		});
		expect(readSystemdEnvironment(paths, "hermes-gateway")).toEqual({
			CLAWDI_MANAGED_CONTENT_DIGEST: revision,
		});
		expect(readSystemdEnvironment(paths, "clawdi-hermes-dashboard")).toEqual({
			BYOK_SERVICE_SECRET: "service-byok-value",
			CLAWDI_MANAGED_CONTENT_DIGEST: revision,
			HOME: paths.userHome,
			PATH: expect.any(String),
		});
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
		const dashboardEnv = readSystemdEnvironment(paths, "clawdi-hermes-dashboard");
		const gatewayEnv = readSystemdEnvironment(paths, "hermes-gateway");
		const watchEnv = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env"),
			"utf8",
		);
		const watchUnitPath = join(paths.systemdSystemRoot, "clawdi-runtime-watch.service");
		const watchUnit = readFileSync(watchUnitPath, "utf8");
		const gatewayUnit = readUserServiceConfig(paths, "hermes-gateway");
		const watchEnvPath = join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env");
		const watchEnvStat = statSync(watchEnvPath);
		const revision = expect.stringMatching(/^[a-f0-9]{32}$/);
		expect(dashboardEnv).toEqual({
			CLAWDI_MANAGED_CONTENT_DIGEST: revision,
			HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: "opaque-password-value",
			HERMES_DASHBOARD_BASIC_AUTH_SECRET: "opaque-session-value",
			HOME: paths.userHome,
			PATH: expect.any(String),
		});
		expect(gatewayEnv).toEqual({
			CLAWDI_MANAGED_CONTENT_DIGEST: revision,
			RUNTIME_BUNDLE_TOKEN: "bundle-runtime-token",
			RUNTIME_TARGET_TOKEN: "runtime-source-token",
		});
		const dashboardRunConfig = JSON.parse(
			readFileSync(runtimeRunConfigPath("hermes", paths, "dashboard"), "utf8"),
		) as { env?: Record<string, string>; secretEnv?: Record<string, string> };
		expect(dashboardRunConfig.env).toEqual({});
		expect(dashboardRunConfig.secretEnv).toEqual({
			HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: "secret://runtime/hermes/dashboard-password",
			HERMES_DASHBOARD_BASIC_AUTH_SECRET: "secret://runtime/hermes/dashboard-session-secret",
		});
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
		expect(hermesConfig).toContain("public_url: https://agent.example.test/hermes");
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
		const rotatedDashboardEnv = readSystemdEnvironment(paths, "clawdi-hermes-dashboard");
		const rotatedGatewayUnit = readUserServiceConfig(paths, "hermes-gateway");
		const rotatedWatchEnv = readFileSync(watchEnvPath, "utf8");
		const rotatedWatchUnit = readFileSync(watchUnitPath, "utf8");
		expect(rotatedWatchEnv).toBe(watchEnv);
		expect(rotatedDashboardUnit).toBe(dashboardUnit);
		expect(rotatedDashboardEnv).not.toEqual(dashboardEnv);
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
			const commandRoot = join(paths.userHome, ".local", "bin");
			const fakeCommandLog = join(paths.runRoot, "runtime-command.log");
			for (const runtime of ["hermes", "openclaw"] as const) {
				writeFakeGatewayCli({
					path: join(commandRoot, runtime),
					logPath: fakeCommandLog,
					runtime,
					unitPath: join(paths.systemdUserRoot, `${runtime}-gateway.service`),
				});
			}
			const runtimeSettings: RuntimeManifest["runtimes"] = {
				hermes: {
					enabled: true,
					run: {
						...runSettings(join(commandRoot, "hermes"), ["gateway", "run"]),
						secretEnv: { SHARED_RUNTIME_SECRET: "secret://runtime/hermes" },
					},
					services: {},
				},
				openclaw: {
					enabled: true,
					run: {
						...runSettings(join(commandRoot, "openclaw"), ["gateway", "run"]),
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

	test("publishes Hermes environment before deferred startup and respects OpenClaw installer validation", () => {
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
				...(runtime === "hermes"
					? {
							requiredSystemdState: {
								dropInPath,
								envPath,
								snapshotPrefix: join(paths.runRoot, "hermes-install"),
							},
						}
					: { forbiddenDropInPath: dropInPath }),
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
		let invalidatedUserUnits: string[] = [];
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
					activateEgressPrerequisite: () => {
						prerequisiteActivations += 1;
						return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
					},
					activate: (signal) => {
						finalActivations += 1;
						invalidatedUserUnits = signal.invalidatedUserUnits;
						return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
					},
				},
			},
		);

		expect(result.installErrors).toEqual([]);
		expect(prerequisiteActivations).toBe(0);
		expect(finalActivations).toBe(1);
		expect(invalidatedUserUnits).toEqual(["hermes-gateway.service", "openclaw-gateway.service"]);
		expect(readFileSync(logPath, "utf8").trim().split("\n").slice(-4)).toEqual([
			"hermes systemd state ready",
			"hermes gateway install --force --no-start-now",
			"openclaw drop-in absent",
			"openclaw gateway install --force --json",
		]);
		for (const name of ["openclaw-gateway", "hermes-gateway"]) {
			const envPath = join(paths.systemdEnvRoot, `${name}.service.env`);
			const installerDropIn = readFileSync(
				join(paths.systemdUserRoot, `${name}.service.d`, "10-clawdi-hosted.conf"),
				"utf8",
			);
			expect(installerDropIn).not.toContain("\nExecStart=");
			expect(installerDropIn).not.toContain("\nWorkingDirectory=");
			expect(installerDropIn).toContain(`ConditionPathExists=${envPath}`);
			expect(installerDropIn).toContain(`EnvironmentFile=${envPath}`);
		}
	});

	test.each(installGateHarnesses)(
		"adopts %s native revisions and repairs a subsequently missing unit",
		(_name, createHarness) => {
			const harness = createHarness();
			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);

			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);

			harness.drift();
			const nativeUnit = harness.unitContents();
			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);
			expect(harness.unitContents()).toBe(nativeUnit);

			harness.removeUnit();
			harness.failNextInstall();
			expect(harness.converge().installErrors.join("\n")).toContain("install failed");
			expect(harness.installCount()).toBe(2);

			harness.restoreInstaller();
			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.installCount()).toBe(3);
		},
	);

	test("preserves Hermes native updates and only reinstalls a missing gateway unit", () => {
		const harness = officialServiceHarness("hermes");
		expect(harness.converge().installErrors).toEqual([]);
		harness.drift();
		const nativeUnit = harness.unitContents();
		harness.revise();
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(1);
		expect(harness.unitContents()).toBe(nativeUnit);

		const environment = harness.managedDropIn();
		harness.failVersionProbe();
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(1);
		expect(harness.managedDropIn()).toBe(environment);

		harness.removeUnit();
		harness.failNextInstall();
		expect(harness.converge().installErrors.join("\n")).toContain("install failed");
		expect(harness.installCount()).toBe(2);
		expect(harness.managedDropIn()).toBe(environment);
		harness.restoreInstaller();
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(3);
	});

	test.each(installGateHarnesses)(
		"adopts %s version changes without reinstalling its native unit",
		(_name, createHarness) => {
			const harness = createHarness();
			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);

			harness.revise();
			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);
			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);
		},
	);

	test.each([
		["Hermes", "hermes"],
		["OpenClaw", "openclaw"],
	] as const)("does not reinstall %s for service metadata drift", (_name, runtime) => {
		const harness = officialServiceHarness(runtime);
		expect(harness.converge().installErrors).toEqual([]);
		expect(harness.installCount()).toBe(1);

		harness.driftMetadata();
		expect(harness.converge().installErrors).toEqual([]);

		expect(harness.installCount()).toBe(1);
	});

	test.each(installGateHarnesses)(
		"preserves post-commit %s native edits",
		(_name, createHarness) => {
			const harness = createHarness();
			expect(harness.converge(harness.drift).installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);

			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);
		},
	);

	test.each([
		["Hermes", "hermes"],
		["OpenClaw", "openclaw"],
	] as const)(
		"preserves foreign %s gateway drop-ins while reconciling its own",
		(_name, runtime) => {
			const harness = officialServiceHarness(runtime);
			expect(harness.converge().installErrors).toEqual([]);
			const foreignDropIn = harness.addForeignDropIn();
			const foreignContents = readFileSync(foreignDropIn, "utf8");

			const converged = harness.converge();

			expect(converged.installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);
			expect(readFileSync(foreignDropIn, "utf8")).toBe(foreignContents);
		},
	);

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

	test.each(installGateHarnesses)(
		"does not reinstall %s or remove its environment when the version probe fails",
		(_name, createHarness) => {
			const harness = createHarness();
			const dropIn = harness.managedDropIn();
			harness.failVersionProbe();

			expect(harness.converge().installErrors.join("\n")).toContain("refusing service reinstall");
			expect(harness.installCount()).toBe(1);
			expect(harness.managedDropIn()).toBe(dropIn);

			harness.restoreInstaller();
			expect(harness.converge().installErrors).toEqual([]);
			expect(harness.installCount()).toBe(1);
		},
	);

	test("retains a bounded private installer failure log after successful recovery", () => {
		const paths = tempRuntimePaths();
		ensureRuntimeStateDirs(paths);
		const latest = writeRuntimeInstallerLog(paths, "hermes-gateway-service", {
			status: 23,
			stderr: "first installer failure",
		});
		const failure = join(paths.statusRoot, "installer-logs", "hermes-gateway-service.failed.log");
		const contents = readFileSync(failure, "utf8");
		expect(contents).toContain("exitCode=23");
		expect(contents).toContain("first installer failure");
		expect(statSync(failure).mode & 0o777).toBe(0o600);
		writeRuntimeInstallerLog(paths, "hermes-gateway-service", { status: 0, stdout: "recovered" });
		expect(readFileSync(latest, "utf8")).toContain("recovered");
		expect(readFileSync(failure, "utf8")).toBe(contents);
		writeRuntimeInstallerLog(paths, "hermes-gateway-service", { signal: "SIGTERM" });
		expect(readFileSync(failure, "utf8")).toContain("signal=SIGTERM");
	});

	test("uninstalls stale official gateway services when manifest disables them", () => {
		const paths = tempRuntimePaths();
		const logPath = join(paths.runRoot, "official-service-commands.log");
		const openclawCommand = join(paths.userHome, ".local", "bin", "openclaw");
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const systemctlCommand = join(paths.runRoot, "bin", "systemctl");
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlCommand;
		writeFakeSystemctl({ path: systemctlCommand, logPath });
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
		expect(
			readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.filter((line) => line.includes(" gateway ")),
		).toEqual([
			"hermes gateway install --force --no-start-now",
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
		expect(readFileSync(logPath, "utf8")).not.toContain("gateway install");
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
			gateway: {
				mode: "local",
				port: 18789,
				bind: "lan",
				auth: { mode: "token", token: "test-gateway-token" },
			},
		});
	});

	test("withholds hosted drop-ins until an official install succeeds", () => {
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
	  "config patch --stdin") cat >/dev/null ;;
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
				activateEgressPrerequisite: () => ({
					applied: true,
					systemUnitsChanged: [],
					userUnitsChanged: [],
				}),
				activate: () => {
					finalActivations += 1;
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
			},
		});
		const firstInstallError = failedFirstInstall.installErrors.join("\n");
		const installerOutputLog = join(
			paths.statusRoot,
			"installer-logs",
			"openclaw-gateway-service.log",
		);
		expect(firstInstallError).toContain("official openclaw-gateway service install failed");
		expect(firstInstallError).toContain(`see ${installerOutputLog}`);
		expect(firstInstallError).not.toContain(installerToken);
		expect(firstInstallError).not.toContain("manifest-secret-must-not-leak");
		expect(firstInstallError).not.toContain("environment-value-must-not-leak");
		expect(firstInstallError).not.toContain("url-password-must-not-leak");
		expect(firstInstallError).not.toContain("query-token-must-not-leak");
		expect(firstInstallError).not.toContain("discarded-stderr-prefix");
		const installerOutput = readFileSync(installerOutputLog, "utf8");
		expect(installerOutput).toContain("exitCode=41");
		expect(installerOutput).toContain(installerToken);
		expect(installerOutput).toContain("manifest-secret-must-not-leak");
		expect(installerOutput).toContain("environment-value-must-not-leak");
		expect(installerOutput).toContain("url-password-must-not-leak");
		expect(installerOutput).toContain("query-token-must-not-leak");
		expect(installerOutput).toContain("discarded-stderr-prefix");
		const installerLogStat = statSync(installerOutputLog);
		expect(installerLogStat.mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(installerLogStat.uid).toBe(0);
			expect(installerLogStat.gid).toBe(0);
		}
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

		writeFakeGatewayCli({
			path: openclawCommand,
			logPath,
			runtime: "openclaw",
			unitPath,
			failInstall: true,
		});
		writeFileSync(unitPath, `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\n`);
		const failedReinstall = convergeRuntimeManifest(load("inline-reinstall-failure", 3), paths, {
			executeOfficialServiceInstallers: true,
		});
		expect(failedReinstall.installErrors.join("\n")).toContain(
			"official openclaw-gateway service install failed",
		);
		expect(existsSync(unitPath)).toBe(false);
		expect(existsSync(dropInPath)).toBe(false);
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
