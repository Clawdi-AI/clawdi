/**
 * Native channel providers that can be created from the v2 channels UI. Each
 * takes different real connect inputs:
 *   - telegram:  bot token (BotFather)                → provider_token
 *   - discord:   bot token + application_id + public_key (+ optional guild_id)
 *                                                       → provider_token + config
 *   - whatsapp:  NO token — Baileys device link via the tenant-creds flow
 * Tints reuse the app identity palette so channel chips match the chrome.
 */
export const CHANNEL_PROVIDERS = ["telegram", "discord", "whatsapp"] as const;
export type ChannelProviderId = (typeof CHANNEL_PROVIDERS)[number];

/** How the connect form behaves for this provider. */
export type ChannelConnectMode = "token" | "discord" | "whatsapp";

export interface ChannelProviderMeta {
	id: string;
	label: string;
	tint: string;
	connect?: ChannelConnectMode;
	/** Label/placeholder for the single credential field (token / password). */
	tokenLabel?: string;
	tokenPlaceholder?: string;
	hint: string;
	unavailable?: boolean;
}

export type SupportedChannelProviderMeta = ChannelProviderMeta & {
	id: ChannelProviderId;
	connect: ChannelConnectMode;
	unavailable?: false;
};

export const PROVIDER_META: Record<ChannelProviderId, SupportedChannelProviderMeta> = {
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
};

const LEGACY_PROVIDER_META: Record<string, ChannelProviderMeta> = {
	imessage: {
		id: "imessage",
		label: "iMessage (unavailable)",
		tint: "bg-muted text-muted-foreground",
		hint: "iMessage native channels are no longer available in this surface.",
		unavailable: true,
	},
};

function unknownProviderMeta(id: string): ChannelProviderMeta {
	return {
		id,
		label: id || "Channel",
		tint: "bg-muted text-muted-foreground",
		hint: "This channel provider is no longer available in this surface.",
		unavailable: true,
	};
}

export function providerMeta(id: string): ChannelProviderMeta {
	return (
		PROVIDER_META[id as ChannelProviderId] ?? LEGACY_PROVIDER_META[id] ?? unknownProviderMeta(id)
	);
}

export function isChannelProvider(id: string): id is ChannelProviderId {
	return (CHANNEL_PROVIDERS as readonly string[]).includes(id);
}

export function orderedProviderIds(providers: Iterable<string>): string[] {
	const providerList = Array.from(providers);
	const present = new Set(providerList);
	const ordered: string[] = CHANNEL_PROVIDERS.filter((provider) => present.has(provider));

	for (const provider of providerList) {
		if (!isChannelProvider(provider) && !ordered.includes(provider)) {
			ordered.push(provider);
		}
	}

	return ordered;
}
