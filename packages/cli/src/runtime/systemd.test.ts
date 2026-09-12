import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getRuntimePaths } from "./paths";
import { buildRuntimeUserCommand, PRIVILEGE_DROP_STRATEGIES } from "./runtime-user-command";
import { managedRuntimeSystemdUnitEntries, RUNTIME_SYSTEMD_DROP_IN_FILE } from "./systemd";
import {
	applySystemdRuntimeUpdate,
	assertSystemdRuntimeIdle,
	runCommandResult,
	SystemdReobservationRequiredError,
	shouldRecoverFailedSystemdUnit,
	withRuntimeUserServiceStopped,
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

describe("managed runtime service maintenance", () => {
	test.each([
		{
			state: "active",
			managed: true,
			job: "",
			failure: "",
			mutations: ["stop", "repair", "start"],
		},
		{
			state: "activating",
			managed: true,
			job: "",
			failure: "",
			mutations: ["stop", "repair", "start"],
		},
		{ state: "inactive", managed: true, job: "", failure: "", mutations: ["repair"] },
		{ state: "active", managed: false, job: "", failure: "", mutations: [] },
		{ state: "active", managed: true, job: "42", failure: "", mutations: [] },
		{
			state: "active",
			managed: true,
			job: "",
			failure: "repair failed",
			mutations: ["stop", "repair", "start"],
		},
		{
			state: "active",
			managed: true,
			job: "",
			failure: "unknown",
			mutations: ["stop", "repair", "start"],
		},
	])("coordinates $state service (managed=$managed, job=$job, failure=$failure)", (scenario) => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-systemd-maintenance-"));
		roots.push(root);
		const previous = { ...process.env };
		try {
			const unit = "openclaw-gateway.service";
			const paths = {
				...getRuntimePaths({ mode: "local" }),
				systemdSystemRoot: join(root, "system"),
				systemdUserRoot: join(root, "user"),
				systemdEnvRoot: join(root, "env"),
				userHome: root,
			};
			writeFixture(
				paths.systemdUserRoot,
				unit,
				scenario.managed ? GENERATED_RUNTIME_SYSTEMD_FILE_HEADER : "foreign",
			);
			const statePath = join(root, "state");
			const log = join(root, "mutations");
			writeFileSync(statePath, scenario.state);
			writeFileSync(log, "");
			const command = join(root, "systemctl");
			writeFileSync(
				command,
				`#!/bin/sh
set -eu
if [ "$1" = --user ]; then shift; fi
case "$1" in
show) printf 'LoadState=loaded\\nActiveState=%s\\nNeedDaemonReload=no\\nJob=${scenario.job}\\nFragmentPath=${join(paths.systemdUserRoot, unit)}\\n' "$(cat '${statePath}')" ;;
is-enabled) printf 'enabled\\n' ;;
stop) echo stop >> '${log}'; echo inactive > '${statePath}' ;;
start) echo start >> '${log}'; echo active > '${statePath}' ;;
*) exit 64 ;;
esac
`,
				{ mode: 0o755 },
			);
			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.env.CLAWDI_SYSTEMCTL_PATH = command;
			process.env.CLAWDI_RUNTIME_USER = "root";
			const repair = () =>
				withRuntimeUserServiceStopped(paths, unit, () => {
					expect(readFileSync(statePath, "utf8").trim()).toBe("inactive");
					writeFileSync(log, `${readFileSync(log, "utf8")}repair\n`);
					if (scenario.failure === "unknown") throw new SystemdReobservationRequiredError();
					if (scenario.failure) throw new Error(scenario.failure);
				});
			for (let attempt = 0; attempt < 2; attempt++) {
				writeFileSync(log, "");
				if (scenario.failure || scenario.job || !scenario.managed) expect(repair).toThrow();
				else repair();
				expect(readFileSync(log, "utf8").trim().split("\n").filter(Boolean)).toEqual([
					...scenario.mutations,
				]);
			}
		} finally {
			process.env = previous;
		}
	});
});

describe("failed runtime systemd unit recovery", () => {
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
