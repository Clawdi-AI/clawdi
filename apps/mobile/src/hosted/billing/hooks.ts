import {
	computeSubscriptionsRecoveryRefetchInterval,
	loadReusableSubscriptions,
	nextBillingCursor,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router/react-navigation";
import { useMobileApi } from "@/lib/api-provider";
import { transientQueryRetry } from "@/lib/query-retry";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

function initialCursor(): string | undefined {
	return undefined;
}

export function useSubscriptions(enabled = true) {
	const focused = useIsFocused();
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
		refetchInterval: (query) =>
			focused
				? computeSubscriptionsRecoveryRefetchInterval(
						query.state.data?.pages.flatMap((page) => page.items ?? []),
					)
				: false,
		refetchIntervalInBackground: false,
		enabled: scope.isReady && Boolean(compute) && enabled,
		...transientQueryRetry,
	});
}

/** Web's `usePlans`: the compute plan catalog. */
export function usePlans() {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "billing-plans"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.listPlans(s);
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
}

/** One Wallet read for the Overview header, welcome card and Wallet page. */
export function useWallet() {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "billing-wallet"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getWallet(s);
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		...transientQueryRetry,
	});
}

/** Web's reusable inventory, every page: it alone decides "Available for a new agent". */
export function useReusableSubscriptions() {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "billing-reusable"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return loadReusableSubscriptions((limit, cursor) =>
					compute.getReusableSubscriptions({ limit, cursor }, s),
				);
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		staleTime: 30_000,
		...transientQueryRetry,
	});
}
