import { useInfiniteQuery } from "@tanstack/react-query";
import { nextBillingCursor } from "@/hosted/billing/format";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

function initialCursor(): string | undefined {
	return undefined;
}

export function useSubscriptions(enabled = true) {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "billing-subscriptions"),
		initialPageParam: initialCursor(),
		queryFn: ({ signal, pageParam }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getSubscriptions({ limit: 25, cursor: pageParam }, s);
			}, signal),
		getNextPageParam: nextBillingCursor,
		enabled: scope.isReady && Boolean(compute) && enabled,
		retry: false,
	});
}
