import { useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useLayoutEffect,
	useRef,
} from "react";
import {
	type AccountRead,
	type AccountScope,
	createAccountScope,
	isObsoleteAccountQuery,
	readInAccountScope,
} from "@/platform/auth/account-scope";
import { useAppAuth } from "@/platform/auth/auth-client";

export type { AccountRead, AccountScope } from "@/platform/auth/account-scope";
export {
	AccountScopeChangedError,
	accountQueryKey,
	clearAccountScope,
	readInAccountScope,
} from "@/platform/auth/account-scope";

const AccountScopeContext = createContext<AccountScope | null>(null);

export function AccountScopeProvider({ children }: { children: ReactNode }) {
	const { isLoaded, isSignedIn, sessionId, userId } = useAppAuth();
	const queryClient = useQueryClient();
	const normalizedUserId = userId ?? null;
	const normalizedSessionId = sessionId ?? null;
	const identity =
		isLoaded && isSignedIn && normalizedUserId
			? `${normalizedUserId}:${normalizedSessionId ?? ""}`
			: null;
	const scopeRef = useRef<ReturnType<typeof createAccountScope> | null>(null);
	if (scopeRef.current?.identity !== identity) {
		const previous = scopeRef.current;
		previous?.abort();
		const generation = (previous?.generation ?? -1) + 1;
		const next: ReturnType<typeof createAccountScope> = createAccountScope(
			identity,
			identity ? normalizedUserId : null,
			identity ? normalizedSessionId : null,
			generation,
			() => scopeRef.current === next,
		);
		scopeRef.current = next;
	}
	const scope = scopeRef.current;
	if (!scope) throw new Error("Account scope was not initialized");

	useLayoutEffect(() => {
		// StrictMode replays setup after cleanup using the same rendered scope.
		// Old reads retain their aborted signal; new reads use a fresh controller.
		scope.activate();
		queryClient.removeQueries({
			predicate: ({ queryKey }) => isObsoleteAccountQuery(scope, queryKey),
		});
		return () => scope.abort();
	}, [queryClient, scope]);

	return <AccountScopeContext.Provider value={scope}>{children}</AccountScopeContext.Provider>;
}

export function useAccountScope(): AccountScope {
	const scope = useContext(AccountScopeContext);
	if (!scope) throw new Error("useAccountScope must be used inside AccountScopeProvider");
	return scope;
}

export function useAccountRead(): AccountRead {
	const scope = useAccountScope();
	return useCallback(
		function read<Data>(
			reader: (signal: AbortSignal) => Promise<Data>,
			callerSignal?: AbortSignal,
		) {
			return readInAccountScope(scope, reader, callerSignal);
		},
		[scope],
	);
}
