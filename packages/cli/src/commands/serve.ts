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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { AGENT_TYPES, type AgentType } from "../adapters/registry";
import {
	clearAuth,
	clearPendingAuth,
	getAuth,
	getClawdiDir,
	getConfig,
	getPendingAuth,
	isLoggedIn,
	setAuth,
	setPendingAuth,
} from "../lib/config";
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
	type CommandResult,
	operationManager,
	runCliCommandImmediate,
} from "../serve/operation-runner";
import {
	getDaemonControlSocketPath,
	getDaemonControlTokenPath,
	getServeLogPath,
	getServeStateDir,
} from "../serve/paths";
import { runSyncEngine } from "../serve/sync-engine";
import { daemonAutoUpdateOnce, startDaemonAutoUpdate } from "./update";

type ServeOpts = Record<string, unknown>;

interface RpcListenOpts {
	rpcHost?: unknown;
	rpcPort?: unknown;
	rpcAllowRemote?: unknown;
}

interface LegacyRunOpts {
	agent?: unknown;
	environmentId?: unknown;
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

interface RpcCommandOptions {
	name: string;
	args: string[];
	cwd?: string;
	stdin?: string;
	wait: boolean;
	parseJson?: boolean;
	redactedArgs?: string[];
	timeoutMs?: number;
}

interface RpcCommandResponse extends CommandResult {
	json?: unknown;
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
	const opts = _opts as RpcListenOpts & LegacyRunOpts;
	const mode = (process.env.CLAWDI_SERVE_MODE ?? "host").toLowerCase();
	const isContainer = mode === "container";
	const legacyRun = resolveLegacyRunOpts(opts);

	if (legacyRun && !isContainer) {
		migrateLegacyDaemonRun(legacyRun);
		return;
	}

	const rpcListen = resolveRpcListenConfig(opts);

	if (!isLoggedIn()) {
		log.error("serve.no_auth", {
			hint: "Set CLAWDI_AUTH_TOKEN env or run `clawdi auth login`.",
		});
		process.exit(1);
	}

	const targets = legacyRun ? [pickLegacyDaemonRunTarget(legacyRun)] : pickDaemonRunTargets();

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

export function createControlRpcHandlers(): ControlRpcHandlers {
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
	handlers["operation.list"] = (params) => operationListRpc(params);
	handlers["operation.status"] = (params) => operationStatusRpc(params);
	handlers["operation.logs"] = (params) => operationLogsRpc(params);
	handlers["operation.cancel"] = (params) => operationCancelRpc(params);
	handlers["sync.push"] = (params) => syncPushRpc(params);
	handlers["sync.pull"] = (params) => syncPullRpc(params);
	handlers["sync.push_dry_run"] = (params) => syncPushDryRunRpc(params);
	handlers["sync.pull_dry_run"] = (params) => syncPullDryRunRpc(params);
	handlers["vault.set"] = (params) => vaultSetRpc(params);
	handlers["vault.list"] = (params) => vaultListRpc(params);
	handlers["vault.import"] = (params) => vaultImportRpc(params);
	handlers["vault.attach"] = (params) => vaultAttachRpc(params);
	handlers["vault.detach"] = (params) => vaultDetachRpc(params);
	handlers["vault.rm"] = (params) => vaultRmRpc(params);
	handlers["vault.resolve"] = (params) => vaultResolveRpc(params);
	handlers["vault.read"] = (params) => vaultReadRpc(params);
	handlers["vault.inject"] = (params) => vaultInjectRpc(params);
	handlers["auth.status"] = (params) => authStatusRpc(params);
	handlers["auth.login"] = (params) => authLoginRpc(params);
	handlers["auth.complete"] = (params) => authCompleteRpc(params);
	handlers["auth.logout"] = (params) => authLogoutRpc(params);
	handlers["update.check"] = (params) => updateCheckRpc(params);
	handlers["update.install"] = (params) => updateInstallRpc(params);
	return handlers;
}

function operationListRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["limit"]));
	const limit = optionalLimitParam(record.limit, "limit", 1, 1000, 50);
	return { operations: operationManager.list(limit) };
}

function operationStatusRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["id"]));
	const operation = operationManager.get(requiredStringParam(record, "id"));
	if (!operation) throw new Error("Unknown operation id");
	return operation;
}

function operationLogsRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["id", "limit"]));
	const logs = operationManager.logs(
		requiredStringParam(record, "id"),
		optionalLimitParam(record.limit, "limit", 1, 1000, 200),
	);
	if (!logs) throw new Error("Unknown operation id");
	return logs;
}

function operationCancelRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["id"]));
	const operation = operationManager.cancel(requiredStringParam(record, "id"));
	if (!operation) throw new Error("Unknown operation id");
	return operation;
}

function syncPushRpc(params: unknown): Promise<unknown> {
	return syncCommandRpc("push", params, { forceDryRun: false, defaultWait: false });
}

function syncPullRpc(params: unknown): Promise<unknown> {
	return syncCommandRpc("pull", params, { forceDryRun: false, defaultWait: false });
}

function syncPushDryRunRpc(params: unknown): Promise<unknown> {
	return syncCommandRpc("push", params, { forceDryRun: true, defaultWait: true });
}

function syncPullDryRunRpc(params: unknown): Promise<unknown> {
	return syncCommandRpc("pull", params, { forceDryRun: true, defaultWait: true });
}

async function syncCommandRpc(
	command: "push" | "pull",
	params: unknown,
	opts: { forceDryRun: boolean; defaultWait: boolean },
): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(
		record,
		new Set([
			"modules",
			"project",
			"exclude_project",
			"all",
			"all_agents",
			"agent",
			"dry_run",
			"cwd",
			"wait",
		]),
	);
	const args: string[] = [command];
	const modules = optionalStringParam(record.modules, "modules");
	const project = optionalStringParam(record.project, "project");
	const agent = optionalStringParam(record.agent, "agent");
	const cwd = optionalStringParam(record.cwd, "cwd");
	const all = optionalBooleanParam(record.all, "all") ?? false;
	const allAgents = optionalBooleanParam(record.all_agents, "all_agents") ?? false;
	const dryRun = opts.forceDryRun || (optionalBooleanParam(record.dry_run, "dry_run") ?? false);
	if (modules) args.push("--modules", modules);
	if (project) args.push("--project", project);
	if (agent) args.push("--agent", agent);
	if (all) args.push("--all");
	if (allAgents) args.push("--all-agents");
	if (dryRun) args.push("--dry-run");
	if (command === "push") {
		for (const excluded of optionalStringListParam(record.exclude_project, "exclude_project") ??
			[]) {
			args.push("--exclude-project", excluded);
		}
		if (!all && !project && !cwd) {
			throw new Error("sync.push RPC requires cwd or project unless all=true.");
		}
	}
	return runCommandRpc({
		name: `sync.${command}`,
		args,
		cwd,
		wait: optionalBooleanParam(record.wait, "wait") ?? opts.defaultWait,
	});
}

function vaultSetRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["key", "value", "project", "allow_empty", "cwd", "wait"]));
	const key = requiredStringParam(record, "key");
	const value = requiredStringParam(record, "value");
	const args = ["vault", "set", key, "--stdin"];
	appendOptionalStringFlag(args, "--project", record.project);
	if (optionalBooleanParam(record.allow_empty, "allow_empty")) args.push("--allow-empty");
	return runCommandRpc({
		name: "vault.set",
		args,
		cwd: optionalStringParam(record.cwd, "cwd"),
		stdin: value,
		wait: optionalBooleanParam(record.wait, "wait") ?? true,
	});
}

function vaultListRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["project", "cwd", "wait"]));
	const args = ["vault", "list", "--json"];
	appendOptionalStringFlag(args, "--project", record.project);
	return runCommandRpc({
		name: "vault.list",
		args,
		cwd: optionalStringParam(record.cwd, "cwd"),
		wait: optionalBooleanParam(record.wait, "wait") ?? true,
		parseJson: true,
	});
}

function vaultImportRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["file", "project", "vault", "section", "yes", "cwd", "wait"]));
	if (!optionalBooleanParam(record.yes, "yes")) {
		throw new Error("vault.import RPC requires yes=true to avoid an interactive confirmation.");
	}
	const args = ["vault", "import", requiredStringParam(record, "file"), "--yes"];
	appendOptionalStringFlag(args, "--project", record.project);
	appendOptionalStringFlag(args, "--vault", record.vault);
	appendOptionalStringFlag(args, "--section", record.section);
	return runCommandRpc({
		name: "vault.import",
		args,
		cwd: optionalStringParam(record.cwd, "cwd"),
		wait: optionalBooleanParam(record.wait, "wait") ?? true,
	});
}

function vaultAttachRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["vault", "project", "cwd", "wait"]));
	const args = ["vault", "attach", requiredStringParam(record, "vault")];
	args.push("--project", requiredStringParam(record, "project"));
	return runCommandRpc({
		name: "vault.attach",
		args,
		cwd: optionalStringParam(record.cwd, "cwd"),
		wait: optionalBooleanParam(record.wait, "wait") ?? true,
	});
}

function vaultDetachRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["vault", "project", "cwd", "wait"]));
	const args = ["vault", "detach", requiredStringParam(record, "vault")];
	args.push("--project", requiredStringParam(record, "project"));
	return runCommandRpc({
		name: "vault.detach",
		args,
		cwd: optionalStringParam(record.cwd, "cwd"),
		wait: optionalBooleanParam(record.wait, "wait") ?? true,
	});
}

function vaultRmRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["key", "project", "yes", "global", "cwd", "wait"]));
	if (!optionalBooleanParam(record.yes, "yes")) {
		throw new Error("vault.rm RPC requires yes=true to avoid an interactive confirmation.");
	}
	const args = ["vault", "rm", requiredStringParam(record, "key"), "--yes"];
	appendOptionalStringFlag(args, "--project", record.project);
	if (optionalBooleanParam(record.global, "global")) args.push("--global");
	return runCommandRpc({
		name: "vault.rm",
		args,
		cwd: optionalStringParam(record.cwd, "cwd"),
		wait: optionalBooleanParam(record.wait, "wait") ?? true,
	});
}

function vaultResolveRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(
		record,
		new Set([
			"key",
			"project",
			"agent",
			"allow_conflicts",
			"debug",
			"dry_run",
			"include_value",
			"confirm_secret_access",
			"json",
			"cwd",
			"wait",
		]),
	);
	const includeValue = optionalBooleanParam(record.include_value, "include_value") ?? false;
	const wait = optionalBooleanParam(record.wait, "wait") ?? true;
	if (includeValue) {
		requireBooleanConfirmation(record, "confirm_secret_access", "vault.resolve plaintext access");
		if (!wait)
			throw new Error(
				"vault.resolve with include_value=true cannot run as a background operation.",
			);
	}
	const args = ["vault", "resolve", requiredStringParam(record, "key")];
	appendVaultResolveFlags(args, record);
	if (!includeValue || optionalBooleanParam(record.dry_run, "dry_run")) args.push("--dry-run");
	if (optionalBooleanParam(record.json, "json")) args.push("--json");
	return runCommandRpc({
		name: "vault.resolve",
		args,
		cwd: optionalStringParam(record.cwd, "cwd"),
		wait,
		parseJson: optionalBooleanParam(record.json, "json") ?? false,
	});
}

function vaultReadRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(
		record,
		new Set([
			"reference",
			"project",
			"agent",
			"allow_conflicts",
			"debug",
			"dry_run",
			"confirm_secret_access",
			"json",
			"cwd",
			"wait",
		]),
	);
	const dryRun = optionalBooleanParam(record.dry_run, "dry_run") ?? false;
	const wait = optionalBooleanParam(record.wait, "wait") ?? true;
	if (!dryRun) {
		requireBooleanConfirmation(record, "confirm_secret_access", "vault.read plaintext access");
		if (!wait) throw new Error("vault.read plaintext access cannot run as a background operation.");
	}
	const args = ["read", requiredStringParam(record, "reference")];
	appendVaultResolveFlags(args, record);
	if (dryRun) args.push("--dry-run");
	if (optionalBooleanParam(record.json, "json")) args.push("--json");
	return runCommandRpc({
		name: "vault.read",
		args,
		cwd: optionalStringParam(record.cwd, "cwd"),
		wait,
		parseJson: optionalBooleanParam(record.json, "json") ?? false,
	});
}

function vaultInjectRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(
		record,
		new Set([
			"in",
			"out",
			"input",
			"project",
			"agent",
			"allow_conflicts",
			"no_project_folder",
			"force",
			"dry_run",
			"confirm_secret_access",
			"cwd",
			"wait",
		]),
	);
	const dryRun = optionalBooleanParam(record.dry_run, "dry_run") ?? false;
	if (!dryRun)
		requireBooleanConfirmation(record, "confirm_secret_access", "vault.inject secret rendering");
	const args = ["inject"];
	const stdin = optionalStringParam(record.input, "input");
	const inPath = optionalStringParam(record.in, "in") ?? (stdin !== undefined ? "-" : undefined);
	appendOptionalStringFlag(args, "--in", inPath);
	appendOptionalStringFlag(args, "--out", record.out);
	appendOptionalStringFlag(args, "--project", record.project);
	appendOptionalStringFlag(args, "--agent", record.agent);
	if (optionalBooleanParam(record.allow_conflicts, "allow_conflicts"))
		args.push("--allow-conflicts");
	if (optionalBooleanParam(record.no_project_folder, "no_project_folder"))
		args.push("--no-project-folder");
	if (optionalBooleanParam(record.force, "force")) args.push("--force");
	if (dryRun) args.push("--dry-run");
	return runCommandRpc({
		name: "vault.inject",
		args,
		cwd: optionalStringParam(record.cwd, "cwd"),
		stdin,
		wait: optionalBooleanParam(record.wait, "wait") ?? true,
	});
}

function authStatusRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set());
	const auth = getAuth();
	const pending = getPendingAuth();
	return {
		logged_in: auth !== null,
		user: auth ? { email: auth.email, id: auth.userId } : null,
		api_url: getConfig().apiUrl,
		pending_auth: pending
			? {
					user_code: pending.userCode,
					verification_uri: pending.verificationUri,
					expires_at: pending.expiresAt,
					interval_ms: pending.intervalMs,
					api_url: pending.apiUrl,
				}
			: null,
	};
}

async function authLoginRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["api_key", "api_url", "replace", "confirm_secret_access"]));
	const existing = getAuth();
	const replace = optionalBooleanParam(record.replace, "replace") ?? false;
	if (existing && !replace) {
		return { status: "already_logged_in", user: { email: existing.email, id: existing.userId } };
	}
	if (existing && replace) {
		requireBooleanConfirmation(record, "confirm_secret_access", "auth.login replace existing auth");
	}
	const apiUrl = optionalStringParam(record.api_url, "api_url") ?? getConfig().apiUrl;
	const apiKey = optionalStringParam(record.api_key, "api_key");
	if (apiKey) {
		requireBooleanConfirmation(record, "confirm_secret_access", "auth.login API key import");
		const me = await verifyAndSaveRpcAuth(apiUrl, apiKey);
		return { status: "logged_in", user: me, api_url: apiUrl };
	}
	return startDeviceAuthRpc(apiUrl);
}

