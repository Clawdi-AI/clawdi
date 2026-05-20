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

import type { Command } from "commander";

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
	};
}

export function registerServeCommand(program: Command, handlers?: ServeHandlers): Command {
	const get = handlers ? () => Promise.resolve(handlers) : defaultHandlers;
	const serveCmd = program
		.command("daemon")
		.alias("serve")
		.description(
			"Manage the background sync daemon — pushes local skill edits to cloud, pulls dashboard installs via SSE",
		)
		.option("--agent <type>", "Agent to service (claude_code, codex, hermes, openclaw)")
		.option("--environment-id <id>", "Environment id (overrides ~/.clawdi/environments/*.json)")
		.addHelpText(
			"after",
			`
Environment:
  CLAWDI_AUTH_TOKEN       Bearer token (preferred over ~/.clawdi/auth.json)
  CLAWDI_ENVIRONMENT_ID   Same as --environment-id
  CLAWDI_SERVE_MODE       "container" forces polling watcher + graceful SIGTERM
  CLAWDI_STATE_DIR        Override location of queue.jsonl + health (default ~/.clawdi/serve)
  CLAWDI_SERVE_DEBUG=1    Emit debug-level events to stderr

Examples:
  $ clawdi daemon run --agent claude_code
  $ CLAWDI_SERVE_MODE=container clawdi daemon run --agent claude_code
  $ clawdi daemon install --agent claude_code   # set up launchd / systemd unit
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

	serveCmd
		.command("run")
		.description("Run the sync daemon in the foreground")
		.option("--agent <type>", "Agent to service (claude_code, codex, hermes, openclaw)")
		.option("--environment-id <id>", "Environment id (overrides ~/.clawdi/environments/*.json)")
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serve(cmd.optsWithGlobals());
		});

	serveCmd
		.command("install")
		.description("Install the daemon as a per-user OS service (launchd on macOS, systemd on Linux)")
		.option(
			"--agent <type>",
			"Agent to service (auto-picked when only one is registered; required when multiple)",
		)
		.option("--all", "Install a daemon unit for every registered agent on this machine")
		.option(
			"--environment-id <id>",
			"Pin a specific environment id into the unit (single-agent only; ignored with --all)",
		)
		// `optsWithGlobals` merges parent (`serveCmd`) options with this
		// subcommand's. Without it, `--agent` defined on both the parent
		// (`clawdi daemon --agent X`) and the child (`clawdi daemon install
		// --agent X`) makes commander hand the child action ONLY the
		// child-scoped opts, so `clawdi daemon install --agent codex` lost
		// the agent and silently installed the default. Same fix applied
		// to uninstall + status below.
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveInstall(cmd.optsWithGlobals());
		});

	serveCmd
		.command("uninstall")
		.description("Remove the per-user OS service unit and stop the daemon")
		.option(
			"--agent <type>",
			"Agent to uninstall (auto-picked when only one is registered; required when multiple)",
		)
		.option("--all", "Uninstall the daemon unit for every registered agent on this machine")
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveUninstall(cmd.optsWithGlobals());
		});

	serveCmd
		.command("restart")
		.description(
			"Restart an installed daemon (launchctl kickstart -k on macOS, systemctl --user restart on Linux)",
		)
		.option(
			"--agent <type>",
			"Agent to restart (auto-picked when only one is registered; required when multiple)",
		)
		.option("--all", "Restart every installed daemon on this machine")
		.action(async (_opts, cmd) => {
			const h = await get();
			await h.serveRestart(cmd.optsWithGlobals());
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
		.option(
			"--agent <type>",
			"Agent whose log to tail (auto-picked when only one is registered; required when multiple)",
		)
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
