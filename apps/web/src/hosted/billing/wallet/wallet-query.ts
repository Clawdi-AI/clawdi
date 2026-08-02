"use client";

import { useQuery } from "@tanstack/react-query";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import { billingQueryRetry } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";
import { walletSnapshotForCache } from "@/hosted/billing/wallet/wallet-cache";

export const WALLET_SNAPSHOT_REFRESH_INTERVAL_MS = 30_000;

type WalletSnapshotClient = Pick<ReturnType<typeof useBillingClient>, "getWallet">;

export function walletSnapshotQueryOptions(
	client: WalletSnapshotClient,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return {
		queryKey: billingKeys.wallet,
		queryFn: async () => walletSnapshotForCache(await client.getWallet()),
		enabled: isDeployApiConfigured() && enabled,
		retry: billingQueryRetry,
		// A second observer (for example Settings → Wallet) should reuse the
		// global header snapshot instead of paying for an immediate mount refetch.
		staleTime: WALLET_SNAPSHOT_REFRESH_INTERVAL_MS,
		refetchInterval: WALLET_SNAPSHOT_REFRESH_INTERVAL_MS,
		refetchIntervalInBackground: false,
	};
}

/** Wallet polling whose query function projects out secrets before caching. */
export function useWalletSnapshot({ enabled = true }: { enabled?: boolean } = {}) {
	const client = useBillingClient();
	return useQuery(walletSnapshotQueryOptions(client, { enabled }));
}
