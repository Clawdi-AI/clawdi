import { CHATWOOT_LOCALE, type ChatwootIdentity } from "@clawdi/shared/view";

/** What support sees on the conversation, as Web's `openChatwootWithContext` sets it. */
export type SupportChatContext = Readonly<{
	conversationAttributes: Readonly<Record<string, string | number>>;
	/** Applied only when the label exists in the Chatwoot account. */
	label: string;
}>;

/** Route params for the live chat sheet; only strings survive navigation. */
export type SupportChatParams = { label?: string; attributes?: string };

export function supportChatParams(context?: SupportChatContext): SupportChatParams {
	return context
		? { label: context.label, attributes: JSON.stringify(context.conversationAttributes) }
		: {};
}

export function supportChatContext(params: SupportChatParams): SupportChatContext | null {
	if (!params.label || !params.attributes) return null;
	let attributes: unknown;
	try {
		attributes = JSON.parse(params.attributes);
	} catch {
		return null;
	}
	if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes))
		return null;
	const entries = Object.entries(attributes);
	if (!entries.every(([, value]) => typeof value === "string" || typeof value === "number"))
		return null;
	return { label: params.label, conversationAttributes: Object.fromEntries(entries) };
}

/** Chatwoot's widget page, loaded the way the official React Native widget loads it. */
export function chatwootWidgetUrl({
	baseUrl,
	websiteToken,
}: {
	baseUrl: string;
	websiteToken: string;
}): string {
	return `${baseUrl}/widget?website_token=${encodeURIComponent(websiteToken)}&locale=${CHATWOOT_LOCALE}`;
}

const WIDGET_MESSAGE_PREFIX = "chatwoot-widget:";

/**
 * Runs after the widget page loads. The widget page listens for the Web SDK's prefixed
 * postMessage events; the official React Native widget sends set-user, set-locale and
 * set-color-scheme the same way. Contact support's context adds Web's conversation
 * attributes and label. Each message is a JSON string literal, so values cannot escape it.
 */
export function chatwootWidgetScript({
	identity,
	identifierHash,
	colorScheme,
	context,
}: {
	identity: ChatwootIdentity;
	identifierHash: string;
	colorScheme: "light" | "dark";
	context: SupportChatContext | null;
}): string {
	const events = [
		{
			event: "set-user",
			identifier: identity.id,
			user: {
				name: identity.name,
				email: identity.email,
				...(identity.avatarUrl ? { avatar_url: identity.avatarUrl } : {}),
				identifier_hash: identifierHash,
			},
		},
		{ event: "set-locale", locale: CHATWOOT_LOCALE },
		{ event: "set-color-scheme", darkMode: colorScheme },
		...(context
			? [
					{
						event: "set-conversation-custom-attributes",
						customAttributes: context.conversationAttributes,
					},
					{ event: "set-label", label: context.label },
				]
			: []),
	];
	return `${events
		.map(
			(event) =>
				`window.postMessage(${JSON.stringify(`${WIDGET_MESSAGE_PREFIX}${JSON.stringify(event)}`)}, "*");`,
		)
		.join("\n")}\ntrue;`;
}

/** The widget's own close button, reported through `window.ReactNativeWebView`. */
export function isChatwootCloseMessage(data: string): boolean {
	try {
		const message: unknown = JSON.parse(data.replace(WIDGET_MESSAGE_PREFIX, ""));
		return (
			typeof message === "object" &&
			message !== null &&
			"type" in message &&
			message.type === "close-widget"
		);
	} catch {
		return false;
	}
}

/** The widget stays on its own origin; links and attachments open in the browser instead. */
export function isChatwootWidgetUrl(url: string, baseUrl: string): boolean {
	return url === baseUrl || url.startsWith(`${baseUrl}/`) || url.startsWith("about:");
}
