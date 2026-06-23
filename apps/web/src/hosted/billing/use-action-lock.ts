"use client";

import { useCallback, useRef } from "react";

/**
 * Re-entrancy guard for async click handlers.
 *
 * A button's `disabled={mutation.isPending}` only takes effect on the next
 * render, leaving a sub-frame window where a fast double-click (or an
 * Enter-key repeat) can fire two mutations before React repaints. The returned
 * `run` wrapper sets a synchronous ref lock so the second call is dropped until
 * the first settles — making Pay / Confirm / Upgrade actions idempotent at the
 * source, not just visually.
 */
export function useActionLock() {
	const locked = useRef(false);
	return useCallback(async (fn: () => Promise<void> | void) => {
		if (locked.current) return;
		locked.current = true;
		try {
			await fn();
		} finally {
			locked.current = false;
		}
	}, []);
}
