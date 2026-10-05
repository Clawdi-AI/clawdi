import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	gatewayOomProtectionLines,
	platformOomProtectionLines,
	runtimeMemoryBudget,
	withoutOomProtection,
} from "./oom-protection";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import {
	applySystemdRuntimeUpdate,
	readSystemdUnitSnapshot,
	runCommandResult,
	type SystemdUnitSnapshot,
} from "./systemd-transaction";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

const GIB = 1024 ** 3;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("uses the tightest visible ancestor limit rather than host RAM", () => {
	const files: Record<string, string> = {
		"/proc/self/cgroup": "0::/system.slice/clawdi-runtime-watch.service\n",
		"/sys/fs/cgroup/memory.max": String(4 * GIB),
		"/sys/fs/cgroup/system.slice/memory.max": String(3 * GIB),
		"/sys/fs/cgroup/system.slice/clawdi-runtime-watch.service/memory.max": "max",
	};
	expect(runtimeMemoryBudget((path) => files[path] ?? null, 64 * GIB)).toBe(3 * GIB);
	files["/sys/fs/cgroup/system.slice/memory.max"] = "invalid";
	expect(runtimeMemoryBudget((path) => files[path] ?? null, 64 * GIB)).toBe(4 * GIB);
	files["/sys/fs/cgroup/memory.max"] = "18446744073709551615";
	expect(runtimeMemoryBudget((path) => files[path] ?? null, 8 * GIB)).toBe(8 * GIB);
	expect(runtimeMemoryBudget(() => null, 8 * GIB)).toBe(8 * GIB);
	expect(
		runtimeMemoryBudget(
			(path) => (path === "/sys/fs/cgroup/memory.max" ? String(4 * GIB) : null),
			64 * GIB,
		),
	).toBe(4 * GIB);
});

test("renders continue policy and the official Hermes memory control", () => {
	expect(platformOomProtectionLines()).toContain("OOMPolicy=continue");
	expect(platformOomProtectionLines().join("\n")).not.toContain("OOMScoreAdjust");
	for (const gib of [4, 8, 16]) {
		const lines = gatewayOomProtectionLines("hermes", gib * GIB);
		expect(lines).toContain("OOMPolicy=continue");
		expect(lines).toContain(`Environment=TERMINAL_LOCAL_MEMORY_MAX_MB=${gib * 512}`);
		expect(lines.join("\n")).not.toContain("OOMScoreAdjust");
	}
	expect(gatewayOomProtectionLines("openclaw", 4 * GIB).join("\n")).not.toContain("Environment=");
});

test("excludes whole marked blocks from activation and preserves surrounding content", () => {
	const original = "[Service]\nExecStart=/bin/sleep 30\n";
	const policy = gatewayOomProtectionLines("hermes", 4 * GIB).join("\n");
	expect(withoutOomProtection(`${original}${policy}\n`)).toBe(original);
	for (const mutation of ["OOMPolicy=kill", "MemoryHigh=3G", "OOMScoreAdjust=-900"]) {
		expect(
			withoutOomProtection(`${original}${policy.replace("OOMPolicy=continue", mutation)}\n`),
		).toBe(original);
	}
	const outside = "Environment=OUTSIDE_POLICY=1\n";
	expect(withoutOomProtection(`${policy}\n${original}${policy}\n${outside}`)).toBe(
		`${original}${outside}`,
	);
	expect(withoutOomProtection(`${original}${policy}`)).toBe(original);
	const incomplete = `${original}${policy.replace("# EndClawdiOOMProtection", "")}`;
	expect(withoutOomProtection(incomplete)).toBe(incomplete);
});

function commitActivation(paths: RuntimePaths, snapshot: SystemdUnitSnapshot): void {
	writeFileSync(
		paths.appliedState,
		JSON.stringify({
			schemaVersion: "clawdi.runtimeAppliedState.v2",
			appliedAt: new Date().toISOString(),
			instanceId: "oom-fixture",
			etag: "oom-fixture",
			sourceRevision: "a".repeat(64),
			generation: 1,
			contentIdentity: { sourcePath: "fixture", sha256: "b".repeat(64) },
			activated: Object.fromEntries([...snapshot.system, ...snapshot.user]),
			providerIds: [],
			projectedProviderIds: {},
		}),
	);
}

