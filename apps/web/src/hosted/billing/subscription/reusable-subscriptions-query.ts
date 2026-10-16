import { loadReusableSubscriptions } from "@clawdi/shared/view";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { BillingClient } from "@/hosted/billing/billing-client";
import { billingQueryRetry } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";

export function reusableSubscriptionsQueryOptions(client: BillingClient, enabled = true) {
	return queryOptions({
		queryKey: billingKeys.reusableSubscriptions,
		queryFn: () => loadReusableSubscriptions(client.getReusableSubscriptions),
		enabled,
		retry: billingQueryRetry,
		staleTime: 30_000,
	});
}

export function useReusableSubscriptions(client: BillingClient, enabled = true) {
	return useQuery(reusableSubscriptionsQueryOptions(client, enabled));
}
