import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { safeTruncate } from "../lib/sanitize";
import { durationSecondsBetween } from "../lib/session-duration";
import {
	canonicalJson,
	type SessionEventDraft,
	sequenceSessionEvents,
} from "../lib/session-events";
import type {
	AgentAdapterCore,
	RawSession,
	SessionContentPart,
	SessionEvent,
	SessionEventSemantics,
	SessionScanRequest,
	SessionScanResult,
	SyncReadContext,
} from "./base";
import { getOpenCodeDataDir, getOpenCodeDbPath, matchesProjectFilter } from "./paths";
import {
	canonicalStructuredString,
	type JsonObject,
	jsonObject,
	jsonString,
	reasoningContent,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
import {
	describeSessionContent,
	EAGER_SESSION_MAX_BYTES,
	SESSION_RECORD_MAX_BYTES,
} from "./session-source";
import { openReadonlySqlite, type ReadonlySqliteDatabase } from "./sqlite";
import { readCommandVersion } from "./version";

interface TableInfoRow {
	name: string;
	pk: number;
}

interface OpenCodeSessionRow {
	id: string;
	directory: string;
	title: string;
	tokens_input: number;
	tokens_output: number;
	tokens_cache_read: number;
	time_created: number;
	time_updated: number;
	model: string | null;
}

interface OpenCodeMessageRow {
	id: string;
	time_created: number;
	time_updated: number;
	data: string;
}

interface OpenCodePartRow {
	id: string;
	time_created: number;
	data: string;
}

const REQUIRED_COLUMNS = {
	session: [
		"id",
		"directory",
		"title",
		"tokens_input",
		"tokens_output",
		"tokens_cache_read",
		"time_created",
		"time_updated",
		"model",
	],
	message: ["id", "session_id", "time_created", "time_updated", "data"],
	part: ["id", "message_id", "session_id", "time_created", "data"],
} as const;

const EVENT_SEMANTICS: SessionEventSemantics = {
	lifecycle: "active",
	display: "event",
	compressed_summary: false,
};

function tableInfo(
	db: ReadonlySqliteDatabase,
	table: keyof typeof REQUIRED_COLUMNS,
): TableInfoRow[] {
	return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

function assertSupportedSchema(db: ReadonlySqliteDatabase): void {
	for (const table of ["session", "message", "part"] as const) {
		const required = REQUIRED_COLUMNS[table];
		const columns = tableInfo(db, table);
		const names = new Set(columns.map((column) => column.name));
		if (!required.every((column) => names.has(column))) {
			throw new Error(`OpenCode session database has an unsupported ${table} table`);
		}
		const id = columns.find((column) => column.name === "id");
		if (id?.pk !== 1) throw new Error(`OpenCode session database ${table}.id is not stable`);
	}
}

function parseStoredObject(value: string, label: string): JsonObject {
	try {
		const parsed = jsonObject(JSON.parse(value));
		if (parsed) return parsed;
	} catch {
		// The error below identifies the durable source row without exposing its contents.
	}
	throw new Error(`OpenCode ${label} contains invalid JSON`);
}

function timestampIso(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function nonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function modelName(value: unknown): string | undefined {
	const model = jsonObject(value);
	return jsonString(model?.modelID) ?? jsonString(model?.id) ?? undefined;
}

function sessionModel(value: string | null): string | undefined {
	if (!value) return undefined;
	try {
		return modelName(JSON.parse(value));
	} catch {
		return undefined;
	}
}

function source(sessionKey: string, recordId: string, partIndex?: number) {
	return {
		adapter: "opencode" as const,
		session_key: sessionKey,
		record_id: recordId,
		...(partIndex === undefined ? {} : { part_index: partIndex }),
	};
}

function partTimestamp(part: JsonObject, fallback: number): string | undefined {
	const time = jsonObject(part.time);
	return timestampIso(time?.start) ?? timestampIso(time?.created) ?? timestampIso(fallback);
}

function markerEvent(
	sessionKey: string,
	recordId: string,
	kind: string,
	value: JsonObject,
	timestamp?: string,
): SessionEventDraft {
	return {
		type: "message",
		role: "system",
		parts: [{ type: "text", text: `OpenCode ${kind}: ${canonicalJson(value)}` }],
		source: source(sessionKey, recordId),
		semantics: { ...EVENT_SEMANTICS, display_kind: kind },
		...(timestamp ? { timestamp } : {}),
	};
}

function safeError(value: unknown): JsonObject {
	const error = jsonObject(value);
	const data = jsonObject(error?.data);
	const name = jsonString(error?.name);
	const message = jsonString(data?.message);
	return {
		...(name ? { name } : {}),
		...(message ? { message } : {}),
		...(typeof data?.statusCode === "number" ? { status_code: data.statusCode } : {}),
		...(typeof data?.isRetryable === "boolean" ? { retryable: data.isRetryable } : {}),
	};
}

function toolSemantics(part: JsonObject): SessionEventSemantics | undefined {
	const state = jsonObject(part.state);
	const time = jsonObject(state?.time);
	return typeof time?.compacted === "number"
		? { ...EVENT_SEMANTICS, lifecycle: "compacted", display_kind: "tool" }
		: undefined;
}

function messagePreludeEvents(
	sessionKey: string,
	message: OpenCodeMessageRow,
	data: JsonObject,
): SessionEventDraft[] {
	const drafts: SessionEventDraft[] = [];
	const timestamp =
		timestampIso(jsonObject(data.time)?.created) ?? timestampIso(message.time_created);
	const system = jsonString(data.system);
	if (system) {
		drafts.push({
			type: "message",
			role: "system",
			parts: [{ type: "text", text: system }],
			source: source(sessionKey, `${message.id}:system`),
			semantics: EVENT_SEMANTICS,
			...(timestamp ? { timestamp } : {}),
		});
	}
	return drafts;
}

function messageEpilogueEvents(
	sessionKey: string,
	message: OpenCodeMessageRow,
	data: JsonObject,
): SessionEventDraft[] {
	if (data.role !== "assistant") return [];
	const drafts: SessionEventDraft[] = [];
	const timestamp =
		timestampIso(jsonObject(data.time)?.completed) ?? timestampIso(message.time_updated);
	const structured = data.structured === undefined ? undefined : canonicalJson(data.structured);
	if (structured) {
		const model = modelName(data);
		drafts.push({
			type: "message",
			role: "assistant",
			parts: [{ type: "text", text: structured }],
			source: source(sessionKey, `${message.id}:structured`),
			...(model ? { model } : {}),
			...(timestamp ? { timestamp } : {}),
		});
	}
	if (data.error !== undefined) {
		drafts.push(
			markerEvent(
				sessionKey,
				`${message.id}:error`,
				"assistant_error",
				safeError(data.error),
				timestamp,
			),
		);
	}
	return drafts;
}

function partEvents(
	sessionKey: string,
	message: OpenCodeMessageRow,
	messageData: JsonObject,
	part: OpenCodePartRow,
	data: JsonObject,
): SessionEventDraft[] {
	const type = jsonString(data.type);
	const role = messageData.role === "assistant" ? "assistant" : "user";
	const model = modelName(messageData);
	const timestamp = partTimestamp(data, part.time_created || message.time_created);
	const eventSource = source(sessionKey, part.id);
	if (type === "text") {
		const text = jsonString(data.text);
		if (!text) return [];
		return [
			{
				type: "message",
				role,
				parts: [{ type: "text", text }],
				source: eventSource,
				...(data.ignored === true
					? {
							semantics: {
								lifecycle: "active" as const,
								display: "hidden" as const,
								compressed_summary: false,
								display_kind: "ignored_text",
							},
						}
					: {}),
				...(role === "assistant" && model ? { model } : {}),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (type === "reasoning") {
		const reasoning = reasoningContent({
			type: "reasoning",
			text: data.text,
			reasoning_details: data.metadata,
		});
		return reasoning
			? [
					{
						type: "reasoning",
						...reasoning,
						source: eventSource,
						...(model ? { model } : {}),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
	}
	if (type === "file") {
		const parts = visibleContentParts(data);
		return parts.length > 0
			? [
					{
						type: "message",
						role,
						parts,
						source: eventSource,
						...(role === "assistant" && model ? { model } : {}),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
	}
	if (type === "tool") {
		const state = jsonObject(data.state);
		const callId = jsonString(data.callID);
		const name = jsonString(data.tool);
		if (!state || !callId || !name) return [];
		const semantics = toolSemantics(data);
		const call: SessionEventDraft = {
			type: "tool_call",
			call_id: callId,
			name,
			arguments_json: canonicalStructuredString(state.input),
			source: source(sessionKey, part.id, 0),
			...(semantics ? { semantics } : {}),
			...(model ? { model } : {}),
			...(timestamp ? { timestamp } : {}),
		};
		if (state.status !== "completed" && state.status !== "error") return [call];
		const result = toolResultContent(
			state.status === "completed" ? state.output : state.error,
			state.metadata,
		);
		const attachments: SessionContentPart[] =
			state.status === "completed" ? visibleContentParts(state.attachments) : [];
		return [
			call,
			{
				type: "tool_result",
				call_id: callId,
				name,
				status: state.status,
				...result,
				parts: [...result.parts, ...attachments],
				source: source(sessionKey, part.id, 1),
				...(semantics ? { semantics } : {}),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (type === "subtask") {
		const prompt = jsonString(data.prompt);
		const agent = jsonString(data.agent);
		if (!prompt || !agent) return [];
		return [
			{
				type: "tool_call",
				call_id: `opencode-subtask:${part.id}`,
				name: "subtask",
				arguments_json: canonicalStructuredString({
					prompt,
					description: jsonString(data.description),
					agent,
					model: data.model,
					command: jsonString(data.command),
				}),
				source: eventSource,
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (type === "agent") {
		const name = jsonString(data.name);
		return name ? [markerEvent(sessionKey, part.id, "agent", { name }, timestamp)] : [];
	}
	if (type === "compaction") {
		return [
			markerEvent(
				sessionKey,
				part.id,
				"compaction",
				{
					auto: data.auto === true,
					overflow: data.overflow === true,
					tail_start_id: jsonString(data.tail_start_id),
				},
				timestamp,
			),
		];
	}
	if (type === "retry") {
		return [
			markerEvent(
				sessionKey,
				part.id,
				"retry",
				{ attempt: nonNegativeNumber(data.attempt), error: safeError(data.error) },
				timestamp,
			),
		];
	}
	if (type === "step-start") {
		return [markerEvent(sessionKey, part.id, "step_start", {}, timestamp)];
	}
	if (type === "step-finish") {
		return [
			markerEvent(
				sessionKey,
				part.id,
				"step_finish",
				{
					reason: jsonString(data.reason),
					cost: nonNegativeNumber(data.cost),
					tokens: data.tokens,
				},
				timestamp,
			),
		];
	}
	if (type === "snapshot" || type === "patch") {
		return [markerEvent(sessionKey, part.id, type, {}, timestamp)];
	}
	return [];
}

async function parseSession(
	db: ReadonlySqliteDatabase,
	row: OpenCodeSessionRow,
	context?: SyncReadContext,
): Promise<RawSession | null> {
	const boundary = (table: "message" | "part") =>
		db
			.prepare(
				`SELECT time_created, id FROM ${table} WHERE session_id=? ORDER BY time_created DESC, id DESC LIMIT 1`,
			)
			.get(row.id) as { time_created: number; id: string } | undefined;
	const lastMessage = boundary("message");
	if (!lastMessage) return null;
	const lastPart = boundary("part");
	const size = db
		.prepare(`
		SELECT (SELECT coalesce(sum(octet_length(data)), 0) FROM message WHERE session_id=?)
		+ (SELECT coalesce(sum(octet_length(data)), 0) FROM part WHERE session_id=?) AS bytes
	`)
		.get(row.id, row.id) as { bytes: number };
	let revision: string | undefined;
	const databasePath = getOpenCodeDbPath();
	const readEvents = async function* (): AsyncGenerator<SessionEvent> {
		const reader = await openReadonlySqlite(databasePath);
		let transaction = false;
		try {
			reader.exec("BEGIN");
			transaction = true;
			const digest = createHash("sha256").update(canonicalJson(row));
			let seq = 0;
			let count = 0;
			const select = `CASE WHEN octet_length(data) <= ${SESSION_RECORD_MAX_BYTES} THEN data END AS data, octet_length(data) AS source_bytes`;
			const parts = reader.prepare(`
				SELECT id, time_created, ${select} FROM part
				WHERE session_id=? AND message_id=? AND (time_created < ? OR (time_created=? AND id<=?)) ORDER BY id ASC
			`);
			const messages = reader.prepare(`
				SELECT id, time_created, time_updated, ${select} FROM message WHERE session_id=?
				AND (time_created < ? OR (time_created=? AND id<=?)) ORDER BY time_created ASC, id ASC
			`);
			for (const value of messages.iterate(
				row.id,
				lastMessage.time_created,
				lastMessage.time_created,
				lastMessage.id,
			)) {
				context?.signal.throwIfAborted();
				const message = value as OpenCodeMessageRow & { source_bytes: number };
				if (message.source_bytes > SESSION_RECORD_MAX_BYTES)
					throw new Error("OpenCode message exceeds supported source record size");
				digest.update(JSON.stringify(message));
				const data = parseStoredObject(message.data, `message ${message.id}`);
				let events = sequenceSessionEvents(messagePreludeEvents(row.id, message, data), seq);
				seq += events.length;
				yield* events;
				if (lastPart)
					for (const value of parts.iterate(
						row.id,
						message.id,
						lastPart.time_created,
						lastPart.time_created,
						lastPart.id,
					)) {
						context?.signal.throwIfAborted();
						const part = value as OpenCodePartRow & { source_bytes: number };
						if (part.source_bytes > SESSION_RECORD_MAX_BYTES)
							throw new Error("OpenCode part exceeds supported source record size");
						digest.update(JSON.stringify(part));
						events = sequenceSessionEvents(
							partEvents(
								row.id,
								message,
								data,
								part,
								parseStoredObject(part.data, `part ${part.id}`),
							),
							seq,
						);
						seq += events.length;
						yield* events;
						await setImmediate(undefined, context ? { signal: context.signal } : {});
					}
				events = sequenceSessionEvents(messageEpilogueEvents(row.id, message, data), seq);
				seq += events.length;
				yield* events;
				if (++count % 128 === 0)
					await setImmediate(undefined, context ? { signal: context.signal } : {});
			}
			const hash = digest.digest("hex");
			if (revision !== undefined && hash !== revision)
				throw new Error("OpenCode source changed during sync; retry with a fresh scan");
			revision = hash;
		} finally {
			try {
				if (transaction) reader.exec("ROLLBACK");
			} finally {
				reader.close();
			}
		}
	};
	const description = await describeSessionContent(
		readEvents,
		!context?.streaming && size.bytes <= EAGER_SESSION_MAX_BYTES,
	);
	if (description.eventCount === 0) return null;
	const eventModels = description.modelsUsed;
	const fallbackModel = sessionModel(row.model);
	const modelsUsed = [...new Set([...eventModels, ...(fallbackModel ? [fallbackModel] : [])])];
	const startedAt = new Date(row.time_created);
	const endedAt = new Date(row.time_updated);
	const firstUser = description.firstUser;
	const defaultTitle = row.title.startsWith("New session - ");
	return {
		localSessionId: `opencode.${row.id}`,
		projectPath: row.directory,
		startedAt,
		endedAt,
		messageCount: description.messageCount,
		inputTokens: nonNegativeNumber(row.tokens_input),
		outputTokens: nonNegativeNumber(row.tokens_output),
		cacheReadTokens: nonNegativeNumber(row.tokens_cache_read),
		model: description.lastModel ?? fallbackModel ?? null,
		modelsUsed,
		durationSeconds: durationSecondsBetween(startedAt, endedAt),
		summary:
			!defaultTitle && row.title.trim()
				? row.title
				: firstUser
					? safeTruncate(firstUser.content, 200)
					: null,
		...description.content,
		sourceRevision: revision,
		rawFilePath: `${getOpenCodeDbPath()}#${row.id}`,
	};
}

export class OpenCodeAdapter implements AgentAdapterCore {
	readonly agentType = "opencode" as const;
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

	async detect(): Promise<boolean> {
		return existsSync(getOpenCodeDbPath()) || existsSync(getOpenCodeDataDir());
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("opencode", ["--version"]);
	}

	private async collectSessions(
		request: SessionScanRequest,
		context?: SyncReadContext,
	): Promise<SessionScanResult> {
		context?.signal.throwIfAborted();
		const sessions = await this.collectCurrentSessions(undefined, request.projectFilter, context);
		return { sessions, dedupedCount: 0, coverage: "complete" };
	}

	private async resolveSession(
		localSessionId: string,
		context?: SyncReadContext,
	): Promise<RawSession | null> {
		context?.signal.throwIfAborted();
		const sourceId = localSessionId.startsWith("opencode.")
			? localSessionId.slice("opencode.".length)
			: localSessionId;
		return (await this.collectCurrentSessions(sourceId, undefined, context))[0] ?? null;
	}

	private async collectCurrentSessions(
		sourceId?: string,
		projectFilter?: string,
		context?: SyncReadContext,
	): Promise<RawSession[]> {
		const databasePath = getOpenCodeDbPath();
		if (!existsSync(databasePath)) return [];
		const db = await openReadonlySqlite(databasePath);
		try {
			context?.signal.throwIfAborted();
			assertSupportedSchema(db);
			const rows = db
				.prepare(
					`SELECT id, directory, title, tokens_input, tokens_output,
					        tokens_cache_read, time_created, time_updated, model
					 FROM session
					 ${sourceId === undefined ? "" : "WHERE id = ?"}
					 ORDER BY time_created DESC, id ASC`,
				)
				.iterate(...(sourceId === undefined ? [] : [sourceId]));
			const normalizedFilter = projectFilter ? resolve(projectFilter) : null;
			const sessions: RawSession[] = [];
			for (const value of rows) {
				const row = value as OpenCodeSessionRow;
				if (context) await setImmediate(undefined, { signal: context.signal });
				if (!matchesProjectFilter(row.directory, normalizedFilter)) continue;
				const session = await parseSession(db, row, context);
				if (session) sessions.push(session);
			}
			return sessions;
		} finally {
			db.close();
		}
	}

	private getSessionsWatchPaths(): string[] {
		const database = getOpenCodeDbPath();
		return [database, `${database}-wal`, `${database}-journal`];
	}
}
