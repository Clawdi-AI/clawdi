import { parseAgentPathname } from "@/lib/agent-routes";

// Official Website SDK surface: https://www.chatwoot.com/hc/user-guide/articles/1677587234
export type ChatwootSettings = Readonly<{
	hideMessageBubble: boolean;
	position: "left" | "right";
	type: "standard" | "expanded_bubble";
	widgetStyle: "standard" | "flat";
	darkMode: "light" | "auto";
	useBrowserLanguage: boolean;
}>;

export type ChatwootApi = {
	hasLoaded: boolean;
	setUser: (
		identifier: string,
		user: { name: string; email: string; identifier_hash: string },
	) => void;
	reset: () => void;
	toggle: (state?: "open" | "close") => void;
	toggleBubbleVisibility: (visibility: "hide" | "show") => void;
};

export type ChatwootIdentity = Readonly<{
	id: string;
	name: string;
	email: string;
}>;

// The bubble stays hidden until the signed-in user has been identified.
export const CHATWOOT_SETTINGS = {
	hideMessageBubble: true,
	position: "right",
	type: "standard",
	widgetStyle: "standard",
	darkMode: "auto",
	useBrowserLanguage: true,
} as const satisfies ChatwootSettings;

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

export function shouldHideChatwoot(pathname: string): boolean {
	if (pathname === "/deploy" || /^\/terminal\/[^/]+\/?$/.test(pathname)) return true;
	const section = parseAgentPathname(pathname)?.section;
	return section === "console" || section === "files" || section === "terminal";
}

/** Opens the widget, waiting for `chatwoot:ready` when the SDK is still loading. */
export function openChatwoot(): void {
	if (window.$chatwoot?.hasLoaded) {
		window.$chatwoot.toggle("open");
		return;
	}
	window.addEventListener("chatwoot:ready", () => window.$chatwoot?.toggle("open"), {
		once: true,
	});
}

/** Chatwoot's documented logout step: clears the widget contact and conversation cookies. */
export function resetChatwoot(): void {
	if (typeof window === "undefined" || !window.$chatwoot?.hasLoaded) return;
	window.$chatwoot.reset();
}

declare global {
	interface Window {
		chatwootSDK?: { run: (config: { websiteToken: string; baseUrl: string }) => void };
		chatwootSettings?: ChatwootSettings;
		$chatwoot?: ChatwootApi;
	}
}
