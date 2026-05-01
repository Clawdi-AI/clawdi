/**
 * `clawdi serve` daemon entry.
 *
 * Long-lived process. Watches local skill directories, mirrors
 * cloud changes back to the local agent, posts heartbeats, and
 * keeps a bounded retry queue to survive transient outages.
 *
 * Three deploy contexts share this same code:
 *   - laptop: started by the user via `clawdi serve install`
 *     (launchd / systemd unit) or `clawdi serve` in a tmux pane
 *   - VPS: same as laptop (systemd unit)
 *   - hosted pod: pid-1 in a sidecar container; auth via
 *     CLAWDI_AUTH_TOKEN env, env id passed via flag or env var
 *
 * The differences (signals, fs.watch vs poll, log format) are
 * controlled by `CLAWDI_SERVE_MODE`:
 *   - "container" — force poll watcher, exit 0 on SIGTERM (k8s
 *     graceful), no startup auth check (env may not be ready
 *     yet on first boot)
 *   - "host" (default) — fs.watch, normal SIGINT/SIGTERM
 *
 * Logs are JSON-per-line on stderr; stdout is reserved.
 */

import { existsSync, readFileSync } from "node:fs";
import { AGENT_TYPES, type AgentType } from "../adapters/registry";
import { isLoggedIn } from "../lib/config";
import { adapterForType, getEnvIdByAgent, listRegisteredAgentTypes } from "../lib/select-adapter";
import { getCliVersion } from "../lib/version";
import { startAutoRestart } from "../serve/auto-restart";
import {
	install as installService,
	listInstalledAgents,
	readHealth,
	restart as restartService,
	statusLines as serviceStatusLines,
	uninstall as uninstallService,
} from "../serve/installer";
import { log, toErrorMessage } from "../serve/log";
import { getServeLogPath, getServeStateDir } from "../serve/paths";
import { runSyncEngine } from "../serve/sync-engine";

interface ServeOpts {
	agent?: string;
	environmentId?: string;
}

/**
 * Reject parent (`serveCmd`) global options that bled into a
 * subcommand which doesn't use them. Pre-fix `clawdi serve doctor
 * --agent codex` and `clawdi serve status --environment-id <id>`
 * silently accepted those flags (because parent defines them for the
 * foreground daemon's use) but ignored them — leaving users with no
 * signal that their command had no effect. Codex flagged this as
 * P2; we fail-loud now.
 */
export function rejectUnsupportedOpts(
	cmdName: string,
	opts: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): void {
	const offenders: string[] = [];
	for (const key of Object.keys(opts)) {
		if (!allowed.has(key)) offenders.push(key);
	}
	if (offenders.length > 0) {
		const flags = offenders.map(camelToFlag).join(", ");
		console.error(
			`\`serve ${cmdName}\` does not accept ${flags}. ` + `See \`clawdi serve ${cmdName} --help\`.`,
		);
		process.exit(1);
	}
}

