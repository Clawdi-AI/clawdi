/**
 * `clawdi daemon` entry.
 *
 * Long-lived process. Watches local skill directories, mirrors
 * cloud changes back to the local agent, posts heartbeats, and
 * keeps a bounded retry queue to survive transient outages.
 *
 * Three deploy contexts share this same code:
 *   - laptop: started by the user via `clawdi daemon install`
 *     (launchd / systemd unit) or `clawdi daemon run` in a tmux pane
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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { AGENT_TYPES, type AgentType } from "../adapters/registry";
import { isLoggedIn } from "../lib/config";
import { adapterForType, getEnvIdByAgent, listRegisteredAgentTypes } from "../lib/select-adapter";
import { getCliVersion } from "../lib/version";
import { startAutoRestart } from "../serve/auto-restart";
import {
	type ControlRpcClientConfig,
	type ControlRpcHandlers,
	type ControlRpcListenConfig,
	callControlRpc,
	rotateControlToken,
	startControlRpcServer,
} from "../serve/control-rpc";
import {
	install as installService,
	isSingletonDaemonInstalled,
	listInstalledAgents,
	readHealth,
	restart as restartService,
	statusLines as serviceStatusLines,
	uninstall as uninstallService,
} from "../serve/installer";
import { log, toErrorMessage } from "../serve/log";
import {
	getDaemonControlSocketPath,
	getDaemonControlTokenPath,
	getServeLogPath,
	getServeStateDir,
} from "../serve/paths";
import { runSyncEngine } from "../serve/sync-engine";
import { startDaemonAutoUpdate } from "./update";

type ServeOpts = Record<string, unknown>;

interface RpcListenOpts {
	rpcHost?: unknown;
	rpcPort?: unknown;
	rpcAllowRemote?: unknown;
}

interface ResolvedRpcListenConfig extends ControlRpcListenConfig {
	allowRemote?: boolean;
}

let activeControlRpcHttp: { host: string; port: number; allow_remote: boolean } | null = null;

const CONTROL_ACTION_DELAY_MS = 100;

interface DaemonRunTarget {
	agentType: AgentType;
	adapter: NonNullable<ReturnType<typeof adapterForType>>;
	environmentId: string;
}

interface DaemonStatusReport {
	agent: AgentType;
	state_dir: string;
	health: ReturnType<typeof readHealth> & { fresh: boolean };
	supervisor: string[];
}

interface DaemonDoctorReport {
	entrypoint: string | null;
	node: string;
	cli_version: string;
	registered_agents: number;
	singleton_unit_installed: boolean;
	legacy_daemon_units: AgentType[];
	control_rpc: {
		socket_path: string;
		token_path: string;
		http: { host: string; port: number; allow_remote: boolean } | null;
	};
	api_url: string | null;
	agents: Array<
		DaemonStatusReport & {
			daemon_version: string | null;
			version_drift: boolean;
			heartbeat: {
				age_seconds: number | null;
				status: "live" | "stale" | "never_ran";
			};
		}
	>;
}

/**
 * Reject legacy selector options that a singleton-daemon subcommand
 * does not support. Pre-fix `clawdi daemon doctor --agent codex`
 * and `clawdi daemon status --environment-id <id>` silently accepted
 * those flags but ignored them, leaving users with no signal that
 * their command had no effect.
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
			`\`daemon ${cmdName}\` does not accept ${flags}. ` +
				`See \`clawdi daemon ${cmdName} --help\`.`,
		);
		process.exit(1);
	}
}

function camelToFlag(name: string): string {
	return `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export async function serve(_opts: ServeOpts): Promise<void> {
	const opts = _opts as RpcListenOpts;
	const rpcListen = resolveRpcListenConfig(opts);
	const mode = (process.env.CLAWDI_SERVE_MODE ?? "host").toLowerCase();
	const isContainer = mode === "container";

	if (!isLoggedIn()) {
		log.error("serve.no_auth", {
			hint: "Set CLAWDI_AUTH_TOKEN env or run `clawdi auth login`.",
		});
		process.exit(1);
	}

	const targets = pickDaemonRunTargets();

	log.info("serve.boot", {
		mode,
		agents: targets.map((target) => target.agentType),
		state_dirs: Object.fromEntries(
			targets.map((target) => [target.agentType, getServeStateDir(target.agentType)]),
		),
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
		if (startDaemonAutoUpdate({ abort })) {
			log.info("serve.auto_update_armed", {});
		}
	}

	const rpc = await startControlRpcServer(createControlRpcHandlers(), abort.signal, rpcListen);
	activeControlRpcHttp = rpc.http
		? { ...rpc.http, allow_remote: rpcListen.allowRemote === true }
		: null;
	log.info("serve.rpc_listening", {
		socket: rpc.socketPath,
		token_path: rpc.tokenPath,
		http: rpc.http,
	});

	try {
		await Promise.all(
			targets.map((target) =>
				runSyncEngine({
					environmentId: target.environmentId,
					adapter: target.adapter,
					abort: abort.signal,
					abortController: abort,
					forcePollWatcher: isContainer,
				}),
			),
		);
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

type ServeInstallOpts = Record<string, unknown>;

export async function serveInstall(opts: ServeInstallOpts): Promise<void> {
	rejectUnsupportedOpts("install", opts as Record<string, unknown>, INSTALL_ALLOWED);
	const rpcListen = resolveRpcListenConfig(opts as RpcListenOpts);
	if (!isLoggedIn()) {
		console.error("Not logged in. Run `clawdi auth login` first — the daemon needs an api key.");
		process.exit(1);
	}
	const registered = listRegisteredAgentTypes();
	if (registered.length === 0) {
		console.error("No agents registered. Run `clawdi setup` first.");
		process.exit(1);
	}
	for (const agentType of registered) {
		if (getEnvIdByAgent(agentType) === null) {
			console.error(
				`No environment configured for ${agentType} ` +
					`(missing ~/.clawdi/environments/${agentType}.json). ` +
					`Run \`clawdi setup --agent ${agentType}\` first.`,
			);
			process.exit(1);
		}
	}
	try {
		const result = installService({
			rpcHost: rpcListen.host,
			rpcPort: rpcListen.port,
			rpcAllowRemote: rpcListen.allowRemote === true ? true : undefined,
		});
		const verb = result.replaced ? "Replaced existing" : "Installed";
		console.log(`✓ ${verb} singleton daemon unit: ${result.unit}`);
		console.log(result.instructions);
	} catch (e) {
		console.error(`Install failed: ${toErrorMessage(e)}`);
		process.exit(1);
	}
	const failed = cleanupLegacyDaemonUnits();
	if (failed > 0) process.exit(1);
}

const INSTALL_ALLOWED = new Set(["rpcHost", "rpcPort", "rpcAllowRemote"]);
const UNINSTALL_ALLOWED = new Set<string>();
const STATUS_ALLOWED = new Set(["agent"]);
const DOCTOR_ALLOWED = new Set(["json"]);
const RPC_ALLOWED = new Set(["params", "rpcHost", "rpcPort", "rpcToken"]);

export async function serveUninstall(opts: ServeInstallOpts): Promise<void> {
	rejectUnsupportedOpts("uninstall", opts as Record<string, unknown>, UNINSTALL_ALLOWED);
	let removed = 0;
	let failed = 0;
	try {
		const result = uninstallService();
		if (result.removed) {
			console.log("✓ Removed singleton daemon unit.");
			removed += 1;
		} else {
			console.log("(no singleton daemon unit installed)");
		}
	} catch (e) {
		console.error(`✗ daemon: ${toErrorMessage(e)}`);
		failed += 1;
	}
	failed += cleanupLegacyDaemonUnits();
	if (removed === 0 && failed === 0) console.log("No daemon units installed.");
	if (failed > 0) process.exit(1);
}

const RESTART_ALLOWED = new Set<string>();

export async function serveRestart(opts: ServeInstallOpts): Promise<void> {
	rejectUnsupportedOpts("restart", opts as Record<string, unknown>, RESTART_ALLOWED);
	try {
		restartService();
		console.log("✓ Restarted singleton daemon.");
	} catch (e) {
		console.error(`Restart failed: ${toErrorMessage(e)}`);
		process.exit(1);
	}
}

interface ServeStatusOpts {
	agent?: string;
}

export async function serveStatus(opts: ServeStatusOpts): Promise<void> {
	rejectUnsupportedOpts("status", opts as Record<string, unknown>, STATUS_ALLOWED);
	const targets: AgentType[] = opts.agent
		? [pickAgent(opts.agent).agentType]
		: listRegisteredAgentTypes();
	if (targets.length === 0) {
		console.log("No agents registered yet — run `clawdi setup` first.");
		return;
	}
	for (const [i, report] of targets.map(buildStatusReport).entries()) {
		if (i > 0) console.log("");
		printAgentStatus(report);
	}
}

function buildStatusReport(agentType: AgentType): DaemonStatusReport {
	const stateDir = getServeStateDir(agentType);
	const health = readHealth(stateDir);
	const fresh = health.exists && health.ageSeconds !== null && health.ageSeconds < 90;
	return {
		agent: agentType,
		state_dir: stateDir,
		health: { ...health, fresh },
		supervisor: serviceStatusLines(),
	};
}

function printAgentStatus(report: DaemonStatusReport): void {
	const health = report.health;
	console.log(`agent:   ${report.agent}`);
	console.log(`state:   ${report.state_dir}`);
	if (health.exists) {
		// The 90s cutoff matches the dashboard's "online/offline"
		// freshness window. A daemon writing `health` more recently
		// than that AND posting heartbeats is what we call "live".
		console.log(
			`health:  ${health.fresh ? "✓ live" : "stale"} (last write ${health.ageSeconds}s ago)`,
		);
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
					"⚠ drift — run `clawdi daemon restart` to pick up the latest",
			);
		} else {
			console.log(`version: ${health.version}`);
		}
	}
	for (const line of report.supervisor) {
		console.log(line);
	}
}

interface ServeLogsOpts {
	follow?: boolean;
}

const LOGS_ALLOWED = new Set(["follow"]);

export async function serveLogs(opts: ServeLogsOpts): Promise<void> {
	rejectUnsupportedOpts("logs", opts as Record<string, unknown>, LOGS_ALLOWED);
	const { spawn } = await import("node:child_process");
	// Per-platform log access. macOS launchd routes the unit's
	// `StandardErrorPath` to a file we own (we wrote it in the
	// plist), so `tail` works. Linux systemd routes
	// `StandardError=journal` to journald — there's no file to
	// tail, so we delegate to `journalctl --user -u <unit>`.
	// Codex flagged the original implementation: it used `tail`
	// unconditionally and silently failed (or worse, errored) on
	// Linux because `~/.clawdi/serve/logs/daemon.stderr.log`
	// never gets created.
	const platform = process.platform;
	let cmd: string;
	let args: string[];
	if (platform === "linux") {
		const unit = "clawdi-serve.service";
		cmd = "journalctl";
		args = opts.follow
			? ["--user", "-u", unit, "-n", "200", "-f"]
			: ["--user", "-u", unit, "-n", "200"];
	} else if (platform === "darwin") {
		const path = getServeLogPath("daemon", "stderr");
		if (!existsSync(path)) {
			console.error(
				`No log file at ${path} (daemon hasn't started yet — run \`clawdi daemon install\`).`,
			);
			process.exit(1);
		}
		cmd = "tail";
		args = opts.follow ? ["-n", "200", "-F", path] : ["-n", "200", path];
	} else {
		console.error(`unsupported platform for daemon logs: ${platform}`);
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
	// `clawdi daemon doctor` — single-call snapshot of every
	// daemon's runtime state, designed for support handoff and
	// for the dashboard's "What's wrong with my sync?" panel
	// (round-5 must-have #3). Shows per-agent: registration,
	// state-dir path, last-heartbeat age, OS supervisor unit
	// state, daemon entrypoint binary. JSON mode is for
	// programmatic callers.
	const summary = buildDoctorReport();
	if (opts.json) {
		console.log(JSON.stringify(summary, null, 2));
		return;
	}
	console.log(`entrypoint:  ${summary.entrypoint ?? "?"}`);
	console.log(`node:        ${summary.node}`);
	console.log(`cli version: ${summary.cli_version}`);
	console.log(`agents:      ${summary.registered_agents}`);
	console.log(`unit:        ${summary.singleton_unit_installed ? "installed" : "not installed"}`);
	if (summary.legacy_daemon_units.length > 0) {
		console.log(`legacy:      ${summary.legacy_daemon_units.join(", ")}`);
	}
	console.log(`rpc socket:  ${summary.control_rpc.socket_path}`);
	if (summary.control_rpc.http) {
		console.log(`rpc http:    ${summary.control_rpc.http.host}:${summary.control_rpc.http.port}`);
	}
	console.log("");
	if (summary.registered_agents === 0) {
		console.log("No agents registered yet — run `clawdi setup` first.");
		return;
	}
	let anyDrift = false;
	for (const r of summary.agents) {
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
				console.log(`version:   ⚠ daemon=${r.daemon_version}, CLI=${summary.cli_version}`);
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
				"Run `clawdi daemon restart` to pick up the latest.",
		);
	}
}

function buildDoctorReport(): DaemonDoctorReport {
	const cliVersion = getCliVersion();
	const registered = listRegisteredAgentTypes();
	const agents = registered.map((agent) => {
		const report = buildStatusReport(agent);
		const status: "live" | "stale" | "never_ran" = report.health.fresh
			? "live"
			: report.health.exists
				? "stale"
				: "never_ran";
		return {
			...report,
			daemon_version: report.health.version,
			version_drift: report.health.version !== null && report.health.version !== cliVersion,
			heartbeat: report.health.exists
				? { age_seconds: report.health.ageSeconds, status }
				: { age_seconds: null, status },
		};
	});
	return {
		entrypoint: process.argv[1] ?? null,
		node: process.execPath,
		cli_version: cliVersion,
		registered_agents: registered.length,
		singleton_unit_installed: isSingletonDaemonInstalled(),
		legacy_daemon_units: listInstalledAgents(),
		control_rpc: {
			socket_path: getDaemonControlSocketPath(),
			token_path: getDaemonControlTokenPath(),
			http: activeControlRpcHttp ?? normalizeRpcHttpConfig(resolveRpcListenConfig({})),
		},
		api_url: process.env.CLAWDI_API_URL ?? null,
		agents,
	};
}

interface ServeRpcOpts {
	params?: string;
	rpcHost?: unknown;
	rpcPort?: unknown;
	rpcToken?: unknown;
}

export async function serveRpc(method: string, opts: ServeRpcOpts): Promise<void> {
	rejectUnsupportedOpts("rpc", opts as Record<string, unknown>, RPC_ALLOWED);
	let params: unknown = {};
	if (opts.params !== undefined) {
		try {
			params = JSON.parse(opts.params);
		} catch (error) {
			throw new Error(`--params must be valid JSON: ${toErrorMessage(error)}`);
		}
	}
	const rpcTarget = resolveRpcClientConfig(opts);
	const result = await callControlRpc(method, params, rpcTarget);
	console.log(JSON.stringify(result, null, 2));
}

function createControlRpcHandlers(): ControlRpcHandlers {
	const handlers: ControlRpcHandlers = {};
	handlers["daemon.ping"] = () => ({
		pid: process.pid,
		version: getCliVersion(),
		uptime_seconds: Math.round(process.uptime()),
	});
	handlers["daemon.methods"] = () => ({
		methods: Object.keys(handlers).sort(),
	});
	handlers["daemon.status"] = (params) => {
		const record = rpcParamsRecord(params);
		rejectRpcParams(record, new Set(["agent"]));
		const agent = optionalAgentParam(record.agent);
		const targets = agent ? [agent] : listRegisteredAgentTypes();
		return {
			singleton_unit_installed: isSingletonDaemonInstalled(),
			legacy_daemon_units: listInstalledAgents(),
			agents: targets.map(buildStatusReport),
		};
	};
	handlers["daemon.doctor"] = () => buildDoctorReport();
	handlers["daemon.install"] = (params) => daemonInstallRpc(params);
	handlers["daemon.uninstall"] = (params) => daemonUninstallRpc(params);
	handlers["daemon.restart"] = (params) => daemonRestartRpc(params);
	handlers["daemon.logs"] = (params) => daemonLogsRpc(params);
	handlers["daemon.rotate_token"] = (params) => daemonRotateTokenRpc(params);
	return handlers;
}

function daemonInstallRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["rpc_host", "rpc_port", "rpc_allow_remote"]));
	const hasExplicitRpcConfig =
		record.rpc_host !== undefined ||
		record.rpc_port !== undefined ||
		record.rpc_allow_remote !== undefined;
	const rpcListen = hasExplicitRpcConfig
		? resolveRpcListenConfig({
				rpcHost: record.rpc_host,
				rpcPort: record.rpc_port,
				rpcAllowRemote: record.rpc_allow_remote,
			})
		: resolveRpcListenConfig({
				rpcHost: activeControlRpcHttp?.host,
				rpcPort: activeControlRpcHttp?.port,
				rpcAllowRemote: activeControlRpcHttp?.allow_remote,
			});
	return scheduleDaemonControlAction(
		"install",
		() => {
			installService({
				rpcHost: rpcListen.host,
				rpcPort: rpcListen.port,
				rpcAllowRemote: rpcListen.allowRemote === true ? true : undefined,
			});
		},
		{
			rpc_http: normalizeRpcHttpConfig(rpcListen),
		},
	);
}

function daemonUninstallRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set());
	const targets = daemonUnitTargets();
	if (targets.length === 0) {
		return { accepted: false, reason: "no daemon units installed" };
	}
	return scheduleDaemonControlAction(
		"uninstall",
		() => {
			for (const target of targets) {
				try {
					const opts = target === "daemon" ? undefined : { agent: target };
					uninstallService(opts);
				} catch (error) {
					log.error("daemon.control_action_target_failed", {
						action: "uninstall",
						target,
						error: toErrorMessage(error),
					});
				}
			}
		},
		{ targets },
	);
}

function daemonRestartRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set());
	if (!isSingletonDaemonInstalled()) {
		return { accepted: false, reason: "no singleton daemon unit installed" };
	}
	return scheduleDaemonControlAction(
		"restart",
		() => {
			restartService();
		},
		{ target: "daemon" },
	);
}

function daemonRotateTokenRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set());
	const token = rotateControlToken();
	return {
		rotated: true,
		token_path: getDaemonControlTokenPath(),
		token,
	};
}

function scheduleDaemonControlAction(
	action: string,
	run: () => void,
	extra: Record<string, unknown> = {},
): unknown {
	setTimeout(() => {
		try {
			run();
			log.info("daemon.control_action_completed", { action });
		} catch (error) {
			log.error("daemon.control_action_failed", { action, error: toErrorMessage(error) });
		}
	}, CONTROL_ACTION_DELAY_MS);
	return {
		accepted: true,
		action,
		delay_ms: CONTROL_ACTION_DELAY_MS,
		...extra,
	};
}

function daemonLogsRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["limit"]));
	const limit = optionalLogLimitParam(record.limit);
	const currentPlatform = process.platform;
	if (currentPlatform === "linux") {
		const command = [
			"journalctl",
			"--user",
			"-u",
			"clawdi-serve.service",
			"-n",
			String(limit),
			"--no-pager",
		];
		try {
			const output = execFileSync(command[0], command.slice(1), {
				encoding: "utf-8",
				maxBuffer: 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 5000,
			});
			return {
				platform: currentPlatform,
				source: "journalctl",
				command,
				lines: splitLogLines(output),
			};
		} catch (error) {
			return {
				platform: currentPlatform,
				source: "journalctl",
				command,
				lines: [],
				error: toErrorMessage(error),
			};
		}
	}
	if (currentPlatform === "darwin") {
		const stderr = getServeLogPath("daemon", "stderr");
		const output = existsSync(stderr) ? readFileSync(stderr, "utf-8") : "";
		return {
			platform: currentPlatform,
			source: "file",
			stdout: getServeLogPath("daemon", "stdout"),
			stderr,
			lines: tailLogLines(splitLogLines(output), limit),
		};
	}
	return {
		platform: currentPlatform,
		lines: [],
		error: `unsupported platform for daemon logs: ${currentPlatform}`,
	};
}

function splitLogLines(output: string): string[] {
	return output.split(/\r?\n/).filter((line) => line.length > 0);
}

function tailLogLines(lines: string[], limit: number): string[] {
	return lines.slice(Math.max(0, lines.length - limit));
}

function daemonUnitTargets(): Array<"daemon" | AgentType> {
	const targets: Array<"daemon" | AgentType> = [];
	if (isSingletonDaemonInstalled()) targets.push("daemon");
	targets.push(...listInstalledAgents());
	return targets;
}

function rejectRpcParams(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
	const offenders = Object.keys(record).filter((key) => !allowed.has(key));
	if (offenders.length > 0) {
		throw new Error(`Unsupported RPC params: ${offenders.join(", ")}`);
	}
}

function rpcParamsRecord(params: unknown): Record<string, unknown> {
	if (params === undefined || params === null) return {};
	if (typeof params !== "object" || Array.isArray(params)) {
		throw new Error("RPC params must be a JSON object");
	}
	return params as Record<string, unknown>;
}

function optionalStringParam(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	if (!value.trim()) throw new Error(`${label} must not be empty`);
	return value;
}

function optionalAgentParam(value: unknown): AgentType | undefined {
	const agent = optionalStringParam(value, "agent");
	if (agent === undefined) return undefined;
	if (!isAgentType(agent)) {
		throw new Error(`Unknown agent: ${agent}. Expected one of: ${AGENT_TYPES.join(", ")}`);
	}
	return agent;
}

function resolveRpcListenConfig(opts: RpcListenOpts): ResolvedRpcListenConfig {
	const host =
		optionalStringParam(opts.rpcHost, "--rpc-host") ?? process.env.CLAWDI_DAEMON_RPC_HOST;
	const portValue = opts.rpcPort ?? process.env.CLAWDI_DAEMON_RPC_PORT;
	const port = optionalPortParam(portValue, "--rpc-port");
	const allowRemote =
		optionalBooleanParam(opts.rpcAllowRemote, "--rpc-allow-remote") ??
		optionalBooleanParam(
			process.env.CLAWDI_DAEMON_RPC_ALLOW_REMOTE,
			"CLAWDI_DAEMON_RPC_ALLOW_REMOTE",
		) ??
		false;
	if (host !== undefined && port === undefined) {
		throw new Error("--rpc-host requires --rpc-port (or CLAWDI_DAEMON_RPC_PORT)");
	}
	if (host === undefined && port === undefined) return {};
	const resolvedHost = host ?? "127.0.0.1";
	if (!allowRemote && !isLoopbackRpcHost(resolvedHost)) {
		throw new Error(
			`Refusing to listen on non-loopback HTTP RPC host ${resolvedHost}. ` +
				"Use --rpc-allow-remote only behind SSH tunneling or a TLS-terminating proxy.",
		);
	}
	return { host: resolvedHost, port, allowRemote };
}

function resolveRpcClientConfig(
	opts: RpcListenOpts & { rpcToken?: unknown },
): ControlRpcClientConfig {
	const host =
		optionalStringParam(opts.rpcHost, "--rpc-host") ?? process.env.CLAWDI_DAEMON_RPC_HOST;
	const portValue = opts.rpcPort ?? process.env.CLAWDI_DAEMON_RPC_PORT;
	const port = optionalPortParam(portValue, "--rpc-port");
	if (host !== undefined && port === undefined) {
		throw new Error("--rpc-host requires --rpc-port (or CLAWDI_DAEMON_RPC_PORT)");
	}
	const token = optionalStringParam(opts.rpcToken, "--rpc-token");
	if (host === undefined && port === undefined) return { token };
	return { host: host ?? "127.0.0.1", port, token };
}

function normalizeRpcHttpConfig(
	config: ResolvedRpcListenConfig,
): { host: string; port: number; allow_remote: boolean } | null {
	if (config.port === undefined) return null;
	return {
		host: config.host ?? "127.0.0.1",
		port: config.port,
		allow_remote: config.allowRemote === true,
	};
}

function optionalBooleanParam(value: unknown, label: string): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (!normalized) return undefined;
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
	}
	throw new Error(`${label} must be a boolean`);
}

function optionalLogLimitParam(value: unknown): number {
	if (value === undefined || value === null) return 200;
	let limit: number;
	if (typeof value === "number") {
		limit = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		limit = Number(value);
	} else {
		throw new Error("limit must be an integer from 1 to 1000");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
		throw new Error("limit must be an integer from 1 to 1000");
	}
	return limit;
}

function isLoopbackRpcHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized === "0:0:0:0:0:0:0:1" ||
		normalized === "127.0.0.1" ||
		normalized.startsWith("127.")
	);
}

function optionalPortParam(value: unknown, label: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	let port: number;
	if (typeof value === "number") {
		port = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		port = Number(value);
	} else {
		throw new Error(`${label} must be an integer from 1 to 65535`);
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`${label} must be an integer from 1 to 65535`);
	}
	return port;
}

function cleanupLegacyDaemonUnits(): number {
	let failed = 0;
	for (const agentType of listInstalledAgents()) {
		try {
			const result = uninstallService({ agent: agentType });
			if (result.removed) {
				console.log(`✓ Removed legacy per-agent daemon unit for ${agentType}`);
			}
		} catch (e) {
			console.error(`✗ Failed to remove legacy daemon unit for ${agentType}: ${toErrorMessage(e)}`);
			failed += 1;
		}
	}
	return failed;
}

function isAgentType(s: string): s is AgentType {
	return (AGENT_TYPES as readonly string[]).includes(s);
}

function pickDaemonRunTargets(): DaemonRunTarget[] {
	const registered = listRegisteredAgentTypes();
	const envAgent = process.env.CLAWDI_AGENT_TYPE;
	const targets = registered.length > 0 ? registered : envAgent ? [envAgent] : [];
	for (const target of targets) {
		if (!isAgentType(target)) {
			log.error("serve.unknown_agent", { agent: target, known: AGENT_TYPES });
			console.error(`Unknown agent: ${target}. Expected one of: ${AGENT_TYPES.join(", ")}`);
			process.exit(1);
		}
	}
	if (registered.length === 0) {
		if (!envAgent) {
			log.error("serve.no_agent", {
				hint: "Run `clawdi setup` to register an agent on this machine, or set CLAWDI_AGENT_TYPE in a container.",
			});
			process.exit(1);
		}
	}
	const agentTypes = targets as AgentType[];
	return agentTypes.map((agentType) => {
		const adapter = adapterForType(agentType);
		if (!adapter) {
			log.error("serve.no_agent_adapter", { agent: agentType });
			console.error(`No adapter available for ${agentType}.`);
			process.exit(1);
		}
		const environmentId = resolveEnvironmentId(agentType, agentTypes.length);
		if (!environmentId) {
			log.error("serve.no_environment", {
				agent: agentType,
				hint: "Run `clawdi setup` to write ~/.clawdi/environments/<agent>.json.",
			});
			process.exit(1);
		}
		return { agentType, adapter, environmentId };
	});
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
		// which used to let target-specific daemon operations pick
		// an arbitrary agent. Single-agent setups are unaffected
		// — registered.length === 1 takes the next line and
		// auto-picks.
		log.error("serve.ambiguous_agent", { agents: registered });
		console.error(
			`Multiple agents registered (${registered.join(", ")}). ` +
				"Use `clawdi daemon status --agent <type>` to inspect one agent.",
		);
		process.exit(1);
	}
	const picked = registered[0];
	return { agentType: picked, adapter: adapterForType(picked) };
}

function resolveEnvironmentId(agentType: AgentType, registeredCount: number): string | null {
	// Fallback: read the per-agent env file written by `clawdi
	// setup`. Hosted pods bypass this (provision flow injects
	// CLAWDI_ENVIRONMENT_ID directly); laptops use it.
	const fromFile = getEnvIdByAgent(agentType);
	if (fromFile) return fromFile;
	// Hosted/single-agent containers can still pass one env id via
	// env var or mounted file. Multi-agent singleton runs must not
	// apply one global env id to every engine.
	if (registeredCount === 1) {
		const fromEnv = process.env.CLAWDI_ENVIRONMENT_ID;
		if (fromEnv) return fromEnv;
	}
	// Last resort: read /etc/clawdi/env-id (writable mount in
	// the pod entrypoint). Skipped on host.
	const podPath = "/etc/clawdi/env-id";
	if (registeredCount === 1 && existsSync(podPath)) {
		try {
			return readFileSync(podPath, "utf-8").trim();
		} catch {
			/* fall through */
		}
	}
	return null;
}
