import type { AgentType } from "./agent-types";

export interface SessionMessage {
	role: "user" | "assistant";
	content: string;
	model?: string;
	timestamp?: string;
}

export interface SessionEventSource {
	adapter: AgentType;
	session_key: string;
	record_id: string;
	record_seq?: number;
	part_index?: number;
}

export interface SessionEventReaction {
	emoji: string;
	author: string;
	at?: string;
	seen?: boolean;
}

export interface SessionEventDisplayMetadata {
	task_count?: number;
	attempt?: number;
	reactions?: SessionEventReaction[];
}

export interface SessionEventSemantics {
	lifecycle: "active" | "compacted" | "inactive";
	display: "message" | "event" | "hidden";
	compressed_summary: boolean;
	display_kind?: string;
	display_metadata?: SessionEventDisplayMetadata;
}

export type SessionContentPart =
	| { type: "text"; text: string }
	| {
			type: "attachment";
			attachment_id: string;
			availability: "external" | "metadata_only";
			uri?: string;
			name?: string;
			media_type?: string;
			size_bytes?: number;
			sha256?: string;
	  };

interface SessionEventBase {
	seq: number;
	event_id: string;
	source: SessionEventSource;
	timestamp?: string;
	semantics?: SessionEventSemantics;
}

export interface SessionMessageEvent extends SessionEventBase {
	type: "message";
	role: "user" | "assistant" | "system" | "developer";
	parts: SessionContentPart[];
	model?: string;
}

export interface SessionToolCallEvent extends SessionEventBase {
	type: "tool_call";
	call_id: string;
	name: string;
	arguments_json?: string;
	model?: string;
}

export interface SessionToolResultEvent extends SessionEventBase {
	type: "tool_result";
	call_id: string;
	name?: string;
	status: "completed" | "error";
	parts: SessionContentPart[];
	result_json?: string;
}

/** Owner-private model reasoning. Display/search projections never consume this event. */
export interface SessionReasoningEvent extends SessionEventBase {
	type: "reasoning";
	kind: "thinking" | "reasoning" | "redacted";
	parts: Array<{ type: "text"; text: string }>;
	/** Canonical JSON containing only non-display provider state such as signatures. */
	payload_json?: string;
	model?: string;
}

export type SessionEvent =
	| SessionMessageEvent
	| SessionToolCallEvent
	| SessionToolResultEvent
	| SessionReasoningEvent;

export interface RawSession {
	/** Ingest metadata only; never part of projected event bytes. */
	profileKey?: string;
	contentProtocol?: "snapshot-v1" | "events-v1";
	localSessionId: string;
	projectPath: string | null;
	startedAt: Date;
	endedAt: Date | null;
	messageCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	model: string | null;
	modelsUsed: string[];
	durationSeconds: number | null;
	summary: string | null;
	messages: SessionMessage[];
	/** Present only when the source supports strict, stable events-v1. */
	events?: SessionEvent[];
	/** Repeatable bounded reader for histories too large to retain in memory. */
	readEvents?: () => AsyncIterable<SessionEvent>;
	readMessages?: () => AsyncIterable<SessionMessage>;
	lastMessageTimestamp?: string;
	rawFilePath: string;
	/** Opaque adapter revision used to avoid materializing unchanged backing content. */
	sourceRevision?: string;
	/** Optional adapter metadata that participates in the local sync hash. */
	localHashMetadata?: string;
	/**
	 * Adapter-classified timestamp of the latest real user input in this
	 * session. `null` means the complete materialized session contains no real
	 * user input; `undefined` means the adapter does not provide this signal.
	 */
	realUserInputAt?: string | null;
	// Set by `pushOneAgent` after collection — sha256 hex of the JSON
	// the CLI is about to upload. Adapters do not populate this.
	contentHash?: string;
}

export type SessionScanRequest =
	| { kind: "complete"; projectFilter?: string }
	| { kind: "paths"; paths: readonly string[]; projectFilter?: string };

export interface SessionScanIssue {
	path: string;
	reason: string;
}

/**
 * Return shape of `AgentAdapter.collectSessions`.
 *
 * `dedupedCount` is non-zero only for `ClaudeCodeAdapter`, which dedupes
 * resume chains: when a newer session's message-uuid set strictly contains
 * an older one's, the older one is recognized as a resume predecessor and
 * dropped from the result. Other adapters return `dedupedCount: 0` because
 * their storage formats don't produce cross-file duplication (e.g. Codex
 * keeps long-conversation history in-file via `compacted` entries).
 */
export interface SessionScanResult {
	sessions: RawSession[];
	dedupedCount: number;
	coverage: "complete" | "partial";
	scanIssues?: readonly SessionScanIssue[];
}

export interface SessionScanBatch {
	sessions: RawSession[];
	/** Every local session observed in this batch, including revision-matched sessions. */
	observedLocalSessionIds: readonly string[];
	dedupedCount: number;
	scanIssues?: readonly SessionScanIssue[];
}

