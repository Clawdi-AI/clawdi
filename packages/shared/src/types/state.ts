/**
 * Per-module activity timestamps tracked in `~/.clawdi/state.json`.
 * Both `push` and `pull` update the relevant module's `lastActivityAt`.
 * `push --since` uses it as an incremental cursor when no explicit
 * `--since` is supplied.
 */
export interface ModuleState {
	[module: string]: {
		lastActivityAt: string;
	};
}
