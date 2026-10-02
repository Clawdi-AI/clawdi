import { useAuth } from "@clerk/expo";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef } from "react";

export class AccountScopeChangedError extends Error {
	constructor() {
		super("The account scope changed while the request was running");
		this.name = "AccountScopeChangedError";
	}
}

export type AccountScope = Readonly<{
	identity: string | null;
	accountKey: string | null;
	sessionId: string | null;
	generation: number;
	isReady: boolean;
	signal: AbortSignal;
	abort: () => void;
	isCurrent: () => boolean;
}>;

export type AccountRead = <Data>(
	reader: (signal: AbortSignal) => Promise<Data>,
	callerSignal?: AbortSignal,
) => Promise<Data>;

const AccountScopeContext = createContext<AccountScope | null>(null);

function linkedAbortSignal(signals: readonly AbortSignal[]): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const listeners = signals.map((signal) => {
		const abort = () => controller.abort(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		return { signal, abort };
	});
	return {
		signal: controller.signal,
		dispose: () => {
			for (const listener of listeners)
				listener.signal.removeEventListener("abort", listener.abort);
		},
	};
}

export async function readInAccountScope<Data>(
	scope: AccountScope,
	reader: (signal: AbortSignal) => Promise<Data>,
	callerSignal?: AbortSignal,
): Promise<Data> {
	if (!scope.isReady || !scope.isCurrent() || scope.signal.aborted) {
		throw new AccountScopeChangedError();
	}
	if (callerSignal?.aborted) {
		throw callerSignal.reason ?? createAbortError();
	}
	const linked = linkedAbortSignal(callerSignal ? [scope.signal, callerSignal] : [scope.signal]);
	try {
		if (scope.signal.aborted || !scope.isCurrent()) throw new AccountScopeChangedError();
		if (callerSignal?.aborted) throw callerSignal.reason ?? createAbortError();
		const value = await reader(linked.signal);
		if (scope.signal.aborted || !scope.isCurrent()) throw new AccountScopeChangedError();
		if (callerSignal?.aborted) throw callerSignal.reason ?? createAbortError();
		return value;
	} catch (error) {
		// A reader is allowed to ignore AbortSignal. Re-check both fences after
		// it rejects so an old account can never surface its result or error.
		if (scope.signal.aborted || !scope.isCurrent()) throw new AccountScopeChangedError();
		if (callerSignal?.aborted) throw callerSignal.reason ?? createAbortError();
		throw error;
	} finally {
		linked.dispose();
	}
}

function createAbortError(): Error {
	const error = new Error("The request was cancelled");
	error.name = "AbortError";
	return error;
}

export function accountQueryKey(
	scope: AccountScope,
	...parts: readonly unknown[]
): readonly ["account", string, number, ...unknown[]] {
	return ["account", scope.accountKey ?? "signed-out", scope.generation, ...parts];
}

export function AccountScopeProvider({ children }: { children: ReactNode }) {
	const { isLoaded, isSignedIn, sessionId, userId } = useAuth();
	const queryClient = useQueryClient();
	const normalizedUserId = userId ?? null;
	const normalizedSessionId = sessionId ?? null;
	const identity =
		isLoaded && isSignedIn && normalizedUserId
			? `${normalizedUserId}:${normalizedSessionId ?? ""}`
			: null;
	const scopeRef = useRef<AccountScope | null>(null);
	if (scopeRef.current?.identity !== identity) {
		const previous = scopeRef.current;
		previous?.abort();
		const controller = new AbortController();
		const generation = (previous?.generation ?? -1) + 1;
		let next: AccountScope;
		next = {
			identity,
			accountKey: identity ? normalizedUserId : null,
			sessionId: identity ? normalizedSessionId : null,
			generation,
			isReady: Boolean(identity),
			signal: controller.signal,
			abort: () => controller.abort(),
			isCurrent: () => scopeRef.current === next,
		};
		scopeRef.current = next;
	}
	const scope = scopeRef.current;
	if (!scope) throw new Error("Account scope was not initialized");

	useEffect(() => {
		void queryClient.cancelQueries().catch(() => undefined);
		queryClient.clear();
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
