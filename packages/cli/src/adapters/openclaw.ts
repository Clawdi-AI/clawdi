import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../lib/codex-oauth-native-store";
import { safeTruncate } from "../lib/sanitize";
import {
	computeOpenClawRealUserActivity,
	isInternalOpenClawSession,
} from "../lib/session-activity";
import { durationSecondsBetween } from "../lib/session-duration";
import {
	projectEventsToMessages,
	type SessionEventDraft,
	sequenceSessionEvents,
} from "../lib/session-events";
import { extractTarGz } from "../lib/tar";
import { managedSkillDirectoryDigest } from "../runtime/hosted-bundled-skill";
import {
	collectManagedSkillTree,
	managedSkillTreesEqual,
	withManagedTargetRollback,
} from "../runtime/managed-skill-delivery";
import {
	migrateLegacyLocalSetupSkill,
	mutateUserSkillTarget,
	shouldIgnoreUserSkill,
} from "../runtime/managed-skill-reservation";
import type {
	AgentAdapterCore,
	RawSession,
	RawSkill,
	SessionBatchScan,
	SessionScanRequest,
	SessionScanResult,
	SessionUserActivity,
} from "./base";
import {
	listOpenClawAgentWorkspaces,
	openClawAgentId,
	resolveOpenClawAgentWorkspace,
} from "./openclaw-workspace";
import { getOpenClawHome, isPathWithinRoots, SKIP_DIRS } from "./paths";
import {
	canonicalStructuredString,
	completeJsonlRecords,
	type JsonObject,
	jsonObject,
	jsonString,
	reasoningContent,
	stableRecordId,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
import { readCommandVersion } from "./version";

function openclawDir() {
	return getOpenClawHome();
}
function agentsRoot() {
	return join(openclawDir(), "agents");
}
function agentId() {
	return openClawAgentId();
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
function activeAgentWorkspace() {
	return resolveOpenClawAgentWorkspace(agentId());
}

function skillsDir() {
	return join(activeAgentWorkspace(), "skills");
}

/**
 * Enumerate every `agents/<id>` subdir we should read from. OpenClaw can
 * host many agent personalities side-by-side (see issue #28: a single state
 * root with `main`, `financial`, `sales`, etc.) so we union them. Honoring
 * `OPENCLAW_AGENT_ID` as a single-agent override keeps the explicit-project
 * escape hatch from the issue's workaround.
 */
interface AgentDirectoryListing {
	dirs: string[];
	complete: boolean;
}

function listAgentDirsWithCompleteness(): AgentDirectoryListing {
	const root = agentsRoot();
	if (!existsSync(root)) return { dirs: [], complete: true };
	const override = process.env.OPENCLAW_AGENT_ID?.trim();
	try {
		const dirs = readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith("."))
			.filter((d) => !override || d.name === override)
			.map((d) => join(root, d.name));
		return { dirs, complete: true };
	} catch (e) {
		// `agents/` is present but unreadable (perm bits, encrypted-at-rest,
		// stale fuse mount, …). Silently treating that as "no agents" hides
		// the fact that we actively skipped data — surface it on stderr so
		// `clawdi push` doesn't appear to succeed with 0 sessions.
		console.warn(
			`[openclaw] could not enumerate ${root}: ${e instanceof Error ? e.message : String(e)}`,
		);
		return { dirs: [], complete: false };
	}
}

function listAgentDirs(): string[] {
	return listAgentDirsWithCompleteness().dirs;
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
	transcriptPath?: string;
	path?: string;
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

interface OfficialSessionEntry extends SessionEntry {
	agentId: string;
	key: string;
	spawnedCwd?: string;
	spawnedWorkspaceDir?: string;
	sessionStartedAt?: number;
}

interface OfficialSessionInventory {
	entries: OfficialSessionEntry[];
	storePaths: Map<string, string>;
	complete: boolean;
}

interface TranscriptReference {
	internalOnly: boolean;
	requiredExternal: boolean;
}

function canonicalTranscriptReferences(name: string): string[] {
	if (
		!name.endsWith(".jsonl") &&
		!name.includes(".jsonl.reset.") &&
		!name.includes(".jsonl.deleted.")
	) {
		return [];
	}
	const references = new Set([name]);
	for (const marker of [".reset.", ".deleted."]) {
		let offset = 0;
		while (true) {
			const index = name.indexOf(marker, offset);
			if (index < 0) break;
			if (index > 0) references.add(name.slice(0, index));
			offset = index + marker.length;
		}
	}
	return [...references];
}

function transcriptReferenceName(
	sessionsRoot: string,
	indexKey: string,
	entry: SessionEntry,
): string | undefined {
	const explicit = [entry.sessionFile, entry.transcriptPath, entry.path].find(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	const raw = explicit?.trim() ?? `${entry.sessionId ?? indexKey}.jsonl`;
	const name = basename(raw);
	if (!name || name === "." || name === "..") return undefined;
	if (!isAbsolute(raw)) {
		const candidate = resolve(sessionsRoot, raw);
		return isPathWithinRoots(candidate, [resolve(sessionsRoot)]) ? name : undefined;
	}
	const candidate = resolve(raw);
	if (isPathWithinRoots(candidate, [resolve(sessionsRoot)])) return name;
	return raw.startsWith("/data/openclaw/agents/") || raw.startsWith("/var/openclaw/agents/")
		? name
		: undefined;
}

function collectCanonicalOpenClawActivity(
	officialInventory: OfficialSessionInventory | null,
	classifiedPaths: ReadonlySet<string>,
): SessionUserActivity {
	const listing = listAgentDirsWithCompleteness();
	let activity: SessionUserActivity = {
		lastUserInputAt: null,
		complete: listing.complete,
	};
	const visitedAgentIds = new Set<string>();
	const officialByAgent = new Map<string, OfficialSessionEntry[]>();
	for (const entry of officialInventory?.entries ?? []) {
		const entries = officialByAgent.get(entry.agentId) ?? [];
		entries.push(entry);
		officialByAgent.set(entry.agentId, entries);
	}
	for (const agentRoot of listing.dirs) {
		const agentId = basename(agentRoot);
		const sessionsRoot = join(agentRoot, "sessions");
		if (!existsSync(sessionsRoot)) continue;
		visitedAgentIds.add(agentId);
		let transcripts: Array<{ path: string; references: string[] }>;
		try {
			transcripts = readdirSync(sessionsRoot, { withFileTypes: true }).flatMap((entry) => {
				if (!entry.isFile()) return [];
				const references = canonicalTranscriptReferences(entry.name);
				return references.length > 0
					? [{ path: resolve(sessionsRoot, entry.name), references }]
					: [];
			});
		} catch {
			activity.complete = false;
			continue;
		}
		const presentReferences = new Set(transcripts.flatMap((transcript) => transcript.references));
		const references = new Map<string, TranscriptReference>();
		const addReference = (identity: string, entry: SessionEntry, required: boolean): void => {
			const name = transcriptReferenceName(sessionsRoot, identity, entry);
			if (!name) {
				activity.complete = false;
				return;
			}
			const reference = references.get(name) ?? {
				internalOnly: true,
				requiredExternal: false,
			};
			const internal = isInternalOpenClawSession(identity, entry);
			reference.internalOnly &&= internal;
			reference.requiredExternal ||= required && !internal;
			references.set(name, reference);
		};
		const indexPath = join(sessionsRoot, "sessions.json");
		if (existsSync(indexPath)) {
			try {
				const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as unknown;
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
				for (const [key, value] of Object.entries(parsed)) {
					if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
					const entry = value as SessionEntry;
					if (!entry.sessionFile && !entry.sessionId && !entry.transcriptPath && !entry.path)
						continue;
					addReference(key, entry, officialInventory === null);
				}
			} catch {
				activity.complete = false;
			}
		}
		for (const entry of officialByAgent.get(agentId) ?? []) {
			if (entry.sessionFile) addReference(entry.key, entry, true);
		}
		for (const transcript of transcripts) {
			if (classifiedPaths.has(transcript.path)) continue;
			const matches = transcript.references.flatMap((name) => {
				const reference = references.get(name);
				return reference ? [reference] : [];
			});
			if (matches.length > 0 && matches.every((reference) => reference.internalOnly)) continue;
			activity = mergeUserActivity(activity, readOpenClawTranscriptActivity(transcript.path));
		}
		for (const [name, reference] of references) {
			if (
				reference.requiredExternal &&
				!presentReferences.has(name) &&
				!classifiedPaths.has(resolve(sessionsRoot, name))
			) {
				activity.complete = false;
			}
		}
	}
	for (const entry of officialInventory?.entries ?? []) {
		if (
			entry.sessionFile &&
			!visitedAgentIds.has(entry.agentId) &&
			!isInternalOpenClawSession(entry.key, entry)
		) {
			activity.complete = false;
		}
	}
	return activity;
}

function readOpenClawTranscriptActivity(path: string): SessionUserActivity {
	try {
		const before = statSync(path, { bigint: true });
		const content = readFileSync(path, "utf-8");
		const after = statSync(path, { bigint: true });
		const records = completeJsonlRecords(content);
		const activity = computeOpenClawRealUserActivity(
			records.map((record) => record.data),
			"",
		);
		return {
			lastUserInputAt: activity.lastUserInputAt,
			complete:
				activity.complete &&
				records.length === content.split("\n").filter((line) => line.trim()).length &&
				before.dev === after.dev &&
				before.ino === after.ino &&
				before.size === after.size &&
				before.mtimeNs === after.mtimeNs,
		};
	} catch {
		return { lastUserInputAt: null, complete: false };
	}
}

function maxActivityTimestamp(left: string | null, right: string | null): string | null {
	if (!left) return right;
	if (!right) return left;
	return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function mergeUserActivity(
	left: SessionUserActivity,
	right: SessionUserActivity,
): SessionUserActivity {
	return {
		lastUserInputAt: maxActivityTimestamp(left.lastUserInputAt, right.lastUserInputAt),
		complete: left.complete && right.complete,
	};
}

const OPENCLAW_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function runOpenClawJson(args: string[]): JsonObject | null {
	const result = spawnSync("openclaw", args, {
		encoding: "utf8",
		env: process.env,
		maxBuffer: OPENCLAW_COMMAND_MAX_BUFFER_BYTES,
		timeout: 120_000,
	});
	if (result.status !== 0) return null;
	try {
		return jsonObject(JSON.parse(result.stdout)) ?? null;
	} catch {
		return null;
	}
}

function readOfficialSessionInventory(): OfficialSessionInventory | null {
	const override = process.env.OPENCLAW_AGENT_ID?.trim();
	const payload = runOpenClawJson([
		"sessions",
		"--json",
		...(override ? ["--agent", override] : ["--all-agents"]),
		"--limit",
		"all",
	]);
	if (!payload || !Array.isArray(payload.sessions)) return null;

	let complete = true;
	const entries = payload.sessions.flatMap((value): OfficialSessionEntry[] => {
		const row = jsonObject(value);
		const agentId = jsonString(row?.agentId);
		const key = jsonString(row?.key);
		if (!row || !agentId || !key) {
			complete = false;
			return [];
		}
		const sessionId = jsonString(row.sessionId) ?? undefined;
		const number = (field: string) => {
			const candidate = row[field];
			return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
		};
		const acp = jsonObject(row.acp);
		const acpLastActivityAt = acp?.lastActivityAt;
		return [
			{
				agentId,
				key,
				sessionId,
				updatedAt: number("updatedAt"),
				sessionStartedAt: number("sessionStartedAt"),
				inputTokens: number("inputTokens"),
				outputTokens: number("outputTokens"),
				totalTokens: number("totalTokens"),
				cacheRead: number("cacheRead"),
				cacheWrite: number("cacheWrite"),
				model: jsonString(row.model) ?? undefined,
				modelProvider: jsonString(row.modelProvider) ?? undefined,
				sessionFile: jsonString(row.sessionFile) ?? undefined,
				displayName: jsonString(row.displayName) ?? undefined,
				subject: jsonString(row.subject) ?? undefined,
				label: jsonString(row.label) ?? undefined,
				spawnedCwd: jsonString(row.spawnedCwd) ?? undefined,
				spawnedWorkspaceDir: jsonString(row.spawnedWorkspaceDir) ?? undefined,
				...(acp
					? {
							acp: {
								cwd: jsonString(acp.cwd) ?? undefined,
								lastActivityAt:
									typeof acpLastActivityAt === "number" && Number.isFinite(acpLastActivityAt)
										? acpLastActivityAt
										: undefined,
							},
						}
					: {}),
			},
		];
	});
	const storePaths = new Map<string, string>();
	if (Array.isArray(payload.stores)) {
		for (const value of payload.stores) {
			const store = jsonObject(value);
			const agentId = jsonString(store?.agentId);
			const path = jsonString(store?.path);
			if (agentId && path) storePaths.set(agentId, path);
		}
	}
	return { entries, storePaths, complete };
}

async function readOfficialSessionMessagesFromSdk(
	entry: OfficialSessionEntry,
): Promise<JsonObject[] | null> {
	if (!entry.sessionId) return null;
	const sdkPath = resolveOpenClawSdkExport(
		process.env.HOME ?? homedir(),
		[],
		OPENCLAW_SDK_EXPORT_PATHS.sessionTranscript,
	);
	if (!sdkPath) return null;
	try {
		const sdk: unknown = await import(pathToFileURL(sdkPath).href);
		if (
			typeof sdk !== "object" ||
			sdk === null ||
			!("readVisibleSessionTranscriptMessageEntries" in sdk) ||
			typeof sdk.readVisibleSessionTranscriptMessageEntries !== "function"
		)
			return null;
		const result: unknown = await sdk.readVisibleSessionTranscriptMessageEntries({
			agentId: entry.agentId,
			sessionId: entry.sessionId,
			sessionKey: entry.key,
		});
		if (!Array.isArray(result)) return null;
		return result.flatMap((value): JsonObject[] => {
			const item = jsonObject(value);
			const message = jsonObject(item?.message);
			if (!item || !message) return [];
			return [
				{
					...message,
					...(jsonString(item.entryId) ? { id: jsonString(item.entryId) } : {}),
					...(jsonString(item.parentId) ? { parentId: jsonString(item.parentId) } : {}),
					...(jsonString(item.createdAt) ? { timestamp: jsonString(item.createdAt) } : {}),
				},
			];
		});
	} catch {
		return null;
	}
}

function readOfficialSessionMessagesFromGateway(entry: OfficialSessionEntry): JsonObject[] | null {
	let offset = 0;
	let messages: JsonObject[] = [];
	const seenOffsets = new Set<number>();
	while (!seenOffsets.has(offset)) {
		seenOffsets.add(offset);
		const payload = runOpenClawJson([
			"gateway",
			"call",
			"chat.history",
			"--params",
			JSON.stringify({
				agentId: entry.agentId,
				limit: 1000,
				maxChars: 500_000,
				offset,
				sessionKey: entry.key,
			}),
			"--json",
		]);
		if (!payload || !Array.isArray(payload.messages)) return null;
		const page = payload.messages.flatMap((value): JsonObject[] => {
			const message = jsonObject(value);
			return message ? [message] : [];
		});
		messages = [...page, ...messages];
		if (payload.hasMore !== true) return messages;
		if (typeof payload.nextOffset !== "number" || payload.nextOffset <= offset) return null;
		offset = payload.nextOffset;
	}
	return null;
}

interface TranscriptLine {
	type?: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		content?: string | Array<{ type: string; text?: string }>;
	};
	provider?: string;
	modelId?: string;
}

function openClawEventDrafts(
	raw: JsonObject,
	sessionKey: string,
	recordSeq: number,
	currentModel: string | null,
): SessionEventDraft[] {
	const timestampValue = raw.timestamp;
	const timestamp =
		typeof timestampValue === "number"
			? new Date(timestampValue).toISOString()
			: (jsonString(timestampValue) ?? undefined);
	const recordId = stableRecordId(raw, recordSeq);
	const eventSource = (partIndex?: number) => ({
		adapter: "openclaw" as const,
		session_key: sessionKey,
		record_id: recordId,
		record_seq: recordSeq,
		...(partIndex === undefined ? {} : { part_index: partIndex }),
	});
	if (raw.type === "model_change") {
		const model = jsonString(raw.modelId);
		return model
			? [
					{
						type: "message",
						role: "system",
						parts: [{ type: "text", text: `Model changed to ${model}.` }],
						model,
						source: eventSource(),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
	}
	if (raw.type !== "message") return [];
	const message = jsonObject(raw.message);
	if (!message) return [];
	const role = jsonString(message.role);
	const model = jsonString(message.model) ?? currentModel ?? undefined;
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
		if (role === "assistant" && (block.type === "toolCall" || block.type === "tool_use")) {
			const callId = jsonString(block.id);
			const name = jsonString(block.name);
			if (!callId || !name) continue;
			drafts.push({
				type: "tool_call",
				call_id: callId,
				name,
				arguments_json: canonicalStructuredString(block.arguments ?? block.input),
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
				...(model ? { model } : {}),
			});
		}
		if (role === "user" && block.type === "tool_result") {
			const callId = jsonString(block.tool_use_id);
			if (!callId) continue;
			drafts.push({
				type: "tool_result",
				call_id: callId,
				status: block.is_error === true ? "error" : "completed",
				...toolResultContent(block.content, block.details),
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
			});
		}
	}
	if (role === "toolResult") {
		const callId = jsonString(message.toolCallId);
		if (callId)
			drafts.push({
				type: "tool_result",
				call_id: callId,
				...(jsonString(message.toolName) ? { name: jsonString(message.toolName) as string } : {}),
				status: message.isError === true ? "error" : "completed",
				...toolResultContent(message.content, message.details),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			});
	}
	return drafts;
}

interface SessionCollection {
	sessions: RawSession[];
	observedLocalSessionIds: readonly string[];
	dedupedCount: number;
	matchedTranscriptPaths: Set<string>;
	classifiedTranscriptPaths: Set<string>;
	userActivity: SessionUserActivity;
}

function singleSessionBatch(
	coverage: SessionScanResult["coverage"],
	collection: SessionCollection,
): SessionBatchScan {
	return {
		coverage,
		userActivity: collection.userActivity,
		batches: (async function* () {
			yield {
				sessions: collection.sessions,
				observedLocalSessionIds: collection.observedLocalSessionIds,
				dedupedCount: collection.dedupedCount,
			};
		})(),
	};
}

interface MaterializedOpenClawSession {
	session: RawSession | null;
	userActivity: SessionUserActivity;
}

function materializeOpenClawJsonlSession(input: {
	entry: SessionEntry;
	indexPath: string;
	projectPath: string | null;
	sourceAgentId: string;
	sourceSessionKey: string;
	sourceRevision: string;
	transcriptPath: string;
}): MaterializedOpenClawSession {
	const {
		entry,
		indexPath,
		projectPath,
		sourceAgentId,
		sourceSessionKey,
		sourceRevision,
		transcriptPath,
	} = input;
	const sessionId = entry.sessionId;
	const updatedAt = entry.updatedAt ?? entry.acp?.lastActivityAt;
	const internalSession = isInternalOpenClawSession(sourceSessionKey, entry);
	const unavailableActivity = { lastUserInputAt: null, complete: internalSession };
	if (!sessionId || !updatedAt) {
		return { session: null, userActivity: unavailableActivity };
	}

	let events = [] as import("./base").SessionEvent[];
	let startedAt: Date | null = null;
	let endedAt: Date | null = null;
	const modelsUsed = new Set<string>();
	if (entry.model) modelsUsed.add(entry.model);
	let currentModel = entry.model ?? null;
	const transcriptRecords: JsonObject[] = [];
	let transcriptComplete = true;

	if (!existsSync(transcriptPath)) {
		if (entry.sessionFile) {
			console.warn(`[openclaw] transcript missing for ${sessionId}: ${transcriptPath}`);
		}
		return { session: null, userActivity: unavailableActivity };
	} else {
		try {
			const transcriptContent = readFileSync(transcriptPath, "utf-8");
			const drafts: SessionEventDraft[] = [];
			const records = completeJsonlRecords(transcriptContent);
			transcriptComplete =
				records.length === transcriptContent.split("\n").filter((line) => line.trim()).length;
			for (const { data: raw, recordSeq } of records) {
				transcriptRecords.push(raw);
				const parsed = raw as TranscriptLine;
				drafts.push(
					...openClawEventDrafts(raw, `${sourceAgentId}:${sessionId}`, recordSeq, currentModel),
				);

				const timestamp = parsed.timestamp ? new Date(parsed.timestamp) : null;
				if (timestamp && !Number.isNaN(timestamp.getTime())) {
					startedAt ??= timestamp;
					endedAt = timestamp;
				}
				if (parsed.type === "model_change" && parsed.modelId) {
					modelsUsed.add(parsed.modelId);
					currentModel = parsed.modelId;
				}
			}
			events = sequenceSessionEvents(drafts);
		} catch {
			return { session: null, userActivity: unavailableActivity };
		}
	}

	const userActivity = computeOpenClawRealUserActivity(transcriptRecords, sourceSessionKey, entry);
	if (!internalSession) userActivity.complete &&= transcriptComplete;
	const messages = projectEventsToMessages(events);
	if (messages.length === 0) return { session: null, userActivity };
	startedAt ??= new Date(updatedAt);
	endedAt ??= new Date(updatedAt);
	const firstUserContent = messages.find((message) => message.role === "user")?.content;
	return {
		userActivity,
		session: {
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
			durationSeconds: durationSecondsBetween(startedAt, endedAt),
			summary:
				entry.displayName ??
				entry.subject ??
				entry.label ??
				(firstUserContent === undefined ? null : safeTruncate(firstUserContent, 200)),
			messages,
			events,
			rawFilePath: existsSync(transcriptPath) ? transcriptPath : indexPath,
			sourceRevision,
			realUserInputAt: userActivity.lastUserInputAt,
		},
	};
}

export class OpenClawAdapter implements AgentAdapterCore {
	readonly agentType = "openclaw" as const;
	readonly sessions = {
		contentProtocol: async () => "events-v1" as const,
		collect: (request: SessionScanRequest) => this.collectSessions(request),
		scan: (request: SessionScanRequest, knownSourceRevisions: ReadonlyMap<string, string>) =>
			this.scanSessions(request, knownSourceRevisions),
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
		return (
			readCommandVersion("openclaw", ["--version"]) ?? readCommandVersion("openclaw", ["--help"])
		);
	}

	private async collectSessions(request: SessionScanRequest): Promise<SessionScanResult> {
		const scan = await this.scanSessions(request, new Map());
		const sessions: RawSession[] = [];
		let dedupedCount = 0;
		for await (const batch of scan.batches) {
			sessions.push(...batch.sessions);
			dedupedCount += batch.dedupedCount;
		}
		return { sessions, dedupedCount, coverage: scan.coverage };
	}

	private async scanSessions(
		request: SessionScanRequest,
		knownSourceRevisions: ReadonlyMap<string, string>,
	): Promise<SessionBatchScan> {
		const materializeCanonicalActivity =
			request.kind === "complete" && knownSourceRevisions.size === 0;
		const officialInventory = readOfficialSessionInventory();
		if (officialInventory) {
			const collection = await this.collectOfficialSessionsMatching(
				officialInventory,
				request,
				undefined,
				knownSourceRevisions,
			);
			if (materializeCanonicalActivity) {
				collection.userActivity = mergeUserActivity(
					collection.userActivity,
					collectCanonicalOpenClawActivity(officialInventory, collection.classifiedTranscriptPaths),
				);
			}
			return singleSessionBatch("complete", collection);
		}

		const collection = await this.collectLegacySessions(request, knownSourceRevisions);
		if (collection.coverage === "complete" && materializeCanonicalActivity) {
			collection.userActivity = mergeUserActivity(
				collection.userActivity,
				collectCanonicalOpenClawActivity(null, collection.classifiedTranscriptPaths),
			);
		}
		return singleSessionBatch(collection.coverage, collection);
	}

	private async collectLegacySessions(
		request: SessionScanRequest,
		knownSourceRevisions: ReadonlyMap<string, string>,
	): Promise<SessionCollection & { coverage: SessionScanResult["coverage"] }> {
		if (request.kind === "complete") {
			return {
				...(await this.collectLegacySessionsMatching(
					request,
					undefined,
					undefined,
					knownSourceRevisions,
				)),
				coverage: "complete",
			};
		}
		if (request.paths.length === 0) {
			return this.collectLegacySessions(
				{ kind: "complete", projectFilter: request.projectFilter },
				knownSourceRevisions,
			);
		}
		const sessionRoots = listAgentDirs().map((dir) => resolve(dir, "sessions"));
		const transcriptPaths = new Set<string>();
		for (const path of request.paths) {
			const normalized = resolve(path);
			if (
				!isPathWithinRoots(normalized, sessionRoots) ||
				basename(normalized) === "sessions.json" ||
				!normalized.endsWith(".jsonl")
			) {
				return this.collectLegacySessions(
					{ kind: "complete", projectFilter: request.projectFilter },
					knownSourceRevisions,
				);
			}
			transcriptPaths.add(normalized);
		}

		const collection = await this.collectLegacySessionsMatching(
			request,
			transcriptPaths,
			undefined,
			knownSourceRevisions,
		);
		for (const path of transcriptPaths) {
			if (existsSync(path) && !collection.matchedTranscriptPaths.has(path)) {
				return this.collectLegacySessions(
					{ kind: "complete", projectFilter: request.projectFilter },
					knownSourceRevisions,
				);
			}
		}
		return { ...collection, coverage: "partial" };
	}

	private async resolveSession(localSessionId: string): Promise<RawSession | null> {
		const officialInventory = readOfficialSessionInventory();
		if (officialInventory) {
			return (
				(
					await this.collectOfficialSessionsMatching(
						officialInventory,
						{},
						localSessionId,
						new Map(),
					)
				).sessions[0] ?? null
			);
		}
		return (
			(await this.collectLegacySessionsMatching({}, undefined, localSessionId, new Map()))
				.sessions[0] ?? null
		);
	}

	private async collectLegacySessionsMatching(
		opts: { projectFilter?: string },
		transcriptPaths?: ReadonlySet<string>,
		localSessionId?: string,
		knownSourceRevisions: ReadonlyMap<string, string> = new Map(),
	): Promise<SessionCollection> {
		const agentDirectoryListing = listAgentDirsWithCompleteness();
		const agentDirs = agentDirectoryListing.dirs;
		if (agentDirs.length === 0) {
			return {
				sessions: [],
				dedupedCount: 0,
				observedLocalSessionIds: [],
				matchedTranscriptPaths: new Set(),
				classifiedTranscriptPaths: new Set(),
				userActivity: { lastUserInputAt: null, complete: agentDirectoryListing.complete },
			};
		}

		const { projectFilter } = opts;
		let absFilter: string | null = null;
		if (projectFilter) {
			const { resolve } = await import("node:path");
			absFilter = resolve(projectFilter);
		}

		const sessions: RawSession[] = [];
		const observedLocalSessionIds: string[] = [];
		const matchedTranscriptPaths = new Set<string>();
		const classifiedTranscriptPaths = new Set<string>();
		let userActivity: SessionUserActivity = { lastUserInputAt: null, complete: true };

		for (const agentRoot of agentDirs) {
			const sourceAgentId = basename(agentRoot);
			const sessionsDirForAgent = join(agentRoot, "sessions");
			const indexPath = join(sessionsDirForAgent, "sessions.json");
			if (!existsSync(indexPath)) continue;

			let index: Record<string, SessionEntry>;
			try {
				index = JSON.parse(readFileSync(indexPath, "utf-8"));
			} catch {
				userActivity.complete = false;
				continue;
			}

			for (const [indexKey, entry] of Object.entries(index)) {
				// Prefer the entry's own `sessionId` (real UUID); fall back to
				// the index key only for legacy fixtures that use the UUID as
				// the key directly.
				const sessionId = entry.sessionId ?? indexKey;
				if (localSessionId !== undefined && sessionId !== localSessionId) continue;
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
				const normalizedTranscriptPath = resolve(transcriptPath);
				if (transcriptPaths && !transcriptPaths.has(normalizedTranscriptPath)) continue;
				matchedTranscriptPaths.add(normalizedTranscriptPath);
				observedLocalSessionIds.push(sessionId);
				const sourceRevision = `${sessionId}:${updatedAt}`;
				const externalSession = !isInternalOpenClawSession(indexKey, entry);
				if (externalSession && existsSync(transcriptPath)) {
					classifiedTranscriptPaths.add(normalizedTranscriptPath);
				}
				if (knownSourceRevisions.get(sessionId) === sourceRevision) continue;

				const materialized = materializeOpenClawJsonlSession({
					entry: { ...entry, sessionId, updatedAt },
					indexPath,
					projectPath,
					sourceAgentId,
					sourceSessionKey: indexKey,
					sourceRevision,
					transcriptPath,
				});
				if (existsSync(transcriptPath)) {
					userActivity = mergeUserActivity(userActivity, materialized.userActivity);
				}
				if (materialized.session) sessions.push(materialized.session);
			}
		}

		// OpenClaw stores one session per ACP transcript with stable sessionIds
		// — no resume-chain duplication to dedupe.
		return {
			sessions,
			dedupedCount: 0,
			observedLocalSessionIds,
			matchedTranscriptPaths,
			classifiedTranscriptPaths,
			userActivity,
		};
	}

	private async collectOfficialSessionsMatching(
		inventory: OfficialSessionInventory,
		opts: { projectFilter?: string },
		localSessionId?: string,
		knownSourceRevisions: ReadonlyMap<string, string> = new Map(),
	): Promise<SessionCollection> {
		const absFilter = opts.projectFilter ? resolve(opts.projectFilter) : null;
		const sessions: RawSession[] = [];
		const observedLocalSessionIds: string[] = [];
		const classifiedTranscriptPaths = new Set<string>();
		let userActivity: SessionUserActivity = {
			lastUserInputAt: null,
			complete: inventory.complete,
		};
		for (const entry of inventory.entries) {
			const sessionId = entry.sessionId;
			if (localSessionId !== undefined && sessionId !== localSessionId) continue;
			if (!sessionId && isInternalOpenClawSession(entry.key, entry)) continue;
			const updatedAt = entry.updatedAt;
			if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
				userActivity.complete = false;
				continue;
			}
			const projectPath = entry.spawnedCwd ?? entry.spawnedWorkspaceDir ?? entry.acp?.cwd ?? null;
			if (
				absFilter &&
				(!projectPath || (projectPath !== absFilter && !projectPath.startsWith(`${absFilter}/`)))
			)
				continue;
			if (sessionId) observedLocalSessionIds.push(sessionId);
			const sourceRevision = sessionId ? `${sessionId}:${updatedAt}` : null;
			if (sessionId && knownSourceRevisions.get(sessionId) === sourceRevision) continue;

			let transcript = await readOfficialSessionMessagesFromSdk(entry);
			transcript ??= readOfficialSessionMessagesFromGateway(entry);
			if (transcript === null && entry.sessionFile && sessionId && sourceRevision) {
				const sessionsDirForAgent = join(agentsRoot(), entry.agentId, "sessions");
				const transcriptPath = isAbsolute(entry.sessionFile)
					? entry.sessionFile
					: join(sessionsDirForAgent, entry.sessionFile);
				const normalizedTranscriptPath = resolve(transcriptPath);
				if (!isInternalOpenClawSession(entry.key, entry) && existsSync(transcriptPath)) {
					classifiedTranscriptPaths.add(normalizedTranscriptPath);
				}
				const legacy = materializeOpenClawJsonlSession({
					entry,
					indexPath: join(sessionsDirForAgent, "sessions.json"),
					projectPath,
					sourceAgentId: entry.agentId,
					sourceSessionKey: entry.key,
					sourceRevision,
					transcriptPath,
				});
				if (existsSync(transcriptPath)) {
					userActivity = mergeUserActivity(userActivity, legacy.userActivity);
				}
				if (legacy.session) sessions.push(legacy.session);
				continue;
			}
			if (!transcript) {
				userActivity.complete = false;
				console.warn(
					`[openclaw] could not read active transcript for ${sessionId ?? entry.key} through official transcript surfaces`,
				);
				continue;
			}
			const sessionUserActivity = computeOpenClawRealUserActivity(transcript, entry.key, entry);
			userActivity = mergeUserActivity(userActivity, sessionUserActivity);
			if (entry.sessionFile && !isInternalOpenClawSession(entry.key, entry)) {
				const sessionsDirForAgent = join(agentsRoot(), entry.agentId, "sessions");
				const transcriptPath = isAbsolute(entry.sessionFile)
					? entry.sessionFile
					: join(sessionsDirForAgent, entry.sessionFile);
				classifiedTranscriptPaths.add(resolve(transcriptPath));
			}
			if (!sessionId || !sourceRevision) continue;

			const drafts: SessionEventDraft[] = [];
			const modelsUsed = new Set<string>();
			if (entry.model) modelsUsed.add(entry.model);
			let currentModel = entry.model ?? null;
			let startedAt: Date | null = null;
			let endedAt: Date | null = null;
			for (const [recordSeq, message] of transcript.entries()) {
				const timestamp = jsonString(message.timestamp) ?? jsonString(message.createdAt);
				const raw = {
					type: "message",
					...(jsonString(message.id) ? { id: jsonString(message.id) } : {}),
					...(timestamp ? { timestamp } : {}),
					message,
				};
				drafts.push(
					...openClawEventDrafts(raw, `${entry.agentId}:${sessionId}`, recordSeq, currentModel),
				);
				const messageModel = jsonString(message.model);
				if (messageModel) {
					modelsUsed.add(messageModel);
					currentModel = messageModel;
				}
				if (timestamp) {
					const parsed = new Date(timestamp);
					if (!Number.isNaN(parsed.getTime())) {
						startedAt ??= parsed;
						endedAt = parsed;
					}
				}
			}
			const events = sequenceSessionEvents(drafts);
			const messages = projectEventsToMessages(events);
			if (messages.length === 0) continue;
			startedAt ??= new Date(entry.sessionStartedAt ?? updatedAt);
			endedAt ??= new Date(updatedAt);
			const firstUserContent = messages.find((message) => message.role === "user")?.content;
			const storePath =
				inventory.storePaths.get(entry.agentId) ??
				join(agentsRoot(), entry.agentId, "agent", "openclaw-agent.sqlite");
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
				durationSeconds: durationSecondsBetween(startedAt, endedAt),
				summary:
					entry.label ??
					(firstUserContent === undefined ? null : safeTruncate(firstUserContent, 200)),
				messages,
				events,
				rawFilePath: storePath,
				sourceRevision,
				realUserInputAt: sessionUserActivity.lastUserInputAt,
			});
		}
		return {
			sessions,
			dedupedCount: 0,
			observedLocalSessionIds,
			matchedTranscriptPaths: new Set(),
			classifiedTranscriptPaths,
			userActivity,
		};
	}

	private async collectSkills(): Promise<RawSkill[]> {
		const skills: RawSkill[] = [];
		const seen = new Map<string, string>(); // skillKey → first-winning agentDir
		migrateLegacyLocalSetupSkill({
			targetDir: join(skillsDir(), "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});

		// Skills live in each official agent workspace — iterate every
		// configured workspace so a deployment with multiple
		// personalities (issue #28) doesn't lose six of seven skill sets.
		// Dedup by `skillKey`: identical names across agents collapse to
		// the first occurrence (server-side `skill_key` is per-user, so
		// we'd 409 on the second push anyway). Warn on collision so the
		// user can rename or pick an explicit OPENCLAW_AGENT_ID.
		for (const agent of listOpenClawAgentWorkspaces()) {
			const dir = join(agent.workspace, "skills");
			migrateLegacyLocalSetupSkill({
				targetDir: join(dir, "clawdi"),
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			});
			if (!existsSync(dir)) continue;

			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (entry.name.startsWith(".")) continue;
				if (SKIP_DIRS.has(entry.name)) continue;
				const dirPath = join(dir, entry.name);
				if (shouldIgnoreUserSkill(dirPath, entry.name)) continue;
				const skillMd = join(dirPath, "SKILL.md");
				if (!existsSync(skillMd)) continue;

				const existing = seen.get(entry.name);
				if (existing) {
					console.warn(
						`[openclaw] skipping duplicate skill "${entry.name}" at ${dirPath} ` +
							`(already collected from ${existing}). Set OPENCLAW_AGENT_ID to project explicitly.`,
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

	private getSkillPath(key: string): string {
		return join(skillsDir(), key, "SKILL.md");
	}

	private getSkillsRootDir(): string {
		return skillsDir();
	}

	private getSharedSkillPath(skillKey: string, ownerHandle: string): string {
		return join(skillsDir(), `${skillKey}__${ownerHandle}`);
	}

	private async listSkillKeys(): Promise<string[]> {
		// Restricted to the CURRENT agent's `skillsDir()` —
		// `collectSkills` walks every agent dir for `clawdi push`
		// (one-shot, batch view), but the daemon's hot path is
		// strictly single-agent: it hashes/tars
		// `join(getSkillsRootDir(), key)` where rootDir is JUST
		// the current agent. Returning skills from sibling agent
		// dirs would point the daemon at paths it can't resolve,
		// silently dropping those skills. Pre-fix the cross-agent
		// enumerator silently lost OpenClaw skills under any
		// agent other than the active one.
		const root = skillsDir();
		migrateLegacyLocalSetupSkill({
			targetDir: join(root, "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
		if (!existsSync(root)) return [];
		const out: string[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			if (shouldIgnoreUserSkill(join(root, entry.name), entry.name)) continue;
			const skillMd = join(root, entry.name, "SKILL.md");
			if (!existsSync(skillMd)) continue;
			out.push(entry.name);
		}
		return out;
	}

	private getSessionsWatchPaths(): string[] {
		const paths = listAgentDirs().flatMap((dir) => {
			const sessionRoot = join(dir, "sessions");
			const database = join(dir, "agent", "openclaw-agent.sqlite");
			return [
				...(existsSync(sessionRoot) ? [sessionRoot] : []),
				...(existsSync(database) ? [database, `${database}-wal`, `${database}-journal`] : []),
			];
		});
		return paths.length > 0 ? paths : [sessionsDir()];
	}

	private async removeLocalSkill(key: string): Promise<void> {
		const dir = join(skillsDir(), key);
		mutateUserSkillTarget(dir, key, () => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
	}

	private async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		await this.installOfficialSkillArchive(key, key, tarGzBytes);
	}

	private async installOfficialSkillArchive(
		archiveKey: string,
		installedSlug: string,
		tarGzBytes: Buffer,
	): Promise<void> {
		const workspace = activeAgentWorkspace();
		const targetDir = join(workspace, "skills", installedSlug);
		const stagingRoot = mkdtempSync(join(tmpdir(), "clawdi-openclaw-install-"));
		try {
			await extractTarGz(stagingRoot, tarGzBytes);
			const sourceDir = join(stagingRoot, archiveKey);
			if (!existsSync(join(sourceDir, "SKILL.md")))
				throw new Error("Skill archive is missing SKILL.md");
			mutateUserSkillTarget(targetDir, installedSlug, () =>
				withManagedTargetRollback({
					target: targetDir,
					operation: () => {
						const result = spawnSync(
							"openclaw",
							[
								"skills",
								"install",
								sourceDir,
								"--agent",
								agentId(),
								"--as",
								installedSlug,
								"--force",
							],
							{
								encoding: "utf8",
								env: process.env,
								maxBuffer: 1024 * 1024,
								timeout: 120_000,
							},
						);
						if (result.status !== 0) {
							throw new Error(
								`OpenClaw official Skill install failed: ${(result.stderr || result.stdout).trim() || "unknown error"}`,
							);
						}
						if (activeAgentWorkspace() !== workspace) {
							throw new Error("OpenClaw agent workspace changed during Skill install");
						}
						const sourceTree = collectManagedSkillTree(sourceDir);
						const installedTree = collectManagedSkillTree(targetDir, {
							exclude: new Set([".openclaw/source-origin.json"]),
						});
						if (sourceTree.status !== "collected") {
							throw new Error(`OpenClaw Skill source tree is ${sourceTree.status}`);
						}
						if (installedTree.status !== "collected") {
							throw new Error(`OpenClaw installed Skill tree is ${installedTree.status}`);
						}
						if (!managedSkillTreesEqual(sourceTree.tree, installedTree.tree)) {
							throw new Error(`OpenClaw installed an unexpected Skill tree in ${workspace}`);
						}
					},
				}),
			);
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	private async writeSharedSkillArchive(
		key: string,
		ownerHandle: string,
		tarGzBytes: Buffer,
	): Promise<void> {
		await this.installOfficialSkillArchive(key, `${key}__${ownerHandle}`, tarGzBytes);
	}
}
