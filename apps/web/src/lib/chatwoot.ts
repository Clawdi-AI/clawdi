import { parseAgentPathname } from "@/lib/agent-routes";

export type ChatwootIdentity = Readonly<{
	id: string;
	name: string;
	email: string;
}>;

export type SignedChatwootIdentity = ChatwootIdentity &
	Readonly<{
		identifierHash: string;
	}>;

export type ChatwootWidgetSettings = Readonly<{
	hideMessageBubble: true;
	position: "right";
	type: "standard";
	widgetStyle: "standard";
	darkMode: "auto";
	useBrowserLanguage: true;
}>;

export type ChatwootSdk = {
	run: (config: { websiteToken: string; baseUrl: string }) => unknown;
};

export type ChatwootApi = {
	hasLoaded: boolean;
	isOpen?: boolean;
	user?: unknown;
	setUser: (
		identifier: string,
		attributes: { name: string; email: string; identifier_hash: string },
	) => unknown;
	reset: () => unknown;
	toggle: () => unknown;
	toggleBubbleVisibility: (visibility: "hide" | "show") => unknown;
};

export type ChatwootRuntime = {
	chatwootSDK?: ChatwootSdk;
	$chatwoot?: ChatwootApi;
	chatwootSettings?: ChatwootWidgetSettings;
};

export type ChatwootSessionStore = {
	readIdentity: (websiteToken: string) => string | null;
	writeIdentity: (websiteToken: string, userId: string) => void;
	clearIdentity: (websiteToken: string) => void;
	hasSessionCookie: (websiteToken: string) => boolean;
};

export type ChatwootSessionSyncResult = "waiting" | "anonymous" | "identified" | "reloading";

const CHATWOOT_WIDGET_SETTINGS = {
	hideMessageBubble: true,
	position: "right",
	type: "standard",
	widgetStyle: "standard",
	darkMode: "auto",
	useBrowserLanguage: true,
} as const satisfies ChatwootWidgetSettings;

const IDENTITY_MARKER_PREFIX = "clawdi:chatwoot:identity:";
const IDENTITY_FAILURE_PREFIX = "clawdi:chatwoot:identity-failed:";
let identityGeneration = 0;

export function getChatwootIdentityGeneration(): number {
	return identityGeneration;
}

function invalidateChatwootIdentity(): void {
	identityGeneration += 1;
}

export function hasChatwootIdentityFailure(websiteToken: string, storage: Storage): boolean {
	try {
		return storage.getItem(`${IDENTITY_FAILURE_PREFIX}${websiteToken}`) === "1";
	} catch {
		return true;
	}
}

export function markChatwootIdentityFailure(websiteToken: string, storage: Storage): void {
	try {
		storage.setItem(`${IDENTITY_FAILURE_PREFIX}${websiteToken}`, "1");
	} catch {}
}

function clean(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized || undefined;
}

export function resolveChatwootIdentity(user: {
	id: string;
	fullName: string | null;
	primaryEmailAddress: { emailAddress: string } | null;
}): ChatwootIdentity | null {
	const id = clean(user.id);
	const email = clean(user.primaryEmailAddress?.emailAddress);
	if (!id || !email) return null;
	return {
		id,
		name: clean(user.fullName) ?? email,
		email,
	};
}

export function startChatwoot(
	runtime: ChatwootRuntime,
	config: { baseUrl: string; websiteToken: string },
): boolean {
	const baseUrl = clean(config.baseUrl)?.replace(/\/+$/, "");
	const websiteToken = clean(config.websiteToken);
	if (!runtime.chatwootSDK || !baseUrl || !websiteToken) return false;

	runtime.chatwootSettings = CHATWOOT_WIDGET_SETTINGS;
	runtime.chatwootSDK.run({ websiteToken, baseUrl });
	return true;
}

export function applyChatwootIdentity(
	api: ChatwootApi | undefined,
	identity: SignedChatwootIdentity,
	hidden: boolean,
): boolean {
	if (!api?.hasLoaded) return false;
	api.setUser(identity.id, {
		name: identity.name,
		email: identity.email,
		identifier_hash: identity.identifierHash,
	});
	if (hidden && api.isOpen) api.toggle();
	api.toggleBubbleVisibility(hidden ? "hide" : "show");
	return true;
}

export function setChatwootBubbleVisibility(
	api: ChatwootApi | undefined,
	hidden: boolean,
): boolean {
	if (!api?.hasLoaded) return false;
	if (hidden && api.isOpen) api.toggle();
	api.toggleBubbleVisibility(hidden ? "hide" : "show");
	return true;
}

function sessionNeedsReset(
	store: ChatwootSessionStore,
	websiteToken: string,
	currentUserId: string | null,
	activeUserId: string | null,
): boolean {
	const marker = store.readIdentity(websiteToken);
	if (activeUserId !== null && (activeUserId !== currentUserId || marker === null)) return true;
	if (marker !== null) return marker !== currentUserId;
	return store.hasSessionCookie(websiteToken);
}

