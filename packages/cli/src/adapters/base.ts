import type { AgentType } from "@clawdi-cloud/shared/consts";

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
	summary: string | null;
	rawFilePath: string;
}

export interface RawSkill {
	skillKey: string;
	name: string;
	content: string;
	filePath: string;
}

export interface AgentAdapter {
	readonly agentType: AgentType;

	detect(): Promise<boolean>;
	getVersion(): Promise<string | null>;

	collectSessions(since?: Date): Promise<RawSession[]>;
	collectSkills(): Promise<RawSkill[]>;

	writeSkill(key: string, content: string): Promise<void>;

	buildRunCommand(args: string[], env: Record<string, string>): string[];
}
