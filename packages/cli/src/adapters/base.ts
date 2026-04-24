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

	collectSessions(since?: Date, projectFilter?: string): Promise<RawSession[]>;
	collectSkills(): Promise<RawSkill[]>;

	getSkillPath(key: string): string;
	writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void>;

	buildRunCommand(args: string[], env: Record<string, string>): string[];
}
