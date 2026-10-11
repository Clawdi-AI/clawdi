import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyRuntimeManifestLoad } from "../src/commands/runtime";
import * as manifest from "../src/runtime/manifest";
import { runtimeConvergenceWithoutApply } from "../src/runtime/manifest-planning";
import type { RuntimeManifestLoad } from "../src/runtime/manifest-source";
import { adoptableWarmOpenClawGatewayUnits } from "../src/runtime/openclaw-warm-gateway";
import { getRuntimePaths } from "../src/runtime/paths";
import { warmHostedOpenClawRuntime } from "../src/runtime/runtime-warm";
import { writeFakeOpenClawConfigMutationSdk } from "../src/test-support/openclaw-config-mutation";

const environment = { ...process.env };
const roots: string[] = [];
const gateway = "openclaw-gateway.service";

afterEach(() => {
	mock.restore();
	process.env = { ...environment };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, contents: string, mode = 0o600) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, { mode });
}

function fixture(hotApply: string | undefined) {
	const root = mkdtempSync(join(tmpdir(), "clawdi-warm-openclaw-"));
	roots.push(root);
	const runtimeUser = String(process.getuid?.() ?? 1000);
	Object.assign(process.env, {
		CLAWDI_RUNTIME_HOME: join(root, "home"),
		CLAWDI_HOME: join(root, "clawdi-home"),
		CLAWDI_SERVICE_STATE_DIR: join(root, "state"),
		CLAWDI_RUN_DIR: join(root, "run"),
		CLAWDI_SYSTEMD_SYSTEM_ROOT: join(root, "run/systemd/system"),
		CLAWDI_SYSTEMD_APPLY: "1",
		CLAWDI_SYSTEMCTL_PATH: join(root, "bin/systemctl"),
		CLAWDI_RUNTIME_USER: runtimeUser,
		PATH: `${join(root, "bin")}:${process.env.PATH}`,
	});
	if (hotApply === undefined) delete process.env.CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY;
	else process.env.CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY = hotApply;
	const paths = getRuntimePaths({ mode: "hosted" });
	const command = join(paths.userHome, ".local/bin/openclaw");
	const config = writeFakeOpenClawConfigMutationSdk(paths.userHome);
	write(
		command,
		`#!/bin/sh
case "$*" in
 "--version") echo 'OpenClaw 2026.8.1' ;;
 "agents list --json") printf '[{"id":"main","workspace":"%s"}]\\n' "$HOME/.openclaw/workspace" ;;
 *) exit 0 ;;
esac
`,
		0o755,
	);
	write(join(paths.systemdUserRoot, gateway), `[Service]\nExecStart=${command} gateway run\n`);
	mkdirSync(paths.systemdSystemRoot, { recursive: true });
	write(
		join(paths.serviceStateRoot, "preinstallation/receipt.json"),
		JSON.stringify({
			schemaVersion: "clawdi.runtime-preinstallation.v1",
			imageFingerprint: "b".repeat(64),
			architecture: process.arch,
			cliPackageSpec: "clawdi@1.2.3",
			runtime: "openclaw",
			preparedAt: "2026-10-11T00:00:00Z",
		}),
	);
	const log = join(root, "commands");
	const active = join(root, "gateway-active");
	const firstRun = join(paths.userHome, ".openclaw/identity/device.json");
	const stopFailure = join(root, "stop-failure");
	write(
		join(root, "bin/systemctl"),
		`#!/bin/bash
set -eu
echo "$*" >> '${log}'
if [ "$1" = --user ]; then shift; fi
if [ "$1" = -M ]; then shift 2; fi
op=$1; shift
case "$op" in
show)
 for unit in "$@"; do
  [[ "$unit" != --* ]] || continue
  state=inactive; [ ! -f '${active}' ] || state=active
  printf 'Id=%s\\nLoadState=loaded\\nActiveState=%s\\nNeedDaemonReload=no\\nJob=\\nInvocationID=%032x\\n\\n' "$unit" "$state" 1
 done ;;
is-enabled) for unit in "$@"; do echo enabled; done ;;
start|restart)
 for unit in "$@"; do
  if [ "$unit" = '${gateway}' ]; then
   touch '${active}'
   mkdir -p '${dirname(firstRun)}'
   if [ ! -f '${firstRun}' ]; then echo '{"id":"anonymous-first-run"}' > '${firstRun}'; fi
  fi
 done ;;
stop)
 [ ! -f '${stopFailure}' ] || exit 1
 for unit in "$@"; do if [ "$unit" = '${gateway}' ]; then rm '${active}'; fi; done ;;
daemon-reload|enable|reset-failed) ;;
*) exit 2 ;;
esac
`,
		0o755,
	);
	spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
	return {
		paths,
		runtimeUser,
		log,
		active,
		firstRun,
		config,
		stopFailure,
		marker: join(paths.statusRoot, "openclaw-warm-gateway.json"),
	};
}