export interface SessionUserActivity {
	lastUserInputAt: string | null;
	complete: boolean;
}

export interface SessionBatchScan {
	coverage: SessionScanResult["coverage"];
	/** Runtime-wide aggregate from the canonical local inventory. */
	userActivity?: SessionUserActivity;
	batches: AsyncIterable<SessionScanBatch>;
}

export interface SyncReadContext {
	signal: AbortSignal;
	/** Keep content lazy even for small sessions during whole-inventory synchronization. */
	streaming?: boolean;
	/** Shared inventory lifetime for one multi-profile scan. */
	profileScanToken?: object;
}

export interface SessionModule {
	contentProtocol(context?: SyncReadContext): Promise<"events-v1" | "snapshot-v1">;
	collect(request: SessionScanRequest, context?: SyncReadContext): Promise<SessionScanResult>;
	/**
	 * Bounded scan for large or monolithic stores. Implementations may omit it;
	 * callers then treat `collect` as one batch.
	 */
	scan?(
		request: SessionScanRequest,
		knownSourceRevisions: ReadonlyMap<string, string>,
		context?: SyncReadContext,
	): Promise<SessionBatchScan>;
	resolve(localSessionId: string, context?: SyncReadContext): Promise<RawSession | null>;
	/** Paths watched as one backing-store stability group. */
	watchPaths(): string[];
}

/** Adapt a batch scanner to collection without changing eager/streaming context. */
export function collectFromScan(
	scan: NonNullable<SessionModule["scan"]>,
): SessionModule["collect"] {
	return async (request, context) => {
		context?.signal.throwIfAborted();
		const result = await scan(request, new Map(), context);
		const sessions: RawSession[] = [];
		let dedupedCount = 0;
		const scanIssues: SessionScanIssue[] = [];
		for await (const batch of result.batches) {
			context?.signal.throwIfAborted();
			sessions.push(...batch.sessions);
			dedupedCount += batch.dedupedCount;
			scanIssues.push(...(batch.scanIssues ?? []));
		}
		context?.signal.throwIfAborted();
		return { sessions, dedupedCount, coverage: result.coverage, scanIssues };
	};
}

export async function scanSessionModule(
	module: SessionModule,
	request: SessionScanRequest,
	knownSourceRevisions: ReadonlyMap<string, string> = new Map(),
	context?: SyncReadContext,
): Promise<SessionBatchScan> {
	context?.signal.throwIfAborted();
	const readContext = {
		...context,
		signal: context?.signal ?? new AbortController().signal,
		streaming: true,
	};
	if (module.scan) return module.scan(request, knownSourceRevisions, readContext);
	const result = await module.collect(request, readContext);
	context?.signal.throwIfAborted();
	return {
		coverage: result.coverage,
		batches: (async function* () {
			yield {
				sessions: result.sessions,
				observedLocalSessionIds: result.sessions.map((session) => session.localSessionId),
				dedupedCount: result.dedupedCount,
				scanIssues: result.scanIssues,
			};
		})(),
	};
}

export interface RawSkill {
	skillKey: string;
	name: string;
	content: string;
	filePath: string;
	directoryPath: string;
	isDirectory: boolean;
	// Set by `push` during the scan phase — the skill folder hash used to
	// diff against the skills-lock. Adapters do not populate this.
	contentHash?: string;
}

export interface SkillModule {
	collect(context?: SyncReadContext): Promise<RawSkill[]>;
	listKeys(context?: SyncReadContext): Promise<string[]>;
	path(key: string): string;
	rootDir(): string;
	sharedPath(skillKey: string, ownerHandle: string): string;
	writeArchive(key: string, tarGzBytes: Buffer): Promise<void>;
	writeSharedArchive(key: string, ownerHandle: string, tarGzBytes: Buffer): Promise<void>;
	remove(key: string): Promise<void>;
}

export interface AgentAdapterCore {
	readonly agentType: AgentType;
	detect(): Promise<boolean>;
	getVersion(): Promise<string | null>;
}

type AtLeastOne<T> = {
	[K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

/** An adapter is core identity plus at least one complete data module. */
export type AgentAdapter = AgentAdapterCore &
	AtLeastOne<{
		sessions: SessionModule;
		skills: SkillModule;
	}>;

export type AdapterModuleName = "sessions" | "skills";

/** Derive the registration contract from complete modules actually present. */
export function adapterModuleNames(
	adapter: AgentAdapter,
): [AdapterModuleName, ...AdapterModuleName[]] {
	const modules: AdapterModuleName[] = [];
	if (adapter.sessions) modules.push("sessions");
	if (adapter.skills) modules.push("skills");
	if (modules.length === 0) throw new Error(`${adapter.agentType} has no data modules`);
	return modules as [AdapterModuleName, ...AdapterModuleName[]];
}
