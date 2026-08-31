import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCancelledError, runCommand } from "./command-runner";

const testRoots: string[] = [];

afterEach(() => {
	for (const root of testRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("desktop command cancellation", () => {
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
		expect(readFileSync(marker, "utf8")).toBe("exited");
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
