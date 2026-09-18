import { expect, test } from "bun:test";
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

const TASK_START_TIMEOUT_MS = 90_000;
const TASK_STOP_TIMEOUT_MS = 30_000;

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
		const script = join(root, "worker.ps1");
		const systemRoot = process.env.SystemRoot;
		if (!systemRoot)
			throw new Error("SystemRoot is required for the Windows task lifecycle fixture.");
		const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		writeFileSync(
			script,
			`\uFEFF$sequence = 0
Write-Output 'Clawdi 日志 fixture'
while ($true) {
  $sequence++
  $heartbeat = @{ pid = $PID; sequence = $sequence; value = $env:CLAWDI_TEST_VALUE } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($env:CLAWDI_TEST_HEARTBEAT, $heartbeat, [System.Text.UTF8Encoding]::new($false))
  Start-Sleep -Milliseconds 100
}`,
		);
		const ownedPids = new Set<number>();
		const readPid = () => {
			const pid = JSON.parse(readFileSync(heartbeat, "utf8")).pid as number;
			ownedPids.add(pid);
			return pid;
		};
		try {
			installWindowsTask(
				root,
				{
					command: powershell,
					args: [
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						script,
					],
					entryPath: script,
				},
				[
					{ key: "CLAWDI_TEST_HEARTBEAT", value: heartbeat },
					{ key: "CLAWDI_TEST_VALUE", value: "quote ' and $literal" },
				],
			);
			await until("worker start", () => readPid() > 0, TASK_START_TIMEOUT_MS);
			const first = readPid();
			const logPath = windowsTaskLogPath(root);
			await until(
				"daemon log",
				() => readFileSync(logPath, "utf16le").includes("Clawdi 日志 fixture"),
				TASK_STOP_TIMEOUT_MS,
			);
			expect(readFileSync(logPath).readUInt16LE(0)).toBe(0xfeff);
			expect(windowsTaskRunning()).toBe(true);
			expect(JSON.parse(readFileSync(heartbeat, "utf8")).value).toBe("quote ' and $literal");
			stopWindowsTask();
			await heartbeatStops(heartbeat);
			expect(windowsTaskInstalled()).toBe(true);
			expect(windowsTaskRunning()).toBe(false);
			restartWindowsTask();
			await until("worker restart", () => readPid() !== first, TASK_START_TIMEOUT_MS);
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
	300_000,
);

async function heartbeatStops(path: string): Promise<void> {
	await until(
		"worker stop",
		async () => {
			const before = readFileSync(path, "utf8");
			await Bun.sleep(500);
			return readFileSync(path, "utf8") === before;
		},
		TASK_STOP_TIMEOUT_MS,
	);
}

async function until(
	label: string,
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
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
