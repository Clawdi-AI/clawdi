import * as Sentry from "@sentry/tanstackstart-react";
import { parseAgentPathname } from "@/lib/agent-routes";

// Official Website SDK surface: https://www.chatwoot.com/hc/user-guide/articles/1677587234
export type ChatwootSettings = Readonly<{
	hideMessageBubble: boolean;
	position: "left" | "right";
	type: "standard" | "expanded_bubble";
	widgetStyle: "standard" | "flat";
	darkMode: "light" | "dark" | "auto";
	locale: string;
}>;

export type ChatwootApi = {
	hasLoaded: boolean;
	darkMode: ChatwootSettings["darkMode"];
	setUser: (
		identifier: string,
		user: { name: string; email: string; avatar_url?: string; identifier_hash: string },
	) => void;
	reset: () => void;
	toggle: (state?: "open" | "close") => void;
	/** Attributes for the current conversation, or queued for the next one. */
	setConversationCustomAttributes: (attributes: Record<string, string | number>) => void;
	/** Applied only when the label exists in the Chatwoot account. */
	setLabel: (label: string) => void;
	toggleBubbleVisibility: (visibility: "hide" | "show") => void;
	setColorScheme: (scheme: ChatwootSettings["darkMode"]) => void;
};

export type ChatwootIdentity = Readonly<{
	id: string;
	name: string;
	email: string;
	avatarUrl?: string;
}>;

// The bubble stays hidden until the signed-in user has been identified.
export const CHATWOOT_SETTINGS = {
	hideMessageBubble: true,
	position: "right",
	type: "standard",
	widgetStyle: "standard",
	darkMode: "auto",
	// Support runs in English, and Chatwoot writes its system messages in the widget locale.
	locale: "en",
} as const satisfies ChatwootSettings;

function clean(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized || undefined;
}

// Chatwoot downloads the avatar server-side, so only https URLs are shared.
function resolveAvatarUrl(imageUrl: string): string | undefined {
	const value = clean(imageUrl);
	if (!value || !URL.canParse(value)) return undefined;
	return new URL(value).protocol === "https:" ? value : undefined;
}

export function resolveChatwootIdentity(user: {
	id: string;
	fullName: string | null;
	primaryEmailAddress: { emailAddress: string } | null;
	imageUrl: string;
}): ChatwootIdentity | null {
	const id = clean(user.id);
	const email = clean(user.primaryEmailAddress?.emailAddress);
	if (!id || !email) return null;
	const avatarUrl = resolveAvatarUrl(user.imageUrl);
	return {
		id,
		name: clean(user.fullName) ?? email,
		email,
		...(avatarUrl ? { avatarUrl } : {}),
	};
}

export function shouldHideChatwoot(pathname: string): boolean {
	if (pathname === "/deploy" || /^\/terminal\/[^/]+\/?$/.test(pathname)) return true;
	const section = parseAgentPathname(pathname)?.section;
	return section === "console" || section === "files" || section === "terminal";
}

/** Live chat loads only in hosted Web builds with a configured widget. */
export const CHATWOOT_LIVE_CHAT_AVAILABLE =
	import.meta.env.VITE_CLAWDI_HOSTED === "true" &&
	import.meta.env.VITE_CLAWDI_DESKTOP_BUILD !== "true" &&
	Boolean(import.meta.env.VITE_CHATWOOT_BASE_URL && import.meta.env.VITE_CHATWOOT_WEBSITE_TOKEN);

function whenChatwootReady(run: (chatwoot: ChatwootApi) => void): void {
	if (window.$chatwoot?.hasLoaded) {
		run(window.$chatwoot);
		return;
	}
	window.addEventListener(
		"chatwoot:ready",
		() => {
			if (window.$chatwoot) run(window.$chatwoot);
		},
		{ once: true },
	);
}

/** Opens the widget, waiting for `chatwoot:ready` when the SDK is still loading. */
export function openChatwoot(): void {
	whenChatwootReady((chatwoot) => chatwoot.toggle("open"));
}

/**
 * Opens the widget with context for support: conversation attributes and a label,
 * which Chatwoot attaches to the conversation the visitor starts or continues.
 */
export function openChatwootWithContext(context: {
	conversationAttributes: Record<string, string | number>;
	label: string;
}): void {
	whenChatwootReady((chatwoot) => {
		try {
			chatwoot.setConversationCustomAttributes(context.conversationAttributes);
			chatwoot.setLabel(context.label);
		} catch (error: unknown) {
			Sentry.captureException(error);
		}
		chatwoot.toggle("open");
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
