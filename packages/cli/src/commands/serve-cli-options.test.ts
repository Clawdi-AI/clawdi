import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerServeCommand, type ServeHandlers } from "./serve-cli";

/**
 * Regression tests for the `clawdi daemon` command tree wiring.
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
		serveRpc: async (_method: string, opts: Record<string, unknown>) => {
			captured.last = opts;
		},
	};
}

function buildTree(): { program: Command; captured: { last: Record<string, unknown> | null } } {
	const captured = { last: null as Record<string, unknown> | null };
	const program = new Command();
	registerServeCommand(program, makeHandlers(captured));
	return { program, captured };
}

describe("registerServeCommand", () => {
	it("daemon install reaches the action with no target selector", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "daemon", "install"]);
		expect(captured.last).toEqual({});
	});

	it("daemon run reaches the foreground action with no target selector", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "daemon", "run"]);
		expect(captured.last).toEqual({});
	});

	it("daemon run accepts RPC HTTP host and port", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync([
			"node",
			"clawdi",
			"daemon",
			"run",
			"--rpc-host",
			"127.0.0.1",
			"--rpc-port",
			"17654",
		]);
		expect(captured.last?.rpcHost).toBe("127.0.0.1");
		expect(captured.last?.rpcPort).toBe("17654");
	});

	it("daemon run accepts the non-loopback HTTP RPC opt-in", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "daemon", "run", "--rpc-allow-remote"]);
		expect(captured.last?.rpcAllowRemote).toBe(true);
	});

	it("daemon run accepts hidden legacy selector args for supervisor migration", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync([
			"node",
			"clawdi",
			"daemon",
			"run",
			"--agent",
			"codex",
			"--environment-id",
			"env-codex",
		]);
		expect(captured.last?.agent).toBe("codex");
		expect(captured.last?.environmentId).toBe("env-codex");
	});

	it("daemon with no subcommand still runs the foreground action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "daemon"]);
		expect(captured.last).toEqual({});
	});

	it("daemon with no subcommand accepts RPC HTTP host and port", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync([
			"node",
			"clawdi",
			"daemon",
			"--rpc-host",
			"127.0.0.1",
			"--rpc-port",
			"17654",
		]);
		expect(captured.last?.rpcHost).toBe("127.0.0.1");
		expect(captured.last?.rpcPort).toBe("17654");
	});

	it("daemon with no subcommand accepts the non-loopback HTTP RPC opt-in", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "daemon", "--rpc-allow-remote"]);
		expect(captured.last?.rpcAllowRemote).toBe(true);
	});

	it("legacy serve with no subcommand still runs the foreground action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve"]);
		expect(captured.last).toEqual({});
	});

	it("uninstall reaches the action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "uninstall"]);
		expect(captured.last).toEqual({});
	});

	it("install accepts RPC HTTP host and port", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync([
			"node",
			"clawdi",
			"daemon",
			"install",
			"--rpc-host",
			"127.0.0.1",
			"--rpc-port",
			"17654",
		]);
		expect(captured.last?.rpcHost).toBe("127.0.0.1");
		expect(captured.last?.rpcPort).toBe("17654");
	});

	it("install accepts the non-loopback HTTP RPC opt-in", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "daemon", "install", "--rpc-allow-remote"]);
		expect(captured.last?.rpcAllowRemote).toBe(true);
	});

	it("restart reaches the action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "restart"]);
		expect(captured.last).toEqual({});
	});

	it("ping reaches the daemon ping RPC", async () => {
		const captured = {
			lastMethod: null as string | null,
			last: null as Record<string, unknown> | null,
		};
		const program = new Command();
		registerServeCommand(program, {
			...makeHandlers(captured),
			serveRpc: async (method: string, opts: Record<string, unknown>) => {
				captured.lastMethod = method;
				captured.last = opts;
			},
		});

		await program.parseAsync(["node", "clawdi", "daemon", "ping"]);

		expect(captured.lastMethod).toBe("ping");
		expect(captured.last).toEqual({});
	});

	it("rotate-token reaches the token rotation RPC", async () => {
		const captured = {
			lastMethod: null as string | null,
			last: null as Record<string, unknown> | null,
		};
		const program = new Command();
		registerServeCommand(program, {
			...makeHandlers(captured),
			serveRpc: async (method: string, opts: Record<string, unknown>) => {
				captured.lastMethod = method;
				captured.last = opts;
			},
		});

		await program.parseAsync([
			"node",
			"clawdi",
			"daemon",
			"rotate-token",
			"--rpc-host",
			"127.0.0.1",
			"--rpc-port",
			"17654",
			"--rpc-token",
			"tok-test",
		]);

		expect(captured.lastMethod).toBe("rotate_token");
		expect(captured.last?.rpcHost).toBe("127.0.0.1");
		expect(captured.last?.rpcPort).toBe("17654");
		expect(captured.last?.rpcToken).toBe("tok-test");
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

	it("logs --follow flows through", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "logs", "--follow"]);
		expect(captured.last?.follow).toBe(true);
	});

	it("doctor --json reaches the action", async () => {
		const { program, captured } = buildTree();
		await program.parseAsync(["node", "clawdi", "serve", "doctor", "--json"]);
		expect(captured.last?.json).toBe(true);
	});
});
