import { useSyncExternalStore } from "react";

// SDK contract fixture: resource emissions and status events are independent.
// No credentials or Clerk network requests are used by this browser suite.
export type SdkState = {
	status: "loading" | "ready" | "degraded" | "error";
	isLoaded: boolean;
	userId: string | null;
	sessionId: string | null;
	pending: boolean;
	tokenFailure: boolean;
};
const initial: SdkState = {
	status: "ready",
	isLoaded: true,
	userId: "user-a",
	sessionId: "session-a",
	pending: false,
	tokenFailure: false,
};
let state = initial;
const resources = new Set<() => void>();
const statuses = new Set<() => void>();
export let signOutCalls = 0;

export function emitSdk(update: Partial<SdkState>) {
	state = { ...state, ...update };
	for (const listener of resources) listener();
	for (const listener of statuses) listener();
}

const subscribe = (listener: () => void) => {
	resources.add(listener);
	return () => {
		resources.delete(listener);
	};
};
const getToken = async () => {
	if (state.tokenFailure) throw new TypeError("Token refresh unavailable");
	return state.userId && state.sessionId ? `${state.userId}:${state.sessionId}` : null;
};

export function useAuth({ treatPendingAsSignedOut = true } = {}) {
	const snapshot = useSyncExternalStore(
		subscribe,
		() => state,
		() => initial,
	);
	const signedIn =
		snapshot.isLoaded &&
		Boolean(snapshot.userId && snapshot.sessionId) &&
		!(snapshot.pending && treatPendingAsSignedOut);
	return {
		isLoaded: snapshot.isLoaded,
		isSignedIn: snapshot.isLoaded ? signedIn : undefined,
		userId: signedIn ? snapshot.userId : null,
		sessionId: signedIn ? snapshot.sessionId : null,
		getToken,
	};
}

const clerk = {
	get status() {
		return state.status;
	},
	on(_event: "status", listener: () => void) {
		statuses.add(listener);
	},
	off(_event: "status", listener: () => void) {
		statuses.delete(listener);
	},
	signOut: async () => {
		signOutCalls += 1;
		emitSdk({ userId: null, sessionId: null });
	},
};
export const useClerk = () => clerk;
export function useUser() {
	const auth = useAuth();
	return { ...auth, user: auth.userId ? { id: auth.userId } : null };
}
