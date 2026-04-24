"use client";

import { useEffect, useState } from "react";

/**
 * Debounced mirror of `value` — updates `delay` ms after the last change.
 * Used to throttle query-string changes into `useQuery` keys so we don't
 * fire a network request on every keystroke.
 */
export function useDebouncedValue<T>(value: T, delay = 250): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(t);
	}, [value, delay]);
	return debounced;
}