function camelToFlag(name: string): string {
	return `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export async function serve(opts: ServeOpts): Promise<void> {
	const mode = (process.env.CLAWDI_SERVE_MODE ?? "host").toLowerCase();
	const isContainer = mode === "container";

	if (!isLoggedIn()) {
		log.error("serve.no_auth", {
			hint: "Set CLAWDI_AUTH_TOKEN env or run `clawdi auth login`.",
		});
		process.exit(1);
	}

	const { agentType, adapter } = pickAgent(opts.agent);
	if (!adapter) {
		log.error("serve.no_agent", {
			hint: "Run `clawdi setup` to register an agent on this machine.",
		});
		process.exit(1);
	}

	const environmentId = resolveEnvironmentId(opts.environmentId, agentType);
	if (!environmentId) {
		log.error("serve.no_environment", {
			agent: agentType,
			hint: "Pass --environment-id, set CLAWDI_ENVIRONMENT_ID, or run `clawdi setup`.",
		});
		process.exit(1);
	}

	log.info("serve.boot", {
		mode,
		agent_type: agentType,
		environment_id: environmentId,
		state_dir: getServeStateDir(agentType),
		pid: process.pid,
	});

	const abort = new AbortController();
	const triggerShutdown = (signal: string) => {
		log.info("serve.signal", { signal });
		abort.abort();
	};

	// In container mode SIGTERM is graceful (kubelet sends it
	// during pod termination). On host, both SIGINT (ctrl-c) and
	// SIGTERM (systemctl stop) flow through the same shutdown.
	process.once("SIGINT", () => triggerShutdown("SIGINT"));
	process.once("SIGTERM", () => triggerShutdown("SIGTERM"));

	// Crash-loop detection courtesy: if the daemon exits within 5s
	// of boot, supervisors (systemd, k8s) flag it loudly. We don't
	// add a delay here — the engine itself tolerates SSE failures
	// and the heartbeat posts during outages — but a hard crash
	// means setup is wrong, and the supervisor's restart-with-
	// backoff is the right answer.

	// Watch our own bundled JS for updates; if `npm i -g clawdi`
	// or `bun run build:dev` rewrites the file, abort cleanly so
	// launchd / systemd respawns the daemon with the new code.
	// Skip in container mode — k8s rolls pods on its own schedule
	// and self-restart inside a pod fights the orchestrator.
	if (!isContainer) {
		const watching = await startAutoRestart({ abort });
		if (watching) {
			log.info("serve.auto_restart_armed", { entry: watching });
		}
	}

	try {
		await runSyncEngine({
			environmentId,
			adapter,
			abort: abort.signal,
			abortController: abort,
			forcePollWatcher: isContainer,
		});
	} catch (e) {
		log.error("serve.fatal", { error: toErrorMessage(e) });
		process.exit(1);
	}

	// Preserve any non-zero exitCode the engine set (e.g. auth
	// failure → 1). A naked `process.exit(0)` would otherwise mask
	// the failure and supervisors would stop restarting on a
	// revoked deploy-key.
	const code = process.exitCode ?? 0;
	log.info("serve.exit", { code });
	process.exit(code);
}

interface ServeInstallOpts {
	agent?: string;
	all?: boolean;
	environmentId?: string;
}

export async function serveInstall(opts: ServeInstallOpts): Promise<void> {
	if (!isLoggedIn()) {
		console.error("Not logged in. Run `clawdi auth login` first — the daemon needs an api key.");
		process.exit(1);
	}
	if (opts.all) {
		// `--all` is the recommended path on multi-agent machines: one
		// invocation, one daemon-per-agent, no shell loops in the docs.
		// Failures on a single agent shouldn't abort the rest — surface
		// per-agent results and exit non-zero only if every install
		// failed.
		if (opts.agent) {
			// Mutex: --all targets every registered agent; --agent
			// targets one. Both at once is contradictory and pre-fix
			// --all silently won, e.g. `serve uninstall --all --agent
			// codex` looked like "uninstall codex with extras" but
			// actually nuked everything.
			console.error(
				"--all and --agent are mutually exclusive. --all targets every registered agent; --agent targets one.",
			);
			process.exit(1);
		}
		const registered = listRegisteredAgentTypes();
		if (registered.length === 0) {
			console.error("No agents registered. Run `clawdi setup` first.");
			process.exit(1);
		}
		// `--environment-id` deliberately rejected for `--all`. A
		// single id pinned across every agent unit defeats the
		// per-agent env model — every daemon would `resolveEnvironmentId`
		// to the same value and trample each other's scope. Each
		// agent picks up its own id from `~/.clawdi/environments/<agent>.json`
		// (written by `clawdi setup`), or fail loudly if missing.
		if (opts.environmentId) {
			console.error(
				"--environment-id can't be combined with --all. Each agent's env is read from " +
					"~/.clawdi/environments/<agent>.json (written by `clawdi setup`); pinning a " +
					"single id across every unit would route every daemon to the same scope.",
			);
			process.exit(1);
		}
		let installed = 0;
		let failed = 0;
		for (const agentType of registered) {
			try {
				if (getEnvIdByAgent(agentType) === null) {
					throw new Error(`no environment configured (run \`clawdi setup --agent ${agentType}\`)`);
				}
				const result = installService({ agent: agentType });
				const verb = result.replaced ? "(replaced)" : "(new)";
				console.log(`✓ ${agentType} ${verb}: ${result.unit}`);
				installed += 1;
			} catch (e) {
				console.error(`✗ ${agentType}: ${toErrorMessage(e)}`);
				failed += 1;
			}
		}
		console.log(`\n${installed} installed, ${failed} failed.`);
		// Exit non-zero on any failure, not just total wipeout. CI /
		// scripted callers need to know to retry the failed agents;
		// silently exiting 0 with "2 of 4 installed" hides partial
		// breakage in `set -e` pipelines.
		if (failed > 0) process.exit(1);
		return;
	}
	const { agentType, adapter } = pickAgent(opts.agent);
	if (!adapter) {
		console.error("No agent registered. Run `clawdi setup` first.");
		process.exit(1);
	}
	// Pre-flight: when --environment-id isn't pinned at install time,
	// the unit defers env-id resolution to daemon boot, which reads
	// `~/.clawdi/environments/<agent>.json`. Without that file the
	// unit boots into a no-op crash loop. Codex flagged: pre-fix the
	// CLI happily wrote the unit, the user only saw the failure when
	// they tailed the daemon's stderr 30 seconds later. Catch it here
	// with an actionable error.
	if (!opts.environmentId && getEnvIdByAgent(agentType) === null) {
		console.error(
			`No environment configured for ${agentType} ` +
				`(missing ~/.clawdi/environments/${agentType}.json). ` +
				`Run \`clawdi setup --agent ${agentType}\` first, or pass --environment-id <uuid>.`,
		);
		process.exit(1);
	}
	try {
		const result = installService({
			agent: agentType,
			environmentId: opts.environmentId,
		});
		// Surface "replaced existing unit" so users running install
		// after a CLI upgrade understand that the new plist /
		// systemd unit just got written and the daemon was
		// restarted. Pre-fix the message was identical for fresh
		// vs reinstall, leaving "did anything actually change?"
		// ambiguous.
		const verb = result.replaced ? "Replaced existing" : "Installed";
		console.log(`✓ ${verb} daemon unit: ${result.unit}`);
		console.log(result.instructions);
	} catch (e) {
		console.error(`Install failed: ${toErrorMessage(e)}`);
		process.exit(1);
	}
}

