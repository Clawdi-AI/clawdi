import { existsSync } from "node:fs";
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
import { getCodexHome, matchesProjectFilter } from "./paths";
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
import { jsonlPathsWithin, listJsonlFiles } from "./session-files";
import { addSessionModel, describeSessionContent, JsonlSessionSource } from "./session-source";
import { flatSkillModule } from "./skill-dir";
import { readCommandVersion } from "./version";

const ROLLED_BACK_SEMANTICS = {
	lifecycle: "inactive" as const,
	display: "hidden" as const,
	compressed_summary: false,
	display_kind: "rolled_back",
};

const CONTEXT_INJECTION_TAGS = [
	["# AGENTS.md instructions", "</INSTRUCTIONS>"],
	["<environment_context>", "</environment_context>"],
	["<skill>", "</skill>"],
	["<user_shell_command>", "</user_shell_command>"],
	["<turn_aborted>", "</turn_aborted>"],
	["<subagent_notification>", "</subagent_notification>"],
	["<recommended_plugins>", "</recommended_plugins>"],
	["<goal_context>", "</goal_context>"],
] as const;

// These are the stable prefixes used by Codex's injected developer/context
// records. Keep this list deliberately literal: rollback ownership must not
// classify an ordinary user prompt from a substring in its body.
const DEVELOPER_PREFIXES = [
	"<permissions instructions>",
	"<model_switch>",
	"<managed_developer_instructions>",
	"<apps_instructions>",
	"<collaboration_mode>",
	"<multi_agent_mode>",
	"<environments_instructions>",
	"<git_attribution>",
	"<plugins_instructions>",
	"<realtime_conversation>",
	"<skills_instructions>",
	"<tools>",
	"<personality_spec>",
	"<token_budget>",
	"<context_window>",
	"<context_window_guidance>",
	"<rollout_budget>",
];

interface RollbackRecordMeta {
	recordSeq: number;
	isAssistantOrCall: boolean;
	userInputOrder: number | undefined;
}

interface RollbackBoundary {
	alive: boolean;
	userInputOrder: number | undefined;
	records: number[];
}

interface RollbackPlan {
	isUndone(recordSeq: number): boolean;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function recordPayload(raw: JsonObject): JsonObject | null {
	return jsonObject(raw.payload);
}

function recordType(raw: JsonObject): string | null {
	return jsonString(raw.type) ?? jsonString(recordPayload(raw)?.type);
}

function recordText(raw: JsonObject): string {
	const payload = recordPayload(raw);
	const value = payload?.content ?? payload?.message ?? raw.content ?? raw.message;
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				const object = jsonObject(part);
				return object ? (jsonString(object.text) ?? jsonString(object.content) ?? "") : "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (value && typeof value === "object") {
		const object = jsonObject(value);
		if (object) return recordText({ payload: object });
	}
	return "";
}

function userInputOrder(raw: JsonObject): number | undefined {
	const payload = recordPayload(raw);
	return numberValue(raw.user_input_order) ?? numberValue(payload?.user_input_order);
}

function turnId(raw: JsonObject): string | undefined {
	const payload = recordPayload(raw);
	return (
		jsonString(raw.turn_id) ?? jsonString(payload?.turn_id) ?? jsonString(raw.turnId) ?? undefined
	);
}

