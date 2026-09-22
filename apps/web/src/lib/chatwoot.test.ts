import { describe, expect, mock, test } from "bun:test";
import {
	type ChatwootApi,
	type ChatwootSessionStore,
	type ChatwootWidgetSettings,
	createChatwootSessionController,
	createChatwootToggleQueue,
	hasChatwootIdentityFailure,
	markChatwootIdentityFailure,
	resetChatwootBeforeSignOut,
	resolveChatwootIdentity,
	shouldHideChatwoot,
	startChatwoot,
	watchChatwootIdentityStorage,
} from "@/lib/chatwoot";

function createApi(calls: string[], hasLoaded = false): ChatwootApi {
	return {
		hasLoaded,
		setUser: mock((identifier: string) => calls.push(`user:${identifier}`)),
		reset: mock(() => calls.push("reset")),
		toggle: mock(() => calls.push("toggle")),
		toggleBubbleVisibility: mock((visibility: "hide" | "show") => calls.push(visibility)),
	};
}

function createStore({
	marker = null,
	identifiedCookie = false,
}: {
	marker?: string | null;
	identifiedCookie?: boolean;
} = {}) {
	let currentMarker: string | null = marker;
	const store: ChatwootSessionStore = {
		readIdentity: () => currentMarker,
		writeIdentity: (_websiteToken, userId) => {
			currentMarker = userId;
		},
		clearIdentity: () => {
			currentMarker = null;
		},
		hasSessionCookie: () => identifiedCookie,
	};
	return { store, readMarker: () => currentMarker };
}

const ada = {
	id: "user_123",
	name: "Ada Lovelace",
	email: "ada@example.com",
	identifierHash: "trusted-hash",
};

