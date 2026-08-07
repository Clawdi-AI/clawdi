import {
	CHANNEL_PROVIDERS,
	type ChannelProviderId,
	orderedProviderIds,
} from "@/hosted/v2/channels/channel-providers";
import type { ChannelAccount, ChannelBotPoolItem } from "@/hosted/v2/channels/channel-types";

export type ChannelProviderFilter = "all" | ChannelProviderId;

/** Flatten provider groups in canonical provider order while preserving item order within each provider. */
export function orderedChannelsForFilter<T extends Pick<ChannelAccount, "provider">>(
	channels: readonly T[],
	filter: ChannelProviderFilter,
): T[] {
	const providerIds =
		filter === "all" ? orderedProviderIds(channels.map((channel) => channel.provider)) : [filter];
	return providerIds.flatMap((provider) =>
		channels.filter((channel) => channel.provider === provider),
	);
}

export function providerCounts(
	channels: readonly Pick<ChannelAccount, "provider">[],
): Record<ChannelProviderId, number> {
	const counts: Record<ChannelProviderId, number> = {
		telegram: 0,
		discord: 0,
		whatsapp: 0,
	};
	for (const channel of channels) {
		if (isKnownProvider(channel.provider)) counts[channel.provider] += 1;
	}
	return counts;
}

export function providersWithBots(
	counts: Readonly<Record<ChannelProviderId, number>>,
): ChannelProviderId[] {
	return CHANNEL_PROVIDERS.filter((provider) => counts[provider] > 0);
}

export function sharedBotsFromPool(
	providers: Readonly<Record<string, readonly ChannelBotPoolItem[]>> | undefined,
): ChannelBotPoolItem[] {
	if (!providers) return [];
	return orderedProviderIds(Object.keys(providers)).flatMap((provider) =>
		(providers[provider] ?? []).filter((item) => item.access === "public"),
	);
}

function isKnownProvider(provider: string): provider is ChannelProviderId {
	return (CHANNEL_PROVIDERS as readonly string[]).includes(provider);
}
