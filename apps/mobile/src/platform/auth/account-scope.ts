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

export function createAccountScope(
	identity: string | null,
	accountKey: string | null,
	sessionId: string | null,
	generation: number,
	isCurrent: () => boolean,
) {
	let controller = new AbortController();
	return {
		identity,
		accountKey,
		sessionId,
		generation,
		isReady: Boolean(identity),
		get signal() {
			return controller.signal;
		},
		abort: () => controller.abort(),
		isCurrent,
		activate: () => {
			if (controller.signal.aborted) controller = new AbortController();
		},
	};
}

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
	const scopeSignal = scope.signal;
	const linked = linkedAbortSignal(callerSignal ? [scopeSignal, callerSignal] : [scopeSignal]);
	try {
		if (scopeSignal.aborted || !scope.isCurrent()) throw new AccountScopeChangedError();
		if (callerSignal?.aborted) throw callerSignal.reason ?? createAbortError();
		const value = await reader(linked.signal);
		if (scopeSignal.aborted || !scope.isCurrent()) throw new AccountScopeChangedError();
		if (callerSignal?.aborted) throw callerSignal.reason ?? createAbortError();
		return value;
	} catch (error) {
		// A reader is allowed to ignore AbortSignal. Re-check both fences after
		// it rejects so an old account can never surface its result or error.
		if (scopeSignal.aborted || !scope.isCurrent()) throw new AccountScopeChangedError();
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

export function isObsoleteAccountQuery(scope: AccountScope, queryKey: readonly unknown[]): boolean {
	return (
		queryKey[0] === "account" &&
		(queryKey[1] !== (scope.accountKey ?? "signed-out") || queryKey[2] !== scope.generation)
	);
}
