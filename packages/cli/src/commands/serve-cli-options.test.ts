import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerServeCommand, type ServeHandlers } from "./serve-cli";

/**
 * Regression tests for the `clawdi serve` command tree wiring.
 *
 * `index.ts` and this test both call `registerServeCommand` —
 * earlier rounds maintained a parallel mock tree, which silently
 * drifted from production (codex flagged in PR #73 review). The
 * registration accepts an optional `handlers` argument so we can
 * intercept dispatch without `mock.module` (which bleeds across
 * test files in bun:test).
 */

function makeHandlers(captured: { last: Record<string, unknown> | null }): ServeHandlers {
	const recordOpts = async (opts: Record<string, unknown>) => {
		captured.last = opts;
	};
	return {
		serve: recordOpts,
		serveInstall: recordOpts,
		serveUninstall: recordOpts,
		serveRestart: recordOpts,
		serveStatus: recordOpts,
		serveLogs: recordOpts,
		serveDoctor: recordOpts,
	};
}

function buildTree(): { program: Command; captured: { last: Record<string, unknown> | null } } {
	const captured = { last: null as Record<string, unknown> | null };
	const program = new Command();
	registerServeCommand(program, makeHandlers(captured));
	return { program, captured };
}

describe("registerServeCommand", () => {
	it("install --agent codex (child-side) reaches the action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "install", "--agent", "codex"]);
		expect(captured.last?.agent).toBe("codex");
	});

	it("install with --agent on parent side also reaches the action", async () => {
		// `clawdi serve --agent codex install` — the user passed
		// --agent before the subcommand. Without optsWithGlobals,
		// the action received `agent: undefined`.
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "--agent", "codex", "install"]);
		expect(captured.last?.agent).toBe("codex");
	});

	it("install --agent codex --environment-id <uuid> flows through", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync([
			"node",
			"clawdi",
			"serve",
			"install",
			"--agent",
			"codex",
			"--environment-id",
			"00000000-0000-0000-0000-000000000001",
		]);
		expect(captured.last?.agent).toBe("codex");
		expect(captured.last?.environmentId).toBe("00000000-0000-0000-0000-000000000001");
	});

	it("uninstall --all is visible to action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "uninstall", "--all"]);
		expect(captured.last?.all).toBe(true);
		expect(captured.last?.agent).toBeUndefined();
	});

	it("status --agent claude_code (child-side) reaches the action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "status", "--agent", "claude_code"]);
		expect(captured.last?.agent).toBe("claude_code");
	});

	it("status without --agent gives undefined (caller defaults to all)", async () => {
		// `serveStatus` branches on `opts.agent` being falsy to list
		// every registered daemon. This test pins that the parser
		// hands the action `agent: undefined` (not e.g. an empty
		// string), so the falsy check works.
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "status"]);
		expect(captured.last?.agent).toBeUndefined();
	});

	it("restart --all reaches the action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "restart", "--all"]);
		expect(captured.last?.all).toBe(true);
	});

	it("logs --follow flows through", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "logs", "--follow", "--agent", "codex"]);
		expect(captured.last?.follow).toBe(true);
		expect(captured.last?.agent).toBe("codex");
	});

	it("doctor --json reaches the action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "doctor", "--json"]);
		expect(captured.last?.json).toBe(true);
	});

	it("doctor passes through --agent (validated/rejected by handler, not parser)", async () => {
		// Commander accepts `--agent X` on doctor because parent
		// defines it, even though doctor itself doesn't. The handler
		// is the one that says "doctor doesn't accept --agent" via
		// `rejectUnsupportedOpts`. This test pins the parser-level
		// invariant: agent IS visible to the action so the handler
		// can produce the right error message.
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "doctor", "--agent", "codex"]);
		expect(captured.last?.agent).toBe("codex");
		expect(captured.last?.json).toBeUndefined();
	});
});