const UNINSTALL_ALLOWED = new Set(["agent", "all"]);
const STATUS_ALLOWED = new Set(["agent"]);
const DOCTOR_ALLOWED = new Set(["json"]);

export async function serveUninstall(opts: ServeInstallOpts): Promise<void> {
	rejectUnsupportedOpts("uninstall", opts as Record<string, unknown>, UNINSTALL_ALLOWED);
	if (opts.all) {
		// Symmetric with `install --all` — one invocation, every
		// daemon gone. Pre-fix users had to loop in the shell
		// (`for a in claude_code codex; do clawdi serve uninstall --agent $a`),
		// which is exactly the friction `install --all` exists to
		// remove.
		if (opts.agent) {
			console.error(
				"--all and --agent are mutually exclusive. --all uninstalls every daemon; --agent uninstalls one.",
			);
			process.exit(1);
		}
		const registered = listRegisteredAgentTypes();
		if (registered.length === 0) {
			console.log("No agents registered.");
			return;
		}
		let removed = 0;
		let failed = 0;
		for (const agentType of registered) {
			try {
				const result = uninstallService({ agent: agentType });
				if (result.removed) {
					console.log(`✓ ${agentType}: removed`);
					removed += 1;
				} else {
					console.log(`(${agentType}: no daemon unit installed)`);
				}
			} catch (e) {
				console.error(`✗ ${agentType}: ${toErrorMessage(e)}`);
				failed += 1;
			}
		}
		console.log(`\n${removed} removed, ${failed} failed.`);
		if (failed > 0) process.exit(1);
		return;
	}
	const { agentType } = pickAgent(opts.agent);
	try {
		const result = uninstallService({ agent: agentType });
		if (result.removed) {
			console.log(`✓ Removed daemon unit for ${agentType}.`);
		} else {
			console.log(`(no daemon unit installed for ${agentType})`);
		}
	} catch (e) {
		console.error(`Uninstall failed: ${toErrorMessage(e)}`);
		process.exit(1);
	}
}

