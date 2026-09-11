import type { ClerkProvider as NativeClerkProvider } from "@clerk/tanstack-react-start";
import { useRouter } from "@tanstack/react-router";
import { type ComponentProps, useSyncExternalStore } from "react";

let navigate: ((to: string) => Promise<void>) | undefined;
export function ClerkProvider(props: ComponentProps<typeof NativeClerkProvider>) {
	const router = useRouter();
	navigate = async (to) => {
		if (props.routerPush) await props.routerPush(to);
		else await router.navigate({ href: to });
	};
	return props.children;
}

// setActive updates the cookie before its transitive resource emission and
// awaits framework navigation before publishing the newly active session.
let serverState = { userId: "user-a", sessionId: "session-a" };
export function serverAuth() {
	return serverState;
}
let activation: ReturnType<typeof Promise.withResolvers<void>> | undefined;
export function releaseActivation() {
	activation?.resolve();
}
export async function activateSession(to: string) {
	activation = Promise.withResolvers<void>();
	serverState = { userId: "user-a", sessionId: "session-a" };
	emitSdk({ isLoaded: false });
	if (!navigate) throw new Error("Missing native navigation");
	await navigate(to);
	await activation.promise;
	emitSdk({ isLoaded: true, ...serverState });
}

// SDK contract fixture: resource emissions and status events are independent.
// No credentials or Clerk network requests are used by this browser suite.
export type SdkState = {
	status: "loading" | "ready" | "degraded" | "error";
	isLoaded: boolean;
	userId: string | null;
	sessionId: string | null;
	pending: boolean;
	tokenFailure: boolean;
	nullToken: boolean;
};
const initial: SdkState = {
	status: "ready",
	isLoaded: true,
	userId: "user-a",
	sessionId: "session-a",
	pending: false,
	tokenFailure: false,
	nullToken: false,
};
let state = initial;
const resources = new Set<() => void>();
const statuses = new Set<() => void>();
export let signOutCalls = 0;
const heldTokens = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
export let heldTokenCalls = 0;
export function holdSessionToken(sessionId: string) {
	heldTokens.set(sessionId, Promise.withResolvers<void>());
}
export function releaseSessionToken(sessionId: string) {
	const held = heldTokens.get(sessionId);
	heldTokens.delete(sessionId);
	held?.resolve();
}

export function emitSdk(update: Partial<SdkState>) {
	state = { ...state, ...update };
	if (state.isLoaded)
		serverState = {
			userId: state.pending ? "" : (state.userId ?? ""),
			sessionId: state.pending ? "" : (state.sessionId ?? ""),
		};
	if (Object.keys(update).some((key) => key !== "status")) {
		for (const listener of resources) listener();
	}
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

const sessionResources = new Map<
	string,
	{ id: string; user: { id: string | null }; getToken: () => Promise<string | null> }
>();
export function useSession() {
	const auth = useAuth();
	const resourceReady = useSyncExternalStore(
		subscribe,
		() => state.status !== "loading" && state.isLoaded,
		() => false,
	);
	const sessionId = resourceReady ? auth.sessionId : null;
	let session = sessionId ? sessionResources.get(sessionId) : undefined;
	if (sessionId && !session) {
		const token = `${auth.userId}:${auth.sessionId}`;
		session = {
			id: sessionId,
			user: { id: auth.userId },
			getToken: async () => {
				const held = heldTokens.get(sessionId);
				if (held) {
					heldTokenCalls += 1;
					await held.promise;
				}
				if (state.tokenFailure) throw new TypeError("Token refresh unavailable");
				return state.nullToken ? null : token;
			},
		};
		sessionResources.set(sessionId, session);
	}
	return { isLoaded: resourceReady, session };
}
const clerk = {
	get session() {
		return state.isLoaded && state.sessionId ? { id: state.sessionId } : undefined;
	},
	get status() {
		return state.status;
	},
	signOut: async () => {
		signOutCalls += 1;
		emitSdk({ userId: null, sessionId: null });
	},
};
export function useClerk() {
	// Native ClerkProvider subscribes to status and updates its context even
	// without a resource emission. Model that separately from useAuth's store.
	useSyncExternalStore(
		(listener) => {
			statuses.add(listener);
			return () => statuses.delete(listener);
		},
		() => state.status,
		() => initial.status,
	);
	return clerk;
}
export function useUser() {
	const auth = useAuth();
	return { ...auth, user: auth.userId ? { id: auth.userId } : null };
}
