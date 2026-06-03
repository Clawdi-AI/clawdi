import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rejectUnsupportedOpts } from "./serve";

/**
 * Behavior tests for the post-codex-review fixes:
 *   - rejectUnsupportedOpts (helper used by status/uninstall/restart/logs/doctor)
 *   - singleton daemon handlers rejecting legacy target selectors
 *
 * Strategy: swap `process.exit` to throw a tagged error so we can
 * `expect(...).toThrow()` and inspect the captured `console.error`
 * output. Real listRegisteredAgentTypes / file-system calls are
 * left in place — the test environment has 0 registered agents,
 * which is enough to hit every "rejects before reaching the OS"
 * branch we care about.
 */

const captured = {
	stderr: [] as string[],
	exitCode: null as number | null,
};

class ExitCalled extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
	}
}

let restoreExit: (() => void) | null = null;

beforeEach(() => {
	captured.stderr = [];
	captured.exitCode = null;
	const origExit = process.exit;
	const origErr = console.error;
	process.exit = ((code?: number) => {
		captured.exitCode = code ?? 0;
		throw new ExitCalled(code ?? 0);
	}) as typeof process.exit;
	console.error = (...args: unknown[]) => {
		captured.stderr.push(args.map(String).join(" "));
	};
	restoreExit = () => {
		process.exit = origExit;
		console.error = origErr;
	};
});

afterEach(() => {
	restoreExit?.();
	restoreExit = null;
});

describe("rejectUnsupportedOpts", () => {
	const ALLOWED = new Set(["agent", "json"]);

	it("returns silently when opts only contain allowed keys", () => {
		expect(() => rejectUnsupportedOpts("foo", { agent: "x", json: true }, ALLOWED)).not.toThrow();
		expect(captured.exitCode).toBeNull();
	});

	it("returns silently on empty opts", () => {
		expect(() => rejectUnsupportedOpts("foo", {}, ALLOWED)).not.toThrow();
		expect(captured.exitCode).toBeNull();
	});

	it("exits 1 when an unsupported key is present", () => {
		expect(() =>
			rejectUnsupportedOpts("doctor", { agent: "codex", environmentId: "x" }, new Set(["json"])),
		).toThrow(ExitCalled);
		expect(captured.exitCode).toBe(1);
		// Both offenders surfaced, kebab-cased, in the error.
		const msg = captured.stderr.join("\n");
		expect(msg).toMatch(/daemon doctor/);
		expect(msg).toMatch(/--agent/);
		expect(msg).toMatch(/--environment-id/);
	});

	it("kebab-cases camelCase option names in the error", () => {
		expect(() =>
			rejectUnsupportedOpts("status", { environmentId: "x" }, new Set(["agent"])),
		).toThrow(ExitCalled);
		expect(captured.stderr.join("\n")).toMatch(/--environment-id/);
		expect(captured.stderr.join("\n")).not.toMatch(/--environmentId/);
	});
});

describe("subcommand handler rejects parent-leaked options", () => {
	it("install rejects legacy selectors", async () => {
		const { serveInstall } = await import("./serve");
		await expect(serveInstall({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon install.*--agent/);
	});

	it("uninstall rejects legacy selectors", async () => {
		const { serveUninstall } = await import("./serve");
		await expect(serveUninstall({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon uninstall.*--agent/);
	});

	it("restart rejects legacy selectors", async () => {
		const { serveRestart } = await import("./serve");
		await expect(serveRestart({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon restart.*--agent/);
	});

	it("uninstall rejects --environment-id", async () => {
		const { serveUninstall } = await import("./serve");
		await expect(
			serveUninstall({
				environmentId: "00000000-0000-0000-0000-000000000001",
			} as Record<string, unknown>),
		).rejects.toThrow(ExitCalled);
		expect(captured.stderr.join("\n")).toMatch(/daemon uninstall.*--environment-id/);
	});

	it("status rejects --environment-id", async () => {
		const { serveStatus } = await import("./serve");
		await expect(
			serveStatus({
				environmentId: "00000000-0000-0000-0000-000000000001",
			} as Record<string, unknown>),
		).rejects.toThrow(ExitCalled);
		expect(captured.stderr.join("\n")).toMatch(/daemon status.*--environment-id/);
	});

	it("doctor rejects --agent", async () => {
		const { serveDoctor } = await import("./serve");
		await expect(serveDoctor({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon doctor.*--agent/);
	});
});
