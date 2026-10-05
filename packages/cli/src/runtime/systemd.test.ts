import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	readComponentInvocation,
	readComponentServiceState,
	readHostedRuntimeObserved,
} from "./observed";
import { getRuntimePaths } from "./paths";
import { buildRuntimeUserCommand, PRIVILEGE_DROP_STRATEGIES } from "./runtime-user-command";
import { managedRuntimeSystemdUnitEntries, RUNTIME_SYSTEMD_DROP_IN_FILE } from "./systemd";
import {
	applySystemdRuntimeUpdate,
	assertSystemdRuntimeIdle,
	beginFirstApplyEgress,
	readSystemdUnitSnapshot,
	runCommandResult,
	SystemdReobservationRequiredError,
	shouldRecoverFailedSystemdUnit,
} from "./systemd-transaction";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeFixture(root: string, path: string, contents: string): void {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
}

describe("managed runtime systemd unit classification", () => {
	test("classifies only prefixed, generated, and exact generated drop-in units", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-systemd-classification-"));
		roots.push(root);
		const generated = `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n`;
		const dropIn = RUNTIME_SYSTEMD_DROP_IN_FILE;
		writeFixture(root, "clawdi-prefix.service", "foreign");
		writeFixture(root, "generated.service", generated);
		writeFixture(root, "foreign.service", "foreign");
		writeFixture(root, join("official.service.d", dropIn), generated);
		writeFixture(root, join("official.service.d", "20-foreign.conf"), generated);
		writeFixture(root, join("foreign.service.d", dropIn), "foreign");

		const classified = managedRuntimeSystemdUnitEntries(root)
			.map(({ kind, unitName }) => [kind, unitName])
			.sort((left, right) => left[1].localeCompare(right[1]));
		expect(classified).toEqual([
			["base-unit", "clawdi-prefix.service"],
			["base-unit", "generated.service"],
			["hosted-drop-in", "official.service"],
		]);
	});

	test("returns no units for a missing root", () => {
		const root = join(tmpdir(), `clawdi-systemd-missing-${crypto.randomUUID()}`);
		expect(managedRuntimeSystemdUnitEntries(root)).toEqual([]);
	});
});

