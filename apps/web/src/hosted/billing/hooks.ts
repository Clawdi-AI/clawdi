"use client";

import {
	keepPreviousData,
	type UseQueryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import type {
	CheckoutRequest,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionResumeRequest,
	DeployRequest,
	PortalRequest,
	WalletAutoReloadRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import { billingQueryRetry } from "@/hosted/billing/errors";

export const billingKeys = {
	wallet: ["billing", "wallet"] as const,
	ledger: (limit: number) => ["billing", "ledger", limit] as const,
	plans: ["billing", "plans"] as const,
	deployments: ["billing", "deployments"] as const,
	me: ["billing", "me"] as const,
	usage: ["billing", "usage"] as const,
};

/**
 * Shared billing read: gates fetches on `isDeployApiConfigured()` and applies
 * the transient-only `billingQueryRetry` so deterministic 4xx (auth,
 * validation, not-found, conflict) surface immediately. Per-query options (staleTime,
 * refetchInterval, placeholderData) are spread last and override the defaults.
 */
function useBillingQuery<TData>(
	options: UseQueryOptions<TData, Error, TData> & { queryFn: () => Promise<TData> },
) {
	return useQuery({ enabled: isDeployApiConfigured(), retry: billingQueryRetry, ...options });
}

export function useHostedUser() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.me,
		queryFn: () => client.getMe(),
		staleTime: 5 * 60_000,
	});
}

// ── Wallet ───────────────────────────────────────────────────────────────────

/**
 * Wallet balance + auto-reload config. The balance is a sub2api snapshot, so
 * it can lag a few seconds — poll every 30s to keep it reasonably fresh while
 * the page is open. `billingQueryRetry` keeps deterministic 4xx failures
 * surfacing immediately while still absorbing transient 5xx / network blips
 * with up to two retries.
 */
export function useWallet() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.wallet,
		queryFn: () => client.getWallet(),
		refetchInterval: 30_000,
	});
}

export function useWalletLedger(limit = 50) {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.ledger(limit),
		queryFn: () => client.getLedger(limit),
		// Bumping the limit ("Show more") keeps the current rows on screen
		// instead of flashing the skeleton while the larger page loads.
		placeholderData: keepPreviousData,
	});
}

export function useTopUp() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ body, idempotencyKey }: { body: WalletTopupRequest; idempotencyKey: string }) =>
			client.topUp(body, idempotencyKey),
		onSuccess: () => {
			// Refetch both balance and activity so a fresh top-up never shows a
			// stale balance or an empty ledger.
			qc.invalidateQueries({ queryKey: billingKeys.wallet });
			qc.invalidateQueries({ queryKey: ["billing", "ledger"] });
		},
	});
}

export function useSetAutoReload() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: WalletAutoReloadRequest) => client.setAutoReload(body),
		onSuccess: (next) => {
			qc.setQueryData(billingKeys.wallet, next);
			qc.invalidateQueries({ queryKey: billingKeys.wallet });
		},
	});
}

// ── Subscription / compute ────────────────────────────────────────────────────

export function usePlans() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.plans,
		queryFn: () => client.getPlans(),
		staleTime: 5 * 60_000,
	});
}

export function useCheckout() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (body: CheckoutRequest) => client.checkout(body),
	});
}

export function useCancelSubscription() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: ComputeSubscriptionCancelRequest) => client.cancelSubscription(body),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
		},
	});
}

export function usePortal() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (body: PortalRequest) => client.portal(body),
	});
}

export function useResumeSubscription() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: ComputeSubscriptionResumeRequest) => client.resumeSubscription(body),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
		},
	});
}

// ── Usage ────────────────────────────────────────────────────────────────────

export function useUsage() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.usage,
		queryFn: () => client.getUsage(),
	});
}

// ── Deployments ────────────────────────────────────────────────────────────────

function hasTransientDeployment(items: { status: string }[] | undefined): boolean {
	return (items ?? []).some(
		(d) => d.status === "pending" || d.status === "provisioning" || d.status === "starting",
	);
}

export function useHostedDeployments() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.deployments,
		queryFn: () => client.listDeployments(),
		refetchInterval: (q) => (hasTransientDeployment(q.state.data) ? 10_000 : false),
	});
}

export function useCreateDeployment() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: DeployRequest) => client.createDeployment(body),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
		},
	});
}