test.each([undefined, "0", "1"])(
	"OpenClaw warm and claim preserve first-run state with hot apply=%s",
	async (hotApply) => {
		const f = fixture(hotApply);
		await warmHostedOpenClawRuntime(f.paths, f.runtimeUser);
		const adopt = hotApply === "1";
		expect(existsSync(f.active)).toBe(adopt);
		expect(existsSync(f.marker)).toBe(adopt);
		expect(adoptableWarmOpenClawGatewayUnits(f.paths)).toEqual(adopt ? [gateway] : []);
		const initialized = readFileSync(f.firstRun, "utf8");
		expect(JSON.parse(initialized)).toEqual({ id: "anonymous-first-run" });
		expect(JSON.parse(readFileSync(f.config, "utf8")).gateway.mode).toBe("local");
		expect(
			readFileSync(f.log, "utf8").includes(`--user -M ${f.runtimeUser}@ stop ${gateway}`),
		).toBe(!adopt);
		const load: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				workspaceRoot: f.paths.userHome,
				deploymentId: "dep_test",
				environmentId: "env_test",
				instanceId: "iid_test",
				generation: 1,
				issuedAt: "2026-10-11T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud.test" },
				runtimes: {},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://openclaw-warm-claim",
			offline: false,
		};
		const warmEnvironment = readFileSync(join(f.paths.systemdEnvRoot, `${gateway}.env`), "utf8");
		// Isolate tenant projection, retaining the actual claim callbacks and systemd transaction.
		spyOn(manifest, "convergeRuntimeManifest").mockImplementation((_load, paths, options) => {
			write(
				join(paths.systemdEnvRoot, `${gateway}.env`),
				`${warmEnvironment}CLAWDI_MANAGED_CONTENT_DIGEST="tenant"\n`,
			);
			options?.systemdApply?.activate({
				staleSystemUnits: [],
				staleUserUnits: [],
				invalidatedUserUnits: [],
			});
			return runtimeConvergenceWithoutApply({
				load,
				paths,
				workspaceRoot: paths.userHome,
				enabledRuntimes: [],
				installErrors: [],
				projectedProviderIds: {},
			});
		});
		writeFileSync(f.log, "");
		expect((await applyRuntimeManifestLoad(load, f.paths)).kind).toBe("converged");
		const calls = readFileSync(f.log, "utf8").trim().split("\n");
		expect(calls.filter((call) => call === `--user start ${gateway}`)).toHaveLength(adopt ? 0 : 1);
		expect(calls.filter((call) => call === `--user restart ${gateway}`)).toHaveLength(0);
		expect(existsSync(f.active)).toBe(true);
		expect(existsSync(f.marker)).toBe(false);
		expect(readFileSync(f.firstRun, "utf8")).toBe(initialized);
	},
);

test("OpenClaw warm fails if its default-off anonymous gateway cannot stop", async () => {
	const f = fixture(undefined);
	write(f.stopFailure, "fail\n");
	await expect(warmHostedOpenClawRuntime(f.paths, f.runtimeUser)).rejects.toThrow(
		"anonymous OpenClaw gateway did not stop",
	);
	expect(existsSync(f.marker)).toBe(false);
});
