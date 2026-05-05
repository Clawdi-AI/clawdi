import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { extractTarGz } from "../lib/tar";
import type {
	AgentAdapter,
	CollectSessionsOptions,
	ContentBlock,
	RawSession,
	RawSkill,
	SessionMessage,
} from "./base";
import { clampToolOutput, collapseTextOnly } from "./base";
import { getOpenClawHome, SKIP_DIRS } from "./paths";

function openclawDir() {
	return getOpenClawHome();
}
function agentsRoot() {
	return join(openclawDir(), "agents");
}
function agentId() {
	return process.env.OPENCLAW_AGENT_ID || "main";
}
function agentDir() {
	// Single-agent path used for *write* operations (skill install, MCP
	// command building). Reads enumerate every agent dir via `listAgentDirs`.
	return join(agentsRoot(), agentId());
}
function sessionsDir() {
	return join(agentDir(), "sessions");
}
function sessionsIndexPath() {
	return join(sessionsDir(), "sessions.json");
}
function skillsDir() {
	return join(agentDir(), "skills");
}

/**
 * Enumerate every `agents/<id>` subdir we should read from. OpenClaw can
 * host many agent personalities side-by-side (see issue #28: a single state
 * root with `main`, `financial`, `sales`, etc.) so we union them. Honoring
 * `OPENCLAW_AGENT_ID` as a single-agent override keeps the explicit-scope
 * escape hatch from the issue's workaround.
 */
function listAgentDirs(): string[] {
	const root = agentsRoot();
	if (!existsSync(root)) return [];
	const override = process.env.OPENCLAW_AGENT_ID?.trim();
	if (override) {
		const dir = join(root, override);
		return existsSync(dir) ? [dir] : [];
	}
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith("."))
			.map((d) => join(root, d.name));
	} catch (e) {
		// `agents/` is present but unreadable (perm bits, encrypted-at-rest,
		// stale fuse mount, …). Silently treating that as "no agents" hides
		// the fact that we actively skipped data — surface it on stderr so
		// `clawdi push` doesn't appear to succeed with 0 sessions.
		console.warn(
			`[openclaw] could not enumerate ${root}: ${e instanceof Error ? e.message : String(e)}`,
		);
		return [];
	}
}

interface SessionEntry {
	// Real openclaw indexes key entries by composite strings like
	// `agent:main:main` or `agent:main:telegram:group:-100…:topic:1`, with
	// the actual UUID stored in this field. Treat the index key as a label
	// only and trust `sessionId` for the localSessionId we publish.
	sessionId?: string;
	updatedAt?: number;
	// May be absolute (production openclaw writes the full `/data/openclaw/…`
	// path) or relative to the agent's `sessions/` dir (older fixtures).
	sessionFile?: string;
	model?: string;
	modelProvider?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	displayName?: string;
	subject?: string;
	label?: string;
	acp?: { cwd?: string; lastActivityAt?: number };
}

interface TranscriptLine {
	type?: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		content?: string | Array<Record<string, unknown>>;
		// Top-level fields on `role: "toolResult"` messages — OpenClaw emits
		// the matching call id + tool name on the message itself, not as a
		// content block. We rewrite these into a canonical user-role message
		// with a `tool_result` block (Anthropic shape) on emit.
		toolCallId?: string;
		toolName?: string;
	};
	provider?: string;
	modelId?: string;
}

/** OpenClaw v3 transcripts use camelCase blocks (`toolCall`, `toolResult`) but
 * the export/load path also accepts snake_case (`tool_use`, `tool_result`)
 * from older sessions. Normalize both to canonical Anthropic shape so the
 * wire format is uniform across adapters.
 *
 * For tool_result, OpenClaw stores `content` as either a string or an array
 * of `{type:"text", text}` blocks — flatten to a single string and clamp to
 * MAX_TOOL_OUTPUT_CHARS so heavy file dumps don't bloat uploads. */