const RESTART_ALLOWED = new Set(["agent", "all"]);

export async function serveRestart(opts: ServeInstallOpts): Promise<void> {
	rejectUnsupportedOpts("restart", opts as Record<string, unknown>, RESTART_ALLOWED);
	if (opts.all) {
		if (opts.agent) {
			console.error(
				"--all and --agent are mutually exclusive. --all restarts every daemon; --agent restarts one.",
			);
			process.exit(1);
		}
		// Source from `listInstalledAgents` (scans the OS supervisor)
		// rather than `listRegisteredAgentTypes` (reads the env-file
		// registry). Pre-fix `restart --all` would silently skip a
		// daemon whose env file got deleted but whose plist was
		// still installed and the process still running — codex
		// flagged this as the surface that mattered for actually
		// touching every running daemon.
		const installed = listInstalledAgents();
		if (installed.length === 0) {
			console.log("No daemon units installed.");
			return;
		}
		let restarted = 0;
		let failed = 0;
		for (const agentType of installed) {
			try {
				restartService({ agent: agentType });
				console.log(`✓ ${agentType}: restarted`);
				restarted += 1;
			} catch (e) {
				console.error(`✗ ${agentType}: ${toErrorMessage(e)}`);
				failed += 1;
			}
		}
		console.log(`\n${restarted} restarted, ${failed} failed.`);
		if (failed > 0) process.exit(1);
		return;
	}
	const { agentType } = pickAgent(opts.agent);
	try {
		restartService({ agent: agentType });
		console.log(`✓ Restarted daemon for ${agentType}.`);
	} catch (e) {
		console.error(`Restart failed: ${toErrorMessage(e)}`);
		process.exit(1);
	}
}

export async function serveStatus(opts: ServeInstallOpts): Promise<void> {
	rejectUnsupportedOpts("status", opts as Record<string, unknown>, STATUS_ALLOWED);
	// Without --agent, list every registered daemon — `serve install
	// --all` is the recommended path on multi-agent machines and
	// status should mirror that. Falling through `pickAgent` here used
	// to silently hide all-but-one daemon's state behind a warning,
	// which made debugging multi-agent setups (the actual common case)
	// confusing. With --agent, scope to that one daemon.
	const targets: AgentType[] = opts.agent
		? [pickAgent(opts.agent).agentType]
		: listRegisteredAgentTypes();
	if (targets.length === 0) {
		console.log("No agents registered yet — run `clawdi setup` first.");
		return;
	}
	for (const [i, agentType] of targets.entries()) {
		if (i > 0) console.log("");
		printAgentStatus(agentType);
	}
}

function printAgentStatus(agentType: AgentType): void {
	const stateDir = getServeStateDir(agentType);
	const health = readHealth(stateDir);
	console.log(`agent:   ${agentType}`);
	console.log(`state:   ${stateDir}`);
	if (health.exists) {
		// The 90s cutoff matches the dashboard's "online/offline"
		// freshness window. A daemon writing `health` more recently
		// than that AND posting heartbeats is what we call "live".
		const fresh = health.ageSeconds !== null && health.ageSeconds < 90;
		console.log(`health:  ${fresh ? "✓ live" : "stale"} (last write ${health.ageSeconds}s ago)`);
	} else {
		console.log("health:  (no health file — daemon never ran or wrote elsewhere)");
	}
	if (health.version) {
		// Surface daemon-vs-CLI version drift. After a `bun install
		// -g clawdi@latest` the dist/index.js gets replaced;
		// auto-restart picks it up within seconds, but until it
		// fires the user can't tell which version is actually
		// running. Spelling the gap out beats a silent stale state.
		const cliVersion = getCliVersion();
		if (health.version !== cliVersion) {
			console.log(
				`version: daemon=${health.version}, CLI=${cliVersion} ` +
					"⚠ drift — run `clawdi serve restart --all` to pick up the latest",
			);
		} else {
			console.log(`version: ${health.version}`);
		}
	}
	for (const line of serviceStatusLines({ agent: agentType })) {
		console.log(line);
	}
}

