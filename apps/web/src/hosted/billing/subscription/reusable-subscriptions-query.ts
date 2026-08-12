import { queryOptions, useQuery } from "@tanstack/react-query";
import type { BillingClient } from "@/hosted/billing/billing-client";
import type { ReusableSubscription } from "@/hosted/billing/contracts";
import { billingQueryRetry } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";

export async function loadReusableSubscriptions(
	getPage: BillingClient["getReusableSubscriptions"],
): Promise<ReusableSubscription[]> {
	const items: ReusableSubscription[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | null | undefined;
	while (cursor !== null) {
		const page = await getPage(100, cursor);
		items.push(...(page.items ?? []));
		if (!page.has_more) {
			cursor = null;
			continue;
		}
		const nextCursor = page.next_cursor?.trim();
		if (!nextCursor || seenCursors.has(nextCursor)) {
			throw new Error("Reusable subscription pagination returned an invalid cursor.");
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
	return items;
}

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
