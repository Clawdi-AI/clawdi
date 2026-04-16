import type { AgentType } from "../consts/agents";

export interface Session {
	id: string;
	userId: string;
	environmentId: string;
	localSessionId: string;
	projectPath: string | null;
	startedAt: string;
	endedAt: string | null;
	durationSeconds: number | null;
	messageCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	model: string | null;
	modelsUsed: string[] | null;
	summary: string | null;
	tags: string[];
	status: "active" | "completed" | "aborted";
	fileKey: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface AgentEnvironment {
	id: string;
	userId: string;
	machineId: string;
	machineName: string;
	agentType: AgentType;
	agentVersion: string | null;
	os: string;
	lastSeenAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface ContributionDay {
	date: string;
	count: number;
	level: 0 | 1 | 2 | 3 | 4;
}

export interface DashboardStats {
	totalSessions: number;
	totalMessages: number;
	totalTokens: number;
	activeDays: number;
	currentStreak: number;
	longestStreak: number;
	peakHour: number;
	favoriteModel: string | null;
}