interface ServeLogsOpts {
	agent?: string;
	follow?: boolean;
}

const LOGS_ALLOWED = new Set(["agent", "follow"]);

export async function serveLogs(opts: ServeLogsOpts): Promise<void> {
	rejectUnsupportedOpts("logs", opts as Record<string, unknown>, LOGS_ALLOWED);
	const { agentType } = pickAgent(opts.agent);
	const { spawn } = await import("node:child_process");
	// Per-platform log access. macOS launchd routes the unit's
	// `StandardErrorPath` to a file we own (we wrote it in the
	// plist), so `tail` works. Linux systemd routes
	// `StandardError=journal` to journald — there's no file to
	// tail, so we delegate to `journalctl --user -u <unit>`.
	// Codex flagged the original implementation: it used `tail`
	// unconditionally and silently failed (or worse, errored) on
	// Linux because `~/.clawdi/serve/logs/<agent>.stderr.log`
	// never gets created.
	const platform = process.platform;
	let cmd: string;
	let args: string[];
	if (platform === "linux") {
		const unit = `clawdi-serve-${agentType}.service`;
		cmd = "journalctl";
		args = opts.follow
			? ["--user", "-u", unit, "-n", "200", "-f"]
			: ["--user", "-u", unit, "-n", "200"];
	} else if (platform === "darwin") {
		const path = getServeLogPath(agentType, "stderr");
		if (!existsSync(path)) {
			console.error(
				`No log file at ${path} ` +
					`(daemon for ${agentType} hasn't started yet — run \`clawdi serve install --agent ${agentType}\`).`,
			);
			process.exit(1);
		}
		cmd = "tail";
		args = opts.follow ? ["-n", "200", "-F", path] : ["-n", "200", path];
	} else {
		console.error(`unsupported platform for serve logs: ${platform}`);
		process.exit(1);
	}
	const proc = spawn(cmd, args, { stdio: "inherit" });
	proc.on("exit", (code) => process.exit(code ?? 0));
}

interface ServeDoctorOpts {
	json?: boolean;
}

export async function serveDoctor(opts: ServeDoctorOpts): Promise<void> {
	rejectUnsupportedOpts("doctor", opts as Record<string, unknown>, DOCTOR_ALLOWED);
	// `clawdi serve doctor` — single-call snapshot of every
	// daemon's runtime state, designed for support handoff and
	// for the dashboard's "What's wrong with my sync?" panel
	// (round-5 must-have #3). Shows per-agent: registration,
	// state-dir path, last-heartbeat age, OS supervisor unit
	// state, daemon entrypoint binary. JSON mode is for
	// programmatic callers.
	const cliVersion = getCliVersion();
	const registered = listRegisteredAgentTypes();
	const report = registered.map((agent) => {
		const stateDir = getServeStateDir(agent);
		const health = readHealth(stateDir);
		const fresh = health.exists && health.ageSeconds !== null && health.ageSeconds < 90;
		const status = fresh ? "live" : health.exists ? "stale" : "never_ran";
		return {
			agent,
			state_dir: stateDir,
			supervisor: serviceStatusLines({ agent }),
			daemon_version: health.version,
			version_drift: health.version !== null && health.version !== cliVersion,
			heartbeat: health.exists
				? { age_seconds: health.ageSeconds, status }
				: { age_seconds: null, status },
		};
	});
	const summary = {
		entrypoint: process.argv[1] ?? null,
		node: process.execPath,
		cli_version: cliVersion,
		registered_agents: registered.length,
		api_url: process.env.CLAWDI_API_URL ?? null,
		agents: report,
	};
	if (opts.json) {
		console.log(JSON.stringify(summary, null, 2));
		return;
	}
	console.log(`entrypoint:  ${summary.entrypoint ?? "?"}`);
	console.log(`node:        ${summary.node}`);
	console.log(`cli version: ${summary.cli_version}`);
	console.log(`agents:      ${summary.registered_agents}`);
	console.log("");
	if (registered.length === 0) {
		console.log("No agents registered yet — run `clawdi setup` first.");
		return;
	}
	let anyDrift = false;
	for (const r of report) {
		console.log(`── ${r.agent} ──`);
		console.log(`state dir: ${r.state_dir}`);
		const hb = r.heartbeat;
		if (hb.status === "live") {
			console.log(`heartbeat: ✓ live (${hb.age_seconds}s ago)`);
		} else if (hb.status === "stale") {
			console.log(`heartbeat: ✗ stale (${hb.age_seconds}s ago)`);
		} else {
			console.log("heartbeat: — never ran");
		}
		if (r.daemon_version) {
			if (r.version_drift) {
				console.log(`version:   ⚠ daemon=${r.daemon_version}, CLI=${cliVersion}`);
				anyDrift = true;
			} else {
				console.log(`version:   ${r.daemon_version}`);
			}
		}
		for (const line of r.supervisor) {
			console.log(line);
		}
		console.log("");
	}
	if (anyDrift) {
		console.log(
			"⚠ One or more daemons are running an older CLI version. " +
				"Run `clawdi serve restart --all` to pick up the latest.",
		);
	}
}

