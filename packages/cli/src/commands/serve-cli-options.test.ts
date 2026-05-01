import { describe, expect, it } from "bun:test";
import { Command } from "commander";

describe("serve subcommand option scoping", () => {
	// Regression test for the v0.5.2 bug: parent `serveCmd` defined
	// `--agent` (for `clawdi serve --agent X` running the daemon
	// foreground), and install/uninstall/status redefined the same
	// `--agent` on each subcommand. Commander's default action binding
	// hands the subcommand action only the child-scoped opts, so
	// `clawdi serve install --agent codex` silently dropped the agent
	// and installed the default.
	//
	// The fix uses `cmd.optsWithGlobals()` inside each subcommand's
	// action to merge parent + child options. These tests pin the
	// invariant: regardless of which side of the subcommand `--agent`
	// is passed on, the action sees it.

	function buildServeTree(captured: { opts: Record<string, unknown> | null }): Command {
		const program = new Command();
		const serve = program
			.command("serve")
			.option("--agent <type>", "agent")
			.option("--environment-id <id>", "env id");

		serve
			.command("install")
			.option("--agent <type>", "agent")
			.option("--all", "install for every agent")
			.option("--environment-id <id>", "env id")
			.action((_opts, cmd) => {
				captured.opts = cmd.optsWithGlobals();
			});

		serve
			.command("uninstall")
			.option("--agent <type>", "agent")
			.option("--all", "uninstall every agent")
			.action((_opts, cmd) => {
				captured.opts = cmd.optsWithGlobals();
			});

		serve
			.command("status")
			.option("--agent <type>", "agent")
			.action((_opts, cmd) => {
				captured.opts = cmd.optsWithGlobals();
			});

		return program;
	}

	it("install --agent codex (child-side) reaches the action", () => {
		const cap = { opts: null as Record<string, unknown> | null };
		buildServeTree(cap).parse(["node", "clawdi", "serve", "install", "--agent", "codex"]);
		expect(cap.opts?.agent).toBe("codex");
	});

	it("install with --agent on parent side also reaches the action", () => {
		// `clawdi serve --agent codex install` — the user passed
		// --agent before the subcommand. Without optsWithGlobals,
		// the action received `agent: undefined`.
		const cap = { opts: null as Record<string, unknown> | null };
		buildServeTree(cap).parse(["node", "clawdi", "serve", "--agent", "codex", "install"]);
		expect(cap.opts?.agent).toBe("codex");
	});

	it("uninstall --all is visible to action", () => {
		const cap = { opts: null as Record<string, unknown> | null };
		buildServeTree(cap).parse(["node", "clawdi", "serve", "uninstall", "--all"]);
		expect(cap.opts?.all).toBe(true);
		expect(cap.opts?.agent).toBeUndefined();
	});

	it("status --agent claude_code (child-side) reaches the action", () => {
		const cap = { opts: null as Record<string, unknown> | null };
		buildServeTree(cap).parse(["node", "clawdi", "serve", "status", "--agent", "claude_code"]);
		expect(cap.opts?.agent).toBe("claude_code");
	});

	it("status without --agent gives undefined (caller defaults to all)", () => {
		// `serveStatus` branches on `opts.agent` being falsy to list
		// every registered daemon. This test pins that the parser
		// hands the action `agent: undefined` (not e.g. an empty
		// string), so the falsy check works.
		const cap = { opts: null as Record<string, unknown> | null };
		buildServeTree(cap).parse(["node", "clawdi", "serve", "status"]);
		expect(cap.opts?.agent).toBeUndefined();
	});

	it("install --environment-id flows through too", () => {
		const cap = { opts: null as Record<string, unknown> | null };
		buildServeTree(cap).parse([
			"node",
			"clawdi",
			"serve",
			"install",
			"--agent",
			"codex",
			"--environment-id",
			"env_123",
		]);
		expect(cap.opts?.agent).toBe("codex");
		expect(cap.opts?.environmentId).toBe("env_123");
	});
});
