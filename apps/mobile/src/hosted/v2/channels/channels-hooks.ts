import type { ChannelClient } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { useMobileApi } from "@/components/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

export function useChannelQuery<T>(
	key: string[],
	query: (client: ChannelClient, signal: AbortSignal) => Promise<T>,
	enabled = true,
) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { channels } = useMobileApi();
	return useQuery({
		queryKey: accountQueryKey(scope, "channels", ...key),
		queryFn: ({ signal }) => read((lease) => query(channels, lease), signal),
		enabled: scope.isReady && enabled,
		retry: false,
	});
}
