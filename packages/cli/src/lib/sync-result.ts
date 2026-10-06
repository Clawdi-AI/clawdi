import type { AgentType } from "../adapters/registry";

export interface SessionSyncCounts {
	new: number;
	updated: number;
	unchanged: number;
	failed: number;
}

export interface SyncError {
	agent: AgentType | null;
	module: "sessions" | "skills" | null;
	key: string | null;
	message: string;
}

export function emptySessionCounts(): SessionSyncCounts {
	return { new: 0, updated: 0, unchanged: 0, failed: 0 };
}