function normalizeOpenClawBlocks(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) return [];
	const out: ContentBlock[] = [];
	for (const b of content) {
		if (typeof b !== "object" || b === null) continue;
		const r = b as Record<string, unknown>;
		const t = r.type;
		if (t === "text" && typeof r.text === "string" && r.text) {
			out.push({ type: "text", text: r.text });
		} else if (t === "toolCall" || t === "tool_use") {
			// camelCase: name, arguments. snake_case: name, input.
			out.push({
				type: "tool_use",
				id: typeof r.id === "string" ? r.id : "",
				name: typeof r.name === "string" ? r.name : "?",
				input: r.input ?? r.arguments ?? {},
			});
		} else if (t === "toolResult" || t === "tool_result") {
			// camelCase: toolCallId. snake_case: tool_use_id.
			const refId =
				typeof r.toolCallId === "string"
					? r.toolCallId
					: typeof r.tool_use_id === "string"
						? r.tool_use_id
						: "";
			out.push({
				type: "tool_result",
				tool_use_id: refId,
				content: clampToolOutput(flattenToolResultContent(r.content)),
				is_error: r.is_error === true || r.isError === true ? true : undefined,
			});
		} else if (t === "thinking" && typeof r.thinking === "string" && r.thinking) {
			out.push({ type: "thinking", thinking: r.thinking });
		}
	}
	return out;
}

function flattenToolResultContent(c: unknown): string {
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.map((b) => {
			if (typeof b !== "object" || b === null) return "";
			const r = b as Record<string, unknown>;
			if (r.type === "text" && typeof r.text === "string") return r.text;
			return `[${r.type ?? "block"}]`;
		})
		.join("\n");
}

/** Render a SessionMessage's content as a snippet for summary fields. */
function snippetOf(content: string | ContentBlock[], n: number): string {
	if (typeof content === "string") return content.slice(0, n);
	for (const b of content) {
		if (b.type === "text") return b.text.slice(0, n);
	}
	return "";
}

export class OpenClawAdapter implements AgentAdapter {
	readonly agentType = "openclaw" as const;

	async detect(): Promise<boolean> {
		// OpenClaw creates `agents/{id}/` per agent. Detection succeeds when
		// the state root has at least one agent dir, or the configured agent's
		// session index exists. Accepting any agent dir is what makes deployments
		// like `/data/openclaw/agents/{main,financial,sales,...}` work without
		// the user setting `OPENCLAW_AGENT_ID` per agent (issue #28).
		if (!existsSync(openclawDir())) return false;
		if (existsSync(sessionsIndexPath())) return true;
		return listAgentDirs().length > 0;
	}

	async getVersion(): Promise<string | null> {
		const { execSync } = await import("node:child_process");
		try {
			return (
				execSync("openclaw --version", { encoding: "utf-8", stdio: "pipe" })
					.trim()
					.split("\n")[0] || null
			);
		} catch {
			try {
				return (
					execSync("openclaw --help", { encoding: "utf-8", stdio: "pipe" }).trim().split("\n")[0] ||
					null
				);
			} catch {
				return null;
			}
		}
	}

