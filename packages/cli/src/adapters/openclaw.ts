import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import zlib from "node:zlib";
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
import { type SessionEventDraft, sequenceSessionEvents } from "../lib/session-events";
import { extractTarGz } from "../lib/tar";
import { commandFailureDetail } from "../runtime/hosted-openclaw-skill";
import {
	collectManagedSkillTree,
	makeSkillStagingReadable,
	managedSkillTreesEqual,
	withManagedTargetRollback,
} from "../runtime/managed-skill-delivery";
import { mutateUserSkillTarget } from "../runtime/managed-skill-reservation";
import { spawnRuntimeUserCommand } from "../runtime/runtime-user-command";
import { log } from "../serve/log";
import {
	type AgentAdapterCore,
	collectFromScan,
	type RawSession,
	type RawSkill,
	type SessionBatchScan,
	type SessionEvent,
	type SessionModule,
	type SessionScanBatch,
	type SessionScanIssue,
	type SessionScanRequest,
	type SessionUserActivity,
	type SkillModule,
	type SyncReadContext,
} from "./base";
import {
	inheritedOpenClawEnvironment,
	OpenClawSdkExitError,
	resolveOpenClawCommandPath,
	runOpenClawCommand,
	runOpenClawSdkCommand,
} from "./openclaw-command";
import {
	openClawAgentId,
	resolveOpenClawAgentWorkspace,
	resolveOpenClawAgentWorkspaceAsync,
} from "./openclaw-workspace";
import { getOpenClawHome, isPathWithinRoots, matchesProjectFilter } from "./paths";
import { isOpenClawBookkeepingMessage, piMessageDrafts } from "./pi-message-drafts";
import {
	type JsonObject,
	jsonObject,
	jsonString,
	SESSION_PROJECTION_REVISION,
	stableRecordId,
} from "./rich-event-mapping";
import { byteBoundedSessionBatches } from "./session-batches";
import { jsonlPathsWithin } from "./session-files";
import {
	addSessionModel,
	describeSessionContent,
	JsonlSessionSource,
	readBoundedJsonFile,
	SESSION_RECORD_MAX_BYTES,
} from "./session-source";
import { collectSkillsFromDir, enumerateSkillDirs, flatSkillModule } from "./skill-dir";
import { openSessionIndex } from "./sqlite";
import { readCommandVersion } from "./version";