describe("Chatwoot Website SDK adapter", () => {
	test("installs runtime settings before starting the official SDK", () => {
		const calls: string[] = [];
		const runtime = {
			set chatwootSettings(value: ChatwootWidgetSettings | undefined) {
				calls.push("settings");
				expect(value).toEqual({
					hideMessageBubble: true,
					position: "right",
					type: "standard",
					widgetStyle: "standard",
					darkMode: "auto",
					useBrowserLanguage: true,
				});
			},
			chatwootSDK: {
				run: mock(() => calls.push("run")),
			},
		};

		expect(
			startChatwoot(runtime, {
				baseUrl: "https://support.example.com",
				websiteToken: "website-token",
			}),
		).toBe(true);
		expect(calls).toEqual(["settings", "run"]);
	});

	test("waits for delayed readiness before identifying or changing visibility", () => {
		const calls: string[] = [];
		const api = createApi(calls);
		const { store, readMarker } = createStore();
		const controller = createChatwootSessionController({
			websiteToken: "website-token",
			readApi: () => api,
			store,
			reload: mock(() => {}),
		});

		expect(controller.sync(ada, ada.id, false)).toBe("waiting");
		expect(calls).toEqual([]);
		expect(readMarker()).toBeNull();

		api.hasLoaded = true;
		expect(controller.sync(ada, ada.id, false)).toBe("identified");
		expect(calls).toEqual(["user:user_123", "show"]);
		expect(readMarker()).toBe("user_123");
	});

	test("resets and hard reloads when the live account changes", () => {
		const calls: string[] = [];
		const api = createApi(calls, true);
		const reload = mock(() => calls.push("reload"));
		const { store, readMarker } = createStore({ marker: "user_a" });
		const controller = createChatwootSessionController({
			websiteToken: "website-token",
			readApi: () => api,
			store,
			reload,
		});

		expect(controller.sync({ ...ada, id: "user_b" }, "user_b", false)).toBe("reloading");
		expect(calls).toEqual(["hide", "reset", "reload"]);
		expect(readMarker()).toBeNull();
	});

	test("resets stale Chatwoot cookies before an anonymous session can inherit them", () => {
		const calls: string[] = [];
		const api = createApi(calls, true);
		const reload = mock(() => calls.push("reload"));
		const { store } = createStore({ identifiedCookie: true });
		const controller = createChatwootSessionController({
			websiteToken: "website-token",
			readApi: () => api,
			store,
			reload,
		});

		expect(controller.needsSdk(null)).toBe(true);
		expect(controller.sync(null, null, false)).toBe("reloading");
		expect(calls).toEqual(["hide", "reset", "reload"]);
	});

	test("resets synchronously on logout and clears the identity marker", () => {
		const calls: string[] = [];
		const api = createApi(calls, true);
		api.user = { identifier: ada.id };
		api.reset = mock(() => {
			calls.push("reset");
			if (api.user) calls.push("user:cached");
		});
		const { store, readMarker } = createStore({ marker: ada.id });

		resetChatwootBeforeSignOut({ $chatwoot: api }, "website-token", store);
		expect(calls).toEqual(["hide", "reset"]);
		expect(api.user).toBeUndefined();
		expect(readMarker()).toBeNull();
	});

	test("invalidates pending identity work when logout resets the session", () => {
		const calls: string[] = [];
		const api = createApi(calls, true);
		const { store } = createStore({ marker: ada.id });
		const controller = createChatwootSessionController({
			websiteToken: "website-token",
			readApi: () => api,
			store,
			reload: mock(() => calls.push("reload")),
		});

		resetChatwootBeforeSignOut({ $chatwoot: api }, "website-token", store);
		expect(controller.sync(ada, ada.id, false)).toBe("reloading");
		expect(calls).toEqual(["hide", "reset"]);
	});

	test("resets when another tab clears the active identity marker", () => {
		const calls: string[] = [];
		const api = createApi(calls, true);
		const reload = mock(() => calls.push("reload"));
		const { store } = createStore();
		const controller = createChatwootSessionController({
			websiteToken: "website-token",
			readApi: () => api,
			store,
			reload,
		});

		expect(controller.sync(ada, ada.id, false)).toBe("identified");
		store.clearIdentity("website-token");
		expect(controller.sync(ada, ada.id, false)).toBe("reloading");
		expect(calls).toEqual(["user:user_123", "show", "hide", "reset", "reload"]);
	});

	test("fails closed when Chatwoot rejects a signed identity", () => {
		const calls: string[] = [];
		const api = createApi(calls, true);
		api.isOpen = true;
		const reload = mock(() => calls.push("reload"));
		const { store, readMarker } = createStore({ marker: ada.id });
		const controller = createChatwootSessionController({
			websiteToken: "website-token",
			readApi: () => api,
			store,
			reload,
		});

		expect(controller.failClosed()).toBe("reloading");
		expect(calls).toEqual(["toggle", "hide", "reset", "reload"]);
		expect(readMarker()).toBeNull();
		expect(controller.failClosed()).toBe("reloading");
		expect(controller.sync(ada, ada.id, false)).toBe("reloading");
		expect(reload).toHaveBeenCalledTimes(1);
	});

	test("persists an identity-error circuit breaker across a page reload", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
		} as unknown as Storage;

		expect(hasChatwootIdentityFailure("website-token", storage)).toBe(false);
		markChatwootIdentityFailure("website-token", storage);
		expect(hasChatwootIdentityFailure("website-token", storage)).toBe(true);
	});

	test("reconciles both marker writes and localStorage.clear events", () => {
		const browser = new EventTarget();
		const onChange = mock(() => {});
		const unwatch = watchChatwootIdentityStorage(
			browser as Pick<Window, "addEventListener" | "removeEventListener">,
			"website-token",
			onChange,
		);

		const dispatchStorage = (key: string | null) => {
			const event = new Event("storage");
			Object.defineProperty(event, "key", { value: key });
			browser.dispatchEvent(event);
		};
		dispatchStorage("clawdi:chatwoot:identity:website-token");
		dispatchStorage(null);
		expect(onChange).toHaveBeenCalledTimes(2);
		unwatch();
	});

	test("closes an open panel before hiding it", () => {
		const calls: string[] = [];
		const api = createApi(calls, true);
		api.isOpen = true;
		const { store } = createStore();
		const controller = createChatwootSessionController({
			websiteToken: "website-token",
			readApi: () => api,
			store,
			reload: mock(() => {}),
		});

		expect(controller.sync(ada, ada.id, true)).toBe("identified");
		expect(calls).toEqual(["user:user_123", "toggle", "hide"]);
	});

	test("queues one toggle until the official ready event", () => {
		const calls: string[] = [];
		const api = createApi(calls);
		let ready: (() => void) | undefined;
		const unsubscribe = mock(() => {});
		const queue = createChatwootToggleQueue({
			readApi: () => api,
			subscribeReady: (listener) => {
				ready = listener;
				return unsubscribe;
			},
		});

		queue.request();
		queue.request();
		expect(calls).toEqual([]);

		api.hasLoaded = true;
		ready?.();
		expect(calls).toEqual(["toggle"]);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe("Chatwoot identity and placement", () => {
	test("uses the authenticated account id and primary email", () => {
		expect(
			resolveChatwootIdentity({
				id: " user_123 ",
				fullName: " Ada Lovelace ",
				primaryEmailAddress: { emailAddress: " ada@example.com " },
			}),
		).toEqual({ id: "user_123", name: "Ada Lovelace", email: "ada@example.com" });
	});

	test("preserves the desktop live-tool route exclusions", () => {
		for (const pathname of [
			"/deploy",
			"/agents/agent-1/console",
			"/agents/agent-1/files",
			"/agents/agent-1/terminal",
			"/terminal/agent-1",
		]) {
			expect(shouldHideChatwoot(pathname)).toBe(true);
		}
		for (const pathname of ["/agents", "/agents/agent-1", "/settings", "/admin"]) {
			expect(shouldHideChatwoot(pathname)).toBe(false);
		}
	});
});
