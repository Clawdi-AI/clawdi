/**
 * Client-side sync cursor persisted at `~/.clawdi/sync.json`.
 *
 * Each sync module (sessions, skills, ...) has its own last-synced
 * timestamp. Kept loose so the CLI can introduce new modules without a
 * shared-package bump.
 */
export interface SyncState {
	[module: string]: {
		lastSyncedAt: string;
	};
}
