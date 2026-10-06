import { describe, expect, it, spyOn } from "bun:test";

import { createHash } from "node:crypto";

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";

import { dirname, join } from "node:path";

import { getCliVersion } from "../src/lib/version";

import { readRuntimeAppliedState, writeRuntimeAppliedState } from "../src/runtime/applied-state";

import {
	applyRuntimeCliDesiredState,
	completePendingRuntimeCliUpgrade,
	readRuntimeCliBootstrapStatus,
	reconcilePendingRuntimeCliUpgrade,
	rollbackPendingRuntimeCliUpgrade,
} from "../src/runtime/cli-update";

import { getRuntimePaths } from "../src/runtime/paths";

import { readSystemdUnitSnapshot } from "../src/runtime/systemd-transaction";

import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "../src/runtime/systemd-user";

import { log } from "../src/serve/log";

import {
	CANONICAL_TEST_CONTEXT,
	cachedMitmproxyBinary,
	cliManifest,
	convergeRuntimeManifest,
	createVersionedCliFixture,
	currentTestApplyContext,
	fakeSystemdStatePath,
	HERMES_CONFIG_CLI_MOCK,
	hostedCliManifestResponse,
	hostedEgressSecretRotationPayload,
	hostedOpenClawRuntime,
	hostedRequiredState,
	hostedRuntimeBundleResponse,
	hostedSystemFixture,
	installRuntimeTestHooks,
	installSuccessfulSystemctlFixture,
	normalizeHostedManifestFixture,
	pointManagedCliAt,
	readSystemdEnvFile,
	readSystemdSystemUnit,
	readSystemdUserServiceConfig,
	root,
	runtimeWatch,
	seedCurrentCliInstall,
	seedFakeSystemdSnapshotProcesses,
	seedMitmproxyCache,
	seedOpenClawBinary,
	setRuntimeApplyGeneration,
	TEST_HOSTED_LOCALE,
	TEST_RUNNING_CLI_VERSION,
	testBundleEtag,
	writeFakeSystemdManager,
	writeHermesDashboardPython,
	writeOpenClawConfigMutationFixture,
} from "../src/test-support/runtime-harness";

import { mockFetch } from "./commands/helpers";

installRuntimeTestHooks();

