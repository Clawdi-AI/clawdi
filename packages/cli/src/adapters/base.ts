import type { AgentType } from "./registry";

export interface SessionMessage {
	role: "user" | "assistant";
	content: string;
	model?: string;
	timestamp?: string;
}

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
	rawFilePath: string;
	// Set by `pushOneAgent` after collection — sha256 hex of the JSON
	// the CLI is about to upload. Adapters do not populate this.
	contentHash?: string;
}

/**
 * Options for `AgentAdapter.collectSessions`.
 *
 * `projectFilter` restricts to sessions whose stored `cwd` / project path
 * equals or is under the given absolute path. Hermes ignores this — its
 * data model has no project linkage.
 *
 * Adapters always do a full scan and return every session that matches
 * the project filter. Whether to actually push a session to the server
 * is decided in `pushOneAgent` against `~/.clawdi/sessions-lock.json`.
 */
export interface CollectSessionsOptions {
	projectFilter?: string;
}

export interface RawSkill {
	skillKey: string;
	name: string;
	content: string;
	filePath: string;
	directoryPath: string;
	isDirectory: boolean;
}

export interface AgentAdapter {
	readonly agentType: AgentType;

	detect(): Promise<boolean>;
	getVersion(): Promise<string | null>;

	collectSessions(opts?: CollectSessionsOptions): Promise<RawSession[]>;
	collectSkills(): Promise<RawSkill[]>;

	getSkillPath(key: string): string;
	writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void>;

	buildRunCommand(args: string[], env: Record<string, string>): string[];
}
