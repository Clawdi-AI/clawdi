import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { safeTruncate } from "../lib/sanitize";
import { durationSecondsBetween } from "../lib/session-duration";
import { type SessionEventDraft, sequenceSessionEvents } from "../lib/session-events";
import type {
	AgentAdapterCore,
	RawSession,
	SessionScanRequest,
	SessionScanResult,
	SyncReadContext,
} from "./base";
import { getClaudeHome, matchesProjectFilter } from "./paths";
import {
	canonicalStructuredString,
	type JsonObject,
	jsonObject,
	jsonString,
	reasoningContent,
	stableRecordId,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
import { jsonlPathsWithin } from "./session-files";
import { addSessionModel, describeSessionContent, JsonlSessionSource } from "./session-source";
import { flatSkillModule } from "./skill-dir";
import { withSessionIndex } from "./sqlite";
import { readCommandVersion } from "./version";

function claudeDir() {
	return getClaudeHome();
}
function projectsDir() {
	return join(claudeDir(), "projects");
}

interface SessionJsonlEntry {
	type?: string;
	message?: {
		role?: string;
		model?: string;
		content?: string | Array<{ type: string; text?: string }>;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
	timestamp?: string;
	sessionId?: string;
	cwd?: string;
	version?: string;
	uuid?: string;
}

function claudeEventDrafts(
	raw: JsonObject,
	sessionKey: string,
	recordSeq: number,
): SessionEventDraft[] {
	const message = jsonObject(raw.message);
	if (!message) return [];
	const role = jsonString(message.role);
	const timestamp = jsonString(raw.timestamp) ?? undefined;
	const model = jsonString(message.model) ?? undefined;
	const recordId = stableRecordId(raw, recordSeq);
	const eventSource = (partIndex?: number) => ({
		adapter: "claude_code" as const,
		session_key: sessionKey,
		record_id: recordId,
		record_seq: recordSeq,
		...(partIndex === undefined ? {} : { part_index: partIndex }),
	});
	const drafts: SessionEventDraft[] = [];
	if (role === "user" || role === "assistant" || role === "system" || role === "developer") {
		const parts = visibleContentParts(message.content);
		if (parts.length > 0) {
			drafts.push({
				type: "message",
				role,
				parts,
				source: eventSource(0),
				...(timestamp ? { timestamp } : {}),
				...(role === "assistant" && model ? { model } : {}),
			});
		}
	}
	const blocks = Array.isArray(message.content) ? message.content : [];
	for (let index = 0; index < blocks.length; index++) {
		const block = jsonObject(blocks[index]);
		if (!block) continue;
		const reasoning = role === "assistant" ? reasoningContent(block) : null;
		if (reasoning) {
			drafts.push({
				type: "reasoning",
				...reasoning,
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
				...(model ? { model } : {}),
			});
		}
		if (role === "assistant" && block.type === "tool_use") {
			const callId = jsonString(block.id);
			const name = jsonString(block.name);
			if (!callId || !name) continue;
			drafts.push({
				type: "tool_call",
				call_id: callId,
				name,
				arguments_json: canonicalStructuredString(block.input),
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
				...(model ? { model } : {}),
			});
		}
		if (role === "user" && block.type === "tool_result") {
			const callId = jsonString(block.tool_use_id);
			if (!callId) continue;
			const result = toolResultContent(block.content);
			drafts.push({
				type: "tool_result",
				call_id: callId,
				status: block.is_error === true ? "error" : "completed",
				...result,
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
			});
		}
	}
	return drafts;
}

type ParsedSession = Omit<RawSession, "localSessionId" | "rawFilePath">;

export class ClaudeCodeAdapter implements AgentAdapterCore {
	readonly agentType = "claude_code" as const;
	readonly sessions = {
		contentProtocol: async (context?: SyncReadContext) => {
			context?.signal.throwIfAborted();
			return "events-v1" as const;
		},
		collect: (request: SessionScanRequest, context?: SyncReadContext) =>
			this.collectSessions(request, context),
		resolve: (localSessionId: string, context?: SyncReadContext) =>
			this.resolveSession(localSessionId, context),
		watchPaths: () => this.getSessionsWatchPaths(),
	};
	readonly skills = flatSkillModule({ root: () => join(claudeDir(), "skills") });

	async detect(): Promise<boolean> {
		// Bare `~/.claude/` may exist from gstack/other tools or be a stale
		// leftover. Require at least one artifact that a real Claude Code
		// install creates: the projects dir (after first run), settings.json
		// (configured via the IDE), or a top-level CLAUDE.md.
		// Last resort: `claude --version` succeeding — covers a brand-new
		// install where the binary is in PATH but the user hasn't started a
		// session yet (none of the artifacts exist).
		if (
			existsSync(claudeDir()) &&
			(existsSync(projectsDir()) ||
				existsSync(join(claudeDir(), "settings.json")) ||
				existsSync(join(claudeDir(), "CLAUDE.md")))
		) {
			return true;
		}
		return (await this.getVersion()) !== null;
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("claude", ["--version"]);
	}

	/**
	 * Convert absolute path to Claude Code project dir name.
	 * /Users/paco/workspace/clawdi → -Users-paco-workspace-clawdi
	 */
	private pathToProjectDir(absPath: string): string {
		return absPath.replace(/\//g, "-");
	}

	private async collectSessions(
		request: SessionScanRequest,
		context?: SyncReadContext,
	): Promise<SessionScanResult> {
		context?.signal.throwIfAborted();
		if (!existsSync(projectsDir())) {
			return { sessions: [], dedupedCount: 0, coverage: "complete" };
		}

		const { projectFilter } = request;
		const absFilter = projectFilter ? resolve(projectFilter) : null;
		if (request.kind === "paths") {
			const root = resolve(projectsDir());
			const paths = jsonlPathsWithin(request, [root]);
			if (!paths) return this.collectSessions({ kind: "complete", projectFilter }, context);
			const projectDirNames = new Set<string>();
			for (const path of paths) {
				const parts = relative(root, path).split(/[\\/]/);
				if (parts.length !== 2)
					return this.collectSessions({ kind: "complete", projectFilter }, context);
				projectDirNames.add(parts[0]);
			}
			return this.collectProjectSessions([...projectDirNames], absFilter, "partial", context);
		}

		let projectDirs = readdirSync(projectsDir(), { withFileTypes: true }).filter((d) =>
			d.isDirectory(),
		);

		if (absFilter) {
			const targetDir = this.pathToProjectDir(absFilter);
			// Coarse pre-filter on the encoded dir name: keep the target and any
			// dir whose name starts with "target-". Because "/" and in-segment "-"
			// both encode as "-", this superset may include sibling repos like
			// "clawdi-web" when the target is "clawdi" — those false positives
			// are dropped below using each session's real cwd.
			projectDirs = projectDirs.filter(
				(d) => d.name === targetDir || d.name.startsWith(`${targetDir}-`),
			);
		}

		return this.collectProjectSessions(
			projectDirs.map((projectDir) => projectDir.name),
			absFilter,
			"complete",
			context,
		);
	}

	private async resolveSession(
		localSessionId: string,
		context?: SyncReadContext,
	): Promise<RawSession | null> {
		context?.signal.throwIfAborted();
		if (!existsSync(projectsDir()) || basename(localSessionId) !== localSessionId) return null;
		const matches: Array<{ filePath: string; projectDirName: string }> = [];
		for (const projectDir of readdirSync(projectsDir(), { withFileTypes: true })) {
			if (!projectDir.isDirectory()) continue;
			const filePath = join(projectsDir(), projectDir.name, `${localSessionId}.jsonl`);
			if (existsSync(filePath)) matches.push({ filePath, projectDirName: projectDir.name });
		}
		if (matches.length !== 1) {
			if (matches.length === 0) return null;
			return (
				(await this.collectSessions({ kind: "complete" }, context)).sessions.find(
					(session) => session.localSessionId === localSessionId,
				) ?? null
			);
		}
		return (
			(
				await this.collectProjectSessions([matches[0].projectDirName], null, "partial", context)
			).sessions.find((session) => session.localSessionId === localSessionId) ?? null
		);
	}

	private async collectProjectSessions(
		projectDirNames: readonly string[],
		absFilter: string | null,
		coverage: SessionScanResult["coverage"],
		context?: SyncReadContext,
	): Promise<SessionScanResult> {
		return withSessionIndex(async (index) => {
			index.exec(`
				CREATE TABLE uuids (source_key INTEGER, uuid TEXT, PRIMARY KEY (source_key, uuid)) WITHOUT ROWID;
				CREATE TABLE inventory (source_key INTEGER PRIMARY KEY, project TEXT, uuid_count INTEGER);
				BEGIN;
			`);
			const insertUuid = index.prepare("INSERT OR IGNORE INTO uuids VALUES (?, ?)");
			const insertSource = index.prepare(
				"INSERT INTO inventory VALUES (?, ?, (SELECT count(*) FROM uuids WHERE source_key=?))",
			);
			const sources: Array<{ session: RawSession; sourceKey: number }> = [];
			let sourceKey = 0;
			for (const projectDirName of projectDirNames) {
				const projectPath = join(projectsDir(), projectDirName);
				if (!existsSync(projectPath)) continue;
				for (const file of readdirSync(projectPath).filter((name) => name.endsWith(".jsonl"))) {
					if (context) await setImmediate(undefined, { signal: context.signal });
					const key = sourceKey++;
					try {
						const session = await this.parseRawSession(join(projectPath, file), context, (uuid) =>
							insertUuid.run(key, uuid),
						);
						if (!session) continue;
						const cwd = session.projectPath;
						if (!matchesProjectFilter(cwd, absFilter)) {
							continue;
						}
						insertSource.run(key, cwd, key);
						sources.push({ session, sourceKey: key });
					} catch (error) {
						context?.signal.throwIfAborted();
						if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
							throw error;
					}
				}
			}
			index.exec("COMMIT");
			const subset = index.prepare(`
				SELECT 1 FROM inventory b
				WHERE b.project IS ? AND b.uuid_count > (SELECT uuid_count FROM inventory WHERE source_key=?)
				AND (SELECT uuid_count FROM inventory WHERE source_key=?) >= 10
				AND NOT EXISTS (
					SELECT 1 FROM uuids a WHERE a.source_key=? AND NOT EXISTS (
						SELECT 1 FROM uuids bu WHERE bu.source_key=b.source_key AND bu.uuid=a.uuid
					)
				) LIMIT 1
			`);
			const dedupedIds = new Set<string>();
			for (const { session, sourceKey: key } of sources) {
				context?.signal.throwIfAborted();
				if (subset.get(session.projectPath, key, key, key)) dedupedIds.add(session.localSessionId);
			}
			return {
				sessions: sources
					.map(({ session }) => session)
					.filter((session) => !dedupedIds.has(session.localSessionId)),
				dedupedCount: dedupedIds.size,
				coverage,
			};
		});
	}

	private async parseRawSession(
		filePath: string,
		context: SyncReadContext | undefined,
		observeUuid: (uuid: string) => void,
	): Promise<RawSession | null> {
		const parsed = await this.parseSessionJsonl(filePath, context, observeUuid);
		if (!parsed) return null;
		return {
			...parsed,
			localSessionId: basename(filePath, ".jsonl"),
			rawFilePath: filePath,
		};
	}

	private async parseSessionJsonl(
		filePath: string,
		context: SyncReadContext | undefined,
		observeUuid: (uuid: string) => void,
	): Promise<ParsedSession | null> {
		const source = await JsonlSessionSource.open(filePath, context);

		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let startedAt: Date | null = null;
		let endedAt: Date | null = null;
		let model: string | null = null;
		const modelsUsed = new Set<string>();
		let projectPath: string | null = null;
		let firstUserMessage: string | null = null;

		for await (const { data: raw } of source.records()) {
			const entry = raw as SessionJsonlEntry;
			const msg = entry.message;
			const role = msg?.role;

			const uuid = jsonString(raw.uuid);
			if (uuid) observeUuid(uuid);

			if (entry.timestamp) {
				const ts = new Date(entry.timestamp);
				if (!Number.isNaN(ts.getTime())) {
					startedAt ??= ts;
					endedAt = ts;
				}
			}

			if (entry.cwd && !projectPath) {
				projectPath = entry.cwd;
			}

			if (role === "user" && !firstUserMessage) {
				const c = msg?.content;
				if (typeof c === "string") {
					firstUserMessage = safeTruncate(c, 200);
				} else if (Array.isArray(c)) {
					const textBlock = c.find((b) => b.type === "text" && b.text);
					if (textBlock?.text) {
						firstUserMessage = safeTruncate(textBlock.text, 200);
					}
				}
			}

			if (role === "assistant" && msg?.model) {
				addSessionModel(modelsUsed, msg.model);
				model = msg.model;
			}

			if (msg?.usage) {
				inputTokens += msg.usage.input_tokens ?? 0;
				outputTokens += msg.usage.output_tokens ?? 0;
				cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
			}
		}
		if (source.validRecords < 3) return null;
		const sourceSessionKey = basename(filePath, ".jsonl");
		const readEvents = async function* () {
			let seq = 0;
			for await (const { data: raw, recordSeq } of source.records()) {
				const events = sequenceSessionEvents(
					claudeEventDrafts(raw, sourceSessionKey, recordSeq),
					seq,
				);
				seq += events.length;
				yield* events;
			}
		};
		const description = await describeSessionContent(readEvents, source.eager);

		if (!startedAt || description.messageCount === 0) return null;

		const durationSeconds = durationSecondsBetween(startedAt, endedAt);

		return {
			projectPath,
			startedAt,
			endedAt,
			messageCount: description.messageCount,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			model,
			modelsUsed: [...modelsUsed],
			summary: firstUserMessage,
			...description.content,
			sourceRevision: source.revision,
			durationSeconds,
		};
	}

	private getSessionsWatchPaths(): string[] {
		// Claude Code dumps each conversation as a JSONL file under
		// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. New
		// projects appear as new subdirs; the watcher attaches
		// recursively from the projects root.
		return [projectsDir()];
	}
}
