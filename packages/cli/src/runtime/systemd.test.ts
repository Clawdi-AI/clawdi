import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getRuntimePaths } from "./paths";
import { managedRuntimeSystemdUnitEntries, RUNTIME_SYSTEMD_DROP_IN_FILE } from "./systemd";
import {
	applySystemdRuntimeUpdate,
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
			const writeManager = (job: string) =>
				writeFileSync(
					command,
					`#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
show) printf 'LoadState=loaded\\nActiveState=active\\nNeedDaemonReload=no\\nJob=${job}\\n' ;;
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
			writeManager("");
			expect(applySystemdRuntimeUpdate(paths, snapshot, snapshot, {}).applied).toBe(true);
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
			runCommandResult("/bin/sh", ["-c", "trap '' TERM; while :; do :; done"], undefined, 50),
		).toThrow(SystemdReobservationRequiredError);
		expect(Date.now() - start).toBeLessThan(5_000);
		expect(runCommandResult("/bin/sh", ["-c", "printf active"], undefined, 1_000)).toMatchObject({
			status: 0,
			stdout: "active",
		});
	});
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
