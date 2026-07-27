import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * False for SSR and the matching hydration render, then true in the browser.
 * Unlike an effect-backed flag, this stays false when a Suspense boundary is
 * hydrated after effects elsewhere in the tree have already run.
 */
export function useHydrated(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => true,
		() => false,
	);
}
