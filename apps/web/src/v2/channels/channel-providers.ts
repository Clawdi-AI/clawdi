/**
 * The four native channel providers (backend `CHANNEL_PROVIDERS`). Each takes
 * DIFFERENT real connect inputs — grounded in cloud-api:
 *   - telegram:  bot token (BotFather)                → provider_token
 *   - discord:   bot token + application_id + public_key (+ optional guild_id)
 *                                                       → provider_token + config
 *   - whatsapp:  NO token — Baileys device link via the tenant-creds flow
 *   - imessage:  BlueBubbles server_url + password (+ auth_mode)
 *                                                       → provider_token + config
 * Tints reuse the app identity palette so channel chips match the chrome.
 */
export const CHANNEL_PROVIDERS = ["telegram", "discord", "whatsapp", "imessage"] as const;
export type ChannelProviderId = (typeof CHANNEL_PROVIDERS)[number];

/** How the connect form behaves for this provider. */
export type ChannelConnectMode = "token" | "discord" | "whatsapp" | "imessage";

export interface ChannelProviderMeta {
	id: ChannelProviderId;
	label: string;
	tint: string;
	connect: ChannelConnectMode;
	/** Label/placeholder for the single credential field (token / password). */
	tokenLabel?: string;
	tokenPlaceholder?: string;
	hint: string;
}

export const PROVIDER_META: Record<ChannelProviderId, ChannelProviderMeta> = {
	telegram: {
		id: "telegram",
		label: "Telegram",
		tint: "bg-identity-3-bg text-identity-3-fg",
		connect: "token",
		tokenLabel: "Bot token",
		tokenPlaceholder: "123456:ABC-DEF…",
		hint: "Create a bot with @BotFather and paste its token.",
	},
	discord: {
		id: "discord",
		label: "Discord",
		tint: "bg-identity-5-bg text-identity-5-fg",
		connect: "discord",
		tokenLabel: "Bot token",
		tokenPlaceholder: "Bot token",
		hint: "From the Discord developer portal: the bot token, plus the application ID and public key for slash commands and interactions.",
	},
	whatsapp: {
		id: "whatsapp",
		label: "WhatsApp",
		tint: "bg-identity-2-bg text-identity-2-fg",
		connect: "whatsapp",
		hint: "No bot token — connect, then link your WhatsApp number by scanning a code (Linked devices).",
	},
	imessage: {
		id: "imessage",
		label: "iMessage",
		tint: "bg-identity-6-bg text-identity-6-fg",
		connect: "imessage",
		tokenLabel: "BlueBubbles password",
		tokenPlaceholder: "Server password",
		hint: "Connect your BlueBubbles server — its URL and password.",
	},
};

/** BlueBubbles auth modes the backend understands (channels.py `_send_imessage`). */
export const IMESSAGE_AUTH_MODES = [
	{ value: "password_query", label: "Password (query)" },
	{ value: "x_api_key", label: "API key header" },
	{ value: "bearer", label: "Bearer token" },
] as const;

const DEFAULT_PROVIDER_META: ChannelProviderMeta = {
	id: "telegram",
	label: "Channel",
	tint: "bg-muted text-muted-foreground",
	connect: "token",
	hint: "",
};

export function providerMeta(id: string): ChannelProviderMeta {
	return PROVIDER_META[id as ChannelProviderId] ?? { ...DEFAULT_PROVIDER_META, label: id };
}

export function isChannelProvider(id: string): id is ChannelProviderId {
	return (CHANNEL_PROVIDERS as readonly string[]).includes(id);
}
