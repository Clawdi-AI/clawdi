import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCancelledError, runCommand } from "./command-runner";

const testRoots: string[] = [];

afterEach(() => {
	for (const root of testRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("desktop command cancellation", () => {
	test("streams complete UTF-8 progress lines before the child exits", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-desktop-progress-"));
		testRoots.push(root);
		const marker = join(root, "child-state");
		const lines: string[] = [];
		const command = runCommand(
			process.execPath,
			[
				"-e",
				`const { writeFileSync, existsSync } = require("node:fs");
				const marker = process.env.CLAWDI_COMMAND_TEST_MARKER;
				const text = Buffer.from('code: ABCD-EFGH ✓\\n');
				process.stderr.write(text.subarray(0, text.length - 3));
				setTimeout(() => {
					process.stderr.write(text.subarray(text.length - 3));
					const timer = setInterval(() => {
						if (existsSync(marker)) {
							clearInterval(timer);
							process.stdout.write("done");
						}
					}, 10);
				}, 30);`,
			],
			{
				env: { ...process.env, CLAWDI_COMMAND_TEST_MARKER: marker },
				timeoutMs: 5_000,
				onStderrLine: (line) => {
					lines.push(line);
					writeFileSync(marker, "progress-received");
				},
			},
		);
		const result = await command;
		expect(lines).toEqual(["code: ABCD-EFGH ✓"]);
		expect(result).toEqual({ stdout: "done", stderr: "code: ABCD-EFGH ✓\n" });
	});

	test("terminates and waits for the child when a progress handler fails", async () => {
		await expect(
			runCommand(
				process.execPath,
				["-e", 'process.stderr.write("progress\\n"); setInterval(() => {}, 1000)'],
				{
					timeoutMs: 5_000,
					onStderrLine: () => {
						throw new Error("private upstream detail");
					},
				},
			),
		).rejects.toThrow("Clawdi returned invalid progress output.");
	});

	test("waits for the exact child to exit after cancellation", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-desktop-command-"));
		testRoots.push(root);
		const marker = join(root, "child-state");
		const controller = new AbortController();
		const command = runCommand(
			process.execPath,
			[
				"-e",
				`const { writeFileSync } = require("node:fs");
				const marker = process.env.CLAWDI_COMMAND_TEST_MARKER;
				if (!marker) process.exit(2);
				process.on("SIGTERM", () => {
					writeFileSync(marker, "exited");
					process.exit(0);
				});
				writeFileSync(marker, "ready");
				setInterval(() => {}, 1000);`,
			],
			{
				env: { ...process.env, CLAWDI_COMMAND_TEST_MARKER: marker },
				signal: controller.signal,
				timeoutMs: 5_000,
			},
		);

		await waitForFileContent(marker, "ready");
		controller.abort();
		await expect(command).rejects.toBeInstanceOf(CommandCancelledError);
		// Windows terminates the process directly; it does not deliver POSIX signals.
		expect(readFileSync(marker, "utf8")).toBe(process.platform === "win32" ? "ready" : "exited");
	});

	test("does not retroactively cancel a completed child", async () => {
		const controller = new AbortController();
		const result = await runCommand(process.execPath, ["-e", 'process.stdout.write("done")'], {
			signal: controller.signal,
			timeoutMs: 5_000,
		});
		controller.abort();
		expect(result.stdout).toBe("done");
	});
});

async function waitForFileContent(path: string, expected: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			if (readFileSync(path, "utf8") === expected) return;
		} catch {
			// The child has not created the marker yet.
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for child marker: ${expected}`);
}