test("policy migration reloads both managers without restarting; repeated apply is idle", () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-oom-migration-"));
	roots.push(root);
	const paths = {
		...getRuntimePaths({ mode: "local" }),
		systemdSystemRoot: join(root, "system"),
		systemdUserRoot: join(root, "user"),
		systemdEnvRoot: join(root, "env"),
		appliedState: join(root, "applied.json"),
	};
	const systemUnit = join(paths.systemdSystemRoot, "clawdi-daemon.service");
	const dropIn = join(paths.systemdUserRoot, "hermes-gateway.service.d", "10-clawdi-hosted.conf");
	for (const path of [systemUnit, dropIn]) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\n`);
	}
	const log = join(root, "commands");
	const command = join(root, "systemctl");
	writeFileSync(
		command,
		`#!/bin/sh
echo "$*" >> '${log}'
if [ "$1" = --user ]; then shift; fi
case "$1" in
show) printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nNeedDaemonReload=no\\nJob=\\n' ;;
is-enabled) printf 'enabled\\n' ;;
esac
`,
		{ mode: 0o755 },
	);
	const previous = { ...process.env };
	const expectReloadOnly = () => {
		const commands = readFileSync(log, "utf8");
		expect(commands.match(/^daemon-reload$/gm)).toHaveLength(1);
		expect(commands.match(/^--user daemon-reload$/gm)).toHaveLength(1);
		expect(commands).not.toMatch(/\b(start|restart|stop)\b/);
		writeFileSync(log, "");
	};
	try {
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = command;
		process.env.CLAWDI_RUNTIME_USER = "root";
		const before = readSystemdUnitSnapshot(paths);
		commitActivation(paths, before);
		writeFileSync(
			systemUnit,
			`${readFileSync(systemUnit, "utf8")}${platformOomProtectionLines()
				.join("\n")
				.replace("OOMPolicy=continue", "OOMScoreAdjust=-900\nOOMPolicy=continue")}\n`,
		);
		writeFileSync(
			dropIn,
			`${readFileSync(dropIn, "utf8")}${gatewayOomProtectionLines("hermes", 4 * GIB).join("\n")}\n`,
		);
		const after = readSystemdUnitSnapshot(paths);
		expect(after.system).toEqual(before.system);
		expect(after.user).toEqual(before.user);
		expect(after.reload).not.toEqual(before.reload);
		expect(
			applySystemdRuntimeUpdate(paths, before, after, { restartChangedUnits: true }),
		).toMatchObject({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: [],
		});
		expectReloadOnly();
		// Removing a legacy setting, changing a value, and adding a new directive only reload.
		writeFileSync(
			systemUnit,
			readFileSync(systemUnit, "utf8").replace("OOMScoreAdjust=-900\n", ""),
		);
		writeFileSync(
			dropIn,
			readFileSync(dropIn, "utf8")
				.replace("TERMINAL_LOCAL_MEMORY_MAX_MB=2048", "TERMINAL_LOCAL_MEMORY_MAX_MB=4096")
				.replace("# EndClawdiOOMProtection", "MemoryHigh=3G\n# EndClawdiOOMProtection"),
		);
		const updated = readSystemdUnitSnapshot(paths);
		expect(updated.system).toEqual(after.system);
		expect(updated.user).toEqual(after.user);
		expect(updated.reload).not.toEqual(after.reload);
		expect(
			applySystemdRuntimeUpdate(paths, after, updated, { restartChangedUnits: true }).applied,
		).toBe(true);
		expectReloadOnly();
		expect(applySystemdRuntimeUpdate(paths, updated, updated, {}).applied).toBe(true);
		expect(readFileSync(log, "utf8")).not.toMatch(/daemon-reload|\b(start|restart|stop)\b/);
		// A real command change still activates the service.
		writeFileSync(dropIn, `${readFileSync(dropIn, "utf8")}ExecStart=/bin/false\n`);
		applySystemdRuntimeUpdate(paths, updated, readSystemdUnitSnapshot(paths), {});
		expect(readFileSync(log, "utf8")).toContain("--user restart hermes-gateway.service");
	} finally {
		for (const key of ["CLAWDI_SYSTEMD_APPLY", "CLAWDI_SYSTEMCTL_PATH", "CLAWDI_RUNTIME_USER"]) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});

test.skipIf(process.env.CLAWDI_TEST_SYSTEMD_COMMAND !== "1")(
	"native reload preserves PID; a higher-score smaller child OOM leaves the gateway alive",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-oom-native-"));
		roots.push(root);
		const unit = `clawdi-oom-proof-${crypto.randomUUID()}.service`;
		const unitPath = `/run/systemd/system/${unit}`;
		const state = join(root, "child-result");
		const trigger = join(root, "trigger");
		const fixture = join(root, "gateway.py");
		writeFileSync(
			fixture,
			`import pathlib, subprocess, sys, time
