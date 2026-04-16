import type { SyncModule } from "../consts/modules";

export interface SyncState {
	[module: string]: {
		lastSyncedAt: string;
	};
}

export interface SyncResult {
	module: SyncModule;
	uploaded: number;
	skipped: number;
	errors: number;
}
