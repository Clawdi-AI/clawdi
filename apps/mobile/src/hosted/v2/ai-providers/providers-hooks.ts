import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

export function useProviderInventory() {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { aiProviders } = useMobileApi();
	return useQuery({
		queryKey: accountQueryKey(scope, "ai-providers"),
		queryFn: ({ signal }) => read((lease) => aiProviders.list(lease), signal),
		enabled: scope.isReady,
		retry: false,
	});
}
export function useRefreshProviders() {
	const scope = useAccountScope();
	const cache = useQueryClient();
	return async () => {
		await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
	};
}
