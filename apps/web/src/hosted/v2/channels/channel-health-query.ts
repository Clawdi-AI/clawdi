import { channelKeys } from "@/hosted/v2/channels/channel-query-cache";

export const CHANNEL_HEALTH_REFETCH_INTERVAL_MS = 20_000;

export function channelHealthQueryOptions<TData>(queryFn: () => Promise<TData>) {
	return {
		queryKey: channelKeys.health,
		queryFn,
		refetchInterval: CHANNEL_HEALTH_REFETCH_INTERVAL_MS,
	};
}
