import { homedir } from "node:os";
import chalk from "chalk";
import type { RawSession } from "../adapters/base";
import { type AgentType, adapterRegistry } from "../adapters/registry";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import type { SessionDetail, SessionListItem, SessionMessage } from "../lib/api-schemas";
import { isLoggedIn } from "../lib/config";
import { sanitizeMetadata, stripTerminalEscapes } from "../lib/sanitize";
import { requireSearchQuery } from "../lib/search-query";
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
		if (!adapter?.sessions) {
			if (opts.agent) {
				console.error(
					chalk.red(`${adapterRegistry[agentType].displayName} does not support local sessions.`),
				);
				process.exitCode = 1;
				return;
			}
			continue;
		}
		let sessions: RawSession[];
		try {
			// `list` command silently benefits from dedupe — no user-facing
			// counter needed since the listing project itself is dedupe's
			// purpose (don't show users two near-identical rows).
			const result = await adapter.sessions.collect({ kind: "complete", projectFilter });
			sessions = result.sessions;
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

interface CloudSessionOpts {
	agent?: string;
	since?: string;
	limit?: string;
	json?: boolean;
}

function requireCloudSessionAuth(): boolean {
	if (isLoggedIn()) return true;
	console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
	process.exitCode = 1;
	return false;
}

function cloudSessionLimit(value?: string): number {
	const limit = value === undefined ? 25 : Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
		throw new Error("--limit must be an integer between 1 and 200.");
	}
	return limit;
}

function cloudSessionSince(value?: string): string | undefined {
	if (!value) return undefined;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid --since date: ${value}`);
	return parsed.toISOString();
}

function printCloudSessionRows(sessions: SessionListItem[], total: number): void {
	for (const session of sessions) {
		const summary = sanitizeMetadata(session.summary ?? "(untitled)");
		const project = session.project_path ? sanitizeMetadata(session.project_path) : "-";
		const agent = sanitizeMetadata(session.agent_type ?? "unknown");
		console.log(
			`  ${chalk.dim(session.id)}  ${chalk.white(summary)}  ${chalk.gray(project)}  ${chalk.gray(agent)}  ${chalk.gray(relativeTime(new Date(session.last_activity_at)))}`,
		);
		if (session.search_match) {
			const role =
				session.search_match.role === "user" ? chalk.cyan("user") : chalk.green("assistant");
			console.log(`    ${role}: ${stripTerminalEscapes(session.search_match.excerpt)}`);
		}
	}
	console.log(chalk.gray(`\n  ${sessions.length} of ${total} match${total === 1 ? "" : "es"}`));
}

export async function sessionSearch(query: string, opts: CloudSessionOpts = {}): Promise<void> {
	if (!requireCloudSessionAuth()) return;
	const trimmedQuery = requireSearchQuery(query, "Session");

	const api = new ApiClient();
	const page = unwrap(
		await api.GET("/v1/sessions", {
			params: {
				query: {
					q: trimmedQuery,
					agent: opts.agent || undefined,
					since: cloudSessionSince(opts.since),
					page_size: cloudSessionLimit(opts.limit),
					sort: "relevance",
					order: "desc",
				},
			},
		}),
	);

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(page.items, null, 2));
		return;
	}
	if (page.items.length === 0) {
		console.log(chalk.gray(`No uploaded sessions matching "${sanitizeMetadata(query)}".`));
		return;
	}
	printCloudSessionRows(page.items, page.total);
}

export async function sessionRead(sessionId: string, opts: { json?: boolean } = {}): Promise<void> {
	if (!requireCloudSessionAuth()) return;
	const api = new ApiClient();
	const detail: SessionDetail = unwrap(
		await api.GET("/v1/sessions/{session_id}", {
			params: { path: { session_id: sessionId } },
		}),
	);
	const messages: SessionMessage[] = detail.has_content
		? unwrap(
				await api.GET("/v1/sessions/{session_id}/content", {
					params: { path: { session_id: sessionId } },
				}),
			)
		: [];

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify({ session: detail, messages }, null, 2));
		return;
	}

	console.log(chalk.bold(sanitizeMetadata(detail.summary ?? detail.local_session_id)));
	console.log(
		chalk.gray(
			`${sanitizeMetadata(detail.agent_type ?? "unknown")} | ${sanitizeMetadata(detail.project_path ?? "no project")} | ${messages.length} messages`,
		),
	);
	console.log();
	for (const message of messages) {
		const role = message.role === "user" ? chalk.cyan("user") : chalk.green("assistant");
		console.log(`${role}: ${stripTerminalEscapes(message.content)}`);
		console.log();
	}
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
			await api.POST("/v1/sessions/{local_session_id}/extract", {
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
