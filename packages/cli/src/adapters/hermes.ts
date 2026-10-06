import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { safeTruncate } from "../lib/sanitize";
import { durationSecondsBetween } from "../lib/session-duration";
import {
	projectEventsToMessages,
	type SessionEventDraft,
	sequenceSessionEvents,
} from "../lib/session-events";
import { describeSkillKey, isValidSkillKey } from "../lib/skill-key";
import { replaceSkillArchiveTarGz } from "../lib/tar";
import { mutateUserSkillTarget } from "../runtime/managed-skill-reservation";
import { log } from "../serve/log";
import type {
	AgentAdapterCore,
	RawSession,
	SessionBatchScan,
	SessionContentPart,
	SessionEvent,
	SessionEventDisplayMetadata,
	SessionEventSemantics,
	SessionMessage,
	SessionScanRequest,
	SessionScanResult,
	SessionUserActivity,
	SyncReadContext,
} from "./base";
import { getHermesHome } from "./paths";
import {
	canonicalStructuredString,
	jsonObject,
	jsonString,
	reasoningContent,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
import { flatSkillModule } from "./skill-dir";
import { openReadonlySqlite, type ReadonlySqliteDatabase } from "./sqlite";
import { readCommandVersion } from "./version";

interface SessionRow {
	id: string;
	source: string | null;
	model: string | null;
	title: string | null;
	started_at: number;
	ended_at: number | null;
	message_count: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
}

interface MessageRow {
	role: string;
	content: string | null;
	timestamp: number;
}

interface ModernMessageRow extends MessageRow {
	source_bytes: number;
	id: number;
	tool_call_id: string | null;
	tool_calls: string | null;
	tool_name: string | null;
	_compressed_summary: number;
	active: number;
	compacted: number;
	display_kind: string | null;
	display_metadata: string | null;
	reasoning: string | null;
	reasoning_content: string | null;
	reasoning_details: string | null;
	codex_reasoning_items: string | null;
}

interface TableInfoRow {
	name: string;
	type: string;
	pk: number;
}

interface SessionSizeRow {
	row_count: number;
	size_bytes: number;
	last_id: number;
}

interface UserActivityRow {
	last_user_input_at: number | string | null;
}

const MODERN_MESSAGE_CORE_COLUMNS = ["session_id", "role", "content", "timestamp"] as const;

const MODERN_MESSAGE_OPTIONAL_COLUMNS = [
	["tool_call_id", "NULL"],
	["tool_calls", "NULL"],
	["tool_name", "NULL"],
	["_compressed_summary", "0"],
	["active", "1"],
	["compacted", "0"],
	["display_kind", "NULL"],
	["display_metadata", "NULL"],
	["reasoning", "NULL"],
	["reasoning_content", "NULL"],
	["reasoning_details", "NULL"],
	["codex_reasoning_items", "NULL"],
] as const;

const HERMES_CONTENT_JSON_PREFIX = "\0json:";
const HERMES_SESSION_SCAN_BATCH_SIZE = 32;
// Bump when persisted Hermes rows map to different Session/Event bytes.
const HERMES_SESSION_PROJECTION_REVISION = 4;
const HERMES_EAGER_MAX_BYTES = 256 * 1024;
const HERMES_EAGER_MAX_ROWS = 512;
const HERMES_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;

function messagePayloadSizeSql(columns: readonly TableInfoRow[]): string {
	const names = new Set(columns.map((column) => column.name));
	return ["role", "content", ...MODERN_MESSAGE_OPTIONAL_COLUMNS.map(([name]) => name)]
		.filter((name) => names.has(name))
		.map((name) => `coalesce(octet_length(${name}), 0)`)
		.join(" + ");
}

function messageTableInfo(db: ReadonlySqliteDatabase): TableInfoRow[] {
	return db.prepare("PRAGMA table_info(messages)").all() as TableInfoRow[];
}

function hasStableModernMessageIds(columns: readonly TableInfoRow[]): boolean {
	const id = columns.find((column) => column.name === "id");
	return (
		id?.pk === 1 &&
		id.type.trim().toUpperCase() === "INTEGER" &&
		MODERN_MESSAGE_CORE_COLUMNS.every((name) => columns.some((column) => column.name === name))
	);
}

function modernMessageSelectColumns(columns: readonly TableInfoRow[]): string {
	const names = new Set(columns.map((column) => column.name));
	const size = messagePayloadSizeSql(columns);
	const bounded = (name: string) =>
		`CASE WHEN (${size}) <= ${HERMES_MESSAGE_MAX_BYTES} THEN ${name} ELSE NULL END AS ${name}`;
	return [
		"id",
		"role",
		bounded("content"),
		...MODERN_MESSAGE_OPTIONAL_COLUMNS.map(([name, fallback]) =>
			names.has(name) ? bounded(name) : `${fallback} AS ${name}`,
		),
		"timestamp",
		`(${size}) AS source_bytes`,
	].join(", ");
}

function messageRevisionQuery(columns: readonly TableInfoRow[]): string {
	// Equal-length edits and tool/reasoning changes must invalidate the scan cache.
	return `
		SELECT ${modernMessageSelectColumns(columns)} FROM messages
		WHERE session_id = ? AND id <= ?
		ORDER BY id
	`;
}

async function sessionSourceRevision(
	row: SessionRow,
	statement: ReturnType<ReadonlySqliteDatabase["prepare"]>,
	context?: SyncReadContext,
	lastId = Number.MAX_SAFE_INTEGER,
): Promise<string> {
	const hash = createHash("sha256").update(
		JSON.stringify([
			HERMES_SESSION_PROJECTION_REVISION,
			row.id,
			row.source,
			row.model,
			row.title,
			row.started_at,
			row.ended_at,
			row.message_count,
			row.input_tokens,
			row.output_tokens,
			row.cache_read_tokens,
		]),
	);
	let count = 0;
	for (const value of statement.iterate(row.id, lastId)) {
		context?.signal.throwIfAborted();
		hash.update(JSON.stringify(value)).update("\n");
		if (++count % 128 === 0)
			await setImmediate(undefined, context ? { signal: context.signal } : {});
	}
	return hash.digest("hex");
}

function hermesUserActivity(db: ReadonlySqliteDatabase): SessionUserActivity {
	const sessionColumns = new Set(
		(db.prepare("PRAGMA table_info(sessions)").all() as TableInfoRow[]).map(
			(column) => column.name,
		),
	);
	const messageColumns = new Set(messageTableInfo(db).map((column) => column.name));
	if (
		!["id", "source"].every((column) => sessionColumns.has(column)) ||
		!["session_id", "role", "timestamp"].every((column) => messageColumns.has(column))
	) {
		return { lastUserInputAt: null, complete: false };
	}
	// parent_session_id chains are compression splits of the same conversation, so they
	// count. Delegated subagents are tagged by source or by model_config._delegate_from.
	const delegated = sessionColumns.has("model_config")
		? "AND NOT (json_valid(s.model_config) AND json_extract(s.model_config, '$._delegate_from') IS NOT NULL)"
		: "";
	try {
		const row = db
			.prepare(`
				SELECT MAX(m.timestamp) AS last_user_input_at
				FROM messages AS m
				JOIN sessions AS s ON s.id = m.session_id
				WHERE lower(m.role) = 'user'
				  AND lower(coalesce(s.source, '')) NOT IN ('cron', 'subagent', 'curator', 'kanban')
				  ${delegated}
			`)
			.get() as UserActivityRow | undefined;
		const timestamp = row?.last_user_input_at ?? null;
		if (timestamp === null) return { lastUserInputAt: null, complete: true };
		const lastUserInputAt = timestampIso(Number(timestamp));
		return lastUserInputAt
			? { lastUserInputAt, complete: true }
			: { lastUserInputAt: null, complete: false };
	} catch {
		return { lastUserInputAt: null, complete: false };
	}
}

function decodeHermesContent(content: string | null): unknown {
	if (!content?.startsWith(HERMES_CONTENT_JSON_PREFIX)) return content;
	try {
		return JSON.parse(content.slice(HERMES_CONTENT_JSON_PREFIX.length));
	} catch {
		return content;
	}
}

const CLOSED_REASONING_BLOCK =
	/<(think|thinking|reasoning|thought|REASONING_SCRATCHPAD)>[\s\S]*?<\/\1>/gi;
const OPEN_REASONING_TAG = /<(?:think|thinking|reasoning|thought|REASONING_SCRATCHPAD)>/gi;
const ORPHAN_REASONING_CLOSE =
	/<\/(?:think|thinking|reasoning|thought|REASONING_SCRATCHPAD)>[ \t\r\n]*/gi;

function stripHiddenReasoning(text: string): string {
	let visible = text.replace(CLOSED_REASONING_BLOCK, "");
	for (const match of visible.matchAll(OPEN_REASONING_TAG)) {
		const index = match.index;
		const lineStart = visible.lastIndexOf("\n", index - 1) + 1;
		if (visible.slice(lineStart, index).trim().length === 0) {
			visible = visible.slice(0, index);
			break;
		}
	}
	return visible.replace(ORPHAN_REASONING_CLOSE, "");
}

function hiddenReasoningTexts(text: string): string[] {
	const texts: string[] = [];
	for (const match of text.matchAll(CLOSED_REASONING_BLOCK)) {
		const value = match[0].replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "");
		if (value) texts.push(value);
	}
	for (const match of text.matchAll(OPEN_REASONING_TAG)) {
		const index = match.index;
		const lineStart = text.lastIndexOf("\n", index - 1) + 1;
		if (text.slice(lineStart, index).trim().length > 0) continue;
		const tail = text.slice(index + match[0].length);
		if (!tail.includes("</") && tail) texts.push(tail);
		break;
	}
	return texts;
}

