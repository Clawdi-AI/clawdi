import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installWindowsTask,
	powershellLiteral,
	restartWindowsTask,
	stopWindowsTask,
	uninstallWindowsTask,
	windowsTaskInstalled,
	windowsTaskLogPath,
	windowsTaskRunning,
	windowsTaskStatus,
} from "./windows-task";

test("PowerShell task values remain literal", () => {
	expect(powershellLiteral("C:\\User's files\\$(whoami) & test")).toBe(
		"'C:\\User''s files\\$(whoami) & test'",
	);
	expect(() => powershellLiteral("bad\0value")).toThrow();
});

test.skipIf(process.platform !== "win32" || process.env.CLAWDI_WINDOWS_TASK_TEST !== "1")(
	"native current-user task installs, stops its child, restarts and uninstalls",
	async () => {
		// Refuse to replace any pre-existing task, even with explicit test opt-in.
		expect(windowsTaskInstalled()).toBe(false);
		const root = mkdtempSync(join(tmpdir(), "clawdi 用户's lifecycle-"));
		const heartbeat = join(root, "heartbeat.json");
		const script = join(root, "worker.js");
		const node = execFileSync("where.exe", ["node.exe"], { encoding: "utf8" })
			.split(/\r?\n/)
			.find((line) => line.trim());
		if (!node) throw new Error("Node.js is required for the Windows task lifecycle fixture.");
		writeFileSync(
			script,
			`const fs = require('node:fs');
const beat = () => fs.writeFileSync(process.env.CLAWDI_TEST_HEARTBEAT, JSON.stringify({ pid: process.pid, value: process.env.CLAWDI_TEST_VALUE }));
beat(); console.log('Clawdi 日志 fixture'); setInterval(beat, 100);`,
		);
		const ownedPids = new Set<number>();
		const readPid = () => {
			const pid = JSON.parse(readFileSync(heartbeat, "utf8")).pid as number;
			ownedPids.add(pid);
			return pid;
		};
		try {
			installWindowsTask(root, { command: node.trim(), args: [script], entryPath: script }, [
				{ key: "CLAWDI_TEST_HEARTBEAT", value: heartbeat },
				{ key: "CLAWDI_TEST_VALUE", value: "quote ' and $literal" },
			]);
			await until("worker start", () => readPid() > 0);
			const first = readPid();
			const logPath = windowsTaskLogPath(root);
			await until("daemon log", () =>
				readFileSync(logPath, "utf16le").includes("Clawdi 日志 fixture"),
			);
			expect(readFileSync(logPath).readUInt16LE(0)).toBe(0xfeff);
			expect(windowsTaskRunning()).toBe(true);
			expect(JSON.parse(readFileSync(heartbeat, "utf8")).value).toBe("quote ' and $literal");
			stopWindowsTask();
			await heartbeatStops(heartbeat);
			expect(windowsTaskInstalled()).toBe(true);
			expect(windowsTaskRunning()).toBe(false);
			restartWindowsTask();
			await until("worker restart", () => readPid() !== first);
			readPid();
			expect(uninstallWindowsTask(root).removed).toBe(true);
			await heartbeatStops(heartbeat);
			expect(windowsTaskInstalled()).toBe(false);
			expect(uninstallWindowsTask(root).removed).toBe(false);
		} finally {
			try {
				uninstallWindowsTask(root);
			} finally {
				for (const pid of ownedPids) {
					try {
						process.kill(pid);
					} catch {
						/* Process has already exited. */
					}
				}
				rmSync(root, { recursive: true, force: true });
			}
		}
	},
	120_000,
);

async function heartbeatStops(path: string): Promise<void> {
	await until("worker stop", async () => {
		const before = readFileSync(path, "utf8");
		await Bun.sleep(500);
		return readFileSync(path, "utf8") === before;
	});
}

async function until(label: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			if (await predicate()) return;
		} catch {
			/* Worker has not written its first heartbeat. */
		}
		await Bun.sleep(100);
	}
	let status = "unavailable";
	try {
		status = windowsTaskStatus().join("; ");
	} catch (error) {
		status = error instanceof Error ? error.message : String(error);
	}
	throw new Error(
		`Scheduled task did not reach the expected lifecycle state: ${label}. Task status: ${status}`,
	);
}
