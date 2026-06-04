/**
 * `clawdi daemon` command tree registration.
 *
 * Extracted from `index.ts` so tests can import the real wiring
 * (parent daemon command + subcommands) onto a test-local Commander
 * tree and exercise option scoping end-to-end. Pre-fix, the test
 * file built a parallel mock tree which silently drifted from the
 * real one — codex's review of PR #73 flagged this as the test's
 * weakest link.
 */

import { type Command, Option } from "commander";

/**
 * Handlers that the daemon command tree dispatches to. Production
 * callers leave this undefined; tests pass stub handlers to
 * intercept dispatch without having to `mock.module` the whole
 * `./serve.js` module (which bleeds across test files in bun:test).
 */
export interface ServeHandlers {
	serve: (opts: Record<string, unknown>) => Promise<void> | void;
	serveInstall: (opts: Record<string, unknown>) => Promise<void> | void;
	serveUninstall: (opts: Record<string, unknown>) => Promise<void> | void;
	serveRestart: (opts: Record<string, unknown>) => Promise<void> | void;
	serveStatus: (opts: Record<string, unknown>) => Promise<void> | void;
	serveLogs: (opts: Record<string, unknown>) => Promise<void> | void;
	serveDoctor: (opts: Record<string, unknown>) => Promise<void> | void;
	serveRpc: (method: string, opts: Record<string, unknown>) => Promise<void> | void;
}

function addRpcEndpointOptions(cmd: Command): Command {
	return cmd
		.option("--rpc-host <host>", "Control RPC HTTP host")
		.option("--rpc-port <port>", "Control RPC HTTP port")
		.option("--rpc-allow-remote", "Allow the HTTP RPC listener to bind a non-loopback host");
}

function addLegacyRunOptions(cmd: Command): Command {
	return cmd
		.addOption(new Option("--agent <type>", "Legacy per-agent daemon selector").hideHelp())
		.addOption(new Option("--environment-id <id>", "Legacy per-agent environment id").hideHelp());
}

async function defaultHandlers(): Promise<ServeHandlers> {
	const m = await import("./serve.js");
	return {
		serve: m.serve,
		serveInstall: m.serveInstall,
		serveUninstall: m.serveUninstall,
		serveRestart: m.serveRestart,
		serveStatus: m.serveStatus,
		serveLogs: m.serveLogs,
		serveDoctor: m.serveDoctor,
		serveRpc: m.serveRpc,
	};
}

export function registerServeCommand(program: Command, handlers?: ServeHandlers): Command {
	const get = handlers ? () => Promise.resolve(handlers) : defaultHandlers;
	const serveCmd = program
		.command("daemon")
		.alias("serve")
		.option("--rpc-host <host>", "Control RPC HTTP host")
		.option("--rpc-port <port>", "Control RPC HTTP port")
		.option("--rpc-allow-remote", "Allow the HTTP RPC listener to bind a non-loopback host")
		.description(
			"Manage the background sync daemon — pushes local skill edits to cloud, pulls dashboard installs via SSE",
		)
		.addHelpText(
			"after",
			`
Environment:
  CLAWDI_AUTH_TOKEN       Bearer token (preferred over ~/.clawdi/auth.json)
  CLAWDI_SERVE_MODE       "container" forces polling watcher + graceful SIGTERM
  CLAWDI_STATE_DIR        Override location of queue.jsonl + health (default ~/.clawdi/serve)
  CLAWDI_DAEMON_RPC_HOST         HTTP RPC host (default 127.0.0.1)
  CLAWDI_DAEMON_RPC_PORT         HTTP RPC port (default 17654)
  CLAWDI_DAEMON_RPC_ALLOW_REMOTE Set to 1 to allow non-loopback HTTP bind
  CLAWDI_DAEMON_RPC_TOKEN        Bearer token for HTTP RPC clients (defaults to generated token file)
  CLAWDI_SERVE_DEBUG=1    Emit debug-level events to stderr

Examples:
  $ clawdi daemon run
  $ clawdi daemon run --rpc-host 127.0.0.1 --rpc-port 17654
  $ clawdi daemon ping
  $ CLAWDI_SERVE_MODE=container clawdi daemon run
  $ clawdi daemon install                       # set up one launchd / systemd unit
  $ clawdi daemon rotate-token                  # rotate the local control token
  $ clawdi daemon status --agent claude_code    # health + supervisor state
  $ clawdi serve status --agent claude_code     # legacy alias`,
		)
		.action(async (opts) => {
			// `clawdi daemon` (or legacy `clawdi serve`) with no
			// subcommand still runs the daemon in the foreground for
			// backward compatibility. `daemon run` is the clearer
			// spelling for new users.
			const h = await get();
			await h.serve(opts);
		});
	addLegacyRunOptions(serveCmd);

	addLegacyRunOptions(
		serveCmd
			.command("run")
			.description("Run the sync daemon in the foreground")
			.configureHelp({ showGlobalOptions: true })
			.addHelpText("after", "\nControl RPC listens on loopback HTTP by default.")
			.option("--rpc-host <host>", "Control RPC HTTP host")
			.option("--rpc-port <port>", "Control RPC HTTP port")
			.option("--rpc-allow-remote", "Allow the HTTP RPC listener to bind a non-loopback host"),
	).action(async (_opts, cmd) => {
		const h = await get();
		await h.serve(cmd.optsWithGlobals());
	});

	addRpcEndpointOptions(
		serveCmd
			.command("install")
			.description("Install the singleton daemon as a per-user OS service"),
	).action(async (_opts, cmd) => {
		const h = await get();
		await h.serveInstall(cmd.optsWithGlobals());
	});

	serveCmd
		.command("uninstall")
		.description("Remove the singleton daemon service unit and stop the daemon")
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveUninstall(cmd.optsWithGlobals());
		});

	serveCmd
		.command("restart")
		.description(
			"Restart the installed singleton daemon (launchctl kickstart -k on macOS, systemctl --user restart on Linux)",
		)
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveRestart(cmd.optsWithGlobals());
		});

	serveCmd
		.command("ping")
		.description("Check whether the daemon control RPC is reachable")
		.option("--rpc-host <host>", "Control RPC HTTP host to call")
		.option("--rpc-port <port>", "Control RPC HTTP port to call")
		.option("--rpc-token <token>", "Bearer token for RPC access (defaults to token file/env)")
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveRpc("ping", cmd.optsWithGlobals());
		});

	serveCmd
		.command("rotate-token")
		.description("Rotate the daemon control RPC bearer token")
		.option("--rpc-host <host>", "Control RPC HTTP host to call")
		.option("--rpc-port <port>", "Control RPC HTTP port to call")
		.option("--rpc-token <token>", "Current bearer token for RPC access")
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveRpc("rotate_token", cmd.optsWithGlobals());
		});

	serveCmd
		.command("status")
		.description("Show daemon health (last heartbeat) and supervisor state")
		.option("--agent <type>", "Agent to check (defaults to all registered agents)")
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveStatus(cmd.optsWithGlobals());
		});

	serveCmd
		.command("logs")
		.description("Tail a daemon's stderr log (delegates to `tail -F`)")
		.option("--follow", "Stream new lines as they arrive (default: print last 200 and exit)")
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveLogs(cmd.optsWithGlobals());
		});

	serveCmd
		.command("doctor")
		.description("Snapshot every registered agent's daemon state — for support handoff")
		.option("--json", "Emit machine-readable JSON instead of human-readable lines")
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveDoctor(cmd.optsWithGlobals());
		});

	return serveCmd;
}
