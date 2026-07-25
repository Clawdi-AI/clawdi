"use client";

import { useQuery } from "@tanstack/react-query";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import { billingQueryRetry } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";
import { walletSnapshotForCache } from "@/hosted/billing/wallet/wallet-cache";

/** Wallet polling whose query function projects out secrets before caching. */
export function useWalletSnapshot({ enabled = true }: { enabled?: boolean } = {}) {
	const client = useBillingClient();
	return useQuery({
		queryKey: billingKeys.wallet,
		queryFn: async () => walletSnapshotForCache(await client.getWallet()),
		enabled: isDeployApiConfigured() && enabled,
		retry: billingQueryRetry,
		refetchInterval: 30_000,
	});
}
