import { homedir } from "node:os";
import chalk from "chalk";
import type { RawSession } from "../adapters/base";
import { type AgentType, adapterRegistry } from "../adapters/registry";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import {
	adapterForType,
	listRegisteredAgentTypes,
	resolveTargetAgentTypes,
} from "../lib/select-adapter";

interface SessionListOpts {
	agent?: string;
	allAgents?: boolean;
	project?: string;
	all?: boolean;
	since?: string;
	limit?: string;
	json?: boolean;
}

interface ListedSession {
	id: string;
	agent: AgentType;
	project: string | null;
	started_at: string;
	ended_at: string | null;
	message_count: number;
	duration_seconds: number | null;
	model: string | null;
	summary: string | null;
}

export async function sessionList(opts: SessionListOpts) {
	// Default to "all registered agents" when neither flag is given. This
	// command is informational — restricting to a single prompted adapter
	// would hide history the user wants to see.
	const wantAllAgents = opts.allAgents || !opts.agent;
	const targetTypes = await resolveTargetAgentTypes(opts.agent, wantAllAgents);
	if (targetTypes.length === 0) {
		// resolveTargetAgentTypes already printed the explanation
		process.exitCode = 1;
		return;
	}

	// `session list` defaults to no project filter — hiding history would
	// defeat the point of the command. `--project` opts back into a filter.
	const projectFilter = opts.all ? undefined : opts.project;
	const since = opts.since ? new Date(opts.since) : undefined;
	const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 100;

	const collected: ListedSession[] = [];
	for (const agentType of targetTypes) {
		const adapter = adapterForType(agentType);
		if (!adapter) continue;
		let sessions: RawSession[];
		try {
			sessions = await adapter.collectSessions({ projectFilter });
		} catch {
			continue;
		}
		for (const s of sessions) {
			// `--since` is a post-filter for the listing UX — adapters no
			// longer filter sessions by session-time (only by file mtime,
			// internally as a perf hint).
			if (since && s.startedAt < since) continue;
			collected.push({
				id: s.localSessionId,
				agent: agentType,
				project: s.projectPath,
				started_at: s.startedAt.toISOString(),
				ended_at: s.endedAt?.toISOString() ?? null,
				message_count: s.messageCount,
				duration_seconds: s.durationSeconds,
				model: s.model,
				summary: s.summary,
			});
		}
	}

	collected.sort((a, b) => b.started_at.localeCompare(a.started_at));
	const truncated = collected.length > limit;
	const shown = collected.slice(0, limit);

	if (opts.json) {
		console.log(JSON.stringify(shown, null, 2));
		return;
	}

	if (shown.length === 0) {
		console.log(chalk.gray("No sessions found."));
		const registered = listRegisteredAgentTypes();
		if (registered.length === 0) {
			console.log(chalk.gray("Run `clawdi setup` to register agents on this machine."));
		}
		return;
	}

	const grouped = new Map<AgentType, ListedSession[]>();
	for (const s of shown) {
		const existing = grouped.get(s.agent) ?? [];
		existing.push(s);
		grouped.set(s.agent, existing);
	}

	const home = homedir();
	for (const [agentType, list] of grouped) {
		console.log();
		console.log(chalk.bold(`${adapterRegistry[agentType].displayName} (${list.length})`));
		for (const s of list) {
			const id = s.id.length > 10 ? `${s.id.slice(0, 8)}…` : s.id;
			const project = s.project ? prettyPath(s.project, home) : chalk.gray("—");
			const when = relativeTime(new Date(s.started_at));
			const msgs = `${s.message_count} msg${s.message_count === 1 ? "" : "s"}`;
			const summary = s.summary ? `"${truncate(s.summary, 60)}"` : "";
			console.log(
				`  ${chalk.dim(id)}  ${project}  ${chalk.gray(when)}  ${chalk.gray(msgs)}  ${chalk.gray(summary)}`,
			);
		}
	}
	console.log();
	const summary = `${shown.length} session${shown.length === 1 ? "" : "s"} across ${grouped.size} agent${grouped.size === 1 ? "" : "s"}`;
	console.log(
		truncated
			? chalk.gray(`${summary} (${collected.length} total — pass --limit to see more)`)
			: chalk.gray(summary),
	);

	// Telegraph the next obvious action for users who came here as a preview
	// step before push.
	console.log();
	console.log(
		chalk.gray("Push with: ") + chalk.cyan("clawdi push --modules sessions --all-agents --all"),
	);
}

function prettyPath(abs: string, home: string): string {
	if (abs === home) return "~";
	if (abs.startsWith(`${home}/`)) return `~/${abs.slice(home.length + 1)}`;
	return abs;
}

function truncate(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function relativeTime(then: Date): string {
	const diffMs = Date.now() - then.getTime();
	const sec = Math.floor(diffMs / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mon = Math.floor(day / 30);
	if (mon < 12) return `${mon}mo ago`;
	const yr = Math.floor(mon / 12);
	return `${yr}y ago`;
}

interface SessionExtractOpts {
	json?: boolean;
}

/** Thin 1:1 wrapper around `POST /api/sessions/{local_session_id}/extract`.
 *
 * No orchestration, no idempotency. The route always calls the LLM;
 * callers (onboarding skill, future dashboard button) decide which
 * sessions to feed in. 503 is the special "extraction not configured"
 * signal the onboarding skill watches for to skip the step cleanly.
 */
export async function sessionExtract(sessionId: string, opts: SessionExtractOpts = {}) {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
	const api = new ApiClient();
	try {
		const result = unwrap(
			await api.POST("/api/sessions/{local_session_id}/extract", {
				params: { path: { local_session_id: sessionId } },
			}),
		);

		if (opts.json || !process.stdout.isTTY) {
			console.log(JSON.stringify({ session_id: sessionId, ...result }));
			return;
		}

		const n = result.memories_created;
		console.log(chalk.green(`✓ ${n} memor${n === 1 ? "y" : "ies"} extracted from ${sessionId}`));
	} catch (e) {
		// 503 means the deployment hasn't configured a memory-extraction LLM.
		// Exit 2 so onboarding scripts can branch on it without parsing stderr.
		if (e instanceof ApiError && e.status === 503) {
			if (opts.json || !process.stdout.isTTY) {
				console.log(
					JSON.stringify({
						session_id: sessionId,
						error: "not_configured",
						message: e.body || e.hint,
					}),
				);
			} else {
				console.log(chalk.yellow(`Memory extraction is not configured on this deployment.`));
			}
			process.exit(2);
		}
		throw e;
	}
}
