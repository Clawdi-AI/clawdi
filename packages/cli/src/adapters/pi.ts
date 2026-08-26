import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { safeTruncate } from "../lib/sanitize";
import { durationSecondsBetween } from "../lib/session-duration";
import {
	canonicalJson,
	canonicalPayloadJson,
	projectEventsToMessages,
	type SessionEventDraft,
	sequenceSessionEvents,
} from "../lib/session-events";
import type { AgentAdapterCore, RawSession, SessionScanRequest, SessionScanResult } from "./base";
import { getPiHome, getPiSessionsDir, isPathWithinRoots } from "./paths";
import {
	completeJsonlRecords,
	type JsonObject,
	jsonObject,
	jsonString,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
import { readCommandVersion } from "./version";

interface ParsedPiEntry {
	data: JsonObject;
	id: string;
	parentId: string | null;
	recordSeq: number;
}

interface ParsedPiFile {
	header: JsonObject;
	entries: ParsedPiEntry[];
	leafId: string | null;
	usage: PiUsage;
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

function readPiFile(filePath: string): ParsedPiFile | null {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const parsed = completeJsonlRecords(content);
	const first = parsed[0];
	if (!first) return null;
	if (first.data.kind === "header" && first.data.version === 4) {
		return readPiV4File(first.data, parsed.slice(1));
	}
	if (first.data.type !== "session" || !jsonString(first.data.id)) return null;
	const version = numberValue(first.data.version) ?? 1;
	const entryRows = parsed.slice(1);
	const ids = entryRows.map(
		({ data, recordSeq }) => jsonString(data.id) ?? stableV1Id(data, recordSeq),
	);
	const usage = emptyUsage();
	const entries = entryRows.map(({ data, recordSeq }, index): ParsedPiEntry => {
		const migrated = { ...data };
		const id = ids[index] as string;
		let parentId = jsonString(data.parentId);
		if (data.parentId === null) parentId = null;
		else if (parentId === null) parentId = index > 0 ? (ids[index - 1] ?? null) : null;
		if (version < 2 && data.type === "compaction") {
			const keptIndex = numberValue(data.firstKeptEntryIndex);
			if (keptIndex !== null) migrated.firstKeptEntryId = ids[keptIndex - 1];
		}
		const message = jsonObject(data.message);
		if (version < 3 && message?.role === "hookMessage") {
			migrated.message = { ...message, role: "custom" };
		}
		if (data.type === "message") addUsage(usage, message?.usage);
		else if (data.type === "compaction" || data.type === "branch_summary") {
			addUsage(usage, data.usage);
		}
		return { data: migrated, id, parentId, recordSeq };
	});
	return { header: first.data, entries, leafId: entries.at(-1)?.id ?? null, usage };
}

function readPiV4File(
	header: JsonObject,
	records: Array<{ data: JsonObject; recordSeq: number }>,
): ParsedPiFile | null {
	if (!jsonString(header.id) || numberValue(header.createdAt) === null) return null;
	const entries: ParsedPiEntry[] = [];
	const entriesById = new Map<string, ParsedPiEntry>();
	const lanes = new Map<string, string | null>([["main", null]]);
	const usage = emptyUsage();
	let expectedSeq = 1;
	for (const { data, recordSeq } of records) {
		const seq = numberValue(data.seq);
		if (!Number.isSafeInteger(seq) || seq !== expectedSeq) break;
		expectedSeq += 1;
		if (data.kind === "entry") {
			const id = jsonString(data.id);
			const parentId = data.parentId === null ? null : jsonString(data.parentId);
			const lane = data.lane === undefined ? null : jsonString(data.lane);
			if (
				!id ||
				!jsonString(data.type) ||
				(data.parentId !== null && !parentId) ||
				(parentId !== null && !entriesById.has(parentId)) ||
				(data.lane !== undefined && (!lane || !lanes.has(lane))) ||
				entriesById.has(id)
			) {
				break;
			}
			const entry = { data, id, parentId, recordSeq };
			entries.push(entry);
			entriesById.set(id, entry);
			if (lane) lanes.set(lane, id);
			continue;
		}
		if (data.kind === "lane") {
			const lane = jsonString(data.lane);
			const leafId = data.leafId === null ? null : jsonString(data.leafId);
			if (!lane || (data.leafId !== null && (!leafId || !entriesById.has(leafId)))) break;
			lanes.set(lane, leafId);
			continue;
		}
		if (data.kind === "record") {
			if (data.type === "usage") addUsage(usage, data.usage);
			continue;
		}
		if (data.kind !== "fact") break;
	}
	return { header, entries, leafId: lanes.get("main") ?? null, usage };
}

function activeBranch(entries: ParsedPiEntry[], leafId: string | null): ParsedPiEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: ParsedPiEntry[] = [];
	let current = leafId ? byId.get(leafId) : undefined;
	const seen = new Set<string>();
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path.reverse();
}

function compactionAwareBranch(entries: ParsedPiEntry[], leafId: string | null): ParsedPiEntry[] {
	const branch = activeBranch(entries, leafId);
	const compactionIndex = branch.findLastIndex((entry) => entry.data.type === "compaction");
	if (compactionIndex < 0) return branch;
	const compaction = branch[compactionIndex];
	if (!compaction) return branch;
	if (Array.isArray(compaction.data.retainedTail)) {
		return [compaction, ...branch.slice(compactionIndex + 1)];
	}
	const firstKeptId = jsonString(compaction.data.firstKeptEntryId);
	const retainedStart = firstKeptId
		? branch.slice(0, compactionIndex).findIndex((entry) => entry.id === firstKeptId)
		: -1;
	return [
		compaction,
		...(retainedStart >= 0 ? branch.slice(retainedStart, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
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
			if (part?.type !== "toolCall") continue;
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
		}
		return drafts;
	}
	if (role === "toolResult") {
		const callId = jsonString(message.toolCallId);
		if (!callId) return [];
		const result = toolResultContent(message.content, message.details);
		const toolName = jsonString(message.toolName);
		return [
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

function listJsonlFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop();
		if (!dir) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	}
	return files.sort();
}

function parseSession(filePath: string, projectFilter?: string): RawSession | null {
	const parsed = readPiFile(filePath);
	if (!parsed) return null;
	const sessionKey = jsonString(parsed.header.id);
	if (!sessionKey) return null;
	const cwd = jsonString(parsed.header.cwd);
	if (projectFilter && (!cwd || resolve(cwd) !== resolve(projectFilter))) return null;
	const events = sequenceSessionEvents(
		compactionAwareBranch(parsed.entries, parsed.leafId).flatMap((entry) =>
			entryEvents(sessionKey, entry),
		),
	);
	const messages = projectEventsToMessages(events);
	if (events.length === 0) return null;
	const timestamps = events
		.map((event) => event.timestamp)
		.filter((value): value is string => value !== undefined)
		.map((value) => new Date(value))
		.filter((value) => !Number.isNaN(value.getTime()));
	const headerTimestamp =
		numberValue(parsed.header.createdAt) ?? jsonString(parsed.header.timestamp) ?? undefined;
	const stat = statSync(filePath);
	const parsedHeaderTimestamp = headerTimestamp === undefined ? null : new Date(headerTimestamp);
	const startedAt =
		timestamps[0] ??
		(parsedHeaderTimestamp && !Number.isNaN(parsedHeaderTimestamp.getTime())
			? parsedHeaderTimestamp
			: stat.birthtime);
	const endedAt = timestamps.at(-1) ?? stat.mtime;
	const models = events
		.map((event) =>
			event.type === "message" || event.type === "tool_call" ? event.model : undefined,
		)
		.filter((value): value is string => Boolean(value));
	const modelsUsed = [...new Set(models)];
	const firstUser = messages.find((message) => message.role === "user");
	return {
		localSessionId: `pi.${sessionKey}`,
		projectPath: cwd,
		startedAt,
		endedAt,
		messageCount: messages.length,
		inputTokens: parsed.usage.inputTokens,
		outputTokens: parsed.usage.outputTokens,
		cacheReadTokens: parsed.usage.cacheReadTokens,
		model: models.at(-1) ?? null,
		modelsUsed,
		durationSeconds: durationSecondsBetween(startedAt, endedAt),
		summary: firstUser ? safeTruncate(firstUser.content, 200) : basename(filePath, ".jsonl"),
		messages,
		events,
		rawFilePath: filePath,
	};
}

export class PiAdapter implements AgentAdapterCore {
	readonly agentType = "pi" as const;
	readonly sessions = {
		contentProtocol: async () => "events-v1" as const,
		collect: (request: SessionScanRequest) => this.collectSessions(request),
		resolve: (localSessionId: string) => this.resolveSession(localSessionId),
		watchPaths: () => [getPiSessionsDir()],
	};

	async detect(): Promise<boolean> {
		return existsSync(getPiSessionsDir()) || existsSync(getPiHome());
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("pi", ["--version"]);
	}

	private async collectSessions(request: SessionScanRequest): Promise<SessionScanResult> {
		const root = resolve(getPiSessionsDir());
		if (request.kind === "paths") {
			if (request.paths.length === 0) {
				return this.collectSessions({ kind: "complete", projectFilter: request.projectFilter });
			}
			const paths = request.paths.map((path) => resolve(path));
			if (paths.some((path) => !isPathWithinRoots(path, [root]) || !path.endsWith(".jsonl"))) {
				return this.collectSessions({ kind: "complete", projectFilter: request.projectFilter });
			}
			const sessions = paths
				.filter((path) => existsSync(path))
				.map((path) => parseSession(path, request.projectFilter))
				.filter((session): session is RawSession => session !== null);
			return { sessions, dedupedCount: 0, coverage: "partial" };
		}
		const sessions = listJsonlFiles(root)
			.map((path) => parseSession(path, request.projectFilter))
			.filter((session): session is RawSession => session !== null);
		return { sessions, dedupedCount: 0, coverage: "complete" };
	}

	private async resolveSession(localSessionId: string): Promise<RawSession | null> {
		const sourceId = localSessionId.startsWith("pi.") ? localSessionId.slice(3) : localSessionId;
		for (const path of listJsonlFiles(getPiSessionsDir())) {
			const session = parseSession(path);
			if (session?.localSessionId === `pi.${sourceId}`) return session;
		}
		return null;
	}
}
