/**
 * Native channel providers that can be created from the v2 channels UI. Each
 * takes different real connect inputs:
 *   - telegram:  bot token (BotFather)                → provider_token
 *   - discord:   bot token + application_id + interactions public_key
 *                                                       → provider_token + config
 *   - whatsapp:  no token; agent/device linking is gated during the beta
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
	tokenPlaceholder?: string;
	setupUrl?: string;
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
		tokenPlaceholder: "123456:ABC-DEF…",
		setupUrl: "https://t.me/BotFather",
	},
	discord: {
		id: "discord",
		label: "Discord",
		tint: "bg-identity-5-bg text-identity-5-fg",
		connect: "discord",
		tokenPlaceholder: "Bot token",
		setupUrl: "https://discord.com/developers/applications",
	},
	whatsapp: {
		id: "whatsapp",
		label: "WhatsApp",
		tint: "bg-identity-2-bg text-identity-2-fg",
		connect: "whatsapp",
	},
};

function unknownProviderMeta(id: string): ChannelProviderMeta {
	return {
		id,
		label: id || "Channel",
		tint: "bg-muted text-muted-foreground",
		unavailable: true,
	};
}

export function providerMeta(id: string): ChannelProviderMeta {
	return PROVIDER_META[id as ChannelProviderId] ?? unknownProviderMeta(id);
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