async function authCompleteRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["wait_ms"]));
	if (getAuth()) return { status: "already_logged_in" };
	const pending = getPendingAuth();
	if (!pending) return { status: "no_pending_auth" };
	if (Date.now() / 1000 >= pending.expiresAt) {
		clearPendingAuth();
		return { status: "expired" };
	}
	return pollPendingAuthRpc(
		pending,
		optionalLimitParam(record.wait_ms, "wait_ms", 0, 600_000, 30_000),
	);
}

function authLogoutRpc(params: unknown): unknown {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["confirm"]));
	requireBooleanConfirmation(record, "confirm", "auth.logout");
	const wasLoggedIn = isLoggedIn();
	clearAuth();
	clearPendingAuth();
	return { logged_out: wasLoggedIn };
}

function updateCheckRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["cwd"]));
	return runCommandRpc({
		name: "update.check",
		args: ["update", "--json"],
		cwd: optionalStringParam(record.cwd, "cwd"),
		wait: true,
		parseJson: true,
	});
}

async function updateInstallRpc(params: unknown): Promise<unknown> {
	const record = rpcParamsRecord(params);
	rejectRpcParams(record, new Set(["confirm"]));
	requireBooleanConfirmation(record, "confirm", "update.install");
	const result = await daemonAutoUpdateOnce({
		currentVersion: getCliVersion(),
		ignoreDisabled: true,
	});
	return { result };
}

async function runCommandRpc(options: RpcCommandOptions): Promise<unknown> {
	if (!options.wait) {
		return {
			operation: operationManager.start({
				name: options.name,
				args: options.args,
				cwd: options.cwd,
				stdin: options.stdin,
				redactedArgs: options.redactedArgs,
			}),
		};
	}
	const result = await runCliCommandImmediate({
		name: options.name,
		args: options.args,
		cwd: options.cwd,
		stdin: options.stdin,
		redactedArgs: options.redactedArgs,
		timeoutMs: options.timeoutMs,
	});
	const response: RpcCommandResponse = { ...result };
	if (options.parseJson && result.stdout.trim()) {
		response.json = JSON.parse(result.stdout);
	}
	return response;
}

function appendVaultResolveFlags(args: string[], record: Record<string, unknown>): void {
	appendOptionalStringFlag(args, "--project", record.project);
	appendOptionalStringFlag(args, "--agent", record.agent);
	if (optionalBooleanParam(record.allow_conflicts, "allow_conflicts"))
		args.push("--allow-conflicts");
	if (optionalBooleanParam(record.debug, "debug")) args.push("--debug");
}

function appendOptionalStringFlag(args: string[], flag: string, value: unknown): void {
	const parsed = optionalStringParam(value, flag);
	if (parsed !== undefined) args.push(flag, parsed);
}

interface AuthMeResponse {
	id: string;
	email?: string;
	name?: string;
}

interface DeviceStartResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

interface AuthPollResponse {
	status: string;
	api_key?: string | null;
}

async function verifyAndSaveRpcAuth(apiUrl: string, apiKey: string): Promise<AuthMeResponse> {
	setAuth({ apiKey });
	const response = await fetch(`${apiUrl}/api/auth/me`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) {
		clearAuth();
		throw new Error(`API key verification failed with HTTP ${response.status}`);
	}
	const me = await readJsonObject<AuthMeResponse>(response, isAuthMeResponse, "/api/auth/me");
	setAuth({ apiKey, userId: me.id, email: me.email });
	return me;
}

async function startDeviceAuthRpc(apiUrl: string): Promise<unknown> {
	const response = await fetch(`${apiUrl}/api/cli/auth/device`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_label: `clawdi daemon rpc · ${hostname()}` }),
	});
	if (!response.ok) {
		throw new Error(`Failed to start device authorization: HTTP ${response.status}`);
	}
	const start = await readJsonObject<DeviceStartResponse>(
		response,
		isDeviceStartResponse,
		"/api/cli/auth/device",
	);
	const pending = {
		deviceCode: start.device_code,
		userCode: start.user_code,
		verificationUri: start.verification_uri,
		expiresAt: Math.floor(Date.now() / 1000) + start.expires_in,
		intervalMs: Math.max(1, start.interval) * 1000,
		apiUrl,
	};
	setPendingAuth(pending);
	return {
		status: "pending",
		user_code: pending.userCode,
		verification_uri: pending.verificationUri,
		expires_at: pending.expiresAt,
		interval_ms: pending.intervalMs,
		api_url: pending.apiUrl,
	};
}