if len(sys.argv) > 1:
    chunks = []
    for _ in range(192):
        chunks.append(bytearray(1024 * 1024))
        time.sleep(0.005)
    sys.exit(10)
resident = bytearray(80 * 1024 * 1024)
while not pathlib.Path('${trigger}').exists():
    time.sleep(0.025)
child = subprocess.Popen(['/bin/sh', '-c', 'echo 1000 > /proc/self/oom_score_adj; exec "$0" "$@"', sys.executable, __file__, 'child'])
result = child.wait()
pathlib.Path('${state}.tmp').write_text(str(result))
pathlib.Path('${state}.tmp').replace('${state}')
while True:
    time.sleep(1)
`,
		);
		const definition = `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\nExecStart=/usr/bin/python3 ${fixture}\nMemoryMax=144M\nMemorySwapMax=0\nOOMPolicy=stop\n[Install]\nWantedBy=multi-user.target\n`;
		writeFileSync(unitPath, definition);
		const paths = {
			...getRuntimePaths({ mode: "local" }),
			systemdSystemRoot: "/run/systemd/system",
			systemdUserRoot: join(root, "user"),
			systemdEnvRoot: join(root, "env"),
			appliedState: join(root, "applied.json"),
		};
		const run = (args: string[]) => {
			const result = runCommandResult("systemctl", args);
			if (result.status !== 0) throw new Error(`systemctl ${args[0]} failed: ${result.stderr}`);
			return result.stdout.trim();
		};
		const show = (property: string) => run(["show", unit, `--property=${property}`, "--value"]);
		try {
			run(["daemon-reload"]);
			run(["start", unit]);
			const pid = show("MainPID");
			const before = readSystemdUnitSnapshot(paths);
			commitActivation(paths, before);
			writeFileSync(
				unitPath,
				definition.replace(
					"OOMPolicy=stop\n",
					`OOMPolicy=stop\n${gatewayOomProtectionLines("openclaw", 2 * GIB).join("\n")}\n`,
				),
			);
			expect(
				applySystemdRuntimeUpdate(paths, before, readSystemdUnitSnapshot(paths), {}).applied,
			).toBe(true);
			expect(show("MainPID")).toBe(pid);
			expect(show("OOMPolicy")).toBe("continue");
			const cg = join("/sys/fs/cgroup", show("ControlGroup"));
			expect(readFileSync(join(cg, "memory.oom.group"), "utf8").trim()).toBe("0");
			const eventsBefore = readFileSync(join(cg, "memory.events"), "utf8");
			writeFileSync(trigger, "start");
			const deadline = Date.now() + 8_000;
			while (!existsSync(state) && Date.now() < deadline) await Bun.sleep(50);
			expect(readFileSync(state, "utf8")).toBe("-9");
			expect(show("ActiveState")).toBe("active");
			expect(show("MainPID")).toBe(pid);
			expect(readFileSync(join(cg, "memory.events"), "utf8")).not.toBe(eventsBefore);
			console.log(
				"native OOM proof: daemon-reload kept PID; child SIGKILL; gateway active; memory.oom.group=0",
			);
		} finally {
			runCommandResult("systemctl", ["stop", unit]);
			runCommandResult("systemctl", ["disable", unit]);
			rmSync(unitPath, { force: true });
			runCommandResult("systemctl", ["daemon-reload"]);
		}
	},
);
