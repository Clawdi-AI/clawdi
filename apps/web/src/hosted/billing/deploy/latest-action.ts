export type LatestActionRef = {
	current: () => void | Promise<void>;
};

/**
 * Build a long-lived UI callback that always invokes the latest render's action.
 * Toast actions can outlive the render that created them, so capturing the action
 * directly would also capture stale submission guards.
 */
export function latestAction(ref: LatestActionRef): () => void {
	return () => {
		void ref.current();
	};
}