function decodeOptionalJson(value: string | null): unknown {
	if (value === null) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function safeHermesContent(content: string | null, scrubReasoning: boolean): unknown {
	const decoded = decodeHermesContent(content);
	if (!scrubReasoning) return decoded;
	if (typeof decoded === "string") return stripHiddenReasoning(decoded);
	const scrubBlock = (item: unknown): unknown => {
		const block = jsonObject(item);
		if (!block || typeof block.text !== "string") return item;
		return { ...block, text: stripHiddenReasoning(block.text) };
	};
	return Array.isArray(decoded) ? decoded.map(scrubBlock) : scrubBlock(decoded);
}

function hermesContentParts(content: string | null, scrubReasoning: boolean): SessionContentPart[] {
	return visibleContentParts(safeHermesContent(content, scrubReasoning)).filter(
		(part) => part.type !== "text" || part.text.length > 0,
	);
}

function hermesReasoning(row: ModernMessageRow) {
	if (row.role !== "assistant") return null;
	const decoded = decodeHermesContent(row.content);
	const texts: string[] = [];
	if (row.reasoning) texts.push(row.reasoning);
	if (row.reasoning_content) texts.push(row.reasoning_content);
	const collect = (value: unknown) => {
		if (typeof value === "string") texts.push(...hiddenReasoningTexts(value));
		else {
			const block = jsonObject(value);
			if (typeof block?.text === "string") texts.push(...hiddenReasoningTexts(block.text));
		}
	};
	if (Array.isArray(decoded)) decoded.forEach(collect);
	else collect(decoded);
	const uniqueTexts = [...new Set(texts.filter(Boolean))];
	return reasoningContent({
		type: "reasoning",
		summary: uniqueTexts.map((text) => ({ type: "summary_text", text })),
		reasoning_details: decodeOptionalJson(row.reasoning_details),
		codex_reasoning_items: decodeOptionalJson(row.codex_reasoning_items),
	});
}

function timestampIso(value: number): string | undefined {
	if (!Number.isFinite(value)) return undefined;
	const date = new Date(value * 1000);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function displayMetadata(raw: string | null): SessionEventDisplayMetadata | undefined {
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const metadata = jsonObject(parsed);
	if (!metadata) return undefined;
	const normalized: SessionEventDisplayMetadata = {};
	const taskCount = nonNegativeInteger(metadata.task_count);
	const attempt = nonNegativeInteger(metadata.attempt);
	if (taskCount !== undefined) normalized.task_count = taskCount;
	if (attempt !== undefined) normalized.attempt = attempt;
	if (Array.isArray(metadata.reactions)) {
		const reactions = metadata.reactions.flatMap((value) => {
			const reaction = jsonObject(value);
			const emoji = jsonString(reaction?.emoji);
			const author = jsonString(reaction?.author);
			if (!emoji || emoji.length > 64 || !author || author.length > 100) return [];
			const at = typeof reaction?.at === "number" ? timestampIso(reaction.at) : undefined;
			return [
				{
					emoji,
					author,
					...(at ? { at } : {}),
					...(typeof reaction?.seen === "boolean" ? { seen: reaction.seen } : {}),
				},
			];
		});
		if (reactions.length > 0) normalized.reactions = reactions;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function rowSemantics(row: ModernMessageRow): SessionEventSemantics {
	const displayKind = row.display_kind?.trim() || undefined;
	const metadata = displayMetadata(row.display_metadata);
	return {
		lifecycle: row.active ? "active" : row.compacted ? "compacted" : "inactive",
		display: displayKind === "hidden" ? "hidden" : displayKind ? "event" : "message",
		compressed_summary: Boolean(row._compressed_summary),
		...(displayKind ? { display_kind: displayKind } : {}),
		...(metadata ? { display_metadata: metadata } : {}),
	};
}

function parseToolCalls(raw: string | null): Array<Record<string, unknown>> {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((value): value is Record<string, unknown> => jsonObject(value) !== null)
			: [];
	} catch {
		return [];
	}
}

function hermesEventDrafts(
	row: ModernMessageRow,
	sessionKey: string,
	model: string | null,
): SessionEventDraft[] {
	const semantics = rowSemantics(row);
	const timestamp = timestampIso(row.timestamp);
	const source = (partIndex: number) => ({
		adapter: "hermes" as const,
		session_key: sessionKey,
		record_id: String(row.id),
		record_seq: row.id,
		part_index: partIndex,
	});
	const drafts: SessionEventDraft[] = [];
	const calls = parseToolCalls(row.tool_calls);
	const reasoning = hermesReasoning(row);
	if (reasoning) {
		drafts.push({
			type: "reasoning",
			...reasoning,
			source: source(0),
			semantics,
			...(timestamp ? { timestamp } : {}),
			...(model ? { model } : {}),
		});
	}
	if (
		row.role === "user" ||
		row.role === "assistant" ||
		row.role === "system" ||
		row.role === "developer"
	) {
		const parts = hermesContentParts(row.content, row.role === "assistant");
		if (parts.length > 0 || calls.length === 0) {
			drafts.push({
				type: "message",
				role: row.role,
				parts,
				source: source(0),
				semantics,
				...(timestamp ? { timestamp } : {}),
				...(row.role === "assistant" && model ? { model } : {}),
			});
		}
	}
	if (row.role === "assistant") {
		for (let index = 0; index < calls.length; index++) {
			const call = calls[index];
			if (!call) continue;
			const fn = jsonObject(call.function);
			const name = jsonString(fn?.name) ?? jsonString(call.name);
			if (!name) continue;
			const callId = jsonString(call.id) ?? `hermes:${sessionKey}:${row.id}:tool-call:${index}`;
			const args = fn?.arguments ?? call.arguments;
			drafts.push({
				type: "tool_call",
				call_id: callId,
				name,
				arguments_json: canonicalStructuredString(args),
				source: source(index + 1),
				semantics,
				...(timestamp ? { timestamp } : {}),
				...(model ? { model } : {}),
			});
		}
	}
	if (row.role === "tool") {
		drafts.push({
			type: "tool_result",
			call_id: row.tool_call_id ?? `hermes:${sessionKey}:${row.id}:tool-result`,
			...(row.tool_name ? { name: row.tool_name } : {}),
			status: "completed",
			...toolResultContent(safeHermesContent(row.content, false)),
			source: source(0),
			semantics,
			...(timestamp ? { timestamp } : {}),
		});
	}
	return drafts;
}

function hermesDir() {
	return getHermesHome();
}
function stateDbPath() {
	return join(hermesDir(), "state.db");
}
function skillsDir() {
	return join(hermesDir(), "skills");
}

function acceptHermesSkillKey(skillKey: string): boolean {
	if (isValidSkillKey(skillKey)) return true;
	log.warn("adapter.invalid_skill_key_skipped", {
		adapter: "hermes",
		key_shape: describeSkillKey(skillKey),
	});
	return false;
}

/**
 * Extract a plain model name string from Hermes model field.
 * The field can be a plain string ("claude-opus-4.6") or a JSON object
 * ({"default": "gpt-5.3-codex", "provider": "openai-codex", ...}).
 */
function parseModelField(raw: string | null): string | null {
	if (!raw) return null;
	if (raw.startsWith("{")) {
		try {
			const obj = JSON.parse(raw);
			return obj.default || obj.model || null;
		} catch {
			return /['"](?:default|model)['"]\s*:\s*['"]([^'"]+)['"]/.exec(raw)?.[1] ?? null;
		}
	}
	return raw;
}

export class HermesAdapter implements AgentAdapterCore {
	readonly agentType = "hermes" as const;
	readonly sessions = {
		contentProtocol: (context?: SyncReadContext) => this.getContentProtocol(context),
		collect: (request: SessionScanRequest, context?: SyncReadContext) =>
			this.collectSessions(request, context),
		scan: (
			request: SessionScanRequest,
			knownSourceRevisions: ReadonlyMap<string, string>,
			context?: SyncReadContext,
		) => this.scanSessions(request, knownSourceRevisions, context),
		resolve: (localSessionId: string, context?: SyncReadContext) =>
			this.resolveSession(localSessionId, context),
		watchPaths: () => this.getSessionsWatchPaths(),
	};
	readonly skills = {
		...flatSkillModule({
			root: skillsDir,
			nested: true,
			acceptKey: acceptHermesSkillKey,
			sharedPath: (key, owner) => join(skillsDir(), "shared", `${key}__${owner}`),
		}),
		writeSharedArchive: (key: string, owner: string, bytes: Buffer) =>
			this.writeSharedSkillArchive(key, owner, bytes),
	};

	async detect(): Promise<boolean> {
		// Hermes stores state in a SQLite db. The dir alone may exist as a
		// leftover; the db is the only file every Hermes install creates.
		return existsSync(stateDbPath());
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("hermes", ["--version"]);
	}

	private async getContentProtocol(
		context?: SyncReadContext,
	): Promise<"events-v1" | "snapshot-v1"> {
		context?.signal.throwIfAborted();
		if (!existsSync(stateDbPath())) return "snapshot-v1";
		const db = await openReadonlySqlite(stateDbPath());
		try {
			context?.signal.throwIfAborted();
			return hasStableModernMessageIds(messageTableInfo(db)) ? "events-v1" : "snapshot-v1";
		} finally {
			db.close();
		}
	}

	private async collectSessions(
		request: SessionScanRequest,
		context?: SyncReadContext,
	): Promise<SessionScanResult> {
		context?.signal.throwIfAborted();
		const scan = await this.scanSessions(request, new Map(), context);
		const sessions: RawSession[] = [];
		let dedupedCount = 0;
		for await (const batch of scan.batches) {
			sessions.push(...batch.sessions);
			dedupedCount += batch.dedupedCount;
		}
		return { sessions, dedupedCount, coverage: scan.coverage };
	}

	private async scanSessions(
		_request: SessionScanRequest,
		knownSourceRevisions: ReadonlyMap<string, string>,
		context?: SyncReadContext,
	): Promise<SessionBatchScan> {
		if (!existsSync(stateDbPath())) {
			return {
				coverage: "complete",
				userActivity: { lastUserInputAt: null, complete: false },
				batches: (async function* () {})(),
			};
		}
		const db = await openReadonlySqlite(stateDbPath());
		try {
			context?.signal.throwIfAborted();
			const activity = hermesUserActivity(db);
			return {
				coverage: "complete",
				userActivity: activity,
				batches: this.readSessionBatches(db, knownSourceRevisions, context),
			};
		} catch (error) {
			db.close();
			throw error;
		}
	}

	private async *readSessionBatches(
		db: ReadonlySqliteDatabase,
		knownSourceRevisions: ReadonlyMap<string, string>,
		context?: SyncReadContext,
	): AsyncGenerator<{
		sessions: RawSession[];
		observedLocalSessionIds: readonly string[];
		dedupedCount: number;
	}> {
		try {
			const readers = this.sessionReaders(db);
			let cursor: Pick<SessionRow, "started_at" | "id"> | null = null;
			while (true) {
				if (context) await setImmediate(undefined, { signal: context.signal });
				context?.signal.throwIfAborted();
				const rows = db
					.prepare(`
						SELECT id, source, model, title, started_at, ended_at,
						       message_count, input_tokens, output_tokens, cache_read_tokens
						FROM sessions
						${cursor ? "WHERE started_at < ? OR (started_at = ? AND id < ?)" : ""}
						ORDER BY started_at DESC, id DESC
						LIMIT ?
					`)
					.all(
						...(cursor ? [cursor.started_at, cursor.started_at, cursor.id] : []),
						HERMES_SESSION_SCAN_BATCH_SIZE,
					) as SessionRow[];
				if (rows.length === 0) return;

				const observedLocalSessionIds = rows.map((row) => row.id);
				const sessions: RawSession[] = [];
				for (const row of rows) {
					const size = readers.size.get(row.id) as SessionSizeRow;
					const sourceRevision = readers.revision
						? await sessionSourceRevision(row, readers.revision, context, size.last_id)
						: undefined;
					if (sourceRevision && knownSourceRevisions.get(row.id) === sourceRevision) continue;
					const session = await this.materializeSession(
						row,
						sourceRevision,
						readers.modern,
						readers.messages,
						size,
						context,
					);
					if (session) sessions.push(session);
				}
				yield { sessions, observedLocalSessionIds, dedupedCount: 0 };
				const last = rows.at(-1);
				if (!last || rows.length < HERMES_SESSION_SCAN_BATCH_SIZE) return;
				cursor = last;
			}
		} finally {
			db.close();
		}
	}

	private async resolveSession(
		localSessionId: string,
		context?: SyncReadContext,
	): Promise<RawSession | null> {
		context?.signal.throwIfAborted();
		if (!existsSync(stateDbPath())) return null;
		const db = await openReadonlySqlite(stateDbPath());
		try {
			context?.signal.throwIfAborted();
			const row = db
				.prepare(`
					SELECT id, source, model, title, started_at, ended_at,
					       message_count, input_tokens, output_tokens, cache_read_tokens
					FROM sessions
					WHERE id = ?
				`)
				.get(localSessionId) as SessionRow | undefined;
			if (!row) return null;
			const readers = this.sessionReaders(db);
			const size = readers.size.get(row.id) as SessionSizeRow;
			return await this.materializeSession(
				row,
				readers.revision
					? await sessionSourceRevision(row, readers.revision, context, size.last_id)
					: undefined,
				readers.modern,
				readers.messages,
				size,
				context,
			);
		} finally {
			db.close();
		}
	}

	private sessionReaders(db: ReadonlySqliteDatabase) {
		const messageColumns = messageTableInfo(db);
		const modern = hasStableModernMessageIds(messageColumns);
		return {
			modern,
			size: db.prepare(
				`SELECT count(*) AS row_count, coalesce(sum(${messagePayloadSizeSql(messageColumns)}), 0) AS size_bytes, ${modern ? "coalesce(max(id), 0)" : "0"} AS last_id FROM messages WHERE session_id = ?`,
			),
			revision: modern ? db.prepare(messageRevisionQuery(messageColumns)) : null,
			messages: db.prepare(
				modern
					? `
						SELECT ${modernMessageSelectColumns(messageColumns)}
						FROM messages
						WHERE session_id = ? AND id <= ?
						ORDER BY id ASC
					`
					: `
						SELECT role, content, timestamp
						FROM messages
						WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL
						ORDER BY timestamp ASC
					`,
			),
		};
	}

	private async materializeSession(
		row: SessionRow,
		sourceRevision: string | undefined,
		modern: boolean,
		messagesStatement: ReturnType<ReadonlySqliteDatabase["prepare"]>,
		size: SessionSizeRow,
		context?: SyncReadContext,
	): Promise<RawSession | null> {
		const model = parseModelField(row.model);
		const startedAt = new Date(row.started_at * 1000);
		const endedAt = row.ended_at ? new Date(row.ended_at * 1000) : null;
		const durationSeconds = durationSecondsBetween(startedAt, endedAt);
		const stream =
			context?.streaming ||
			size.size_bytes > HERMES_EAGER_MAX_BYTES ||
			size.row_count > HERMES_EAGER_MAX_ROWS;
		const path = stateDbPath();
		const readEvents =
			stream && modern
				? () => this.readSessionEvents(path, row, sourceRevision, size.last_id, context)
				: undefined;
		const readMessages =
			stream && !modern ? () => this.readLegacySessionMessages(path, row, context) : undefined;
		const messageRows = stream
			? []
			: (messagesStatement.all(row.id, ...(modern ? [size.last_id] : [])) as Array<
					MessageRow | ModernMessageRow
				>);
		for (const message of messageRows) {
			if ("source_bytes" in message && message.source_bytes > HERMES_MESSAGE_MAX_BYTES)
				throw new Error(`Hermes message exceeds ${HERMES_MESSAGE_MAX_BYTES} source bytes`);
		}
		const events = modern
			? sequenceSessionEvents(
					(messageRows as ModernMessageRow[]).flatMap((message) =>
						hermesEventDrafts(message, row.id, model),
					),
				)
			: undefined;
		const messages: SessionMessage[] = events
			? projectEventsToMessages(events)
			: (messageRows as MessageRow[]).map((message) => ({
					role: message.role as "user" | "assistant",
					content: message.content ?? "",
					model: message.role === "assistant" ? (model ?? undefined) : undefined,
					...(timestampIso(message.timestamp)
						? { timestamp: timestampIso(message.timestamp) }
						: {}),
				}));
		let streamedMessageCount = 0;
		let streamedEventCount = 0;
		let firstUser: SessionMessage | undefined;
		let lastMessageTimestamp: string | undefined;
		const observeMessage = (message: SessionMessage) => {
			streamedMessageCount++;
			if (!firstUser && message.role === "user")
				firstUser = { ...message, content: safeTruncate(message.content, 200) };
			if (message.timestamp && (!lastMessageTimestamp || message.timestamp > lastMessageTimestamp))
				lastMessageTimestamp = message.timestamp;
		};
		if (readEvents) {
			for await (const event of readEvents()) {
				streamedEventCount++;
				for (const message of projectEventsToMessages([event])) {
					observeMessage(message);
				}
			}
		}
		if (readMessages) for await (const message of readMessages()) observeMessage(message);
		if (
			modern
				? stream
					? streamedEventCount === 0
					: events?.length === 0
				: stream
					? streamedMessageCount === 0
					: messages.length === 0
		)
			return null;

		let summary = row.title;
		if (!summary || summary === "New Chat" || summary.startsWith("New Chat #")) {
			firstUser ??= messages.find((message) => message.role === "user");
			summary = firstUser ? safeTruncate(firstUser.content, 200) : null;
		}
		return {
			localSessionId: row.id,
			projectPath: null,
			startedAt,
			endedAt,
			messageCount: row.message_count ?? (stream ? streamedMessageCount : messages.length),
			inputTokens: row.input_tokens ?? 0,
			outputTokens: row.output_tokens ?? 0,
			cacheReadTokens: row.cache_read_tokens ?? 0,
			model,
			modelsUsed: model ? [model] : [],
			durationSeconds,
			summary,
			messages,
			...(stream ? { readEvents, readMessages, lastMessageTimestamp } : events ? { events } : {}),
			rawFilePath: `${stateDbPath()}#${row.id}`,
			...(sourceRevision ? { sourceRevision } : {}),
		};
	}

	private async *readLegacySessionMessages(
		path: string,
		row: SessionRow,
		context?: SyncReadContext,
	): AsyncGenerator<SessionMessage> {
		const db = await openReadonlySqlite(path);
		try {
			let count = 0;
			const statement = db.prepare(
				`SELECT role, CASE WHEN octet_length(content) <= ${HERMES_MESSAGE_MAX_BYTES} THEN content ELSE NULL END AS content, octet_length(content) AS source_bytes, timestamp FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL ORDER BY timestamp ASC`,
			);
			for (const value of statement.iterate(row.id)) {
				context?.signal.throwIfAborted();
				const message = value as MessageRow & { source_bytes: number };
				if (message.source_bytes > HERMES_MESSAGE_MAX_BYTES)
					throw new Error(`Hermes legacy message exceeds ${HERMES_MESSAGE_MAX_BYTES} source bytes`);
				yield {
					role: message.role as "user" | "assistant",
					content: message.content ?? "",
					model:
						message.role === "assistant" ? (parseModelField(row.model) ?? undefined) : undefined,
					...(timestampIso(message.timestamp)
						? { timestamp: timestampIso(message.timestamp) }
						: {}),
				};
				if (++count % 128 === 0)
					await setImmediate(undefined, context ? { signal: context.signal } : {});
			}
		} finally {
			db.close();
		}
	}

	private async *readSessionEvents(
		path: string,
		row: SessionRow,
		revision: string | undefined,
		lastId: number,
		context?: SyncReadContext,
	): AsyncGenerator<SessionEvent> {
		const db = await openReadonlySqlite(path);
		try {
			context?.signal.throwIfAborted();
			const readers = this.sessionReaders(db);
			const verifyRevision = async () => {
				const current = db
					.prepare(
						"SELECT id, source, model, title, started_at, ended_at, message_count, input_tokens, output_tokens, cache_read_tokens FROM sessions WHERE id = ?",
					)
					.get(row.id) as SessionRow | undefined;
				if (
					!current ||
					!readers.revision ||
					current.model !== row.model ||
					(await sessionSourceRevision(row, readers.revision, context, lastId)) !== revision
				)
					throw new Error(`Hermes session ${row.id} changed during sync; retry with a fresh scan`);
			};
			await verifyRevision();
			let seq = 0;
			let count = 0;
			for (const value of readers.messages.iterate(row.id, lastId)) {
				context?.signal.throwIfAborted();
				const message = value as ModernMessageRow;
				if (message.source_bytes > HERMES_MESSAGE_MAX_BYTES)
					throw new Error(
						`Hermes message ${message.id} exceeds ${HERMES_MESSAGE_MAX_BYTES} source bytes`,
					);
				const events = sequenceSessionEvents(
					hermesEventDrafts(message, row.id, parseModelField(row.model)),
					seq,
				);
				seq += events.length;
				yield* events;
				if (++count % 128 === 0)
					await setImmediate(undefined, context ? { signal: context.signal } : {});
			}
			await verifyRevision();
		} finally {
			db.close();
		}
	}

	private getSessionsWatchPaths(): string[] {
		// SQLite may keep committed session rows in WAL or rollback-journal
		// sidecars while state.db itself remains unchanged. All three paths
		// therefore belong to one global quiescence window; missing sidecars
		// have an empty poll signature and become observable when created.
		const database = stateDbPath();
		return [database, `${database}-wal`, `${database}-journal`];
	}

	private async writeSharedSkillArchive(
		key: string,
		ownerHandle: string,
		tarGzBytes: Buffer,
	): Promise<void> {
		const root = skillsDir();
		const sharedRoot = join(root, "shared");
		await replaceSkillArchiveTarGz(
			key,
			root,
			this.skills.sharedPath(key, ownerHandle),
			tarGzBytes,
			undefined,
			(mutation) => mutateUserSkillTarget(sharedRoot, "shared", mutation),
		);
	}
}