	async collectSessions(opts: CollectSessionsOptions = {}): Promise<RawSession[]> {
		const agentDirs = listAgentDirs();
		if (agentDirs.length === 0) return [];

		const { projectFilter } = opts;
		let absFilter: string | null = null;
		if (projectFilter) {
			const { resolve } = await import("node:path");
			absFilter = resolve(projectFilter);
		}

		const sessions: RawSession[] = [];
		const seenSessionIds = new Set<string>();

		for (const agentRoot of agentDirs) {
			const sessionsDirForAgent = join(agentRoot, "sessions");
			const indexPath = join(sessionsDirForAgent, "sessions.json");
			if (!existsSync(indexPath)) continue;

			let index: Record<string, SessionEntry>;
			try {
				index = JSON.parse(readFileSync(indexPath, "utf-8"));
			} catch {
				continue;
			}

			for (const [indexKey, entry] of Object.entries(index)) {
				// Prefer the entry's own `sessionId` (real UUID); fall back to
				// the index key only for legacy fixtures that use the UUID as
				// the key directly.
				const sessionId = entry.sessionId ?? indexKey;
				// sessions.json can have multiple indexKeys (e.g. agent:main:cron:xxx +
				// agent:main:main:thread:yyy) that resolve to the same underlying
				// sessionId. The batch upload endpoint has a unique constraint on
				// (env_id, local_session_id) and 500s on duplicates, so dedupe here.
				if (seenSessionIds.has(sessionId)) continue;
				seenSessionIds.add(sessionId);
				const updatedAt = entry.updatedAt ?? entry.acp?.lastActivityAt;
				if (!updatedAt) continue;

				const projectPath = entry.acp?.cwd ?? null;
				if (absFilter) {
					if (!projectPath) continue;
					if (projectPath !== absFilter && !projectPath.startsWith(`${absFilter}/`)) continue;
				}

				const transcriptPath = entry.sessionFile
					? isAbsolute(entry.sessionFile)
						? entry.sessionFile
						: join(sessionsDirForAgent, entry.sessionFile)
					: join(sessionsDirForAgent, `${sessionId}.jsonl`);

				const messages: SessionMessage[] = [];
				let startedAt: Date | null = null;
				let endedAt: Date | null = null;
				const modelsUsed = new Set<string>();
				if (entry.model) modelsUsed.add(entry.model);
				let currentModel = entry.model ?? null;

				if (!existsSync(transcriptPath)) {
					if (entry.sessionFile) {
						// Index points at an absolute or relative transcript that we
						// can't reach from this process (different mount, stale path,
						// path-join bug regression). Surface it instead of silently
						// dropping the session.
						console.warn(`[openclaw] transcript missing for ${sessionId}: ${transcriptPath}`);
					}
				} else {
					try {
						const lines = readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean);
						for (const line of lines) {
							let parsed: TranscriptLine;
							try {
								parsed = JSON.parse(line);
							} catch {
								continue;
							}

							const ts = parsed.timestamp
								? new Date(
										typeof parsed.timestamp === "number" ? parsed.timestamp : parsed.timestamp,
									)
								: null;
							if (ts && !Number.isNaN(ts.getTime())) {
								if (!startedAt) startedAt = ts;
								endedAt = ts;
							}

							// `model_change` payload shape is inferred from the pi-coding-agent
							// types; not verified against a live OpenClaw transcript. Defensive.
							if (parsed.type === "model_change" && parsed.modelId) {
								modelsUsed.add(parsed.modelId);
								currentModel = parsed.modelId;
								continue;
							}

							if (parsed.type !== "message") continue;
							const role = parsed.message?.role;
							const c = parsed.message?.content;

							// OpenClaw uses a third role `"toolResult"` for tool
							// outputs — it carries `toolCallId` + `toolName` on
							// the message itself and `content[]` is the result
							// body. Rewrite to canonical Anthropic shape: a
							// user-role message holding one tool_result block.
							if (role === "toolResult") {
								const resultText = clampToolOutput(flattenToolResultContent(c));
								if (!resultText && !parsed.message?.toolCallId) continue;
								const block: ContentBlock = {
									type: "tool_result",
									tool_use_id: parsed.message?.toolCallId ?? "",
									content: resultText,
								};
								messages.push({
									role: "user",
									content: [block],
									timestamp: ts?.toISOString(),
								});
								continue;
							}

							if (role !== "user" && role !== "assistant") continue;
							let normalized: string | ContentBlock[] | null = null;
							if (typeof c === "string") {
								normalized = c ? c : null;
							} else if (Array.isArray(c)) {
								// Preserve toolCall + toolResult blocks (canonical Anthropic
								// shape) so the cloud can count tool usage and search by tool.
								// Plain-text-only messages collapse to a string (legacy wire
								// format); empty messages are dropped (OpenClaw emits some
								// bookkeeping entries with no usable content).
								normalized = collapseTextOnly(normalizeOpenClawBlocks(c));
							}
							if (!normalized) continue;
							messages.push({
								role,
								content: normalized,
								model: role === "assistant" ? (currentModel ?? undefined) : undefined,
								timestamp: ts?.toISOString(),
							});
						}
					} catch {
						// Unreadable transcript — fall through with whatever we have.
					}
				}

				if (messages.length === 0) continue;

				// Defensive fallback: a transcript with messages but no timestamps at all
				// shouldn't happen in practice, but keep the session recoverable via the
				// index's updatedAt rather than throwing.
				startedAt ??= new Date(updatedAt);
				endedAt ??= new Date(updatedAt);

				const durationSeconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);

				const firstUser = messages.find((m) => m.role === "user");
				const summary =
					entry.displayName ??
					entry.subject ??
					entry.label ??
					(firstUser ? snippetOf(firstUser.content, 200) || null : null);

				sessions.push({
					localSessionId: sessionId,
					projectPath,
					startedAt,
					endedAt,
					messageCount: messages.length,
					inputTokens: entry.inputTokens ?? 0,
					outputTokens: entry.outputTokens ?? 0,
					cacheReadTokens: entry.cacheRead ?? 0,
					model: currentModel,
					modelsUsed: [...modelsUsed],
					durationSeconds,
					summary,
					messages,
					rawFilePath: existsSync(transcriptPath) ? transcriptPath : indexPath,
				});
			}
		}

		return sessions;
	}

	async collectSkills(): Promise<RawSkill[]> {
		const skills: RawSkill[] = [];
		const seen = new Map<string, string>(); // skillKey → first-winning agentDir

		// Skills can live under any `agents/<id>/skills/` — iterate every
		// agent the user has on disk so a deployment with multiple
		// personalities (issue #28) doesn't lose six of seven skill sets.
		// Dedup by `skillKey`: identical names across agents collapse to
		// the first occurrence (server-side `skill_key` is per-user, so
		// we'd 409 on the second push anyway). Warn on collision so the
		// user can rename or pick an explicit OPENCLAW_AGENT_ID.
		for (const agentRoot of listAgentDirs()) {
			const dir = join(agentRoot, "skills");
			if (!existsSync(dir)) continue;

			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (SKIP_DIRS.has(entry.name)) continue;
				// Bundled by `clawdi setup`, not user-authored. See claude-code.ts
				// for the full reasoning.
				if (entry.name === "clawdi") continue;
				const dirPath = join(dir, entry.name);
				const skillMd = join(dirPath, "SKILL.md");
				if (!existsSync(skillMd)) continue;

				const existing = seen.get(entry.name);
				if (existing) {
					console.warn(
						`[openclaw] skipping duplicate skill "${entry.name}" at ${dirPath} ` +
							`(already collected from ${existing}). Set OPENCLAW_AGENT_ID to scope explicitly.`,
					);
					continue;
				}

				const content = readFileSync(skillMd, "utf-8");
				const fileCount = readdirSync(dirPath, { recursive: true }).length;

				seen.set(entry.name, dirPath);
				skills.push({
					skillKey: entry.name,
					name: entry.name,
					content,
					filePath: skillMd,
					directoryPath: dirPath,
					isDirectory: fileCount > 1,
				});
			}
		}
		return skills;
	}

	getSkillPath(key: string): string {
		return join(skillsDir(), key, "SKILL.md");
	}

	async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		const targetDir = join(skillsDir(), key);
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		mkdirSync(targetDir, { recursive: true });

		await extractTarGz(skillsDir(), tarGzBytes);
	}

	buildRunCommand(args: string[], _env: Record<string, string>): string[] {
		return ["openclaw", ...args];
	}
}