async function pollPendingAuthRpc(
	pending: NonNullable<ReturnType<typeof getPendingAuth>>,
	waitMs: number,
): Promise<unknown> {
	const deadline = Date.now() + waitMs;
	while (true) {
		const poll = await pollAuthOnce(pending.apiUrl, pending.deviceCode);
		if (poll.status === "approved" && poll.api_key) {
			setAuth({ apiKey: poll.api_key });
			const me = await verifyAndSaveRpcAuth(pending.apiUrl, poll.api_key);
			clearPendingAuth();
			return { status: "logged_in", user: me };
		}
		if (poll.status === "denied" || poll.status === "expired") {
			clearPendingAuth();
			return { status: poll.status };
		}
		if (Date.now() >= deadline || waitMs === 0) {
			return {
				status: "pending",
				user_code: pending.userCode,
				expires_at: pending.expiresAt,
			};
		}
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(pending.intervalMs, Math.max(0, deadline - Date.now()))),
		);
	}
}

async function pollAuthOnce(apiUrl: string, deviceCode: string): Promise<AuthPollResponse> {
	const response = await fetch(`${apiUrl}/api/cli/auth/poll`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ device_code: deviceCode }),
	});
	if (!response.ok) throw new Error(`Auth polling failed with HTTP ${response.status}`);
	return readJsonObject<AuthPollResponse>(response, isAuthPollResponse, "/api/cli/auth/poll");
}

async function readJsonObject<T>(
	response: Response,
	guard: (value: unknown) => value is T,
	label: string,
): Promise<T> {
	const value: unknown = await response.json();
	if (!guard(value)) throw new Error(`Unexpected response body from ${label}`);
	return value;
}

function isAuthMeResponse(value: unknown): value is AuthMeResponse {
	if (!isRecord(value)) return false;
	return typeof value.id === "string";
}

function isDeviceStartResponse(value: unknown): value is DeviceStartResponse {
	if (!isRecord(value)) return false;
	return (
		typeof value.device_code === "string" &&
		typeof value.user_code === "string" &&
		typeof value.verification_uri === "string" &&
		typeof value.expires_in === "number" &&
		typeof value.interval === "number"
	);
}