function isAgentType(s: string): s is AgentType {
	return (AGENT_TYPES as readonly string[]).includes(s);
}

function pickAgent(explicit: string | undefined): {
	agentType: AgentType;
	adapter: ReturnType<typeof adapterForType>;
} {
	const registered = listRegisteredAgentTypes();
	if (explicit) {
		// Validate against AGENT_TYPES before narrowing — otherwise
		// `--agent foo` slipped through as an `as AgentType` cast,
		// adapterForType returned null, and the daemon started in
		// a useless half-state. Exit early with a clear error.
		if (!isAgentType(explicit)) {
			log.error("serve.unknown_agent", {
				agent: explicit,
				known: AGENT_TYPES,
			});
			console.error(`Unknown agent: ${explicit}. Expected one of: ${AGENT_TYPES.join(", ")}`);
			process.exit(1);
		}
		const adapter = adapterForType(explicit);
		return { agentType: explicit, adapter };
	}
	if (registered.length === 0) {
		return { agentType: "claude_code", adapter: null };
	}
	if (registered.length > 1) {
		// Fail-fast on multi-agent without an explicit pick. Pre-fix
		// we picked `registered[0]` and emitted a warn-level event,
		// which let `serve install --agent` (silently using default)
		// and `serve uninstall` (silently nuking the wrong daemon)
		// hit production. Codex flagged: warn-and-pick is one of
		// those things that "works on a single-agent laptop"
		// (correct by accident) and bites multi-agent users in
		// non-obvious ways. Single-agent setups are unaffected
		// — registered.length === 1 takes the next line and
		// auto-picks.
		log.error("serve.ambiguous_agent", { agents: registered });
		console.error(
			`Multiple agents registered (${registered.join(", ")}). ` +
				`Pass --agent <type> to target one, or --all where supported.`,
		);
		process.exit(1);
	}
	const picked = registered[0];
	return { agentType: picked, adapter: adapterForType(picked) };
}

function resolveEnvironmentId(explicit: string | undefined, agentType: AgentType): string | null {
	if (explicit) return explicit;
	const fromEnv = process.env.CLAWDI_ENVIRONMENT_ID;
	if (fromEnv) return fromEnv;
	// Fallback: read the per-agent env file written by `clawdi
	// setup`. Hosted pods bypass this (provision flow injects
	// CLAWDI_ENVIRONMENT_ID directly); laptops use it.
	const fromFile = getEnvIdByAgent(agentType);
	if (fromFile) return fromFile;
	// Last resort: read /etc/clawdi/env-id (writable mount in
	// the pod entrypoint). Skipped on host.
	const podPath = "/etc/clawdi/env-id";
	if (existsSync(podPath)) {
		try {
			return readFileSync(podPath, "utf-8").trim();
		} catch {
			/* fall through */
		}
	}
	return null;
}
