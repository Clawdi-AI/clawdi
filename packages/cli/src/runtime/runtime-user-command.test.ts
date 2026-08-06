import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
	commandExists,
	runRuntimeUserCommand,
	spawnRuntimeUserCommand,
} from "./runtime-user-command";

test("command existence follows shell resolution", () => {
	expect(commandExists("command")).toBe(true);
	expect(commandExists("clawdi-command-that-does-not-exist")).toBe(false);
});

describe("runtime user command timeout", () => {
	test("bounds synchronous runtime-user commands", () => {
		expect(() =>
			runRuntimeUserCommand("bash", ["-c", "while :; do :; done"], "", tmpdir(), tmpdir(), {
				timeoutMs: 20,
			}),
		).toThrow();
	});

	test("reports a bounded runtime-user probe timeout", () => {
		const result = spawnRuntimeUserCommand(
			"bash",
			["-c", "while :; do :; done"],
			tmpdir(),
			tmpdir(),
			{ timeoutMs: 20 },
		);
		expect(result.status).toBeNull();
		expect(result.error?.message).toContain("ETIMEDOUT");
	});
});
