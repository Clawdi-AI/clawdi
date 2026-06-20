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
	DeployRequest,
	PortalRequest,
	RedeemPreviewRequest,
	RedeemRequest,
	WalletAutoReloadRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import { billingQueryRetry, isWalletNotEnabledError } from "@/hosted/billing/errors";

export const billingKeys = {
	wallet: ["billing", "wallet"] as const,
	ledger: (limit: number) => ["billing", "ledger", limit] as const,
	plans: ["billing", "plans"] as const,
	subscription: ["billing", "subscription"] as const,
	activationFee: ["billing", "activation-fee"] as const,
	deployments: ["billing", "deployments"] as const,
	referralCode: ["billing", "referral-code"] as const,
	referralRewards: ["billing", "referral-rewards"] as const,
	myReferrals: ["billing", "my-referrals"] as const,
	me: ["billing", "me"] as const,
	usage: ["billing", "usage"] as const,
};

/**
 * Shared billing read: gates fetches on `isDeployApiConfigured()` and applies
 * the transient-only `billingQueryRetry` so deterministic 4xx (legacy-wallet
 * 403, auth, validation) surface immediately. Per-query options (staleTime,
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
 * the page is open. `billingQueryRetry` keeps a 403 (legacy / not enrolled)
 * surfacing immediately for `useBillingProfile` (4xx isn't retried) while still
 * absorbing transient 5xx / network blips with up to two retries.
 */
export function useWallet() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.wallet,
		queryFn: () => client.getWallet(),
		refetchInterval: 30_000,
	});
}

/**
 * Derived wallet-vs-legacy gate. `billing_model == "wallet"` isn't on the
 * user profile response, so we read it off the wallet endpoint: 200 = wallet
 * user, 403 "wallet billing is not enabled" = legacy. Shares the wallet
 * query cache (no extra request).
 */
export function useBillingProfile() {
	const wallet = useWallet();
	const isLegacy = isWalletNotEnabledError(wallet.error);
	const isWalletUser = wallet.data != null ? true : isLegacy ? false : null;
	return {
		isWalletUser,
		isLoading: wallet.isLoading,
		// A real error is anything that isn't the expected legacy 403.
		error: isLegacy ? null : wallet.error,
	};
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

export function useSubscription() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.subscription,
		queryFn: () => client.getSubscription(),
	});
}

export function useActivationFee() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.activationFee,
		queryFn: () => client.getActivationFee(),
	});
}

export function useCheckout() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (body: CheckoutRequest) => client.checkout(body),
	});
}

export function usePortal() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: PortalRequest) => client.portal(body),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.subscription });
		},
	});
}

export function useRestoreSubscription() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => client.restoreSubscription(),
		onSuccess: (next) => {
			if (next) qc.setQueryData(billingKeys.subscription, next);
			qc.invalidateQueries({ queryKey: billingKeys.subscription });
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

// ── Redemption ─────────────────────────────────────────────────────────────────

export function useRedeemPreview() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (body: RedeemPreviewRequest) => client.redeemPreview(body),
	});
}

export function useRedeem() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ body, idempotencyKey }: { body: RedeemRequest; idempotencyKey: string }) =>
			client.redeem(body, idempotencyKey),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.subscription });
			qc.invalidateQueries({ queryKey: billingKeys.wallet });
			// A redemption grant lands as a ledger entry too.
			qc.invalidateQueries({ queryKey: ["billing", "ledger"] });
		},
	});
}

// ── Referral ──────────────────────────────────────────────────────────────────

export function useReferralCode() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.referralCode,
		queryFn: () => client.getReferralCode(),
	});
}

export function useReferralRewards() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.referralRewards,
		queryFn: () => client.getReferralRewards(),
		staleTime: 5 * 60_000,
	});
}

export function useMyReferrals() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.myReferrals,
		queryFn: () => client.getMyReferrals(),
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
