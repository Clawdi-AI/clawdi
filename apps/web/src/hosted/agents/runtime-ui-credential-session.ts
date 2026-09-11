import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import { openClawHandoffMode } from "@/hosted/agents/runtime-ui-credentials";

export interface RuntimeUiCredentialState {
	credentials: RuntimeUiCredentials | null;
	error: Error | null;
	status: "idle" | "loading" | "ready" | "error";
	nativeHandoffLoaded: boolean;
	attempt: number;
}

export function canReuseRuntimeUiCredentials(credentials: RuntimeUiCredentials, now = Date.now()) {
	if (openClawHandoffMode(credentials) !== "native") return true;
	return (
		credentials.runtime === "openclaw" &&
		typeof credentials.browser_bootstrap_expires_at_ms === "number" &&
		credentials.browser_bootstrap_expires_at_ms > now
	);
}

/** One in-memory access session, owned by the persistent agent route. */
export function createRuntimeUiCredentialSession({
	request,
	hasNativeHandoffLoaded,
	markNativeHandoffLoaded,
	forgetNativeHandoffLoaded,
}: {
	request: () => Promise<RuntimeUiCredentials>;
	hasNativeHandoffLoaded: () => boolean;
	markNativeHandoffLoaded: (credentials: RuntimeUiCredentials) => void;
	forgetNativeHandoffLoaded: () => void;
}) {
	let state: RuntimeUiCredentialState = {
		credentials: null,
		error: null,
		status: "idle",
		nativeHandoffLoaded: false,
		attempt: 0,
	};
	let pending: Promise<RuntimeUiCredentials | null> | null = null;
	let disposed = false;
	let consoleOpen = false;
	const listeners = new Set<() => void>();
	const publish = (next: RuntimeUiCredentialState) => {
		state = next;
		for (const listener of listeners) listener();
	};

	const load = (
		force = false,
		reuseUnknownExpiry = false,
	): Promise<RuntimeUiCredentials | null> => {
		if (disposed) return Promise.resolve(null);
		if (pending) return pending;
		if (!force) {
			if (state.nativeHandoffLoaded || hasNativeHandoffLoaded()) {
				publish({
					...state,
					credentials: null,
					error: null,
					status: "ready",
					nativeHandoffLoaded: true,
				});
				return Promise.resolve(null);
			}
			if (
				state.credentials &&
				(canReuseRuntimeUiCredentials(state.credentials) ||
					(reuseUnknownExpiry &&
						state.credentials.runtime === "openclaw" &&
						state.credentials.browser_bootstrap_expires_at_ms == null))
			) {
				return Promise.resolve(state.credentials);
			}
		} else {
			forgetNativeHandoffLoaded();
		}
		const attempt = state.attempt + 1;

		pending = Promise.resolve()
			.then(() => (disposed || state.attempt !== attempt ? null : request()))
			.then((credentials) => {
				if (disposed || state.attempt !== attempt || !credentials) return null;
				if (
					credentials.runtime === "openclaw" &&
					credentials.browser_bootstrap_expires_at_ms != null &&
					credentials.browser_bootstrap_expires_at_ms <= Date.now()
				)
					throw new Error("The browser sign-in details expired. Try again.");
				publish({ ...state, credentials, status: "ready" });
				return credentials;
			})
			.catch((error: unknown) => {
				if (!disposed && state.attempt === attempt) {
					publish({
						...state,
						error:
							error instanceof Error
								? error
								: new Error("Browser sign-in details are unavailable."),
						status: "error",
					});
				}
				return null;
			})
			.finally(() => {
				if (state.attempt === attempt) pending = null;
			});
		publish({
			credentials: null,
			error: null,
			status: "loading",
			nativeHandoffLoaded: false,
			attempt,
		});
		return pending;
	};

	return {
		activate: () => {
			disposed = false;
		},
		getSnapshot: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		load,
		preload: () =>
			state.status === "idle" ? load() : (pending ?? Promise.resolve(state.credentials)),
		open: () => {
			// Older native responses have no expiry. Share them only within this
			// console entry, including the parent's request before its child mounts.
			const reuseUnknownExpiry = consoleOpen;
			consoleOpen = true;
			return load(false, reuseUnknownExpiry);
		},
		leave: () => {
			consoleOpen = false;
		},
		reconnect: () => load(true),
		clear: () => {
			forgetNativeHandoffLoaded();
			pending = null;
			publish({
				credentials: null,
				error: null,
				status: "idle",
				nativeHandoffLoaded: false,
				attempt: state.attempt + 1,
			});
		},
		markLoaded: (attempt: number) => {
			if (
				disposed ||
				state.attempt !== attempt ||
				!state.credentials ||
				openClawHandoffMode(state.credentials) !== "native"
			)
				return;
			markNativeHandoffLoaded(state.credentials);
			// The mounted frame retains its launch URL; future mounts use the clean endpoint.
			publish({ ...state, credentials: null, nativeHandoffLoaded: true });
		},
		dispose: () => {
			disposed = true;
			consoleOpen = false;
			pending = null;
			state = {
				...state,
				credentials: null,
				error: null,
				status: "idle",
				attempt: state.attempt + 1,
			};
			listeners.clear();
		},
	};
}

export type RuntimeUiCredentialSession = ReturnType<typeof createRuntimeUiCredentialSession>;
