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

export type SessionEvent = SessionMessageEvent | SessionToolCallEvent | SessionToolResultEvent;

export interface RawSession {
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
	rawFilePath: string;
	// Set by `pushOneAgent` after collection — sha256 hex of the JSON
	// the CLI is about to upload. Adapters do not populate this.
	contentHash?: string;
}

export type SessionScanRequest =
	| { kind: "complete"; projectFilter?: string }
	| { kind: "paths"; paths: readonly string[]; projectFilter?: string };

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
}

export interface SessionModule {
	contentProtocol(): Promise<"events-v1" | "snapshot-v1">;
	collect(request: SessionScanRequest): Promise<SessionScanResult>;
	resolve(localSessionId: string): Promise<RawSession | null>;
	/** Paths watched as one backing-store stability group. */
	watchPaths(): string[];
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
	collect(): Promise<RawSkill[]>;
	listKeys(): Promise<string[]>;
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