function isContextInjection(raw: JsonObject): boolean {
	const text = recordText(raw).trim();
	if (!text) return false;
	if (
		CONTEXT_INJECTION_TAGS.some(([start, end]) => text.startsWith(start) && text.endsWith(end)) ||
		(text.startsWith("<external_") && text.match(/^<external_([^>]+)>[\s\S]*<\/external_\1>$/)) ||
		(text.startsWith("<codex_internal_context") && text.endsWith("</codex_internal_context>")) ||
		/^<hook_prompt\b[^>]*\bhook_run_id\s*=\s*["'][^"']+[^>]*>[\s\S]*<\/hook_prompt>$/.test(text)
	)
		return true;
	if (
		text.startsWith("Warning: The maximum number of unified exec processes you can keep open is") ||
		(text.startsWith("Warning: apply_patch was requested via ") &&
			text.endsWith("Use the apply_patch tool instead of exec_command.")) ||
		text.startsWith("Warning: Your account was flagged for potentially high-risk cyber activity")
	)
		return true;
	const lower = text.toLocaleLowerCase();
	return DEVELOPER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function sameUserResponseItem(previous: JsonObject | undefined, current: JsonObject): boolean {
	if (previous?.type !== "response_item") return false;
	const previousPayload = recordPayload(previous);
	const currentPayload = recordPayload(current);
	return (
		jsonString(previousPayload?.type) === "message" &&
		jsonString(previousPayload?.role) === "user" &&
		jsonString(currentPayload?.type) === "user_message" &&
		recordText(previous) === recordText(current)
	);
}

/** Implements the upstream rollback boundary ownership rules in one pass. */
class RollbackPlanner {
	private boundaries: RollbackBoundary[] = [];
	private stack: number[] = [];
	private pendingContext: number[] = [];
	private pendingTurnIds = new Set<string>();
	private turnBoundaries = new Map<string, number>();
	private records: RollbackRecordMeta[] = [];
	private undoneBoundaries = new Set<number>();
	private recordBoundaries = new Int32Array(1024).fill(-1);
	private previousRaw: JsonObject | undefined;

	private ensureRecordCapacity(recordSeq: number): void {
		if (recordSeq < this.recordBoundaries.length) return;
		let length = this.recordBoundaries.length;
		while (length <= recordSeq) length *= 2;
		const expanded = new Int32Array(length).fill(-1);
		expanded.set(this.recordBoundaries);
		this.recordBoundaries = expanded;
	}

	private assign(recordSeq: number, boundary: number | undefined): void {
		this.ensureRecordCapacity(recordSeq);
		if (boundary === undefined) return;
		this.recordBoundaries[recordSeq] = boundary;
		this.boundaries[boundary]?.records.push(recordSeq);
	}

	private pushBoundary(recordSeq: number, order: number | undefined): number {
		const boundary = this.boundaries.length;
		this.boundaries.push({ alive: true, userInputOrder: order, records: [] });
		this.stack.push(boundary);
		for (const pending of this.pendingContext) this.assign(pending, boundary);
		this.pendingContext = [];
		for (const id of this.pendingTurnIds) this.turnBoundaries.set(id, boundary);
		this.pendingTurnIds.clear();
		this.assign(recordSeq, boundary);
		return boundary;
	}

	private rollback(count: number): void {
		for (let index = 0; index < count && this.stack.length > 0; index++) {
			const boundary = this.stack.pop();
			if (boundary !== undefined) {
				const item = this.boundaries[boundary];
				if (item) item.alive = false;
				this.undoneBoundaries.add(boundary);
			}
		}
		this.pendingContext = [];
		this.pendingTurnIds.clear();
	}

	observe(raw: JsonObject, recordSeq: number): void {
		this.ensureRecordCapacity(recordSeq);
		const payload = recordPayload(raw);
		const type = recordType(raw);
		const order = userInputOrder(raw);
		const payloadType = jsonString(payload?.type);
		const isAssistantOrCall =
			(payloadType === "message" && jsonString(payload?.role) === "assistant") ||
			payloadType === "function_call" ||
			payloadType === "custom_tool_call";
		this.records.push({ recordSeq, isAssistantOrCall, userInputOrder: order });

		if (type === "thread_rolled_back" || payloadType === "thread_rolled_back") {
			const count =
				numberValue(raw.n) ??
				numberValue(payload?.n) ??
				numberValue(raw.num_turns) ??
				numberValue(payload?.num_turns) ??
				numberValue(raw.count) ??
				0;
			this.rollback(Math.max(0, count));
			this.previousRaw = raw;
			return;
		}

		const isTurnPending = type === "turn_started" || type === "turn_context";
		if (isTurnPending) {
			const id = turnId(raw);
			if (id) this.pendingTurnIds.add(id);
			this.previousRaw = raw;
			return;
		}

		const id = turnId(raw);
		const isResponseUser =
			raw.type === "response_item" &&
			payloadType === "message" &&
			jsonString(payload?.role) === "user";
		const isEventUser = raw.type === "event_msg" && payloadType === "user_message";
		const mergedEventUser = isEventUser && sameUserResponseItem(this.previousRaw, raw);
		const isAgentBoundary =
			payloadType === "inter_agent_communication" ||
			payloadType === "inter_agent_communication_metadata" ||
			type === "inter_agent_communication" ||
			type === "inter_agent_communication_metadata";
		if (
			(isResponseUser || (isEventUser && !mergedEventUser) || isAgentBoundary) &&
			!isContextInjection(raw)
		) {
			this.pushBoundary(recordSeq, order);
		} else if (isContextInjection(raw)) {
			if (this.stack.length > 0) this.pendingContext.push(recordSeq);
		} else {
			const boundary = id ? this.turnBoundaries.get(id) : this.stack.at(-1);
			this.assign(recordSeq, boundary);
		}
		if (id && this.turnBoundaries.has(id)) this.assign(recordSeq, this.turnBoundaries.get(id));
		this.previousRaw = raw;
	}

	finish(): RollbackPlan {
		const current = this.stack.at(-1);
		if (current !== undefined)
			for (const pending of this.pendingContext) this.assign(pending, current);
		const threshold = Math.min(
			...[...this.undoneBoundaries]
				.map((boundary) => this.boundaries[boundary]?.userInputOrder)
				.filter((value): value is number => value !== undefined),
		);
		const undone = new Set<number>();
		for (const boundary of this.undoneBoundaries) {
			for (const recordSeq of this.boundaries[boundary]?.records ?? []) undone.add(recordSeq);
		}
		if (Number.isFinite(threshold)) {
			for (const record of this.records) {
				if (
					record.isAssistantOrCall &&
					record.userInputOrder !== undefined &&
					record.userInputOrder >= threshold
				)
					undone.add(record.recordSeq);
			}
		}
		return { isUndone: (recordSeq) => undone.has(recordSeq) };
	}
}

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
		const namespace = jsonString(payload.namespace);
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: namespace && namespace !== "functions" ? `${namespace}${name}` : name,
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
	const rollbackPlanner = new RollbackPlanner();

	for await (const { data: raw, recordSeq } of source.records()) {
		rollbackPlanner.observe(raw, recordSeq);
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
	const rollbackPlan = rollbackPlanner.finish();
	if (!sessionId) return null;
	if (!matchesProjectFilter(projectPath, absFilter)) return null;
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
				codexEventDrafts(raw, sessionKey, recordSeq).map((draft) => {
					const bound = bindAssistantModel(draft, model);
					return rollbackPlan.isUndone(recordSeq)
						? { ...bound, semantics: ROLLED_BACK_SEMANTICS }
						: bound;
				}),
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
	if (description.eventCount === 0 || !startedAt) return null;

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
			const paths = jsonlPathsWithin(request, sessionRoots());
			if (!paths)
				return this.collectSessions(
					{ kind: "complete", projectFilter: request.projectFilter },
					context,
				);
			const files = new Set<string>();
			for (const path of paths) {
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
			for (const filePath of listJsonlFiles(root, { skipHidden: true })) {
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
