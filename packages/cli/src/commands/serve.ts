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
import { startAutoRestart } from "../serve/auto-restart";
import {
	install as installService,
	readHealth,
	statusLines as serviceStatusLines,
	uninstall as uninstallService,
} from "../serve/installer";
import { log, toErrorMessage } from "../serve/log";
import { getServeStateDir } from "../serve/paths";
import { runSyncEngine } from "../serve/sync-engine";

interface ServeOpts {
	agent?: string;
	environmentId?: string;
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
				const result = installService({ agent: agentType });
				console.log(`✓ ${agentType}: ${result.unit}`);
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
	try {
		const result = installService({
			agent: agentType,
			environmentId: opts.environmentId,
		});
		console.log(`✓ Installed daemon unit: ${result.unit}`);
		console.log(result.instructions);
	} catch (e) {
		console.error(`Install failed: ${toErrorMessage(e)}`);
		process.exit(1);
	}
}

export async function serveUninstall(opts: ServeInstallOpts): Promise<void> {
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

export async function serveStatus(opts: ServeInstallOpts): Promise<void> {
	const { agentType } = pickAgent(opts.agent);
	const stateDir = getServeStateDir(agentType);
	const health = readHealth(stateDir);
	console.log(`agent:   ${agentType}`);
	console.log(`state:   ${stateDir}`);
	if (health.exists) {
		const fresh = health.ageSeconds !== null && health.ageSeconds < 90;
		// The 90s cutoff matches the dashboard's "online/offline"
		// freshness window. A daemon writing `health` more recently
		// than that AND posting heartbeats is what we call "live".
		console.log(`health:  ${fresh ? "✓ live" : "stale"} (last write ${health.ageSeconds}s ago)`);
	} else {
		console.log("health:  (no health file — daemon never ran or wrote elsewhere)");
	}
	for (const line of serviceStatusLines({ agent: agentType })) {
		console.log(line);
	}
}

interface ServeDoctorOpts {
	json?: boolean;
}

export async function serveDoctor(opts: ServeDoctorOpts): Promise<void> {
	// `clawdi serve doctor` — single-call snapshot of every
	// daemon's runtime state, designed for support handoff and
	// for the dashboard's "What's wrong with my sync?" panel
	// (round-5 must-have #3). Shows per-agent: registration,
	// state-dir path, last-heartbeat age, OS supervisor unit
	// state, daemon entrypoint binary. JSON mode is for
	// programmatic callers.
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
			heartbeat: health.exists
				? { age_seconds: health.ageSeconds, status }
				: { age_seconds: null, status },
		};
	});
	const summary = {
		entrypoint: process.argv[1] ?? null,
		node: process.execPath,
		registered_agents: registered.length,
		api_url: process.env.CLAWDI_API_URL ?? null,
		agents: report,
	};
	if (opts.json) {
		console.log(JSON.stringify(summary, null, 2));
		return;
	}
	console.log(`entrypoint: ${summary.entrypoint ?? "?"}`);
	console.log(`node:       ${summary.node}`);
	console.log(`agents:     ${summary.registered_agents}`);
	console.log("");
	if (registered.length === 0) {
		console.log("No agents registered yet — run `clawdi setup` first.");
		return;
	}
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
		for (const line of r.supervisor) {
			console.log(line);
		}
		console.log("");
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
		log.warn("serve.multiple_agents_detected", {
			agents: registered,
			picked: registered[0],
			hint: "Pass --agent <type> to select explicitly. v1 daemon services one agent per process.",
		});
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
