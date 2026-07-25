"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function executeSensitiveAction<TArgs extends unknown[], TResult>(
	action: (...args: TArgs) => Promise<TResult>,
	...args: TArgs
): Promise<TResult> {
	return action(...args);
}

/**
 * Runs a secret-bearing request without creating a TanStack mutation.
 *
 * Arguments and results exist only on the caller's async stack. This hook
 * deliberately stores only pending/error UI state, so plaintext credentials,
 * one-time tokens, and payment secrets cannot enter MutationCache.
 */
export function useSensitiveAction<TArgs extends unknown[], TResult>(
	action: (...args: TArgs) => Promise<TResult>,
) {
	const actionRef = useRef(action);
	const mountedRef = useRef(true);
	const pendingCountRef = useRef(0);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<unknown>(null);
	actionRef.current = action;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const execute = useCallback(async (...args: TArgs): Promise<TResult> => {
		pendingCountRef.current += 1;
		if (mountedRef.current) {
			setIsPending(true);
			setError(null);
		}
		try {
			return await executeSensitiveAction(actionRef.current, ...args);
		} catch (nextError) {
			if (mountedRef.current) setError(nextError);
			throw nextError;
		} finally {
			pendingCountRef.current -= 1;
			if (mountedRef.current && pendingCountRef.current === 0) setIsPending(false);
		}
	}, []);

	const reset = useCallback(() => {
		if (mountedRef.current) setError(null);
	}, []);

	return { execute, isPending, error, reset };
}
