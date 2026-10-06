import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { getCodexHome, isPathWithinRoots } from "./paths";
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
import { addSessionModel, describeSessionContent, JsonlSessionSource } from "./session-source";
import { flatSkillModule } from "./skill-dir";
import { readCommandVersion } from "./version";

function codexDir() {
	return getCodexHome();
}
function sessionsDir() {
	return join(codexDir(), "sessions");
}
function archivedSessionsDir() {
	return join(codexDir(), "archived_sessions");
}
function sessionRoots() {
	return [sessionsDir(), archivedSessionsDir()];
}
function skillsDir() {
	return join(codexDir(), "skills");
}

interface SessionLine {
	timestamp?: string;
	type?: string;
	payload?: {
		type?: string;
		id?: string;
		timestamp?: string;
		cwd?: string;
		role?: string;
		content?: Array<{ type: string; text?: string }> | string;
		model?: string;
		info?: {
			total_token_usage?: {
				input_tokens?: number;
				output_tokens?: number;
				cached_input_tokens?: number;
			};
		};
	};
}

function codexEventDrafts(
	raw: JsonObject,
	sessionKey: string,
	recordSeq: number,
): SessionEventDraft[] {
	if (raw.type !== "response_item") return [];
	const payload = jsonObject(raw.payload);
	if (!payload) return [];
	const payloadType = jsonString(payload.type);
	const timestamp = jsonString(raw.timestamp) ?? undefined;
	const recordId =
		jsonString(payload.id) ?? jsonString(payload.call_id) ?? stableRecordId(raw, recordSeq);
	const eventSource = (partIndex?: number) => ({
		adapter: "codex" as const,
		session_key: sessionKey,
		record_id: recordId,
		record_seq: recordSeq,
		...(partIndex === undefined ? {} : { part_index: partIndex }),
	});
	if (payloadType === "message") {
		const role = jsonString(payload.role);
		if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") {
			return [];
		}
		const parts = visibleContentParts(payload.content);
		return parts.length > 0
			? [
					{
						type: "message",
						role,
						parts,
						source: eventSource(),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
	}
	if (payloadType === "reasoning") {
		const reasoning = reasoningContent(payload);
		return reasoning
			? [
					{
						type: "reasoning",
						...reasoning,
						source: eventSource(),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
	}
	if (payloadType === "function_call" || payloadType === "custom_tool_call") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		const name = jsonString(payload.name);
		if (!callId || !name) return [];
		return [
			{
				type: "tool_call",
				call_id: callId,
				name,
				arguments_json: canonicalStructuredString(
					payloadType === "function_call" ? payload.arguments : payload.input,
				),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		if (!callId) return [];
		const result = toolResultContent(payload.output);
		return [
			{
				type: "tool_result",
				call_id: callId,
				status: payload.status === "failed" ? "error" : "completed",
				...result,
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "tool_search_call") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		if (!callId) return [];
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "tool_search",
				arguments_json: canonicalStructuredString({
					execution: payload.execution,
					arguments: payload.arguments,
				}),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "tool_search_output") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		if (!callId) return [];
		return [
			{
				type: "tool_result",
				call_id: callId,
				name: "tool_search",
				status: payload.status === "failed" ? "error" : "completed",
				...toolResultContent(undefined, {
					execution: payload.execution,
					tools: payload.tools,
				}),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "image_generation_call") {
		const callId = jsonString(payload.id) ?? recordId;
		const result = toolResultContent([
			{
				type: "image",
				data: payload.result,
				media_type: "image/png",
				name: "generated-image.png",
			},
		]);
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "image_generation",
				arguments_json: canonicalStructuredString({ revised_prompt: payload.revised_prompt }),
				source: eventSource(0),
				...(timestamp ? { timestamp } : {}),
			},
			{
				type: "tool_result",
				call_id: callId,
				name: "image_generation",
				status: payload.status === "failed" ? "error" : "completed",
				...result,
				source: eventSource(1),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "agent_message") {
		const content = Array.isArray(payload.content) ? payload.content : [];
		const text = content
			.map((item) => jsonObject(item))
			.filter((item): item is JsonObject => item?.type === "input_text")
			.map((item) => jsonString(item.text))
			.filter((item): item is string => item !== null)
			.join("\n");
		const author = jsonString(payload.author);
		const recipient = jsonString(payload.recipient);
		const drafts: SessionEventDraft[] = [];
		if (text && author && recipient) {
			drafts.push({
				type: "message",
				role: "developer",
				parts: [{ type: "text", text: `[Agent message from ${author} to ${recipient}]\n${text}` }],
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			});
		}
		for (let index = 0; index < content.length; index++) {
			const reasoning = reasoningContent(content[index]);
			if (!reasoning) continue;
			drafts.push({
				type: "reasoning",
				...reasoning,
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
			});
		}
		return drafts;
	}
	if (payloadType === "local_shell_call") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		if (!callId) return [];
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "shell",
				arguments_json: canonicalStructuredString(payload.action),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "web_search_call") {
		const callId = jsonString(payload.id);
		if (!callId) return [];
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "web_search",
				arguments_json: canonicalStructuredString(payload.action),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	return [];
}

function bindAssistantModel(draft: SessionEventDraft, model: string | null): SessionEventDraft {
	if (
		!model ||
		draft.type === "tool_result" ||
		(draft.type === "message" && draft.role !== "assistant")
	) {
		return draft;
	}
	return { ...draft, model };
}

function collectJsonlFiles(root: string): string[] {
	const results: string[] = [];
	if (!existsSync(root)) return results;

	// Directory layout: YYYY/MM/DD/rollout-*.jsonl. Complete inventory
	// collection walks every file; watcher and queue paths use the bounded
	// collectors below.
	const walk = (dir: string) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				results.push(full);
			}
		}
	};

	walk(root);
	return results;
}

function resolveProjectFilter(projectFilter?: string): string | null {
	return projectFilter ? resolve(projectFilter) : null;
}

async function parseSessionFile(
	filePath: string,
	absFilter: string | null,
	context?: SyncReadContext,
): Promise<RawSession | null> {
	let source: JsonlSessionSource;
	try {
		source = await JsonlSessionSource.open(filePath, context);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}

	let sessionId: string | null = null;
	let projectPath: string | null = null;
	let startedAt: Date | null = null;
	let endedAt: Date | null = null;
	let lastModel: string | null = null;
	const modelsUsed = new Set<string>();
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;

	for await (const { data: raw } of source.records()) {
		const parsed = raw as SessionLine;

		const ts = parsed.timestamp ? new Date(parsed.timestamp) : null;
		if (ts && !Number.isNaN(ts.getTime())) {
			if (!startedAt) startedAt = ts;
			endedAt = ts;
		}

		if (parsed.type === "session_meta") {
			sessionId = parsed.payload?.id ?? sessionId;
			projectPath = parsed.payload?.cwd ?? projectPath;
			if (parsed.payload?.timestamp) {
				const headerTs = new Date(parsed.payload.timestamp);
				if (!Number.isNaN(headerTs.getTime())) startedAt = headerTs;
			}
			continue;
		}

		if (parsed.type === "turn_context") {
			const model = parsed.payload?.model;
			if (model) {
				lastModel = model;
				addSessionModel(modelsUsed, model);
			}
			continue;
		}

		if (parsed.type === "event_msg" && parsed.payload?.type === "token_count") {
			const total = parsed.payload.info?.total_token_usage;
			if (total) {
				inputTokens = total.input_tokens ?? inputTokens;
				outputTokens = total.output_tokens ?? outputTokens;
				cacheReadTokens = total.cached_input_tokens ?? cacheReadTokens;
			}
		}
	}
	if (!sessionId) return null;
	if (absFilter) {
		if (typeof projectPath !== "string") return null;
		if (projectPath !== absFilter && !projectPath.startsWith(`${absFilter}/`)) return null;
	}
	const sessionKey = sessionId;
	const readEvents = async function* () {
		let model: string | null = null;
		let seq = 0;
		for await (const { data: raw, recordSeq } of source.records()) {
			const parsed = raw as SessionLine;
			if (parsed.type === "session_meta") continue;
			if (parsed.type === "turn_context") {
				model = parsed.payload?.model ?? model;
				continue;
			}
			const events = sequenceSessionEvents(
				codexEventDrafts(raw, sessionKey, recordSeq).map((draft) =>
					bindAssistantModel(draft, model),
				),
				seq,
			);
			seq += events.length;
			yield* events;
		}
	};
	const description = await describeSessionContent(
		readEvents,
		source.eager,
		(message) => !message.content.startsWith("<environment_context>"),
	);
	if (description.messageCount === 0 || !startedAt) return null;

	endedAt ??= startedAt;
	const firstRealUser = description.firstUser;

	return {
		localSessionId: sessionId,
		projectPath,
		startedAt,
		endedAt,
		messageCount: description.messageCount,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		model: lastModel,
		modelsUsed: [...modelsUsed],
		durationSeconds: durationSecondsBetween(startedAt, endedAt),
		summary: firstRealUser ? safeTruncate(firstRealUser.content, 200) : null,
		...description.content,
		sourceRevision: source.revision,
		rawFilePath: filePath,
	};
}

export class CodexAdapter implements AgentAdapterCore {
	readonly agentType = "codex" as const;
	private sessionPaths = new Map<string, string>();
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
	readonly skills = flatSkillModule({ root: skillsDir });

	async detect(): Promise<boolean> {
		// Bare `~/.codex/` could be a leftover. Require either the sessions
		// dir (created on first `codex` run) or `config.toml` (created when
		// the user edits codex config).
		if (!existsSync(codexDir())) return false;
		return (
			existsSync(sessionsDir()) ||
			existsSync(archivedSessionsDir()) ||
			existsSync(join(codexDir(), "config.toml"))
		);
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("codex", ["--version"]);
	}

	private async collectSessions(
		request: SessionScanRequest,
		context?: SyncReadContext,
	): Promise<SessionScanResult> {
		context?.signal.throwIfAborted();
		const absFilter = resolveProjectFilter(request.projectFilter);
		if (request.kind === "paths") {
			if (request.paths.length === 0) {
				return this.collectSessions(
					{ kind: "complete", projectFilter: request.projectFilter },
					context,
				);
			}
			const roots = sessionRoots().map((root) => resolve(root));
			const files = new Set<string>();
			for (const path of request.paths.map((candidate) => resolve(candidate))) {
				if (!isPathWithinRoots(path, roots) || !path.endsWith(".jsonl")) {
					return this.collectSessions(
						{ kind: "complete", projectFilter: request.projectFilter },
						context,
					);
				}
				for (const [sessionId, knownPath] of this.sessionPaths) {
					if (knownPath === path && !existsSync(path)) this.sessionPaths.delete(sessionId);
				}
				if (existsSync(path)) files.add(path);
			}
			const sessionsById = new Map<string, RawSession>();
			for (const filePath of files) {
				if (context) await setImmediate(undefined, { signal: context.signal });
				const session = await parseSessionFile(filePath, absFilter, context);
				if (session) {
					sessionsById.set(session.localSessionId, session);
					this.sessionPaths.set(session.localSessionId, filePath);
				}
			}
			return { sessions: [...sessionsById.values()], dedupedCount: 0, coverage: "partial" };
		}

		const sessionsById = new Map<string, RawSession>();
		const pathsById = new Map<string, string>();
		for (const root of sessionRoots()) {
			for (const filePath of collectJsonlFiles(root)) {
				if (context) await setImmediate(undefined, { signal: context.signal });
				const session = await parseSessionFile(filePath, absFilter, context);
				if (session && !sessionsById.has(session.localSessionId)) {
					sessionsById.set(session.localSessionId, session);
					pathsById.set(session.localSessionId, filePath);
				}
			}
		}
		if (request.projectFilter) {
			for (const [sessionId, path] of pathsById) this.sessionPaths.set(sessionId, path);
		} else {
			this.sessionPaths = pathsById;
		}

		// Codex stores long-conversation history via in-file `compacted`
		// entries rather than spawning new sessionId files, so it cannot
		// produce the resume-chain duplication that ClaudeCodeAdapter dedupes.
		return { sessions: [...sessionsById.values()], dedupedCount: 0, coverage: "complete" };
	}

	private async resolveSession(
		localSessionId: string,
		context?: SyncReadContext,
	): Promise<RawSession | null> {
		context?.signal.throwIfAborted();
		const knownPath = this.sessionPaths.get(localSessionId);
		if (knownPath) {
			const current = await parseSessionFile(knownPath, null, context);
			if (current?.localSessionId === localSessionId) return current;
			this.sessionPaths.delete(localSessionId);
		}
		return (
			(await this.collectSessions({ kind: "complete" }, context)).sessions.find(
				(session) => session.localSessionId === localSessionId,
			) ?? null
		);
	}

	private getSessionsWatchPaths(): string[] {
		const existingRoots = sessionRoots().filter((root) => existsSync(root));
		return existingRoots.length > 0 ? existingRoots : [sessionsDir()];
	}
}