describe("runtime manifest datasource", () => {
	it("hands off a CLI update from a 0.14.101 receipt without restarting a tenant", async () => {
		const withOom = false;
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const npmLog = join(root, "npm.log");
		const systemctlLog = join(root, "systemctl-cli-update.log");
		installSuccessfulSystemctlFixture(join(run, "egress", "systemd", "ca.pem"), systemctlLog);
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const currentVersion = getCliVersion();
		setRuntimeApplyGeneration(13);
		const runtimeContextBefore = JSON.stringify(currentTestApplyContext);
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
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
  echo "${currentVersion}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"ok"}'
  exit 0
fi
echo "fake clawdi"
SH
chmod +x "$prefix/bin/clawdi"
`,
		);
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, "1.2.3-test");
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		let runtimeGeneration = 13;
		let desiredCliPackageSpec = "clawdi@1.2.3-test";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: (request) => {
					const etag = testBundleEtag(`${runtimeGeneration}:${desiredCliPackageSpec}`);
					if (request.headers["if-none-match"] === etag) {
						return new Response(null, { status: 304, headers: { etag } });
					}
					return hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_cli_update",
								environmentId: "env_cli_update",
								...hostedRequiredState(),
								instanceId: "iid_cli_update",
								generation: runtimeGeneration,
								issuedAt: `2026-06-06T00:00:${runtimeGeneration}Z`,
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: desiredCliPackageSpec,
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
							},
							secretValues: {},
						},
						{
							applyGeneration: 13,
							etag,
						},
					);
				},
			},
		]);
		const manifestRequests = () =>
			captured.filter((request) => request.path !== "/v1/runtime/vaults");

		try {
			await runtimeWatch({ once: true, json: true });
			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			const paths = getRuntimePaths();
			expect(JSON.parse(logs[0])).toMatchObject({ status: "applied" });
			expect(existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"))).toBe(true);
			expect(existsSync(join(paths.systemdSystemRoot, "clawdi-daemon.service"))).toBe(true);
			expect(existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"))).toBe(
				true,
			);
			expect(existsSync(join(paths.systemdUserRoot, "openclaw-gateway.service"))).toBe(true);
			expect(existsSync(paths.daemonAuthToken)).toBe(true);
			const initialAppliedState = readRuntimeAppliedState(paths);
			if (!initialAppliedState) throw new Error("Initial applied receipt is missing");
			const gatewayUnit = "openclaw-gateway.service";
			const gatewayDropIn = join(
				paths.systemdUserRoot,
				`${gatewayUnit}.d`,
				"10-clawdi-hosted.conf",
			);
			if (!withOom) {
				writeFileSync(
					gatewayDropIn,
					readFileSync(gatewayDropIn, "utf8").replace(
						"# ClawdiOOMProtection=v1\nOOMPolicy=continue\n# EndClawdiOOMProtection\n",
						"",
					),
				);
			}
			// Reproduce 0.14.101's full-byte receipt independently of the current reader.
			const oldGatewayReceipt = createHash("sha256")
				.update(
					`${readFileSync(join(paths.systemdUserRoot, gatewayUnit), "utf8")}\n${readFileSync(gatewayDropIn, "utf8")}`,
				)
				.update(readFileSync(join(paths.systemdEnvRoot, `${gatewayUnit}.env`)))
				.digest("hex");
			writeRuntimeAppliedState(
				{
					...initialAppliedState,
					activated: {
						...initialAppliedState.activated,
						[gatewayUnit]: oldGatewayReceipt,
					},
				},
				paths,
			);
			const initialDaemonActivation = initialAppliedState?.activated["clawdi-daemon.service"];
			expect(initialDaemonActivation).toMatch(/^[a-f0-9]{64}$/);
			const legacyUnitPaths = [
				...readdirSync(paths.systemdSystemRoot)
					.filter((entry) => entry.endsWith(".service"))
					.map((entry) => join(paths.systemdSystemRoot, entry)),
				...readdirSync(paths.systemdUserRoot).flatMap((entry) => {
					if (entry.endsWith(".service")) {
						const unitPath = join(paths.systemdUserRoot, entry);
						return readFileSync(unitPath, "utf-8").includes(GENERATED_RUNTIME_SYSTEMD_FILE_HEADER)
							? [unitPath]
							: [];
					}
					const dropIn = join(paths.systemdUserRoot, entry, "10-clawdi-hosted.conf");
					return entry.endsWith(".service.d") && existsSync(dropIn) ? [dropIn] : [];
				}),
			];
			for (const unitPath of legacyUnitPaths) {
				if (unitPath.startsWith(paths.systemdUserRoot)) continue;
				writeFileSync(unitPath, `${readFileSync(unitPath, "utf-8")}# legacy renderer drift\n`);
			}
			logs.length = 0;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			runtimeGeneration = 14;
			desiredCliPackageSpec = `clawdi@${currentVersion}`;
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(process.exitCode ?? 0).toBe(0);
			expect(manifestRequests()).toHaveLength(2);
			const active = paths.cliManagedBin;
			const sharedPrefixTarget = join(paths.cliNpmPrefix, "bin", "clawdi");
			const activeTarget = readlinkSync(active);
			expect(readlinkSync(active)).toBe(activeTarget);
			const status = JSON.parse(readFileSync(getRuntimePaths().cliBootstrapStatus, "utf-8"));
			expect(status.packageSpec).toBe(`clawdi@${currentVersion}`);
			expect(status.activePath).toBe(active);
			expect(status.activeTarget).toBe(activeTarget);
			expect(status.npmPrefix.startsWith(join(getRuntimePaths().cliNpmPrefix, "packages"))).toBe(
				true,
			);
			expect(activeTarget).toBe(join(status.npmPrefix, "bin", "clawdi"));
			expect(activeTarget).not.toBe(sharedPrefixTarget);
			expect(status.version).toBe(currentVersion);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("cli_handoff");
			expect(event.handoff).toBe("cli_reexec");
			expect(event.selfReexec).toBe(true);
			expect(event.cliUpdate.status).toBe("installed");
			expect(event.cliUpdate.packageSpec).toBe(`clawdi@${currentVersion}`);
			expect(event.systemdUnitsChanged).toBe(false);
			expect(JSON.stringify(currentTestApplyContext)).toBe(runtimeContextBefore);
			expect(event.systemdApply).toEqual({
				applied: false,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			});
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");
			expect(readRuntimeAppliedState(paths)).toMatchObject({
				generation: 13,
				applyGeneration: 13,
			});
			const appliedBeforeDaemonHandoff = readFileSync(paths.appliedState, "utf-8");
			expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"))).toMatchObject({
				status: "installed",
				previous: { version: "1.2.3-test" },
				bad: null,
			});

			logs.length = 0;
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(manifestRequests()).toHaveLength(3);
			const completedEvent = JSON.parse(logs[0]);
			expect(completedEvent.status).toBe("applied");
			expect(completedEvent.selfReexec).toBe(false);
			expect(completedEvent.cliUpdate.status).toBe("current");
			expect(completedEvent.systemdUnitsChanged).toBe(true);
			expect(completedEvent.systemdApply).toEqual({
				applied: true,
				systemUnitsChanged: ["clawdi-daemon.service"],
				userUnitsChanged: [],
			});
			const completedAppliedState = readRuntimeAppliedState(paths);
			expect(completedAppliedState).toMatchObject({
				generation: 14,
				applyGeneration: 13,
			});
			const completedDaemonActivation = completedAppliedState?.activated["clawdi-daemon.service"];
			expect(completedDaemonActivation).toMatch(/^[a-f0-9]{64}$/);
			expect(completedDaemonActivation).not.toBe(initialDaemonActivation);
			expect(JSON.stringify(currentTestApplyContext)).toBe(runtimeContextBefore);
			const activationCalls = readFileSync(systemctlLog, "utf-8")
				.trim()
				.split("\n")
				.filter((call) =>
					/(?:^|\s)(?:daemon-reload|start|restart|stop|enable|disable|reset-failed)(?:\s|$)/.test(
						call,
					),
				);
			expect(activationCalls).toEqual([
				"daemon-reload",
				"--user daemon-reload",
				"restart clawdi-daemon.service",
			]);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"restart clawdi-runtime-watch.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"restart clawdi-runtime-sidecar.service",
			);
			expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"))).toMatchObject({
				previous: null,
				bad: null,
			});

			logs.length = 0;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			runtimeGeneration = 15;
			await runtimeWatch({ once: true, json: true });
			expect(JSON.parse(logs[0]).systemdApply).toEqual({
				applied: true,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			});
			expect(readFileSync(systemctlLog, "utf8")).not.toMatch(/\b(?:start|restart|stop)\b/);

			// Model a crash after the cache write but before the applied-state commit.
			writeFileSync(paths.appliedState, appliedBeforeDaemonHandoff);
			logs.length = 0;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(manifestRequests()).toHaveLength(5);
			expect(JSON.parse(logs[0]).systemdApply).toEqual({
				applied: true,
				systemUnitsChanged: ["clawdi-daemon.service"],
				userUnitsChanged: [],
			});
			const retryCalls = readFileSync(systemctlLog, "utf-8");
			expect(retryCalls.match(/^restart clawdi-daemon\.service$/gm)).toHaveLength(1);
			expect(retryCalls).not.toContain("restart clawdi-runtime-watch.service");
			expect(retryCalls).not.toContain("restart clawdi-runtime-sidecar.service");
			expect(retryCalls).not.toContain("--user restart openclaw-gateway.service");
			expect(readRuntimeAppliedState(paths)?.activated["clawdi-daemon.service"]).toBe(
				completedDaemonActivation,
			);

			const committedAfterRetry = readFileSync(paths.appliedState, "utf-8");
			logs.length = 0;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(manifestRequests()).toHaveLength(6);
			expect(JSON.parse(logs[0])).toMatchObject({ status: "not_modified" });
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");
			expect(readFileSync(paths.appliedState, "utf-8")).toBe(committedAfterRetry);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it.each([
		{ runtime: "openclaw" as const, publishCa: true, dashboardBuilds: true },
		{ runtime: "hermes" as const, publishCa: true, dashboardBuilds: true },
		{ runtime: "hermes" as const, publishCa: true, dashboardBuilds: false },
		{ runtime: "openclaw" as const, publishCa: false, dashboardBuilds: true },
	])(
		"orders the cold $runtime installer after egress (publishCa=$publishCa, dashboardBuilds=$dashboardBuilds)",
		async ({ runtime, publishCa, dashboardBuilds }) => {
			setRuntimeApplyGeneration(41, CANONICAL_TEST_CONTEXT);
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			const run = join(root, "run", "clawdi");
			const bin = join(root, "bin");
			const systemctlLog = join(root, "systemctl-cold-openclaw.log");
			const systemctlStateRoot = join(root, "systemctl-cold-openclaw-state");
			const installerLog = join(root, `${runtime}-installer-order.log`);
			const runtimeBin =
				runtime === "openclaw"
					? join(home, ".local", "bin", "openclaw")
					: join(home, ".local", "bin", "hermes");
			const serviceName = `${runtime}-gateway`;
			const runtimeUnit = join(home, ".config", "systemd", "user", `${serviceName}.service`);
			const installArgs =
				runtime === "openclaw"
					? "gateway install --force --json"
					: "gateway install --force --no-start-now";
			const previousLog = console.log;
			const previousUmask = process.umask(0o022);
			const previousExitCode = process.exitCode;
			const previousPath = process.env.PATH;
			let runtimeExitCode: number | undefined;
			const logs: string[] = [];
			mkdirSync(join(run, "secrets"), { recursive: true });
			if (runtime === "openclaw") writeOpenClawConfigMutationFixture(home);
			mkdirSync(dirname(runtimeBin), { recursive: true });
			mkdirSync(bin, { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
			process.env.CLAWDI_RUNTIME_USER = String(process.getuid?.() ?? 0);
			process.env.PATH = `${bin}:${previousPath ?? ""}`;
			const paths = getRuntimePaths();
			writeFakeSystemdManager({
				path: join(bin, "systemctl"),
				logPath: systemctlLog,
				stateRoot: systemctlStateRoot,
				sidecarReadyPath: publishCa ? paths.egressSystemCaFile : undefined,
			});
			writeFileSync(
				runtimeBin,
				`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> '${installerLog}'
if [ "$*" = "--version" ]; then
  printf '%s\n' '${runtime}-test-version'
elif [ "${runtime}" = "openclaw" ] && [ "$*" = "config schema" ]; then
  printf '%s\n' '{"type":"object","properties":{"memory":{"type":"object","properties":{"search":{"type":"object"}}}}}'
elif [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"${join(home, ".openclaw", "workspace")}"}]\n'
elif [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ]; then
  cat >/dev/null
elif [ "${runtime}" = "hermes" ] && [ "\${1:-}" = "config" ]; then
  exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
elif [ "$*" = "${installArgs}" ]; then
  printf '%s\n' 'official ${runtime} installer' >> '${systemctlLog}'
  test -r '${paths.egressSystemCaFile}'
  test ${runtime === "hermes" ? "-r" : "! -e"} '${join(paths.systemdUserRoot, `${serviceName}.service.d`, "10-clawdi-hosted.conf")}'
  mkdir -p '${dirname(runtimeUnit)}' '${systemctlStateRoot}'
  printf '[Service]\\nExecStart=${runtime} gateway run\\n' > '${runtimeUnit}'
	  systemctl --user enable ${runtime === "hermes" ? "" : "--now"} '${serviceName}.service'
fi
exit 0
`,
			);
			chmodSync(runtimeBin, 0o700);
			if (runtime === "hermes") {
				writeHermesDashboardPython(home, true);
				const appRoot = join(home, ".hermes", "hermes-agent");
				const npm = join(bin, "npm");
				mkdirSync(join(appRoot, "web"), { recursive: true });
				writeFileSync(join(appRoot, "web", "package.json"), '{"scripts":{"build":"true"}}\n');
				writeFileSync(
					npm,
					`#!/usr/bin/env bash
set -euo pipefail
printf 'official hermes dashboard prerequisite %s\n' "$*" >> '${systemctlLog}'
test -r '${paths.egressSystemCaFile}'
case "$*" in
  "ci --include=dev --workspace web")
    mkdir -p '${join(appRoot, "node_modules", ".bin")}'
    ;;
  "run build")
    ${dashboardBuilds ? "" : "exit 1"}
    mkdir -p '${join(appRoot, "hermes_cli", "web_dist")}'
    printf '%s\n' '<html>Hermes dashboard</html>' > '${join(appRoot, "hermes_cli", "web_dist", "index.html")}'
    ;;
  *) exit 64 ;;
esac
`,
				);
				chmodSync(npm, 0o700);
			}
			seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
			writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
			const mitmproxy = seedMitmproxyCache(paths);
			console.log = (value?: unknown) => logs.push(String(value));
			const runtimeFetch = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () =>
						hostedRuntimeBundleResponse(
							hostedEgressSecretRotationPayload(home, mitmproxy, "cold-home-secret", runtime),
							{ etag: testBundleEtag("cold-home-egress") },
						),
				},
			]);

			try {
				await runtimeWatch({ once: true, json: true });
				runtimeExitCode = process.exitCode;
			} finally {
				runtimeFetch.restore();
				console.log = previousLog;
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				process.umask(previousUmask);
				process.exitCode = previousExitCode;
			}

			if (!publishCa) {
				const event = JSON.parse(logs.at(-1) ?? "{}");
				expect(event.status).toBe("error");
				expect(event.error).toContain("prerequisite activation failed");
				expect(readRuntimeAppliedState(paths)).toBeNull();
				expect(existsSync(installerLog) ? readFileSync(installerLog, "utf8") : "").not.toContain(
					installArgs,
				);
				const failedManagerCalls = readFileSync(systemctlLog, "utf8").trim().split("\n");
				expect(
					failedManagerCalls.some((call) => /^(start|restart) .*clawdi-daemon\.service/.test(call)),
				).toBe(false);
				return;
			}
			if (!dashboardBuilds) {
				// The failed optional build withdraws the dashboard; the gateway still commits.
				const event = JSON.parse(logs.at(-1) ?? "{}");
				expect(event).toMatchObject({ status: "error", healthImpact: "resource_projection" });
				expect(event.error).toContain(
					"runtime hermes dashboard unavailable: Hermes dashboard prerequisite failed",
				);
				expect(readRuntimeAppliedState(paths)).toMatchObject({
					generation: 41,
					serviceWithdrawals: [{ runtime: "hermes", service: "dashboard" }],
				});
				const calls = readFileSync(systemctlLog, "utf8").trim().split("\n");
				expect(calls).toContain("official hermes installer");
				expect(
					calls.some((call) => call.startsWith("--user start ") && call.includes(serviceName)),
				).toBe(true);
				expect(calls.some((call) => call.includes("clawdi-hermes-dashboard"))).toBe(false);
				expect(readSystemdUserServiceConfig(paths, "clawdi-hermes-dashboard")).toBe("\n");
				return;
			}
			if (runtimeExitCode !== undefined && runtimeExitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(JSON.parse(logs.at(-1) ?? "{}").status).toBe("applied");
			expect(existsSync(paths.egressSystemCaFile)).toBe(true);
			const calls = readFileSync(systemctlLog, "utf8").trim().split("\n");
			const sidecarActivation = calls.findIndex((call) =>
				/^(start|restart) .*clawdi-runtime-sidecar\.service/.test(call),
			);
			const officialInstaller = calls.indexOf(`official ${runtime} installer`);
			const finalSystemActivation = calls.findIndex(
				(call) => call.startsWith("start") && call.includes("clawdi-daemon.service"),
			);
			expect(sidecarActivation).toBeGreaterThanOrEqual(0);
			if (runtime === "hermes") {
				const dependencyInstall = calls.indexOf(
					"official hermes dashboard prerequisite ci --include=dev --workspace web",
				);
				const dashboardBuild = calls.indexOf("official hermes dashboard prerequisite run build");
				expect(dependencyInstall).toBeGreaterThan(sidecarActivation);
				expect(dashboardBuild).toBeGreaterThan(dependencyInstall);
				expect(officialInstaller).toBeGreaterThan(dashboardBuild);
			}
			expect(officialInstaller).toBeGreaterThan(sidecarActivation);
			expect(finalSystemActivation).toBeGreaterThan(officialInstaller);
			if (runtime === "hermes") {
				const gatewayStart = calls.findIndex(
					(call) => call.startsWith("--user start ") && call.includes(`${serviceName}.service`),
				);
				expect(gatewayStart).toBeGreaterThan(officialInstaller);
				expect(calls).not.toContain(`--user restart ${serviceName}.service`);
			} else {
				expect(calls).toContain(`--user restart ${serviceName}.service`);
			}
			const installerCalls = readFileSync(installerLog, "utf8").trim().split("\n");
			const installIndex = installerCalls.indexOf(installArgs);
			if (runtime === "openclaw") {
				expect(installIndex).toBeGreaterThan(0);
				expect(installerCalls.slice(installIndex + 1)).not.toContain("config patch --stdin");
			} else {
				expect(installIndex).toBeGreaterThanOrEqual(0);
				expect(installerCalls).toContain("config path");
				expect(installerCalls.some((call) => call.startsWith("npm "))).toBe(false);
				expect(existsSync(join(home, ".hermes", "config.yaml"))).toBe(true);
			}
			const applied = readRuntimeAppliedState(paths);
			expect(applied).toMatchObject({
				generation: 41,
				etag: testBundleEtag("cold-home-egress"),
			});
			expect(applied).not.toHaveProperty("serviceWithdrawals");
		},
		30_000,
	);

	it("runtime watch reapplies transparent egress across CLI self-upgrade", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl.log");
		const systemctlStateRoot = join(root, "systemctl-self-upgrade-state");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousPath = process.env.PATH;
		const currentVersion = getCliVersion();
		setRuntimeApplyGeneration(1);
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		seedOpenClawBinary(home);
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
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${currentVersion}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  echo '{"status":"ok"}'
  exit 0
fi
echo "fake upgraded clawdi"
SH
chmod +x "$prefix/bin/clawdi"
`,
		);
		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			sidecarReadyPath: join(run, "egress", "systemd", "ca.pem"),
		});
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		const paths = getRuntimePaths();
		seedCurrentCliInstall(state, "1.2.1-test.1");
		const mitmproxy = seedMitmproxyCache(paths);
		const baseline = normalizeHostedManifestFixture(
			hostedEgressSecretRotationPayload(home, mitmproxy, "sk-before-upgrade"),
		);
		baseline.manifest = {
			...baseline.manifest,
			deploymentId: "dep_cli_mitm",
			environmentId: "env_cli_mitm",
			instanceId: "iid_cli_mitm",
			generation: 1,
		};
		convergeRuntimeManifest(
			{
				...baseline,
				source: "remote-datasource",
				sourcePath: "test://self-upgrade-egress-before",
				offline: false,
			},
			paths,
		);
		const activeUnits = readSystemdUnitSnapshot(paths);
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, activeUnits);
		for (const unit of activeUnits.user.keys()) {
			writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
		}
		writeFileSync(systemctlLog, "");
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_cli_mitm",
								environmentId: "env_cli_mitm",
								...hostedRequiredState(),
								instanceId: "iid_cli_mitm",
								generation: 2,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								egressEngine: mitmproxy,
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: `clawdi@${currentVersion}`,
									registry: "https://registry.npmjs.org",
								},
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
								providers: {
									default: {
										kind: "openai-compatible",
										type: "custom_openai_compatible",
										baseUrl: "https://ai-gateway.example.test/v1",
										models: [{ id: "gpt-5.5" }],
										apiMode: "openai_responses",
										runtimeEnvName: "CLAWDI_AI_API_KEY",
										apiKeySecretRef: "secret://provider.default.apiKey",
									},
								},
							},
							secretValues: {
								"secret://provider.default.apiKey": "sk-after-upgrade",
							},
						},
						{ etag: testBundleEtag("etag-cli-egress-2") },
					),
			},
		]);

		try {
			setRuntimeApplyGeneration(2);
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			const handoff = JSON.parse(logs[0]);
			expect(handoff.status).toBe("cli_handoff");
			expect(handoff.selfReexec).toBe(true);
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");

			logs.length = 0;
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(0);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("applied");
			expect(event.selfReexec).toBe(false);
			expect(event.systemdApply.applied).toBe(true);
			expect(event.systemdApply.systemUnitsChanged).toContain("clawdi-runtime-sidecar.service");
			const systemctlCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			expect(systemctlCalls).not.toContain("restart clawdi-daemon.service");
			const sidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
			const sidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
			const transparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
			expect(sidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
			expect(sidecarEnv).toContain('CLAWDI_MANAGED_CONTENT_DIGEST="');
			expect(sidecarUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "sidecar"`);
			expect(sidecarUnit).toContain(
				`BindReadOnlyPaths=${cachedMitmproxyBinary(paths, mitmproxy)}:${paths.egressServiceBinary}:norbind`,
			);
			expect(transparentEgressEnv).toContain(
				'CLAWDI_EGRESS_TRANSPORT_VERSION="clawdi-transparent-egress-v1"',
			);
			expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_ADDON_PATH="${paths.egressAddon}"`);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it.each([
		["upgrades", "1.2.3-test.1", "1.2.3-test.2"],
		["downgrades", "2.0.0-test.1", "1.2.3-test.2"],
		["retry-expired", "0.14.84", "0.14.85"],
		["new-after-rollback", "0.14.84", "0.14.86"],
	])(
		"hosted exact CLI desired state %s without npm view",
		(action, currentVersion, desiredVersion) => {
			const home = join(root, `home-${currentVersion}`, "clawdi");
			const state = join(root, `state-${currentVersion}`);
			const run = join(root, `run-${currentVersion}`);
			const bin = join(root, `bin-${currentVersion}`);
			const npmLog = join(root, `npm-exact-${currentVersion}.log`);
			const previousPath = process.env.PATH;
			mkdirSync(bin, { recursive: true });
			writeFileSync(
				join(bin, "npm"),
				`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${npmLog}'
