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

/** Flatten the ready-bot pool with the same ordering semantics as personal channels. */
export function orderedPoolItemsForFilter<T extends Pick<ChannelBotPoolItem, "provider">>(
	providers: Readonly<Record<string, readonly T[]>>,
	filter: ChannelProviderFilter,
): T[] {
	const providerIds = filter === "all" ? orderedProviderIds(Object.keys(providers)) : [filter];
	return providerIds.flatMap((provider) => providers[provider] ?? []);
}

export function dedupeBotPoolProviders(
	channels: readonly Pick<ChannelAccount, "id">[],
	poolProviders: Record<string, ChannelBotPoolItem[]>,
): Record<string, ChannelBotPoolItem[]> {
	const seenIds = new Set(channels.map((channel) => channel.id));
	const deduped: Record<string, ChannelBotPoolItem[]> = {};
	for (const [provider, items] of Object.entries(poolProviders)) {
		deduped[provider] = items.filter((item) => {
			if (seenIds.has(item.id)) return false;
			seenIds.add(item.id);
			return true;
		});
	}
	return deduped;
}

export function providerCounts(
	channels: readonly Pick<ChannelAccount, "provider">[],
	poolProviders: Record<string, ChannelBotPoolItem[]>,
): Record<ChannelProviderId, number> {
	const counts: Record<ChannelProviderId, number> = {
		telegram: 0,
		discord: 0,
		whatsapp: 0,
	};
	for (const channel of channels) {
		if (isKnownProvider(channel.provider)) counts[channel.provider] += 1;
	}
	for (const provider of CHANNEL_PROVIDERS) {
		counts[provider] += poolProviders[provider]?.length ?? 0;
	}
	return counts;
}

function isKnownProvider(provider: string): provider is ChannelProviderId {
	return (CHANNEL_PROVIDERS as readonly string[]).includes(provider);
}