export function createChatwootSessionController({
	websiteToken,
	readApi,
	store,
	reload,
}: {
	websiteToken: string;
	readApi: () => ChatwootApi | undefined;
	store: ChatwootSessionStore;
	reload: () => void;
}) {
	const controllerGeneration = identityGeneration;
	let activeUserId: string | null = null;
	let reloading = false;
	const failClosed = (): ChatwootSessionSyncResult => {
		if (reloading) return "reloading";
		reloading = true;
		invalidateChatwootIdentity();
		const api = readApi();
		if (api?.hasLoaded) {
			if (api.isOpen) api.toggle();
			api.toggleBubbleVisibility("hide");
			api.reset();
		}
		activeUserId = null;
		store.clearIdentity(websiteToken);
		reload();
		return "reloading";
	};
	return {
		failClosed,
		needsSdk(currentUserId: string | null): boolean {
			if (reloading || identityGeneration !== controllerGeneration) return false;
			return sessionNeedsReset(store, websiteToken, currentUserId, activeUserId);
		},
		sync(
			identity: SignedChatwootIdentity | null,
			currentUserId: string | null,
			hidden: boolean,
		): ChatwootSessionSyncResult {
			if (reloading || identityGeneration !== controllerGeneration) return "reloading";
			const api = readApi();
			if (!api?.hasLoaded) return "waiting";
			if (sessionNeedsReset(store, websiteToken, currentUserId, activeUserId)) {
				return failClosed();
			}
			if (!identity) {
				if (api.isOpen) api.toggle();
				api.toggleBubbleVisibility("hide");
				return "anonymous";
			}
			if (activeUserId === identity.id) {
				setChatwootBubbleVisibility(api, hidden);
				return "identified";
			}
			applyChatwootIdentity(api, identity, hidden);
			activeUserId = identity.id;
			store.writeIdentity(websiteToken, identity.id);
			return "identified";
		},
	};
}

export function createChatwootToggleQueue({
	readApi,
	subscribeReady,
}: {
	readApi: () => ChatwootApi | undefined;
	subscribeReady: (listener: () => void) => () => void;
}) {
	let pending = false;
	let unsubscribeReady: (() => void) | null = null;

	const flush = () => {
		const api = readApi();
		if (!pending || !api?.hasLoaded) return;
		api.toggle();
		pending = false;
		unsubscribeReady?.();
		unsubscribeReady = null;
	};

	return {
		request(): void {
			pending = true;
			flush();
			if (!pending || unsubscribeReady) return;
			unsubscribeReady = subscribeReady(flush);
		},
	};
}

export function shouldHideChatwoot(pathname: string): boolean {
	if (pathname === "/deploy" || /^\/terminal\/[^/]+\/?$/.test(pathname)) return true;
	const section = parseAgentPathname(pathname)?.section;
	return section === "console" || section === "files" || section === "terminal";
}

export function getChatwootIdentityMarkerKey(websiteToken: string): string {
	return `${IDENTITY_MARKER_PREFIX}${websiteToken}`;
}

export function watchChatwootIdentityStorage(
	browser: Pick<Window, "addEventListener" | "removeEventListener">,
	websiteToken: string,
	onChange: () => void,
): () => void {
	const markerKey = getChatwootIdentityMarkerKey(websiteToken);
	const handleStorage = (event: StorageEvent) => {
		if (event.key === markerKey || event.key === null) onChange();
	};
	browser.addEventListener("storage", handleStorage as EventListener);
	return () => browser.removeEventListener("storage", handleStorage as EventListener);
}

export const browserChatwootSessionStore: ChatwootSessionStore = {
	readIdentity(websiteToken) {
		try {
			return window.localStorage.getItem(getChatwootIdentityMarkerKey(websiteToken));
		} catch {
			return null;
		}
	},
	writeIdentity(websiteToken, userId) {
		try {
			window.localStorage.setItem(getChatwootIdentityMarkerKey(websiteToken), userId);
		} catch {}
	},
	clearIdentity(websiteToken) {
		try {
			window.localStorage.removeItem(getChatwootIdentityMarkerKey(websiteToken));
		} catch {}
	},
	hasSessionCookie(websiteToken) {
		const cookieName = `cw_user_${websiteToken}=`;
		return document.cookie.split(";").some((cookie) => cookie.trim().startsWith(cookieName));
	},
};

export function resetChatwootBeforeSignOut(
	runtime: ChatwootRuntime,
	websiteToken: string | undefined,
	store: ChatwootSessionStore = browserChatwootSessionStore,
): void {
	const normalizedToken = clean(websiteToken);
	if (!normalizedToken) return;
	invalidateChatwootIdentity();
	const api = runtime.$chatwoot;
	if (api?.hasLoaded) {
		if (api.isOpen) api.toggle();
		api.toggleBubbleVisibility("hide");
		// Chatwoot's reset keeps this cache and replays it when the iframe reloads.
		// Clear it synchronously before reset so a departing identity cannot return.
		api.user = undefined;
		api.reset();
	}
	store.clearIdentity(normalizedToken);
}

let browserToggleQueue: ReturnType<typeof createChatwootToggleQueue> | null = null;

export function requestChatwootToggle(): void {
	browserToggleQueue ??= createChatwootToggleQueue({
		readApi: () => window.$chatwoot,
		subscribeReady: (listener) => {
			window.addEventListener("chatwoot:ready", listener);
			return () => window.removeEventListener("chatwoot:ready", listener);
		},
	});
	browserToggleQueue.request();
}

declare global {
	interface Window {
		chatwootSDK?: ChatwootSdk;
		$chatwoot?: ChatwootApi;
		chatwootSettings?: ChatwootWidgetSettings;
	}
}