describe("failed runtime systemd unit recovery", () => {
	test("joins early egress readiness and refuses a changed candidate or an existing job", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-egress-overlap-"));
		roots.push(root);
		const previous = { ...process.env };
		try {
			const command = join(root, "systemctl");
			const log = join(root, "commands");
			const paths = {
				...getRuntimePaths({ mode: "hosted" }),
				appliedState: join(root, "applied.json"),
				systemdSystemRoot: join(root, "units"),
				systemdUserRoot: join(root, "user-units"),
				systemdEnvRoot: join(root, "env"),
			};
			const unit = "clawdi-runtime-sidecar.service";
			writeFixture(
				root,
				`units/${unit}`,
				`${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\nExecStart=/sidecar\n`,
			);
			const writeManager = (job = "", failJoin = false) =>
				writeFileSync(
					command,
					`#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
show) printf 'LoadState=loaded\\nActiveState=inactive\\nNeedDaemonReload=no\\nJob=${job}\\n' ;;
is-enabled) printf 'disabled\\n'; exit 1 ;;
start) [ "$2" = --no-block ] || exit ${failJoin ? 1 : 0} ;;
esac
`,
					{ mode: 0o755 },
				);
			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.env.CLAWDI_SYSTEMCTL_PATH = command;
			const before = { system: new Map<string, string>(), user: new Map<string, string>() };
			writeManager();
			const finish = beginFirstApplyEgress(paths, before);
			expect(finish).not.toBeNull();
			expect(readFileSync(log, "utf8")).toContain(`start --no-block ${unit}`);
			finish?.();
			expect(readFileSync(log, "utf8")).toContain(`start ${unit}`);
			writeManager("", true);
			expect(finish).toThrow("failed (1)");
			writeFixture(
				root,
				`units/${unit}`,
				`${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\nExecStart=/changed\n`,
			);
			expect(finish).toThrow(SystemdReobservationRequiredError);
			writeManager("42");
			expect(() => beginFirstApplyEgress(paths, before)).toThrow(SystemdReobservationRequiredError);
			expect(
				beginFirstApplyEgress(paths, { ...before, system: new Map([[unit, "previous"]]) }),
			).toBeNull();
		} finally {
			process.env = previous;
		}
	});

	test.skipIf(process.env.CLAWDI_TEST_SYSTEMD_COMMAND !== "1")(
		"fresh Hermes overlaps platform startup and retains pending-job admission",
		() => {
			const root = mkdtempSync(join(tmpdir(), "hermes-start-order-"));
			roots.push(root);
			const environment = { ...process.env };
			const paths = {
				...getRuntimePaths({ mode: "local" }),
				runRoot: join(root, "run"),
				appliedState: join(root, "applied.json"),
				systemdSystemRoot: join(root, "system"),
				systemdUserRoot: join(root, "user"),
				systemdEnvRoot: join(root, "env"),
			};
			const dashboard = "clawdi-hermes-dashboard.service";
			const gateway = "hermes-gateway.service";
			const platform = "clawdi-platform-fixture.service";
			for (const [scope, units] of [
				["user", [dashboard, gateway]],
				["system", [platform]],
			] as const)
				for (const unit of units)
					writeFixture(
						root,
						`${scope}/${unit}`,
						`${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\nExecStart=/fixture\n`,
					);
			writeFixture(root, "run/hermes-warmed", "prepared\n");
			const command = join(root, "bin/systemctl");
			const log = join(root, "commands");
			const pending = join(root, "pending");
			writeFixture(
				root,
				"bin/systemctl",
				`#!/bin/bash
set -eu
echo "$*" >> '${log}'
[ "$1" != --user ] || shift
op=$1; shift
case "$op" in
show)
 for unit in "$@"; do
  [[ "$unit" != --* ]] || continue
  active=inactive; [ ! -f '${root}/'$unit.active ] || active=active
  job=; [ ! -f '${pending}' ] || job=42
  printf 'LoadState=loaded\\nActiveState=%s\\nNeedDaemonReload=no\\nJob=%s\\n\\n' "$active" "$job"
 done ;;
is-enabled) for unit in "$@"; do echo enabled; done ;;
start) for unit in "$@"; do touch '${root}/'$unit.active; done ;;
esac
`,
			);
			writeFixture(root, "bin/curl", "#!/bin/sh\necho 200\n");
			try {
				execFileSync("chmod", ["755", command, join(root, "bin/curl")]);
				execFileSync("chmod", ["600", join(paths.runRoot, "hermes-warmed")]);
				process.env.CLAWDI_SYSTEMD_APPLY = "1";
				process.env.CLAWDI_SYSTEMCTL_PATH = command;
				process.env.CLAWDI_RUNTIME_USER = "root";
				process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
				const snapshot = readSystemdUnitSnapshot(paths);
				writeFileSync(pending, "pending");
				expect(() =>
					applySystemdRuntimeUpdate(paths, snapshot, snapshot, { earlyFreshHermes: true }),
				).toThrow(SystemdReobservationRequiredError);
				expect(readFileSync(log, "utf8")).not.toContain("start ");
				rmSync(pending);
				writeFileSync(log, "");
				expect(
					applySystemdRuntimeUpdate(paths, snapshot, snapshot, { earlyFreshHermes: true }).applied,
				).toBe(true);
				const calls = readFileSync(log, "utf8").trim().split("\n");
				expect(calls.indexOf(`--user start ${dashboard}`)).toBeLessThan(
					calls.indexOf(`start ${platform}`),
				);
				expect(calls.indexOf(`start ${platform}`)).toBeLessThan(
					calls.indexOf(`--user start ${gateway}`),
				);
			} finally {
				process.env = environment;
			}
		},
	);

	test.skipIf(process.env.CLAWDI_TEST_SYSTEMD_COMMAND !== "1")(
		"observes real batched manager IDs without mixing active and inactive units",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "native-batched-state-"));
			roots.push(root);
			const paths = {
				...getRuntimePaths({ mode: "hosted" }),
				serviceStateRoot: root,
				bootStatus: join(root, "boot.json"),
				appliedState: join(root, "applied.json"),
				runtimeWatchStatus: join(root, "watch.json"),
				systemdSystemRoot: "/etc/systemd/system",
				systemdUserRoot: join(root, "user"),
			};
			const units = ["clawdi-batch-active.service", "clawdi-batch-inactive.service"];
			try {
				for (const unit of units)
					writeFileSync(
						join(paths.systemdSystemRoot, unit),
						"[Service]\nExecStart=/bin/sleep 60\n",
					);
				execFileSync("systemctl", ["daemon-reload"]);
				execFileSync("systemctl", ["start", units[0]]);
				const observed = await readHostedRuntimeObserved(paths);
				expect(observed?.systemd?.units.filter((unit) => units.includes(unit.name))).toEqual([
					expect.objectContaining({ name: units[0], status: "ok", activeState: "active" }),
					expect.objectContaining({ name: units[1], status: "unknown", activeState: "inactive" }),
				]);
			} finally {
				execFileSync("systemctl", ["stop", ...units]);
				for (const unit of units) rmSync(join(paths.systemdSystemRoot, unit), { force: true });
				execFileSync("systemctl", ["daemon-reload"]);
			}
		},
	);

	test("reobserves an existing job before issuing mutations", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-systemd-pending-"));
		roots.push(root);
		const command = join(root, "systemctl");
		const log = join(root, "commands");
		const previous = {
			apply: process.env.CLAWDI_SYSTEMD_APPLY,
			command: process.env.CLAWDI_SYSTEMCTL_PATH,
		};
		try {
			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.env.CLAWDI_SYSTEMCTL_PATH = command;
			const paths = {
				...getRuntimePaths({ mode: "local" }),
				appliedState: join(root, "absent.json"),
			};
			const snapshot = {
				system: new Map([["clawdi-fixture.service", "revision"]]),
				user: new Map<string, string>(),
			};
			const writeManager = (job: string, activeState = "active") =>
				writeFileSync(
					command,
					`#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
show) printf 'LoadState=loaded\\nActiveState=${activeState}\\nSubState=${activeState === "activating" ? "auto-restart" : "running"}\\nNeedDaemonReload=no\\nJob=${job}\\n' ;;
is-enabled) printf 'enabled\\n' ;;
esac
`,
					{ mode: 0o755 },
				);
			writeManager("42");
			expect(() => applySystemdRuntimeUpdate(paths, snapshot, snapshot, {})).toThrow(
				SystemdReobservationRequiredError,
			);
			expect(readFileSync(log, "utf8")).not.toMatch(/restart|start|stop|daemon-reload/);
			writeManager("", "activating");
			expect(() => assertSystemdRuntimeIdle(paths, snapshot)).not.toThrow();
			expect(applySystemdRuntimeUpdate(paths, snapshot, snapshot, {}).applied).toBe(false);
			writeManager("");
			expect(applySystemdRuntimeUpdate(paths, snapshot, snapshot, {}).applied).toBe(true);
			writeManager("invalid");
			expect(() => assertSystemdRuntimeIdle(paths, snapshot)).toThrow("invalid Job");
			writeFileSync(command, "#!/bin/sh\nprintf 'bus unavailable' >&2\nexit 1\n");
			expect(() => assertSystemdRuntimeIdle(paths, snapshot)).toThrow("bus unavailable");
			expect(() => assertSystemdRuntimeIdle(paths, { system: new Map(), user: new Map() })).toThrow(
				"bus unavailable",
			);
		} finally {
			if (previous.apply === undefined) delete process.env.CLAWDI_SYSTEMD_APPLY;
			else process.env.CLAWDI_SYSTEMD_APPLY = previous.apply;
			if (previous.command === undefined) delete process.env.CLAWDI_SYSTEMCTL_PATH;
			else process.env.CLAWDI_SYSTEMCTL_PATH = previous.command;
		}
	});
	test("bounds an unresponsive client without treating the manager job as cancelled", () => {
		const start = Date.now();
		expect(() =>
			runCommandResult(
				"/bin/sh",
				["-c", "trap '' TERM; sh -c 'trap \"\" TERM; while :; do :; done' & wait"],
				undefined,
				50,
			),
		).toThrow(SystemdReobservationRequiredError);
		expect(Date.now() - start).toBeLessThan(5_000);
		expect(runCommandResult("/bin/sh", ["-c", "printf active"], undefined, 1_000)).toMatchObject({
			status: 0,
			stdout: "active",
		});
	});
	test.skipIf(process.env.CLAWDI_TEST_SYSTEMD_COMMAND !== "1")(
		"verifies native Job rendering and privilege-wrapper descendant deadlines",
		() => {
			const unit = `clawdi-command-proof-${crypto.randomUUID()}.service`;
			const path = `/run/systemd/system/${unit}`;
			writeFileSync(path, "[Service]\nType=oneshot\nExecStart=/bin/sleep 30\n");
			try {
				expect(runCommandResult("systemctl", ["daemon-reload"]).status).toBe(0);
				const idle = runCommandResult("systemctl", ["show", "--all", "--property=Job", unit]);
				expect(idle.stdout.trim()).toBe("Job=");
				expect(runCommandResult("systemctl", ["start", "--no-block", unit]).status).toBe(0);
				const busy = runCommandResult("systemctl", ["show", "--all", "--property=Job", unit]);
				expect(busy.stdout.trim()).toMatch(/^Job=[1-9][0-9]*$/);
				expect(() => runCommandResult("systemctl", ["start", unit], undefined, 100)).toThrow(
					SystemdReobservationRequiredError,
				);
				expect(
					runCommandResult("systemctl", ["show", "--all", "--property=Job", unit]).stdout.trim(),
				).toMatch(/^Job=[1-9][0-9]*$/);
				for (const { mechanism } of PRIVILEGE_DROP_STRATEGIES) {
					const child = buildRuntimeUserCommand(
						"clawdi",
						"/home/clawdi",
						"/bin/sh",
						["-c", "trap '' TERM; sh -c 'trap \"\" TERM; while :; do :; done' & wait"],
						{
							runtimeUid: 10001,
							runtimeGid: 10001,
							preserveSession: true,
							resolver: { resolve: () => mechanism },
						},
					);
					const started = Date.now();
					expect(() => runCommandResult(child.command, child.args, child.env, 100)).toThrow(
						SystemdReobservationRequiredError,
					);
					expect(Date.now() - started).toBeLessThan(3_000);
				}
				expect(runCommandResult("systemctl", ["stop", unit]).status).toBe(0);
				expect(
					runCommandResult("systemctl", ["show", "--all", "--property=Job", unit]).stdout.trim(),
				).toBe("Job=");
				const version = runCommandResult("systemctl", ["--version"]).stdout.split("\n")[0];
				console.log(
					`native ${version} proof: ${idle.stdout.trim()}, ${busy.stdout.trim()}; all wrapper deadlines passed`,
				);
			} finally {
				runCommandResult("systemctl", ["stop", unit]);
				rmSync(path);
				runCommandResult("systemctl", ["daemon-reload"]);
			}
		},
	);
	test.skipIf(process.env.CLAWDI_TEST_SYSTEMD_COMMAND !== "1")(
		"allows no-job auto-restart to reach final proof without claiming it is healthy",
		async () => {
			const unit = `clawdi-restart-proof-${crypto.randomUUID()}.service`;
			const path = `/run/systemd/system/${unit}`;
			const definition = (command: string) =>
				`[Service]\nExecStart=${command}\nRestart=always\nRestartSec=60\n[Install]\nWantedBy=multi-user.target\n`;
			const paths = {
				...getRuntimePaths({ mode: "local" }),
				systemdSystemRoot: "/run/systemd/system",
				appliedState: join(tmpdir(), `${unit}.absent.json`),
			};
			const snapshot = { system: new Map([[unit, "fixture"]]), user: new Map<string, string>() };
			writeFileSync(path, definition("/bin/false"));
			try {
				runCommandResult("systemctl", ["daemon-reload"]);
				runCommandResult("systemctl", ["start", unit]);
				let observed = "";
				const deadline = Date.now() + 5_000;
				do {
					observed = runCommandResult("systemctl", [
						"show",
						"--all",
						"--property=ActiveState",
						"--property=SubState",
						"--property=Job",
						unit,
					]).stdout;
					if (observed.includes("SubState=auto-restart")) break;
					await Bun.sleep(25);
				} while (Date.now() < deadline);
				expect(observed).toContain("ActiveState=activating");
				expect(observed).toContain("SubState=auto-restart");
				expect(observed).toMatch(/^Job=$/m);
				expect(() => assertSystemdRuntimeIdle(paths, snapshot)).not.toThrow();
				expect(applySystemdRuntimeUpdate(paths, snapshot, snapshot, {}).applied).toBe(false);
				writeFileSync(path, definition("/bin/sleep 30"));
				runCommandResult("systemctl", ["daemon-reload"]);
				expect(runCommandResult("systemctl", ["restart", unit]).status).toBe(0);
				expect(applySystemdRuntimeUpdate(paths, snapshot, snapshot, {}).applied).toBe(true);
				const invocation = readComponentInvocation(paths, "system", unit);
				const component = readComponentServiceState(paths, "system", unit);
				if (!component || !invocation) throw new Error("Native component evidence missing");
				expect(component.invocationId).toBe(invocation);
				expect(invocation).toMatch(/^[a-f0-9]{32}$/);
				expect(runCommandResult("systemctl", ["restart", unit]).status).toBe(0);
				expect(readComponentInvocation(paths, "system", unit)).not.toBe(invocation);
				expect(readComponentServiceState(paths, "system", unit)?.configurationRevision).toBe(
					component?.configurationRevision,
				);
				console.log(
					`native crash-loop proof: ${observed.trim().replaceAll("\n", ", ")}; readiness required after repair`,
				);
			} finally {
				runCommandResult("systemctl", ["stop", unit]);
				rmSync(path);
				runCommandResult("systemctl", ["daemon-reload"]);
			}
		},
	);
	test("recovers a failed unit when the current activation changed it", () => {
		expect(
			shouldRecoverFailedSystemdUnit({
				activeState: "failed",
				changed: true,
				pendingActivation: false,
				recoverFailedUnits: false,
			}),
		).toBe(true);
		expect(
			shouldRecoverFailedSystemdUnit({
				activeState: "failed",
				changed: false,
				pendingActivation: true,
				recoverFailedUnits: false,
			}),
		).toBe(true);
	});

	test("leaves an unchanged failed unit for the scheduled recovery pass", () => {
		expect(
			shouldRecoverFailedSystemdUnit({
				activeState: "failed",
				changed: false,
				pendingActivation: false,
				recoverFailedUnits: false,
			}),
		).toBe(false);
	});
});
