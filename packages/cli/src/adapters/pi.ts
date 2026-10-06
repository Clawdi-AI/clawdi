import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { safeTruncate } from "../lib/sanitize";
import { durationSecondsBetween } from "../lib/session-duration";
import {
	canonicalJson,
	canonicalPayloadJson,
	type SessionEventDraft,
	sequenceSessionEvents,
} from "../lib/session-events";
import type {
	AgentAdapterCore,
	RawSession,
	SessionEvent,
	SessionScanRequest,
	SessionScanResult,
	SyncReadContext,
} from "./base";
import { getPiHome, getPiSessionsDir, matchesProjectFilter } from "./paths";
import {
	type JsonObject,
	jsonObject,
	jsonString,
	reasoningContent,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
import { jsonlPathsWithin, listJsonlFiles } from "./session-files";
import { describeSessionContent, JsonlSessionSource } from "./session-source";
import { openSessionIndex } from "./sqlite";
import { readCommandVersion } from "./version";

interface ParsedPiEntry {
	data: JsonObject;
	id: string;
	parentId: string | null;
	recordSeq: number;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampIso(entry: JsonObject, message?: JsonObject): string | undefined {
	const messageTimestamp = numberValue(message?.timestamp);
	if (messageTimestamp !== null) return validIsoTimestamp(messageTimestamp);
	const entryTimestamp = numberValue(entry.timestamp);
	if (entryTimestamp !== null) return validIsoTimestamp(entryTimestamp);
	const timestamp = jsonString(entry.timestamp);
	return timestamp ? validIsoTimestamp(timestamp) : undefined;
}

function validIsoTimestamp(value: string | number): string | undefined {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

interface PiUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

function emptyUsage(): PiUsage {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

function addUsage(totals: PiUsage, value: unknown): void {
	const usage = jsonObject(value);
	if (!usage) return;
	totals.inputTokens += nonNegativeNumber(usage.input);
	totals.outputTokens += nonNegativeNumber(usage.output);
	totals.cacheReadTokens += nonNegativeNumber(usage.cacheRead);
}

function nonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function stableV1Id(entry: JsonObject, recordSeq: number): string {
	return `v1-${recordSeq}-${createHash("sha256").update(canonicalJson(entry), "ascii").digest("hex").slice(0, 16)}`;
}

interface PiReadMetadata {
	header: JsonObject | null;
	usage: PiUsage;
}

interface IndexedPiEntry {
	id: string;
	parent_id: string | null;
	record_seq: number;
	ordinal: number;
	offset: number;
	length: number;
	type: string | null;
	first_kept_id: string | null;
	kept_index: number | null;
	retained_tail: number;
	position?: number;
}

async function* readPiEvents(
	sourceFile: JsonlSessionSource,
	metadata: PiReadMetadata,
): AsyncGenerator<SessionEvent> {
	const index = await openSessionIndex();
	try {
		index.exec(`
   CREATE TABLE entries (
    id TEXT PRIMARY KEY, parent_id TEXT, record_seq INTEGER, ordinal INTEGER UNIQUE,
    offset INTEGER, length INTEGER, type TEXT, first_kept_id TEXT, kept_index INTEGER, retained_tail INTEGER
   );
   CREATE TABLE lanes (name TEXT PRIMARY KEY, leaf_id TEXT);
   CREATE TABLE ordinals (ordinal INTEGER PRIMARY KEY, id TEXT);
   INSERT INTO lanes VALUES ('main', NULL);
   CREATE TABLE branch (id TEXT PRIMARY KEY, position INTEGER UNIQUE);
   BEGIN;
  `);
		const entryById = index.prepare("SELECT * FROM entries WHERE id=?");
		const laneByName = index.prepare("SELECT leaf_id FROM lanes WHERE name=?");
		const setLane = index.prepare("INSERT OR REPLACE INTO lanes VALUES (?, ?)");
		const insertEntry = index.prepare(
			"INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		const insertOrdinal = index.prepare("INSERT INTO ordinals VALUES (?, ?)");
		let header: JsonObject | null = null;
		let version = 1;
		let v4 = false;
		let stopped = false;
		let expectedSeq = 1;
		let ordinal = 0;
		let lastId: string | null = null;
		const usage = emptyUsage();
		for await (const record of sourceFile.records()) {
			const data = record.data;
			if (!header) {
				if (stopped) continue;
				v4 = data.kind === "header" && data.version === 4;
				if (
					!jsonString(data.id) ||
					(v4 ? numberValue(data.createdAt) === null : data.type !== "session")
				) {
					stopped = true;
					continue;
				}
				header = {
					id: data.id,
					cwd: data.cwd,
					createdAt: data.createdAt,
					timestamp: data.timestamp,
				};
				version = numberValue(data.version) ?? 1;
				continue;
			}
			if (stopped) continue;
			if (v4) {
				const seq = numberValue(data.seq);
				if (!Number.isSafeInteger(seq) || seq !== expectedSeq++) {
					stopped = true;
					continue;
				}
				if (data.kind === "lane") {
					const lane = jsonString(data.lane);
					const leaf = data.leafId === null ? null : jsonString(data.leafId);
					if (!lane || (data.leafId !== null && (!leaf || !entryById.get(leaf)))) stopped = true;
					else setLane.run(lane, leaf);
					continue;
				}
				if (data.kind === "record") {
					if (data.type === "usage") addUsage(usage, data.usage);
					continue;
				}
				if (data.kind === "fact") continue;
				if (data.kind !== "entry") {
					stopped = true;
					continue;
				}
			}
			const id = jsonString(data.id) ?? (v4 ? null : stableV1Id(data, record.recordSeq));
			let parent = data.parentId === null ? null : jsonString(data.parentId);
			if (!v4 && data.parentId !== null && parent === null) parent = lastId;
			const lane = data.lane === undefined ? null : jsonString(data.lane);
			if (
				!id ||
				(v4 &&
					(!jsonString(data.type) ||
						(data.parentId !== null && !parent) ||
						(parent !== null && !entryById.get(parent)) ||
						(data.lane !== undefined && (!lane || !laneByName.get(lane))) ||
						entryById.get(id)))
			) {
				stopped = true;
				continue;
			}
			ordinal++;
			insertOrdinal.run(ordinal, id);
			insertEntry.run(
				id,
				parent,
				record.recordSeq,
				ordinal,
				record.offset,
				record.length,
				jsonString(data.type),
				jsonString(data.firstKeptEntryId),
				!v4 && version < 2 ? numberValue(data.firstKeptEntryIndex) : null,
				Array.isArray(data.retainedTail) ? 1 : 0,
			);
			lastId = id;
			if (v4 && lane) setLane.run(lane, id);
			if (!v4) {
				if (data.type === "message") addUsage(usage, jsonObject(data.message)?.usage);
				else if (data.type === "compaction" || data.type === "branch_summary")
					addUsage(usage, data.usage);
			}
		}
		index.exec("COMMIT");
		metadata.header = header;
		metadata.usage = usage;
		if (!header) return;
		const sessionKey = jsonString(header.id);
		if (!sessionKey) return;
		let current = v4 ? (laneByName.get("main") as { leaf_id: string | null }).leaf_id : lastId;
		let position = 0;
		const addBranch = index.prepare("INSERT INTO branch VALUES (?, ?)");
		const inBranch = index.prepare("SELECT 1 FROM branch WHERE id=?");
		index.exec("BEGIN");
		while (current && !inBranch.get(current)) {
			const entry = entryById.get(current) as IndexedPiEntry | undefined;
			if (!entry) break;
			addBranch.run(entry.id, position++);
			current = entry.parent_id;
			if (position % 128 === 0) await sourceFile.checkpoint();
		}
		index.exec("COMMIT");
		const compaction = index
			.prepare(`
   SELECT e.*, b.position FROM branch b JOIN entries e ON e.id=b.id
   WHERE e.type='compaction' ORDER BY b.position ASC LIMIT 1
  `)
			.get() as IndexedPiEntry | undefined;
		let retainedPosition = -1;
		if (compaction && !compaction.retained_tail) {
			const keptId =
				compaction.kept_index === null
					? compaction.first_kept_id
					: (
							index.prepare("SELECT id FROM ordinals WHERE ordinal=?").get(compaction.kept_index) as
								| { id: string }
								| undefined
						)?.id;
			if (keptId) {
				const kept = index
					.prepare("SELECT position FROM branch WHERE id=? AND position>?")
					.get(keptId, compaction.position ?? -1) as { position: number } | undefined;
				retainedPosition = kept?.position ?? -1;
			}
		}
		const positions = compaction
			? index
					.prepare(`
    SELECT e.*, b.position FROM branch b JOIN entries e ON e.id=b.id
    WHERE b.position < ? OR (b.position > ? AND b.position <= ?) ORDER BY b.position DESC
   `)
					.iterate(compaction.position ?? -1, compaction.position ?? -1, retainedPosition)
			: index
					.prepare("SELECT e.* FROM branch b JOIN entries e ON e.id=b.id ORDER BY b.position DESC")
					.iterate();
		let seq = 0;
		const readEntry = async (entry: IndexedPiEntry) => {
			const data = await sourceFile.readRecord(entry.offset, entry.length);
			if (!v4 && version < 3 && jsonObject(data.message)?.role === "hookMessage")
				data.message = { ...jsonObject(data.message), role: "custom" };
			return { data, id: entry.id, parentId: entry.parent_id, recordSeq: entry.record_seq };
		};
		if (compaction) {
			const events = sequenceSessionEvents(
				entryEvents(sessionKey, await readEntry(compaction)),
				seq,
			);
			seq += events.length;
			yield* events;
		}
		for (const value of positions) {
			const events = sequenceSessionEvents(
				entryEvents(sessionKey, await readEntry(value as IndexedPiEntry)),
				seq,
			);
			seq += events.length;
			yield* events;
		}
		// Verify the indexed prefix again before the upload can report a stable head.
		for await (const _record of sourceFile.records()) {
		}
	} finally {
		index.close();
	}
}

function source(sessionKey: string, entry: ParsedPiEntry, partIndex?: number) {
	return {
		adapter: "pi" as const,
		session_key: sessionKey,
		record_id: entry.id,
		record_seq: entry.recordSeq,
		...(partIndex === undefined ? {} : { part_index: partIndex }),
	};
}

function entryEvents(sessionKey: string, entry: ParsedPiEntry): SessionEventDraft[] {
	const type = jsonString(entry.data.type);
	const timestamp = timestampIso(entry.data);
	if (type === "compaction" || type === "branch_summary") {
		const summary = jsonString(entry.data.summary);
		const drafts: SessionEventDraft[] = summary
			? [
					{
						type: "message",
						role: "system",
						parts: [{ type: "text", text: summary }],
						source: source(sessionKey, entry),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
		if (type === "compaction" && Array.isArray(entry.data.retainedTail)) {
			for (let index = 0; index < entry.data.retainedTail.length; index++) {
				const message = jsonObject(entry.data.retainedTail[index]);
				if (!message) continue;
				drafts.push(
					...entryEvents(sessionKey, {
						data: { type: "message", message, timestamp: entry.data.timestamp },
						id: `${entry.id}:retained:${index}`,
						parentId: null,
						recordSeq: entry.recordSeq,
					}),
				);
			}
		}
		return drafts;
	}
	if (type === "model_change") {
		const provider = jsonString(entry.data.provider);
		const model = jsonString(entry.data.modelId);
		if (!provider && !model) return [];
		return [
			{
				type: "message",
				role: "system",
				parts: [
					{
						type: "text",
						text: `Model changed to ${[provider, model].filter(Boolean).join("/")}.`,
					},
				],
				source: source(sessionKey, entry),
				...(timestamp ? { timestamp } : {}),
				...(model ? { model } : {}),
			},
		];
	}
	if (type === "custom_message") {
		if (entry.data.display !== true) return [];
		const parts = visibleContentParts(entry.data.content);
		return parts.length > 0
			? [
					{
						type: "message",
						role: "system",
						parts,
						source: source(sessionKey, entry),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
	}
	if (type !== "message") return [];
	const message = jsonObject(entry.data.message);
	if (!message) return [];
	const role = jsonString(message.role);
	const messageTimestamp = timestampIso(entry.data, message) ?? timestamp;
	if (role === "user") {
		const parts = visibleContentParts(message.content);
		return parts.length > 0
			? [
					{
						type: "message",
						role: "user",
						parts,
						source: source(sessionKey, entry),
						...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
					},
				]
			: [];
	}
	if (role === "assistant") {
		if (message.stopReason === "deferred") return [];
		const content = Array.isArray(message.content) ? message.content : [];
		const model = jsonString(message.model) ?? undefined;
		const drafts: SessionEventDraft[] = [];
		const parts = visibleContentParts(content);
		if (parts.length > 0) {
			drafts.push({
				type: "message",
				role: "assistant",
				parts,
				source: source(sessionKey, entry, 0),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
				...(model ? { model } : {}),
			});
		}
		for (let index = 0; index < content.length; index++) {
			const part = jsonObject(content[index]);
			if (!part) continue;
			const reasoning = reasoningContent(part);
			if (reasoning) {
				drafts.push({
					type: "reasoning",
					...reasoning,
					source: source(sessionKey, entry, index + 1),
					...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
					...(model ? { model } : {}),
				});
			}
			if (part.type !== "toolCall") continue;
			const callId = jsonString(part.id);
			const name = jsonString(part.name);
			if (!callId || !name) continue;
			drafts.push({
				type: "tool_call",
				call_id: callId,
				name,
				arguments_json: canonicalPayloadJson(part.arguments),
				source: source(sessionKey, entry, index + 1),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
				...(model ? { model } : {}),
			});
			const toolThought = reasoningContent({
				type: "redacted_thinking",
				signature: part.thoughtSignature,
			});
			if (toolThought) {
				drafts.push({
					type: "reasoning",
					...toolThought,
					source: source(sessionKey, entry, index + 1),
					...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
					...(model ? { model } : {}),
				});
			}
		}
		return drafts;
	}
	if (role === "toolResult") {
		const callId = jsonString(message.toolCallId);
		if (!callId) return [];
		const result = toolResultContent(message.content, message.details);
		const toolName = jsonString(message.toolName);
		const drafts: SessionEventDraft[] = [
			{
				type: "tool_result",
				call_id: callId,
				...(toolName ? { name: toolName } : {}),
				status: message.isError === true ? "error" : "completed",
				...result,
				source: source(sessionKey, entry),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
			},
		];
		const details = jsonObject(message.details);
		const privateState = reasoningContent({
			type: "redacted_thinking",
			signature: details?.thinkingSignature ?? details?.thoughtSignature,
		});
		if (privateState) {
			drafts.push({
				type: "reasoning",
				...privateState,
				source: source(sessionKey, entry, 1),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
			});
		}
		return drafts;
	}
	if (role === "bashExecution") {
		const command = jsonString(message.command);
		if (!command) return [];
		const callId = `pi-shell-${entry.id}`;
		const output = typeof message.output === "string" ? message.output : "";
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "shell",
				arguments_json: canonicalPayloadJson({ command }),
				source: source(sessionKey, entry, 0),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
			},
			{
				type: "tool_result",
				call_id: callId,
				name: "shell",
				status:
					message.cancelled === true || (numberValue(message.exitCode) ?? 0) !== 0
						? "error"
						: "completed",
				parts: output ? [{ type: "text", text: output }] : [],
				source: source(sessionKey, entry, 1),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
			},
		];
	}
	if (role === "custom" && message.display === true) {
		const parts = visibleContentParts(message.content);
		return parts.length > 0
			? [
					{
						type: "message",
						role: "system",
						parts,
						source: source(sessionKey, entry),
						...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
					},
				]
			: [];
	}
	return [];
}

async function parseSession(
	filePath: string,
	projectFilter?: string,
	sourceId?: string,
	context?: SyncReadContext,
): Promise<RawSession | null> {
	let sourceFile: JsonlSessionSource;
	try {
		sourceFile = await JsonlSessionSource.open(filePath, context);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	for await (const record of sourceFile.records()) {
		const id = jsonString(record.data.id);
		const cwd = jsonString(record.data.cwd);
		if (sourceId !== undefined && id !== sourceId) return null;
		if (!matchesProjectFilter(cwd, projectFilter ? resolve(projectFilter) : null)) return null;
		break;
	}
	const metadata: PiReadMetadata = { header: null, usage: emptyUsage() };
	const readEvents = () => readPiEvents(sourceFile, metadata);
	const description = await describeSessionContent(readEvents, sourceFile.eager);
	const header = metadata.header;
	if (!header || description.eventCount === 0) return null;
	const sessionKey = jsonString(header.id);
	if (!sessionKey || (sourceId !== undefined && sessionKey !== sourceId)) return null;
	const cwd = jsonString(header.cwd);
	if (!matchesProjectFilter(cwd, projectFilter ? resolve(projectFilter) : null)) return null;
	const headerTimestamp =
		numberValue(header.createdAt) ?? jsonString(header.timestamp) ?? undefined;
	const parsedHeaderTimestamp = headerTimestamp === undefined ? null : new Date(headerTimestamp);
	const startedAt = description.firstTimestamp
		? new Date(description.firstTimestamp)
		: parsedHeaderTimestamp && !Number.isNaN(parsedHeaderTimestamp.getTime())
			? parsedHeaderTimestamp
			: new Date(Number(sourceFile.stat.birthtimeMs));
	const endedAt = description.lastTimestamp
		? new Date(description.lastTimestamp)
		: new Date(Number(sourceFile.stat.mtimeMs));
	return {
		localSessionId: `pi.${sessionKey}`,
		projectPath: cwd,
		startedAt,
		endedAt,
		messageCount: description.messageCount,
		inputTokens: metadata.usage.inputTokens,
		outputTokens: metadata.usage.outputTokens,
		cacheReadTokens: metadata.usage.cacheReadTokens,
		model: description.lastModel,
		modelsUsed: description.modelsUsed,
		durationSeconds: durationSecondsBetween(startedAt, endedAt),
		summary: description.firstUser
			? safeTruncate(description.firstUser.content, 200)
			: basename(filePath, ".jsonl"),
		...description.content,
		sourceRevision: sourceFile.revision,
		rawFilePath: filePath,
	};
}

export class PiAdapter implements AgentAdapterCore {
	readonly agentType = "pi" as const;
	readonly sessions = {
		contentProtocol: async (context?: SyncReadContext) => {
			context?.signal.throwIfAborted();
			return "events-v1" as const;
		},
		collect: (request: SessionScanRequest, context?: SyncReadContext) =>
			this.collectSessions(request, context),
		resolve: (localSessionId: string, context?: SyncReadContext) =>
			this.resolveSession(localSessionId, context),
		watchPaths: () => [getPiSessionsDir()],
	};

	async detect(): Promise<boolean> {
		return existsSync(getPiHome());
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("pi", ["--version"]);
	}

	private async collectSessions(
		request: SessionScanRequest,
		context?: SyncReadContext,
	): Promise<SessionScanResult> {
		context?.signal.throwIfAborted();
		const root = resolve(getPiSessionsDir());
		if (request.kind === "paths") {
			const paths = jsonlPathsWithin(request, [root]);
			if (!paths)
				return this.collectSessions(
					{ kind: "complete", projectFilter: request.projectFilter },
					context,
				);
			const sessions: RawSession[] = [];
			for (const path of paths) {
				const session = await parseSession(path, request.projectFilter, undefined, context);
				if (session) sessions.push(session);
			}
			return { sessions, dedupedCount: 0, coverage: "partial" };
		}
		const sessions: RawSession[] = [];
		for (const path of listJsonlFiles(root).sort()) {
			if (context) await setImmediate(undefined, { signal: context.signal });
			const session = await parseSession(path, request.projectFilter, undefined, context);
			if (session) sessions.push(session);
		}
		return { sessions, dedupedCount: 0, coverage: "complete" };
	}

	private async resolveSession(
		localSessionId: string,
		context?: SyncReadContext,
	): Promise<RawSession | null> {
		context?.signal.throwIfAborted();
		const sourceId = localSessionId.startsWith("pi.") ? localSessionId.slice(3) : localSessionId;
		for (const path of listJsonlFiles(getPiSessionsDir())) {
			if (context) await setImmediate(undefined, { signal: context.signal });
			const session = await parseSession(path, undefined, sourceId, context);
			if (session?.localSessionId === `pi.${sourceId}`) return session;
		}
		return null;
	}
}