if [ "\${1:-}" = "view" ]; then
  echo "exact hosted CLI updates must not call npm view" >&2
  exit 96
fi
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
test -n "$prefix"
install -d "$prefix/bin"
cat > "$prefix/bin/clawdi" <<'SH'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "${desiredVersion}"
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then
  test "\${CLAWDI_SERVICE_STATE_DIR:-}" != "${state}"
  test "\${CLAWDI_RUN_DIR:-}" != "${run}"
  echo '{"status":"ok"}'
  exit 0
fi
exit 64
SH
chmod +x "$prefix/bin/clawdi"
`,
			);
			chmodSync(join(bin, "npm"), 0o700);
			process.env.PATH = `${bin}:${previousPath ?? ""}`;
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			const desiredSpec = `clawdi@${desiredVersion}`;
			seedCurrentCliInstall(state, currentVersion);
			const previousUmask = process.umask(0o002);

			try {
				const desired = normalizeHostedManifestFixture(
					hostedCliManifestResponse(home, desiredSpec),
				);
				const paths = getRuntimePaths();
				if (action === "retry-expired" || action === "new-after-rollback") {
					reconcilePendingRuntimeCliUpgrade(paths, currentVersion);
					const receipt = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf8"));
					receipt.bad = {
						version: "0.14.85",
						attempts: 1,
						reason: "first converge failed",
						failedAt: new Date(Date.now() - 120_000).toISOString(),
						retryAt: new Date(
							Date.now() + (action === "retry-expired" ? -1_000 : 3_600_000),
						).toISOString(),
					};
					writeFileSync(paths.cliBootstrapStatus, JSON.stringify(receipt), { mode: 0o600 });
				}
				const result = applyRuntimeCliDesiredState(desired.manifest, paths);
				expect(process.umask()).toBe(0o002);

				expect(result.status).toBe("installed");
				expect(result.selfReexec).toBe(true);
				expect(result.packageSpec).toBe(desiredSpec);
				expect(result.version).toBe(desiredVersion);
				expect(result.activePath).toBe(paths.cliManagedBin);
				expect(readlinkSync(result.activePath)).toBe(result.activeTarget);
				expect(existsSync(join(state, "bin", "clawdi"))).toBe(false);
				expect(statSync(paths.managedCliRoot).mode & 0o777).toBe(0o755);
				expect(statSync(dirname(result.activePath)).mode & 0o777).toBe(0o755);
				expect(statSync(paths.cliNpmPrefix).mode & 0o777).toBe(0o755);
				expect(statSync(result.npmPrefix).mode & 0o777).toBe(0o755);
				if (!result.activeTarget) throw new Error("CLI update did not return an active target");
				expect(statSync(result.activeTarget).mode & 0o777).toBe(0o700);
				expect(statSync(paths.cliBootstrapStatus).mode & 0o777).toBe(0o600);
				const pending = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
				expect(pending).toMatchObject({
					status: "installed",
					packageSpec: desiredSpec,
					activeTarget: result.activeTarget,
					version: desiredVersion,
					previous: { version: currentVersion },
					bad:
						action === "retry-expired"
							? expect.objectContaining({ version: desiredVersion })
							: null,
				});
				expect(pending.verification).toBeDefined();
				const npmCalls = readFileSync(npmLog, "utf-8").trim().split("\n");
				expect(npmCalls.some((call) => call.startsWith("view "))).toBe(false);
				expect(npmCalls.some((call) => call.includes(desiredSpec))).toBe(true);

				if (action !== "downgrades") {
					expect(completePendingRuntimeCliUpgrade(paths, desiredVersion)).toEqual({
						status: "unchanged",
						selfReexec: false,
					});
					expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8")).previous).toBeNull();
				} else {
					expect(rollbackPendingRuntimeCliUpgrade(paths, "first converge failed").status).toBe(
						"rolled_back",
					);
					const rolledBack = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
					expect(rolledBack).toMatchObject({
						version: currentVersion,
						previous: null,
						bad: { version: desiredVersion, attempts: 1 },
					});
					expect(applyRuntimeCliDesiredState(desired.manifest, paths).status).toBe("deferred");
				}
			} finally {
				process.umask(previousUmask);
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
			}
		},
	);

	it("adopts a released image bootstrap receipt and re-verifies stale CLI metadata", () => {
		const state = join(root, "state-cli-verification-cache");
		const run = join(root, "run-cli-verification-cache");
		const commandLog = join(root, "cli-verification-cache.log");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const identity = createVersionedCliFixture(
			paths,
			"1.2.3",
			join(paths.cliNpmPrefix, "installs", "install-bootstrap"),
		);
		pointManagedCliAt(paths, identity);
		const { activeTarget } = identity;
		writeFileSync(
			activeTarget,
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${commandLog}'
if [ "\${1:-}" = "--version" ]; then echo '1.2.3'; exit 0; fi
if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then echo '{"status":"ok"}'; exit 0; fi
exit 64
`,
		);
		chmodSync(activeTarget, 0o700);
		const manifest = cliManifest("1.2.3");
		const bootstrap = {
			schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
			generatedAt: "2026-09-06T00:00:00Z",
			status: "installed",
			source: "npm",
			...identity,
			npmCache: paths.cliNpmCache,
			activePath: paths.cliManagedBin,
			error: null,
		};
		mkdirSync(paths.statusRoot, { recursive: true });
		writeFileSync(paths.cliBootstrapStatus, JSON.stringify(bootstrap));
		const warn = spyOn(log, "warn");
		try {
			expect(readRuntimeCliBootstrapStatus(paths, { strict: true })).toEqual(bootstrap);
			expect(applyRuntimeCliDesiredState(manifest, paths).status).toBe("current");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}

		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(2);
		const adopted = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		expect(adopted).toMatchObject({
			...identity,
			previous: null,
			bad: null,
		});
		expect(adopted.verification.inode).toBe(statSync(activeTarget).ino);
		applyRuntimeCliDesiredState(manifest, paths);
		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(2);

		adopted.verification.device += 1;
		adopted.verification.inode += 1;
		writeFileSync(paths.cliBootstrapStatus, JSON.stringify(adopted));
		expect(applyRuntimeCliDesiredState(manifest, paths).status).toBe("current");
		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toHaveLength(4);
		expect(readlinkSync(paths.cliManagedBin)).toBe(activeTarget);
		expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8")).verification).toMatchObject({
			device: statSync(activeTarget).dev,
			inode: statSync(activeTarget).ino,
		});
	});

	it.each(["partial", "mismatch", "permissions", "symlink", "probe"] as const)(
		"does not adopt or overwrite an invalid CLI receipt/target: %s",
		(failure) => {
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state-cli-invalid");
			const paths = getRuntimePaths();
			const identity = createVersionedCliFixture(paths, "1.2.3");
			pointManagedCliAt(paths, identity);
			reconcilePendingRuntimeCliUpgrade(paths);
			const receipt = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
			switch (failure) {
				case "partial":
					delete receipt.verification;
					break;
				case "mismatch":
					receipt.version = "1.2.4";
					break;
				case "permissions":
					chmodSync(identity.activeTarget, 0o777);
					break;
				case "symlink":
					rmSync(identity.activeTarget);
					symlinkSync("/bin/true", identity.activeTarget);
					break;
				case "probe":
					writeFileSync(identity.activeTarget, "#!/bin/sh\nexit 42\n");
					break;
			}
			writeFileSync(paths.cliBootstrapStatus, JSON.stringify(receipt));
			const before = readFileSync(paths.cliBootstrapStatus, "utf-8");
			expect(() => applyRuntimeCliDesiredState(cliManifest("1.2.3"), paths)).toThrow();
			expect(readFileSync(paths.cliBootstrapStatus, "utf-8")).toBe(before);
			expect(readlinkSync(paths.cliManagedBin)).toBe(identity.activeTarget);
			if (failure === "permissions") {
				expect(statSync(identity.activeTarget).mode & 0o777).toBe(0o777);
			}
		},
	);

	it("rejects an unreadable CLI receipt instead of recovering it as missing", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state-cli-unreadable");
		const paths = getRuntimePaths();
		mkdirSync(paths.statusRoot, { recursive: true });
		writeFileSync(paths.cliBootstrapStatus, "{}", { mode: 0o000 });
		expect(() => applyRuntimeCliDesiredState(cliManifest("1.2.3"), paths)).toThrow("EACCES");
		expect(statSync(paths.cliBootstrapStatus).mode & 0o777).toBe(0);
	});

	it("rolls back when the active symlink disagrees with state", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state-cli-crash-recovery");
		process.env.CLAWDI_RUN_DIR = join(root, "run-cli-crash-recovery");
		const paths = getRuntimePaths();
		const candidate = createVersionedCliFixture(paths, "1.2.8-test.1");
		pointManagedCliAt(paths, candidate);
		reconcilePendingRuntimeCliUpgrade(paths, candidate.version);
		const previous = createVersionedCliFixture(paths, "1.2.7-test.1");
		const state = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		state.previous = { activeTarget: previous.activeTarget, version: previous.version };
		writeFileSync(paths.cliBootstrapStatus, `${JSON.stringify(state)}\n`);
		pointManagedCliAt(paths, previous);

		expect(reconcilePendingRuntimeCliUpgrade(paths, candidate.version)).toEqual({
			status: "rolled_back",
			selfReexec: true,
		});
		const recovered = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		expect(recovered).toMatchObject({
			activeTarget: previous.activeTarget,
			version: previous.version,
			previous: null,
			bad: { version: candidate.version, attempts: 1 },
		});
		expect(readlinkSync(paths.cliManagedBin)).toBe(previous.activeTarget);
		expect(existsSync(candidate.npmPrefix)).toBe(false);
	});

	it("keeps the active CLI and backs off when the candidate fails verification", () => {
		const stateRoot = join(root, "state-cli-verification-failure");
		const runRoot = join(root, "run-cli-verification-failure");
		const bin = join(root, "bin-cli-verification-failure");
		const npmLog = join(root, "npm-cli-verification-failure.log");
		const previousPath = process.env.PATH;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = stateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "npm"),
			`#!/usr/bin/env bash
	set -euo pipefail
	printf '%s\\n' "$*" >> '${npmLog}'
	prefix=""
	while [ "$#" -gt 0 ]; do
	  if [ "$1" = "--prefix" ]; then prefix="$2"; shift 2; else shift; fi
	done
	install -d "$prefix/bin"
	cat > "$prefix/bin/clawdi" <<'SH'
	#!/usr/bin/env bash
	if [ "\${1:-}" = "--version" ]; then echo "9.9.9-test.1"; exit 0; fi
	if [ "\${1:-} \${2:-} \${3:-}" = "runtime verify --json" ]; then echo '{"status":"ok"}'; exit 0; fi
	exit 64
	SH
	chmod +x "$prefix/bin/clawdi"
	`,
		);
		chmodSync(join(bin, "npm"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		seedCurrentCliInstall(stateRoot, "1.2.9-test.1");
		const paths = getRuntimePaths();
		const previousTarget = readlinkSync(paths.cliManagedBin);

		try {
			const failed = applyRuntimeCliDesiredState(cliManifest("1.2.10-test.1"), paths);
			expect(failed.status).toBe("error");
			expect(failed.retryAt).toBeString();
			expect(readlinkSync(paths.cliManagedBin)).toBe(previousTarget);
			expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"))).toMatchObject({
				activeTarget: previousTarget,
				version: "1.2.9-test.1",
				bad: { version: "1.2.10-test.1", attempts: 1, retryAt: failed.retryAt },
			});
			expect(applyRuntimeCliDesiredState(cliManifest("1.2.10-test.1"), paths).status).toBe(
				"deferred",
			);
			expect(readFileSync(npmLog, "utf-8").trim().split("\n")).toHaveLength(1);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});
});
