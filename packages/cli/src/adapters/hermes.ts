import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { safeTruncate } from "../lib/sanitize";
import { durationSecondsBetween } from "../lib/session-duration";
import {
	projectEventsToMessages,
	type SessionEventDraft,
	sequenceSessionEvents,
} from "../lib/session-events";
import { isValidSkillKey } from "../lib/skill-key";
import { replaceSkillArchiveTarGz } from "../lib/tar";
import { managedSkillDirectoryDigest } from "../runtime/hosted-bundled-skill";
import {
	migrateLegacyLocalSetupSkill,
	mutateUserSkillTarget,
	shouldIgnoreUserSkill,
} from "../runtime/managed-skill-reservation";
import type {
	AgentAdapterCore,
	RawSession,
	RawSkill,
	SessionContentPart,
	SessionEventDisplayMetadata,
	SessionEventSemantics,
	SessionMessage,
	SessionScanRequest,
	SessionScanResult,
} from "./base";
import { getHermesHome, SKIP_DIRS } from "./paths";
import {
	canonicalStructuredString,
	jsonObject,
	jsonString,
	reasoningContent,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
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
	return [
		"id",
		"role",
		"content",
		...MODERN_MESSAGE_OPTIONAL_COLUMNS.map(([name, fallback]) =>
			names.has(name) ? name : `${fallback} AS ${name}`,
		),
		"timestamp",
	].join(", ");
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

function shouldSkipHermesSkillDir(entryName: string): boolean {
	return entryName.startsWith(".") || SKIP_DIRS.has(entryName);
}

function hermesSkillKeyFromPath(fullPath: string): string | null {
	const skillKey = relative(skillsDir(), fullPath).replaceAll("\\", "/");
	return isValidSkillKey(skillKey) ? skillKey : null;
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
		contentProtocol: () => this.getContentProtocol(),
		collect: (request: SessionScanRequest) => this.collectSessions(request),
		resolve: (localSessionId: string) => this.resolveSession(localSessionId),
		watchPaths: () => this.getSessionsWatchPaths(),
	};
	readonly skills = {
		collect: () => this.collectSkills(),
		listKeys: () => this.listSkillKeys(),
		path: (key: string) => this.getSkillPath(key),
		rootDir: () => this.getSkillsRootDir(),
		sharedPath: (skillKey: string, ownerHandle: string) =>
			this.getSharedSkillPath(skillKey, ownerHandle),
		writeArchive: (key: string, tarGzBytes: Buffer) => this.writeSkillArchive(key, tarGzBytes),
		writeSharedArchive: (key: string, ownerHandle: string, tarGzBytes: Buffer) =>
			this.writeSharedSkillArchive(key, ownerHandle, tarGzBytes),
		remove: (key: string) => this.removeLocalSkill(key),
	};

	async detect(): Promise<boolean> {
		// Hermes stores state in a SQLite db. The dir alone may exist as a
		// leftover; the db is the only file every Hermes install creates.
		return existsSync(stateDbPath());
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("hermes", ["--version"]);
	}

	private async getContentProtocol(): Promise<"events-v1" | "snapshot-v1"> {
		if (!existsSync(stateDbPath())) return "snapshot-v1";
		const db = await openReadonlySqlite(stateDbPath());
		try {
			return hasStableModernMessageIds(messageTableInfo(db)) ? "events-v1" : "snapshot-v1";
		} finally {
			db.close();
		}
	}

	private async collectSessions(_request: SessionScanRequest): Promise<SessionScanResult> {
		// Hermes' SQLite is a single file with no per-row stat info, so we
		// always scan the whole `sessions` table. Cost is negligible
		// (dozens to hundreds of rows). `projectFilter` has no analogue
		// in Hermes' data model and is silently ignored.
		return { sessions: await this.collectCurrentSessions(), dedupedCount: 0, coverage: "complete" };
	}

	private async resolveSession(localSessionId: string): Promise<RawSession | null> {
		return (await this.collectCurrentSessions(localSessionId))[0] ?? null;
	}

	private async collectCurrentSessions(localSessionId?: string): Promise<RawSession[]> {
		if (!existsSync(stateDbPath())) return [];
		const db = await openReadonlySqlite(stateDbPath());
		try {
			const messageColumns = messageTableInfo(db);
			const modern = hasStableModernMessageIds(messageColumns);
			const selectSessions = `
				SELECT id, source, model, title, started_at, ended_at,
				       message_count, input_tokens, output_tokens, cache_read_tokens
				FROM sessions
				${localSessionId === undefined ? "" : "WHERE id = ?"}
				ORDER BY started_at DESC
			`;
			const rows = db
				.prepare(selectSessions)
				.all(...(localSessionId === undefined ? [] : [localSessionId])) as SessionRow[];
			const msgStmt = db.prepare(
				modern
					? `
						SELECT ${modernMessageSelectColumns(messageColumns)}
						FROM messages
						WHERE session_id = ?
						ORDER BY id ASC
					`
					: `
						SELECT role, content, timestamp
						FROM messages
						WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL
						ORDER BY timestamp ASC
					`,
			);

			const sessions: RawSession[] = [];

			for (const row of rows) {
				const model = parseModelField(row.model);
				const startedAt = new Date(row.started_at * 1000);
				const endedAt = row.ended_at ? new Date(row.ended_at * 1000) : null;
				const durationSeconds = durationSecondsBetween(startedAt, endedAt);

				const msgRows = msgStmt.all(row.id) as Array<MessageRow | ModernMessageRow>;
				const events = modern
					? sequenceSessionEvents(
							(msgRows as ModernMessageRow[]).flatMap((message) =>
								hermesEventDrafts(message, row.id, model),
							),
						)
					: undefined;
				const messages: SessionMessage[] = events
					? projectEventsToMessages(events)
					: (msgRows as MessageRow[]).map((message) => ({
							role: message.role as "user" | "assistant",
							content: message.content ?? "",
							model: message.role === "assistant" ? (model ?? undefined) : undefined,
							...(timestampIso(message.timestamp)
								? { timestamp: timestampIso(message.timestamp) }
								: {}),
						}));

				// Summary: use title or first user message
				let summary = row.title;
				if (!summary || summary === "New Chat" || summary.startsWith("New Chat #")) {
					const firstUser = messages.find((m) => m.role === "user");
					summary = firstUser ? safeTruncate(firstUser.content, 200) : null;
				}

				if (modern ? events?.length === 0 : messages.length === 0) continue;

				sessions.push({
					localSessionId: row.id,
					// Hermes sessions have no filesystem cwd — `row.source` is a channel/origin
					// tag (e.g. "telegram"), not a path. Leave null so the dashboard doesn't
					// render a fake "hermes/..." project.
					projectPath: null,
					startedAt,
					endedAt,
					messageCount: row.message_count ?? messages.length,
					inputTokens: row.input_tokens ?? 0,
					outputTokens: row.output_tokens ?? 0,
					cacheReadTokens: row.cache_read_tokens ?? 0,
					model,
					modelsUsed: model ? [model] : [],
					durationSeconds,
					summary,
					messages,
					...(events ? { events } : {}),
					// The DB is shared across sessions — anchor to the row id so the pointer
					// identifies the specific session rather than the whole store.
					rawFilePath: `${stateDbPath()}#${row.id}`,
				});
			}

			return sessions;
		} finally {
			db.close();
		}
	}

	private async collectSkills(): Promise<RawSkill[]> {
		migrateLegacyLocalSetupSkill({
			targetDir: join(skillsDir(), "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
		if (!existsSync(skillsDir())) return [];

		const skills: RawSkill[] = [];
		this._scanSkillsDir(skillsDir(), skills);
		return skills;
	}

	/**
	 * Recursively scan for directories containing SKILL.md.
	 * Hermes skills can be nested: skills/category/skill-name/SKILL.md
	 */
	private _scanSkillsDir(dir: string, results: RawSkill[]): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (shouldSkipHermesSkillDir(entry.name)) continue;
			const fullPath = join(dir, entry.name);
			const skillMd = join(fullPath, "SKILL.md");

			if (existsSync(skillMd)) {
				const content = readFileSync(skillMd, "utf-8");
				const skillKey = hermesSkillKeyFromPath(fullPath);
				if (!skillKey) continue;
				if (shouldIgnoreUserSkill(fullPath, skillKey)) continue;
				const fileCount = readdirSync(fullPath, { recursive: true }).length;

				results.push({
					skillKey,
					name: entry.name,
					content,
					filePath: skillMd,
					directoryPath: fullPath,
					isDirectory: fileCount > 1,
				});
			} else {
				// Might be a category directory, recurse
				this._scanSkillsDir(fullPath, results);
			}
		}
	}

	private getSkillPath(key: string): string {
		return join(skillsDir(), key, "SKILL.md");
	}

	private getSkillsRootDir(): string {
		return skillsDir();
	}

	private getSharedSkillPath(skillKey: string, ownerHandle: string): string {
		// Hermes nests skills under category dirs; route shared
		// project content into a dedicated `shared/` category so it
		// doesn't intermix with user-authored categories.
		return join(skillsDir(), "shared", `${skillKey}__${ownerHandle}`);
	}

	private async listSkillKeys(): Promise<string[]> {
		// Hermes nests skills under category dirs:
		//   `~/.hermes/skills/category/foo/SKILL.md`
		// Recurse — same logic `_scanSkillsDir` uses for the
		// fully-loaded `collectSkills`, just without reading
		// SKILL.md content. Returns relative paths so the
		// daemon's hash + watch + push paths land at the right
		// place under `getSkillsRootDir()`. Without this method,
		// the generic flat-walk used to silently drop nested
		// Hermes skills from sync.
		migrateLegacyLocalSetupSkill({
			targetDir: join(skillsDir(), "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
		if (!existsSync(skillsDir())) return [];
		const out: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (shouldSkipHermesSkillDir(entry.name)) continue;
				const fullPath = join(dir, entry.name);
				if (existsSync(join(fullPath, "SKILL.md"))) {
					const skillKey = hermesSkillKeyFromPath(fullPath);
					if (skillKey && !shouldIgnoreUserSkill(fullPath, skillKey)) out.push(skillKey);
				} else {
					walk(fullPath);
				}
			}
		};
		walk(skillsDir());
		return out;
	}

	private getSessionsWatchPaths(): string[] {
		// SQLite may keep committed session rows in WAL or rollback-journal
		// sidecars while state.db itself remains unchanged. All three paths
		// therefore belong to one global quiescence window; missing sidecars
		// have an empty poll signature and become observable when created.
		const database = stateDbPath();
		return [database, `${database}-wal`, `${database}-journal`];
	}

	private async removeLocalSkill(key: string): Promise<void> {
		const dir = join(skillsDir(), key);
		mutateUserSkillTarget(dir, key, () => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
	}

	private async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		const root = skillsDir();
		const targetDir = join(root, key);
		await replaceSkillArchiveTarGz(key, root, targetDir, tarGzBytes, undefined, (mutation) =>
			mutateUserSkillTarget(targetDir, key, mutation),
		);
	}

	private async writeSharedSkillArchive(
		key: string,
		ownerHandle: string,
		tarGzBytes: Buffer,
	): Promise<void> {
		const root = this.getSkillsRootDir();
		const sharedRoot = join(root, "shared");
		await replaceSkillArchiveTarGz(
			key,
			root,
			this.getSharedSkillPath(key, ownerHandle),
			tarGzBytes,
			undefined,
			(mutation) => mutateUserSkillTarget(sharedRoot, "shared", mutation),
		);
	}
}