function agentsRoot(home: string) {
	return join(home, "agents");
}
function agentId() {
	return openClawAgentId();
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

function listAgentDirsWithCompleteness(
	home: string,
	selectedAgentId?: string,
): AgentDirectoryListing {
	const root = agentsRoot(home);
	if (!existsSync(root)) return { dirs: [], complete: true };
	const override = selectedAgentId;
	try {
		const dirs = readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith("."))
			.filter((d) => !override || d.name === override)
			.map((d) => join(root, d.name));
		return { dirs, complete: true };
	} catch {
		// `agents/` is present but unreadable (perm bits, encrypted-at-rest,
		// stale fuse mount, …). Silently treating that as "no agents" hides
		// the fact that we actively skipped data. The scan reports the reason
		// through its deduplicated activity warning.
		return { dirs: [], complete: false };
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

function parseSessionEntry(value: unknown): SessionEntry {
	const row = jsonObject(value);
	if (!row) throw new Error("invalid OpenClaw session inventory entry");
	const number = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const string = (value: unknown): string | undefined => jsonString(value) ?? undefined;
	const acp = jsonObject(row.acp);
	return {
		sessionId: string(row.sessionId),
		updatedAt: number(row.updatedAt),
		sessionFile: string(row.sessionFile),
		transcriptPath: string(row.transcriptPath),
		path: string(row.path),
		model: string(row.model),
		modelProvider: string(row.modelProvider),
		inputTokens: number(row.inputTokens),
		outputTokens: number(row.outputTokens),
		totalTokens: number(row.totalTokens),
		cacheRead: number(row.cacheRead),
		cacheWrite: number(row.cacheWrite),
		displayName: string(row.displayName),
		subject: string(row.subject),
		label: string(row.label),
		...(acp ? { acp: { cwd: string(acp.cwd), lastActivityAt: number(acp.lastActivityAt) } } : {}),
	};
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

type ActivityIncompleteReason =
	| "agent_directory_unreadable"
	| "session_directory_unreadable"
	| "transcript_reference_invalid"
	| "session_index_unreadable"
	| "transcript_missing"
	| "agent_directory_missing"
	| "transcript_zstd_unavailable"
	| "transcript_zstd_unverified_runtime"
	| "transcript_zstd_read_failed"
	| "transcript_read_failed"
	| "transcript_record_invalid"
	| "transcript_record_too_large"
	| "transcript_changed"
	| "user_timestamp_invalid"
	| "official_inventory_invalid"
	| "session_updated_at_invalid"
	| "official_transcript_unavailable";

type ActivityIncompleteReasons = Map<ActivityIncompleteReason, number>;

function recordActivityReason(
	reasons: ActivityIncompleteReasons | undefined,
	reason: ActivityIncompleteReason,
): void {
	reasons?.set(reason, (reasons.get(reason) ?? 0) + 1);
}

function mergeActivityReasons(
	target: ActivityIncompleteReasons,
	source: ActivityIncompleteReasons,
): void {
	for (const [reason, count] of source) target.set(reason, (target.get(reason) ?? 0) + count);
}

function markActivityIncomplete(
	activity: SessionUserActivity,
	reasons: ActivityIncompleteReasons | undefined,
	reason: ActivityIncompleteReason,
): void {
	activity.complete = false;
	activity.recentUserInputCount = null;
	recordActivityReason(reasons, reason);
}

function classifyUserActivity(
	records: readonly unknown[],
	sessionKey: string,
	metadata: unknown,
	observedAt: number,
	reasons?: ActivityIncompleteReasons,
): SessionUserActivity {
	const activity = computeOpenClawRealUserActivity(records, sessionKey, metadata, observedAt);
	if (!activity.complete) recordActivityReason(reasons, "user_timestamp_invalid");
	return activity;
}

async function checkActivitySource(
	activity: SessionUserActivity,
	source: JsonlSessionSource,
	reasons?: ActivityIncompleteReasons,
): Promise<void> {
	if (!source.complete) {
		markActivityIncomplete(
			activity,
			reasons,
			source.blockedReason ? "transcript_record_too_large" : "transcript_record_invalid",
		);
	} else if (activity.complete && !(await source.unchanged())) {
		markActivityIncomplete(activity, reasons, "transcript_changed");
	}
}

// Runtime-watch can recreate adapters every reconcile; keep warning state across instances.
const activityReasonSets = new Map<string, string>();

function warnActivityIncompleteOnChange(key: string, reasons: ActivityIncompleteReasons): void {
	const entries = [...reasons].sort(([left], [right]) => left.localeCompare(right));
	const signature = entries.map(([reason]) => reason).join(",");
	if ((activityReasonSets.get(key) ?? "") === signature) return;
	if (!signature) {
		activityReasonSets.delete(key);
		return;
	}
	activityReasonSets.set(key, signature);
	log.warn("engine.user_activity_incomplete", {
		reasons: entries.map(([reason, count]) => ({ reason, count })),
	});
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

async function collectCanonicalOpenClawActivity(
	officialInventory: OfficialSessionInventory | null,
	classifiedPaths: ReadonlySet<string>,
	listing: AgentDirectoryListing,
	incompleteReasons: ActivityIncompleteReasons,
	zstdSupport: () => Promise<ZstdRuntimeSupport>,
	context?: SyncReadContext,
): Promise<SessionUserActivity> {
	let activity: SessionUserActivity = {
		lastUserInputAt: null,
		recentUserInputCount: listing.complete ? 0 : null,
		complete: listing.complete,
	};
	if (!listing.complete) recordActivityReason(incompleteReasons, "agent_directory_unreadable");
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
			markActivityIncomplete(activity, incompleteReasons, "session_directory_unreadable");
			continue;
		}
		const presentReferences = new Set(transcripts.flatMap((transcript) => transcript.references));
		const references = new Map<string, TranscriptReference>();
		const addReference = (identity: string, entry: SessionEntry, required: boolean): void => {
			const name = transcriptReferenceName(sessionsRoot, identity, entry);
			if (!name) {
				markActivityIncomplete(activity, incompleteReasons, "transcript_reference_invalid");
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
				const parsed = await readBoundedJsonFile(indexPath, context);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
				for (const [key, value] of Object.entries(parsed)) {
					if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
					const entry = parseSessionEntry(value);
					if (!entry.sessionFile && !entry.sessionId && !entry.transcriptPath && !entry.path)
						continue;
					addReference(key, entry, officialInventory === null);
				}
			} catch {
				markActivityIncomplete(activity, incompleteReasons, "session_index_unreadable");
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
			activity = mergeUserActivity(
				activity,
				await readOpenClawTranscriptActivity(
					transcript.path,
					incompleteReasons,
					zstdSupport,
					context,
				),
			);
		}
		for (const [name, reference] of references) {
			if (
				reference.requiredExternal &&
				!presentReferences.has(name) &&
				!classifiedPaths.has(resolve(sessionsRoot, name))
			) {
				markActivityIncomplete(activity, incompleteReasons, "transcript_missing");
			}
		}
	}
	for (const entry of officialInventory?.entries ?? []) {
		if (
			entry.sessionFile &&
			!visitedAgentIds.has(entry.agentId) &&
			!isInternalOpenClawSession(entry.key, entry)
		) {
			markActivityIncomplete(activity, incompleteReasons, "agent_directory_missing");
		}
	}
	return activity;
}

async function* decodeOpenClawZstd(
	chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
	signal?: AbortSignal,
): AsyncGenerator<Buffer> {
	const decoder = zlib.createZstdDecompress({
		chunkSize: 64 * 1024,
		params: { [zlib.constants.ZSTD_d_windowLogMax]: 23 },
	});
	const input = Readable.from(chunks, { objectMode: false, highWaterMark: 64 * 1024 });
	const completed = pipeline(input, decoder, { signal });
	// The iterator observes stream errors; handle the promise while it is being consumed.
	void completed.catch(() => {});
	try {
		for await (const bytes of decoder) {
			if (!Buffer.isBuffer(bytes)) throw new Error("invalid decoded session source chunk");
			yield bytes;
		}
		await completed;
	} finally {
		input.destroy();
		decoder.destroy();
		await completed.catch(() => {});
	}
}

type ZstdRuntimeSupport = "verified" | "unavailable" | "unverified";

// zstdCompressSync(Buffer.from("clawdi zstd probe\n")), with the last byte removed for the bad frame.
const ZSTD_PROBE_FRAME = Buffer.from(
	"28b52ffd2012910000636c61776469207a7374642070726f62650a",
	"hex",
);
let zstdRuntimeSupport: Promise<ZstdRuntimeSupport> | undefined;

async function verifyZstdRuntimeSupport(): Promise<ZstdRuntimeSupport> {
	if (typeof zlib.createZstdDecompress !== "function") return "unavailable";
	const expected = Buffer.from("clawdi zstd probe\n");
	try {
		const parts: Buffer[] = [];
		let size = 0;
		for await (const bytes of decodeOpenClawZstd([ZSTD_PROBE_FRAME])) {
			size += bytes.length;
			if (size > expected.length) return "unavailable";
			parts.push(bytes);
		}
		if (!Buffer.concat(parts, size).equals(expected)) return "unavailable";
	} catch {
		return "unavailable";
	}
	try {
		for await (const _bytes of decodeOpenClawZstd([ZSTD_PROBE_FRAME.subarray(0, -1)])) {
		}
	} catch {
		return "verified";
	}
	return "unverified";
}

function readZstdRuntimeSupport(): Promise<ZstdRuntimeSupport> {
	zstdRuntimeSupport ??= verifyZstdRuntimeSupport();
	return zstdRuntimeSupport;
}

async function readOpenClawTranscriptActivity(
	path: string,
	incompleteReasons: ActivityIncompleteReasons,
	zstdSupport: () => Promise<ZstdRuntimeSupport>,
	context?: SyncReadContext,
): Promise<SessionUserActivity> {
	const compressed = path.endsWith(".zst");
	if (compressed) {
		const support = await zstdSupport();
		context?.signal.throwIfAborted();
		if (support !== "verified") {
			recordActivityReason(
				incompleteReasons,
				support === "unavailable"
					? "transcript_zstd_unavailable"
					: "transcript_zstd_unverified_runtime",
			);
			return { lastUserInputAt: null, recentUserInputCount: null, complete: false };
		}
	}
	try {
		const source = await JsonlSessionSource.open(path, context);
		const observedAt = context?.userActivityObservedAt ?? Date.now();
		let activity: SessionUserActivity = {
			lastUserInputAt: null,
			recentUserInputCount: 0,
			complete: true,
		};
		for await (const record of source.records(compressed ? decodeOpenClawZstd : undefined))
			activity = mergeUserActivity(
				activity,
				classifyUserActivity([record.data], "", undefined, observedAt, incompleteReasons),
			);
		await checkActivitySource(activity, source, incompleteReasons);
		return activity;
	} catch {
		context?.signal.throwIfAborted();
		recordActivityReason(
			incompleteReasons,
			compressed ? "transcript_zstd_read_failed" : "transcript_read_failed",
		);
		return { lastUserInputAt: null, recentUserInputCount: null, complete: false };
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
		recentUserInputCount:
			left.recentUserInputCount === null || right.recentUserInputCount === null
				? null
				: left.recentUserInputCount + right.recentUserInputCount,
		complete: left.complete && right.complete,
	};
}

const OPENCLAW_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const warnedMissingOpenClawSdk = new Set<string>();

function warnMissingOpenClawSdkOnce(
	versionKey: string,
	details?: { exit_code?: number | null; signal?: NodeJS.Signals | null },
): void {
	if (warnedMissingOpenClawSdk.has(versionKey)) return;
	warnedMissingOpenClawSdk.add(versionKey);
	log.warn("openclaw.transcript_sdk_fallback", {
		failure: "missing_export",
		...(details ?? {}),
		fallback: "gateway",
	});
}

async function runOpenClawJson(
	args: string[],
	_home: string,
	context?: SyncReadContext,
): Promise<JsonObject | null> {
	try {
		const stdout = await runOpenClawCommand(args, {
			signal: context?.signal,
			maxBuffer: OPENCLAW_COMMAND_MAX_BUFFER_BYTES,
			timeout: 120_000,
		});
		return jsonObject(JSON.parse(stdout)) ?? null;
	} catch {
		context?.signal.throwIfAborted();
		return null;
	}
}

async function readOfficialSessionInventory(
	home: string,
	context?: SyncReadContext,
	profileAgentId?: string,
	incompleteReasons?: ActivityIncompleteReasons,
): Promise<OfficialSessionInventory | null> {
	const override = profileAgentId;
	const payload = await runOpenClawJson(
		[
			"sessions",
			"--json",
			...(override ? ["--agent", override] : ["--all-agents"]),
			"--limit",
			"all",
		],
		home,
		context,
	);
	if (!payload || !Array.isArray(payload.sessions)) return null;

	let complete = true;
	const entries = payload.sessions.flatMap((value): OfficialSessionEntry[] => {
		const row = jsonObject(value);
		const agentId = jsonString(row?.agentId);
		const key = jsonString(row?.key);
		if (!row || !agentId || !key) {
			complete = false;
			recordActivityReason(incompleteReasons, "official_inventory_invalid");
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
	_home: string,
	context?: SyncReadContext,
): Promise<JsonObject[] | null> {
	if (!entry.sessionId) return null;
	const sdkPath = resolveOpenClawSdkExport(
		process.env.HOME ?? homedir(),
		[],
		OPENCLAW_SDK_EXPORT_PATHS.sessionTranscript,
	);
	if (!sdkPath) {
		warnMissingOpenClawSdkOnce("unresolved");
		return null;
	}
	try {
		context?.signal.throwIfAborted();
		const result: unknown = JSON.parse(
			await runOpenClawSdkCommand(
				sdkPath,
				{
					agentId: entry.agentId,
					sessionId: entry.sessionId,
					sessionKey: entry.key,
				},
				{
					signal: context?.signal,
					maxBuffer: OPENCLAW_COMMAND_MAX_BUFFER_BYTES,
					timeout: 120_000,
				},
			),
		);
		context?.signal.throwIfAborted();
		if (!Array.isArray(result))
			throw new SyntaxError("OpenClaw transcript SDK result is not an array");
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
	} catch (error) {
		context?.signal.throwIfAborted();
		const missingExport = error instanceof OpenClawSdkExitError && error.code === 2;
		if (missingExport) {
			warnMissingOpenClawSdkOnce(sdkPath, { exit_code: error.code, signal: error.signal });
		} else {
			log.warn("openclaw.transcript_sdk_fallback", {
				failure:
					error instanceof OpenClawSdkExitError
						? "exit_code"
						: error instanceof SyntaxError
							? "parse_failure"
							: "subprocess_failure",
				...(error instanceof OpenClawSdkExitError
					? { exit_code: error.code, signal: error.signal }
					: {}),
				fallback: "gateway",
			});
		}
		return null;
	}
}

interface OfficialReadState {
	available: boolean;
	userActivity: SessionUserActivity;
	modelsUsed: Set<string>;
	model: string | null;
	startedAt: Date | null;
	endedAt: Date | null;
}

async function* readOfficialSessionMessagesFromGateway(
	entry: OfficialSessionEntry,
	state: OfficialReadState,
	home: string,
	context?: SyncReadContext,
): AsyncGenerator<JsonObject> {
	const index = await openSessionIndex();
	try {
		index.exec(
			"CREATE TABLE messages (page INTEGER, position INTEGER, value TEXT, PRIMARY KEY (page, position)) WITHOUT ROWID",
		);
		const insert = index.prepare("INSERT INTO messages VALUES (?, ?, ?)");
		let offset = 0;
		for (let page = 0; page < 10_000; page++) {
			context?.signal.throwIfAborted();
			const payload = await runOpenClawJson(
				[
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
				],
				home,
				context,
			);
			if (!payload || !Array.isArray(payload.messages)) return;
			index.exec("BEGIN");
			let position = 0;
			for (const value of payload.messages) {
				const message = jsonObject(value);
				if (!message) continue;
				const encoded = JSON.stringify(message);
				if (Buffer.byteLength(encoded) > SESSION_RECORD_MAX_BYTES)
					throw new Error("OpenClaw gateway record exceeds supported source size");
				insert.run(page, position++, encoded);
			}
			index.exec("COMMIT");
			if (payload.hasMore !== true) {
				state.available = true;
				for (const value of index
					.prepare("SELECT value FROM messages ORDER BY page DESC, position ASC")
					.iterate()) {
					context?.signal.throwIfAborted();
					const row = value as { value: string };
					const message = jsonObject(JSON.parse(row.value));
					if (message) yield message;
				}
				return;
			}
			if (
				!position ||
				!Number.isSafeInteger(payload.nextOffset) ||
				typeof payload.nextOffset !== "number" ||
				payload.nextOffset <= offset
			)
				return;
			offset = payload.nextOffset;
		}
		throw new Error("OpenClaw history pagination exceeded supported page count");
	} finally {
		index.close();
	}
}

function officialReadState(entry: OfficialSessionEntry): OfficialReadState {
	const modelsUsed = new Set<string>();
	if (entry.model) addSessionModel(modelsUsed, entry.model);
	return {
		available: false,
		userActivity: { lastUserInputAt: null, recentUserInputCount: 0, complete: true },
		modelsUsed,
		model: entry.model ?? null,
		startedAt: null,
		endedAt: null,
	};
}

function officialTranscriptReader(
	entry: OfficialSessionEntry,
	home: string,
	context?: SyncReadContext,
	incompleteReasons?: ActivityIncompleteReasons,
) {
	const initial = officialReadState(entry);
	const observedAt = context?.userActivityObservedAt ?? Date.now();
	let pinnedCount: number | undefined;
	let pinnedHash: string | undefined;
	const readEvents = async function* (): AsyncGenerator<SessionEvent> {
		const state = officialReadState(entry);
		const sdk = await readOfficialSessionMessagesFromSdk(entry, home, context);
		const transcript =
			sdk === null ? readOfficialSessionMessagesFromGateway(entry, state, home, context) : sdk;
		if (sdk !== null) state.available = true;
		const digest = createHash("sha256");
		let count = 0;
		let seq = 0;
		for await (const message of transcript) {
			context?.signal.throwIfAborted();
			if (pinnedCount !== undefined && count >= pinnedCount) continue;
			const encoded = JSON.stringify(message);
			if (Buffer.byteLength(encoded) > SESSION_RECORD_MAX_BYTES)
				throw new Error("OpenClaw transcript record exceeds supported source size");
			digest.update(encoded).update("\n");
			state.userActivity = mergeUserActivity(
				state.userActivity,
				classifyUserActivity([message], entry.key, entry, observedAt, incompleteReasons),
			);
			const timestamp = jsonString(message.timestamp) ?? jsonString(message.createdAt);
			const raw = {
				type: "message",
				...(jsonString(message.id) ? { id: jsonString(message.id) } : {}),
				...(timestamp ? { timestamp } : {}),
				message,
			};
			const events = sequenceSessionEvents(
				openClawEventDrafts(raw, `${entry.agentId}:${entry.sessionId}`, count++, state.model),
				seq,
			);
			seq += events.length;
			yield* events;
			const model = jsonString(message.model);
			if (model && !isOpenClawBookkeepingMessage(message)) {
				addSessionModel(state.modelsUsed, model);
				state.model = model;
			}
			if (timestamp) {
				const at = new Date(timestamp);
				if (!Number.isNaN(at.getTime())) {
					state.startedAt ??= at;
					state.endedAt = at;
				}
			}
		}
		const hash = digest.digest("hex");
		if (
			pinnedCount !== undefined &&
			(!state.available || count !== pinnedCount || hash !== pinnedHash)
		)
			throw new Error("OpenClaw official transcript changed during sync; retry with a fresh scan");
		if (pinnedCount === undefined && state.available) {
			pinnedCount = count;
			pinnedHash = hash;
			Object.assign(initial, state);
		}
	};
	return { readEvents, initial };
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
	const drafts = piMessageDrafts(message, {
		source: eventSource,
		recordId,
		timestamp,
		model: currentModel,
	});
	return message.display === false
		? drafts.map((draft) => ({
				...draft,
				semantics: { lifecycle: "active", display: "hidden", compressed_summary: false },
			}))
		: drafts;
}

interface SessionCollection {
	observedLocalSessionIds: string[];
	dedupedCount: number;
	matchedTranscriptPaths: Set<string>;
	classifiedTranscriptPaths: Set<string>;
	userActivity: SessionUserActivity;
	incompleteReasons: ActivityIncompleteReasons;
	scanIssues: SessionScanIssue[];
}

function emptySessionCollection(
	complete = true,
	incompleteReasons: ActivityIncompleteReasons = new Map(),
): SessionCollection {
	if (!complete && !incompleteReasons.has("official_inventory_invalid"))
		recordActivityReason(incompleteReasons, "official_inventory_invalid");
	return {
		observedLocalSessionIds: [],
		dedupedCount: 0,
		matchedTranscriptPaths: new Set(),
		classifiedTranscriptPaths: new Set(),
		userActivity: { lastUserInputAt: null, recentUserInputCount: complete ? 0 : null, complete },
		incompleteReasons,
		scanIssues: [],
	};
}

function takeSessionBatch(
	collection: SessionCollection,
	session?: RawSession | null,
): SessionScanBatch {
	const batch = {
		sessions: session ? [session] : [],
		observedLocalSessionIds: collection.observedLocalSessionIds,
		dedupedCount: collection.dedupedCount,
		scanIssues: collection.scanIssues,
	};
	collection.observedLocalSessionIds = [];
	collection.scanIssues = [];
	return batch;
}

interface MaterializedOpenClawSession {
	session: RawSession | null;
	userActivity: SessionUserActivity;
	incompleteReasons: ActivityIncompleteReasons;
	scanIssue?: SessionScanIssue;
}

async function materializeOpenClawJsonlSession(input: {
	entry: SessionEntry;
	indexPath: string;
	projectPath: string | null;
	sourceAgentId: string;
	sourceSessionKey: string;
	sourceRevision: string;
	transcriptPath: string;
	context?: SyncReadContext;
}): Promise<MaterializedOpenClawSession> {
	const {
		entry,
		projectPath,
		sourceAgentId,
		sourceSessionKey,
		sourceRevision,
		transcriptPath,
		context,
	} = input;
	const incompleteReasons: ActivityIncompleteReasons = new Map();
	const sessionId = entry.sessionId;
	const updatedAt = entry.updatedAt ?? entry.acp?.lastActivityAt;
	const internalSession = isInternalOpenClawSession(sourceSessionKey, entry);
	const unavailableActivity = {
		lastUserInputAt: null,
		recentUserInputCount: internalSession ? 0 : null,
		complete: internalSession,
	};
	if (!sessionId || !updatedAt || !existsSync(transcriptPath)) {
		if (!internalSession) recordActivityReason(incompleteReasons, "transcript_missing");
		return { session: null, userActivity: unavailableActivity, incompleteReasons };
	}
	const source = await JsonlSessionSource.open(transcriptPath, context);
	let startedAt: Date | null = null;
	let endedAt: Date | null = null;
	const modelsUsed = new Set<string>();
	if (entry.model) addSessionModel(modelsUsed, entry.model);
	let currentModel = entry.model ?? null;
	const observedAt = context?.userActivityObservedAt ?? Date.now();
	let userActivity: SessionUserActivity = {
		lastUserInputAt: null,
		recentUserInputCount: 0,
		complete: true,
	};
	for await (const { data: raw } of source.records()) {
		userActivity = mergeUserActivity(
			userActivity,
			classifyUserActivity([raw], sourceSessionKey, entry, observedAt, incompleteReasons),
		);
		const parsed = raw as TranscriptLine;
		const timestamp = parsed.timestamp ? new Date(parsed.timestamp) : null;
		if (timestamp && !Number.isNaN(timestamp.getTime())) {
			startedAt ??= timestamp;
			endedAt = timestamp;
		}
		if (parsed.type === "model_change" && parsed.modelId) {
			addSessionModel(modelsUsed, parsed.modelId);
			currentModel = parsed.modelId;
		}
	}
	if (!internalSession) await checkActivitySource(userActivity, source, incompleteReasons);
	if (source.blockedReason) {
		return {
			session: null,
			userActivity,
			incompleteReasons,
			scanIssue: { path: source.path, reason: source.blockedReason },
		};
	}
	const readEvents = async function* () {
		let model = entry.model ?? null;
		let seq = 0;
		for await (const { data: raw, recordSeq } of source.records()) {
			const events = sequenceSessionEvents(
				openClawEventDrafts(raw, `${sourceAgentId}:${sessionId}`, recordSeq, model),
				seq,
			);
			seq += events.length;
			yield* events;
			const parsed = raw as TranscriptLine;
			if (parsed.type === "model_change" && parsed.modelId) model = parsed.modelId;
		}
	};
	const description = await describeSessionContent(readEvents, source.eager);
	if (description.messageCount === 0) return { session: null, userActivity, incompleteReasons };
	startedAt ??= new Date(updatedAt);
	endedAt ??= new Date(updatedAt);
	return {
		userActivity,
		incompleteReasons,
		session: {
			localSessionId: sessionId,
			projectPath,
			startedAt,
			endedAt,
			messageCount: description.messageCount,
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
				(description.firstUser ? safeTruncate(description.firstUser.content, 200) : null),
			...description.content,
			rawFilePath: transcriptPath,
			sourceRevision,
			realUserInputAt: userActivity.lastUserInputAt,
		},
	};
}

export class OpenClawAdapter implements AgentAdapterCore {
	private readonly profileAgentId: string | undefined;
	constructor(
		profileAgentId?: string | null,
		private readonly home = getOpenClawHome(),
		private readonly inventoryReader?: (
			context?: SyncReadContext,
		) => Promise<OfficialSessionInventory | null>,
		private readonly zstdSupport = readZstdRuntimeSupport,
	) {
		this.profileAgentId =
			profileAgentId === null
				? undefined
				: (profileAgentId ?? process.env.OPENCLAW_AGENT_ID?.trim());
	}
	private profileAgentDirectoryListing(): AgentDirectoryListing {
		return listAgentDirsWithCompleteness(this.home, this.profileAgentId);
	}
	private profileAgentDirs(): string[] {
		return this.profileAgentDirectoryListing().dirs;
	}
	readonly agentType = "openclaw" as const;
	readonly sessions = {
		contentProtocol: async (context?: SyncReadContext) => {
			context?.signal.throwIfAborted();
			return "events-v1" as const;
		},
		collect: collectFromScan((request, revisions, context) =>
			this.scanSessions(request, revisions, context),
		),
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
			write: {
				writeArchive: (key, bytes) => this.installOfficialSkillArchive(key, key, bytes),
				writeSharedArchive: (key, owner, bytes) =>
					this.installOfficialSkillArchive(key, `${key}__${owner}`, bytes),
			},
		}),
		forOperation: (context?: SyncReadContext) => this.skillsForOperation(context),
		collect: (context?: SyncReadContext) => this.collectSkills(context),
		listKeys: async (context?: SyncReadContext) => {
			context?.signal.throwIfAborted();
			// Collection and reconciliation use the same default agent workspace.
			const root = join(
				await resolveOpenClawAgentWorkspaceAsync(
					agentId(),
					context?.signal,
					context?.skillPollCycle,
				),
				"skills",
			);
			return enumerateSkillDirs(root).map(({ key }) => key);
		},
	};

	async detect(): Promise<boolean> {
		// OpenClaw creates `agents/{id}/` per agent. Detection succeeds when
		// the state root has at least one agent dir, or the configured agent's
		// session index exists. Accepting any agent dir is what makes deployments
		// like `/data/openclaw/agents/{main,financial,sales,...}` work without
		// the user setting `OPENCLAW_AGENT_ID` per agent (issue #28).
		if (!existsSync(this.home)) return false;
		return this.profileAgentDirs().length > 0;
	}

	async getVersion(): Promise<string | null> {
		try {
			return readCommandVersion(resolveOpenClawCommandPath(), ["--version"]);
		} catch {
			return null;
		}
	}

	private async scanSessions(
		request: SessionScanRequest,
		knownSourceRevisions: ReadonlyMap<string, string>,
		context?: SyncReadContext,
	): Promise<SessionBatchScan> {
		context = {
			...context,
			signal: context?.signal ?? new AbortController().signal,
			userActivityObservedAt: context?.userActivityObservedAt ?? Date.now(),
		};
		const materializeCanonicalActivity =
			request.kind === "complete" &&
			(context.materializeUserActivity || knownSourceRevisions.size === 0);
		const incompleteReasons: ActivityIncompleteReasons = new Map();
		const sharedInventory = this.inventoryReader
			? await this.inventoryReader(context)
			: await readOfficialSessionInventory(
					this.home,
					context,
					this.profileAgentId,
					incompleteReasons,
				);
		const inventory =
			sharedInventory && this.profileAgentId
				? {
						...sharedInventory,
						entries: sharedInventory.entries.filter(
							(entry) => entry.agentId === this.profileAgentId,
						),
					}
				: sharedInventory;
		let coverage: SessionBatchScan["coverage"] = request.kind === "paths" ? "partial" : "complete";
		let transcriptPaths: ReadonlySet<string> | undefined;
		if (!inventory && request.kind === "paths") {
			const paths = jsonlPathsWithin(
				request,
				this.profileAgentDirs().map((dir) => resolve(dir, "sessions")),
			);
			if (paths) {
				const preflight = emptySessionCollection();
				transcriptPaths = new Set(paths);
				// Resolve ambiguous path notifications using inventory metadata only,
				// before any session content is materialized or yielded.
				for await (const _batch of this.collectLegacySessionsMatching(
					request,
					preflight,
					transcriptPaths,
					undefined,
					knownSourceRevisions,
					context,
					true,
				)) {
				}
				if (paths.some((path) => existsSync(path) && !preflight.matchedTranscriptPaths.has(path))) {
					transcriptPaths = undefined;
					coverage = "complete";
				}
			} else coverage = "complete";
		}
		const collection = emptySessionCollection(inventory?.complete ?? true, incompleteReasons);
		const source = inventory
			? this.collectOfficialSessionsMatching(
					inventory,
					request,
					collection,
					undefined,
					knownSourceRevisions,
					context,
					materializeCanonicalActivity,
				)
			: this.collectLegacySessionsMatching(
					request,
					collection,
					transcriptPaths,
					undefined,
					knownSourceRevisions,
					context,
				);
		const adapter = this;
		return {
			coverage,
			userActivity: collection.userActivity,
			batches: (async function* () {
				yield* byteBoundedSessionBatches(source);
				if (coverage === "complete" && materializeCanonicalActivity) {
					Object.assign(
						collection.userActivity,
						mergeUserActivity(
							collection.userActivity,
							await collectCanonicalOpenClawActivity(
								inventory,
								collection.classifiedTranscriptPaths,
								adapter.profileAgentDirectoryListing(),
								incompleteReasons,
								adapter.zstdSupport,
								context,
							),
						),
					);
				}
				if (!materializeCanonicalActivity || request.projectFilter)
					collection.userActivity.recentUserInputCount = null;
				// Successful partial/incremental reads cannot clear a failed canonical baseline.
				if (incompleteReasons.size > 0 || materializeCanonicalActivity) {
					warnActivityIncompleteOnChange(
						JSON.stringify([resolve(adapter.home), adapter.profileAgentId ?? null]),
						incompleteReasons,
					);
				}
			})(),
		};
	}

	private async resolveSession(
		localSessionId: string,
		context?: SyncReadContext,
	): Promise<RawSession | null> {
		context?.signal.throwIfAborted();
		const inventory = this.inventoryReader
			? await this.inventoryReader(context)
			: await readOfficialSessionInventory(this.home, context, this.profileAgentId);
		const collection = emptySessionCollection(inventory?.complete ?? true);
		const batches = inventory
			? this.collectOfficialSessionsMatching(
					inventory,
					{},
					collection,
					localSessionId,
					new Map(),
					context,
				)
			: this.collectLegacySessionsMatching(
					{},
					collection,
					undefined,
					localSessionId,
					new Map(),
					context,
				);
		for await (const batch of batches) {
			if (batch.sessions[0]) return batch.sessions[0];
		}
		return null;
	}

	private async *collectLegacySessionsMatching(
		opts: { projectFilter?: string },
		collection: SessionCollection,
		transcriptPaths?: ReadonlySet<string>,
		localSessionId?: string,
		knownSourceRevisions: ReadonlyMap<string, string> = new Map(),
		context?: SyncReadContext,
		metadataOnly = false,
	): AsyncGenerator<SessionScanBatch> {
		context?.signal.throwIfAborted();
		const agentDirectoryListing = this.profileAgentDirectoryListing();
		const agentDirs = agentDirectoryListing.dirs;
		if (!agentDirectoryListing.complete)
			markActivityIncomplete(
				collection.userActivity,
				collection.incompleteReasons,
				"agent_directory_unreadable",
			);
		if (agentDirs.length === 0) return;

		const { projectFilter } = opts;
		const absFilter = projectFilter ? resolve(projectFilter) : null;

		const { matchedTranscriptPaths, classifiedTranscriptPaths, userActivity } = collection;

		for (const agentRoot of agentDirs) {
			const sourceAgentId = basename(agentRoot);
			const sessionsDirForAgent = join(agentRoot, "sessions");
			const indexPath = join(sessionsDirForAgent, "sessions.json");
			if (!existsSync(indexPath)) continue;

			let index: JsonObject;
			try {
				const parsed = jsonObject(await readBoundedJsonFile(indexPath, context));
				if (!parsed) throw new Error("invalid OpenClaw session inventory");
				index = parsed;
			} catch {
				context?.signal.throwIfAborted();
				markActivityIncomplete(
					userActivity,
					collection.incompleteReasons,
					"session_index_unreadable",
				);
				continue;
			}

			for (const [indexKey, value] of Object.entries(index)) {
				const entry = parseSessionEntry(value);
				// Prefer the entry's own `sessionId` (real UUID); fall back to
				// the index key only for legacy fixtures that use the UUID as
				// the key directly.
				const sessionId = entry.sessionId ?? indexKey;
				if (localSessionId !== undefined && sessionId !== localSessionId) continue;
				const updatedAt = entry.updatedAt ?? entry.acp?.lastActivityAt;
				if (!updatedAt) continue;

				const projectPath = entry.acp?.cwd ?? null;
				if (!matchesProjectFilter(projectPath, absFilter)) continue;

				const transcriptPath = entry.sessionFile
					? isAbsolute(entry.sessionFile)
						? entry.sessionFile
						: join(sessionsDirForAgent, entry.sessionFile)
					: join(sessionsDirForAgent, `${sessionId}.jsonl`);
				const normalizedTranscriptPath = resolve(transcriptPath);
				if (transcriptPaths && !transcriptPaths.has(normalizedTranscriptPath)) continue;
				matchedTranscriptPaths.add(normalizedTranscriptPath);
				collection.observedLocalSessionIds.push(sessionId);
				const sourceRevision = `p${SESSION_PROJECTION_REVISION}:${sessionId}:${updatedAt}`;
				const revisionMatched = knownSourceRevisions.get(sessionId) === sourceRevision;
				if (metadataOnly || revisionMatched) {
					if (
						!metadataOnly &&
						context?.materializeUserActivity &&
						!isInternalOpenClawSession(indexKey, entry) &&
						!classifiedTranscriptPaths.has(normalizedTranscriptPath) &&
						existsSync(transcriptPath)
					) {
						classifiedTranscriptPaths.add(normalizedTranscriptPath);
						Object.assign(
							userActivity,
							mergeUserActivity(
								userActivity,
								await readOpenClawTranscriptActivity(
									transcriptPath,
									collection.incompleteReasons,
									this.zstdSupport,
									context,
								),
							),
						);
					}
					yield takeSessionBatch(collection);
					continue;
				}

				const materialized = await materializeOpenClawJsonlSession({
					entry: { ...entry, sessionId, updatedAt },
					indexPath,
					context,
					projectPath,
					sourceAgentId,
					sourceSessionKey: indexKey,
					sourceRevision,
					transcriptPath,
				});
				if (
					existsSync(transcriptPath) &&
					!classifiedTranscriptPaths.has(normalizedTranscriptPath)
				) {
					Object.assign(userActivity, mergeUserActivity(userActivity, materialized.userActivity));
					mergeActivityReasons(collection.incompleteReasons, materialized.incompleteReasons);
					if (!isInternalOpenClawSession(indexKey, entry))
						classifiedTranscriptPaths.add(normalizedTranscriptPath);
				}
				if (materialized.scanIssue) collection.scanIssues.push(materialized.scanIssue);
				yield takeSessionBatch(collection, materialized.session);
			}
		}
	}

	private async *collectOfficialSessionsMatching(
		inventory: OfficialSessionInventory,
		opts: { projectFilter?: string },
		collection: SessionCollection,
		localSessionId?: string,
		knownSourceRevisions: ReadonlyMap<string, string> = new Map(),
		context?: SyncReadContext,
		materializeActivity = false,
	): AsyncGenerator<SessionScanBatch> {
		const absFilter = opts.projectFilter ? resolve(opts.projectFilter) : null;
		const { classifiedTranscriptPaths, userActivity } = collection;

		for (const entry of inventory.entries) {
			if (this.profileAgentId && entry.agentId !== this.profileAgentId) continue;
			if (context) await setImmediate(undefined, { signal: context.signal });
			const sessionId = entry.sessionId;
			if (localSessionId !== undefined && sessionId !== localSessionId) continue;
			const internalSession = isInternalOpenClawSession(entry.key, entry);
			if (!sessionId && internalSession) continue;
			const updatedAt = entry.updatedAt;
			if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
				markActivityIncomplete(
					userActivity,
					collection.incompleteReasons,
					"session_updated_at_invalid",
				);
				continue;
			}
			const projectPath = entry.spawnedCwd ?? entry.spawnedWorkspaceDir ?? entry.acp?.cwd ?? null;
			if (!matchesProjectFilter(projectPath, absFilter)) continue;
			if (sessionId) collection.observedLocalSessionIds.push(sessionId);
			const sourceRevision = sessionId
				? `p${SESSION_PROJECTION_REVISION}:${sessionId}:${updatedAt}`
				: null;
			const revisionMatched = sessionId && knownSourceRevisions.get(sessionId) === sourceRevision;
			if (revisionMatched && (!materializeActivity || internalSession)) {
				yield takeSessionBatch(collection);
				continue;
			}

			const reader = officialTranscriptReader(
				entry,
				this.home,
				context,
				collection.incompleteReasons,
			);
			const description = await describeSessionContent(reader.readEvents, !context?.streaming);
			const transcript = reader.initial.available;
			if (!transcript && entry.sessionFile && sessionId && sourceRevision) {
				const sessionsDirForAgent = join(agentsRoot(this.home), entry.agentId, "sessions");
				const transcriptPath = isAbsolute(entry.sessionFile)
					? entry.sessionFile
					: join(sessionsDirForAgent, entry.sessionFile);
				const normalizedTranscriptPath = resolve(transcriptPath);
				const legacy = await materializeOpenClawJsonlSession({
					entry,
					indexPath: join(sessionsDirForAgent, "sessions.json"),
					context,
					projectPath,
					sourceAgentId: entry.agentId,
					sourceSessionKey: entry.key,
					sourceRevision,
					transcriptPath,
				});
				if (
					existsSync(transcriptPath) &&
					!classifiedTranscriptPaths.has(normalizedTranscriptPath)
				) {
					Object.assign(userActivity, mergeUserActivity(userActivity, legacy.userActivity));
					mergeActivityReasons(collection.incompleteReasons, legacy.incompleteReasons);
					if (!internalSession) classifiedTranscriptPaths.add(normalizedTranscriptPath);
				}
				if (legacy.scanIssue) collection.scanIssues.push(legacy.scanIssue);
				yield takeSessionBatch(collection, revisionMatched ? null : legacy.session);
				continue;
			}
			if (!transcript) {
				markActivityIncomplete(
					userActivity,
					collection.incompleteReasons,
					"official_transcript_unavailable",
				);
				continue;
			}
			const sessionUserActivity = reader.initial.userActivity;
			let alreadyClassified = false;
			if (entry.sessionFile && !internalSession) {
				const sessionsDirForAgent = join(agentsRoot(this.home), entry.agentId, "sessions");
				const transcriptPath = isAbsolute(entry.sessionFile)
					? entry.sessionFile
					: join(sessionsDirForAgent, entry.sessionFile);
				const normalizedTranscriptPath = resolve(transcriptPath);
				alreadyClassified = classifiedTranscriptPaths.has(normalizedTranscriptPath);
				classifiedTranscriptPaths.add(normalizedTranscriptPath);
			}
			if (!alreadyClassified)
				Object.assign(userActivity, mergeUserActivity(userActivity, sessionUserActivity));
			if (revisionMatched) {
				yield takeSessionBatch(collection);
				continue;
			}
			if (!sessionId || !sourceRevision) continue;

			if (description.messageCount === 0) continue;
			const startedAt = reader.initial.startedAt ?? new Date(entry.sessionStartedAt ?? updatedAt);
			const endedAt = reader.initial.endedAt ?? new Date(updatedAt);
			const storePath =
				inventory.storePaths.get(entry.agentId) ??
				join(agentsRoot(this.home), entry.agentId, "agent", "openclaw-agent.sqlite");
			yield takeSessionBatch(collection, {
				localSessionId: sessionId,
				projectPath,
				startedAt,
				endedAt,
				messageCount: description.messageCount,
				inputTokens: entry.inputTokens ?? 0,
				outputTokens: entry.outputTokens ?? 0,
				cacheReadTokens: entry.cacheRead ?? 0,
				model: reader.initial.model,
				modelsUsed: [...reader.initial.modelsUsed],
				durationSeconds: durationSecondsBetween(startedAt, endedAt),
				summary:
					entry.label ??
					(description.firstUser ? safeTruncate(description.firstUser.content, 200) : null),
				...description.content,
				rawFilePath: storePath,
				sourceRevision,
				realUserInputAt: sessionUserActivity.lastUserInputAt,
			});
		}
		yield takeSessionBatch(collection);
	}

	private async collectSkills(context?: SyncReadContext): Promise<RawSkill[]> {
		context?.signal.throwIfAborted();
		const workspace = await resolveOpenClawAgentWorkspaceAsync(agentId(), context?.signal);
		return collectSkillsFromDir(join(workspace, "skills"));
	}

	private async skillsForOperation(context?: SyncReadContext): Promise<SkillModule> {
		// Authoritative operations seed polling, but never reuse its earlier workspace.
		const workspace = await resolveOpenClawAgentWorkspaceAsync(
			agentId(),
			context?.signal,
			context?.skillPollCycle,
			true,
		);
		const bound = flatSkillModule({
			root: () => join(workspace, "skills"),
			write: {
				writeArchive: (key, bytes) => this.installOfficialSkillArchive(key, key, bytes, workspace),
				writeSharedArchive: (key, owner, bytes) =>
					this.installOfficialSkillArchive(key, `${key}__${owner}`, bytes, workspace),
			},
		});
		const confirmCurrent = async (): Promise<void> => {
			if ((await resolveOpenClawAgentWorkspaceAsync(agentId(), context?.signal)) !== workspace) {
				throw new Error("OpenClaw agent workspace changed during Skill operation");
			}
		};
		return {
			...bound,
			confirmCurrent,
			remove: async (key) => {
				await confirmCurrent();
				await bound.remove(key);
			},
		};
	}

	private getSessionsWatchPaths(): string[] {
		const paths = this.profileAgentDirs().flatMap((dir) => {
			const sessionRoot = join(dir, "sessions");
			const database = join(dir, "agent", "openclaw-agent.sqlite");
			return [
				...(existsSync(sessionRoot) ? [sessionRoot] : []),
				...(existsSync(database) ? [database, `${database}-wal`, `${database}-journal`] : []),
			];
		});
		return paths.length > 0
			? paths
			: [join(agentsRoot(this.home), this.profileAgentId ?? agentId(), "sessions")];
	}

	private async installOfficialSkillArchive(
		archiveKey: string,
		installedSlug: string,
		tarGzBytes: Buffer,
		expectedWorkspace?: string,
	): Promise<void> {
		const home = process.env.HOME ?? homedir();
		const workspace = activeAgentWorkspace();
		if (expectedWorkspace !== undefined && workspace !== expectedWorkspace) {
			throw new Error("OpenClaw agent workspace changed before Skill install");
		}
		const targetDir = join(workspace, "skills", installedSlug);
		const stagingRoot = mkdtempSync(join(tmpdir(), "clawdi-openclaw-install-"));
		try {
			await extractTarGz(stagingRoot, tarGzBytes);
			const sourceDir = join(stagingRoot, archiveKey);
			if (!existsSync(join(sourceDir, "SKILL.md")))
				throw new Error("Skill archive is missing SKILL.md");
			const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
			if (runtimeUser && runtimeUser !== "root") {
				makeSkillStagingReadable(stagingRoot);
			}
			mutateUserSkillTarget(targetDir, installedSlug, () =>
				withManagedTargetRollback({
					target: targetDir,
					operation: () => {
						const args = [
							"skills",
							"install",
							sourceDir,
							"--agent",
							agentId(),
							"--as",
							installedSlug,
							"--force",
						];
						const result =
							runtimeUser && runtimeUser !== "root"
								? spawnRuntimeUserCommand(resolveOpenClawCommandPath(home), args, home, home, {
										environmentOverrides: inheritedOpenClawEnvironment(),
										maxBufferBytes: 1024 * 1024,
										timeoutMs: 120_000,
									})
								: spawnSync("openclaw", args, {
										encoding: "utf8",
										env: process.env,
										maxBuffer: 1024 * 1024,
										timeout: 120_000,
									});
						if (result.status !== 0) {
							throw new Error(
								`OpenClaw official Skill install failed: ${commandFailureDetail(result)}`,
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
}

/** The official all-agents inventory is shared by the readers in each scan. */
export function createOpenClawProfileReaders(
	agentIds: readonly string[],
	home: string,
): Map<string, SessionModule> {
	const inventories = new WeakMap<object, Promise<OfficialSessionInventory | null>>();
	const read = (context?: SyncReadContext) => {
		const token = context?.profileScanToken ?? context;
		if (!token) return readOfficialSessionInventory(home, context);
		let inventory = inventories.get(token);
		if (!inventory) {
			inventory = readOfficialSessionInventory(home, context);
			inventories.set(token, inventory);
		}
		return inventory;
	};
	return new Map(agentIds.map((id) => [id, new OpenClawAdapter(id, home, read).sessions]));
}