function isAuthPollResponse(value: unknown): value is AuthPollResponse {
	if (!isRecord(value)) return false;
	return (
		typeof value.status === "string" &&
		(value.api_key === undefined || value.api_key === null || typeof value.api_key === "string")
	);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredStringParam(record: Record<string, unknown>, key: string): string {
	const value = optionalStringParam(record[key], key);
	if (value === undefined) throw new Error(`${key} is required`);
	return value;
}

function optionalStringParam(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	if (!value.trim()) throw new Error(`${label} must not be empty`);
	return value;
}

function optionalStringListParam(value: unknown, label: string): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return [optionalStringParam(value, label) ?? ""];
	if (!Array.isArray(value)) throw new Error(`${label} must be a string or string array`);
	const items: string[] = [];
	for (const item of value) {
		items.push(optionalStringParam(item, label) ?? "");
	}
	return items;
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

function optionalLimitParam(
	value: unknown,
	label: string,
	min: number,
	max: number,
	defaultValue: number,
): number {
	if (value === undefined || value === null) return defaultValue;
	let parsed: number;
	if (typeof value === "number") {
		parsed = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		parsed = Number(value);
	} else {
		throw new Error(`${label} must be an integer from ${min} to ${max}`);
	}
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${label} must be an integer from ${min} to ${max}`);
	}
	return parsed;
}

function requireBooleanConfirmation(
	record: Record<string, unknown>,
	key: string,
	action: string,
): void {
	if (optionalBooleanParam(record[key], key) !== true) {
		throw new Error(`${action} requires ${key}=true.`);
	}
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
	return cleanupLegacyDaemonUnitsExceptLast();
}

function cleanupLegacyDaemonUnitsExceptLast(lastAgent?: AgentType): number {
	let failed = 0;
	const installedAgents = listInstalledAgents();
	const orderedAgents = lastAgent
		? [
				...installedAgents.filter((agentType) => agentType !== lastAgent),
				...installedAgents.filter((agentType) => agentType === lastAgent),
			]
		: installedAgents;
	for (const agentType of orderedAgents) {
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

interface LegacyDaemonRun {
	agentType: AgentType;
	environmentId?: string;
}

function resolveLegacyRunOpts(opts: LegacyRunOpts): LegacyDaemonRun | null {
	const agentType = optionalAgentParam(opts.agent);
	const environmentId = optionalStringParam(opts.environmentId, "--environment-id");
	if (!agentType) {
		if (environmentId) {
			throw new Error("--environment-id requires --agent for legacy daemon run compatibility");
		}
		return null;
	}
	return { agentType, environmentId };
}

function migrateLegacyDaemonRun(legacy: LegacyDaemonRun): void {
	if (!isLoggedIn()) {
		log.error("serve.legacy_daemon_migration_no_auth", {
			agent: legacy.agentType,
			hint: "Set CLAWDI_AUTH_TOKEN env or run `clawdi auth login`, then run `clawdi daemon install`.",
		});
		process.exit(1);
	}
	if (legacy.environmentId) {
		persistLegacyEnvironmentId(legacy);
	}
	log.info("serve.legacy_daemon_migration_started", {
		agent: legacy.agentType,
		has_environment_id: legacy.environmentId !== undefined,
	});
	try {
		const result = installService();
		log.info("serve.legacy_daemon_migration_singleton_installed", {
			unit: result.unit,
			replaced: result.replaced,
		});
	} catch (error) {
		log.error("serve.legacy_daemon_migration_install_failed", {
			agent: legacy.agentType,
			error: toErrorMessage(error),
		});
		process.exit(1);
	}
	const failed = cleanupLegacyDaemonUnitsExceptLast(legacy.agentType);
	log.info("serve.legacy_daemon_migration_finished", {
		agent: legacy.agentType,
		failed,
	});
	process.exit(failed > 0 ? 1 : 0);
}

function persistLegacyEnvironmentId(legacy: LegacyDaemonRun): void {
	if (!legacy.environmentId) return;
	const envDir = join(getClawdiDir(), "environments");
	mkdirSync(envDir, { recursive: true });
	const envPath = join(envDir, `${legacy.agentType}.json`);
	writeFileSync(
		envPath,
		`${JSON.stringify({ id: legacy.environmentId, agentType: legacy.agentType }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	try {
		chmodSync(envPath, 0o600);
	} catch {
		/* best effort */
	}
}

function pickLegacyDaemonRunTarget(legacy: LegacyDaemonRun): DaemonRunTarget {
	const adapter = adapterForType(legacy.agentType);
	if (!adapter) {
		log.error("serve.no_agent_adapter", { agent: legacy.agentType });
		console.error(`No adapter available for ${legacy.agentType}.`);
		process.exit(1);
	}
	const environmentId = legacy.environmentId ?? resolveEnvironmentId(legacy.agentType, 1);
	if (!environmentId) {
		log.error("serve.no_environment", {
			agent: legacy.agentType,
			hint: "Pass --environment-id, set CLAWDI_ENVIRONMENT_ID, or run `clawdi setup`.",
		});
		process.exit(1);
	}
	return {
		agentType: legacy.agentType,
		adapter,
		environmentId,
	};
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
