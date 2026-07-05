"use client";

import {
	keepPreviousData,
	type QueryClient,
	type UseQueryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import type {
	CheckoutRequest,
	ComputeSubscriptionActionResult,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionResumeRequest,
	DeployRequest,
	HostedDeployment,
	PortalRequest,
	WalletAutoReloadRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import { billingQueryRetry } from "@/hosted/billing/errors";
import { shouldPollDeployments } from "@/hosted/deployment-status";

export const billingKeys = {
	wallet: ["billing", "wallet"] as const,
	ledger: (limit: number) => ["billing", "ledger", limit] as const,
	plans: ["billing", "plans"] as const,
	deployments: ["billing", "deployments"] as const,
	legacyAgentEnvironments: ["billing", "legacy-agent-environments"] as const,
	me: ["billing", "me"] as const,
	usage: ["billing", "usage"] as const,
};

type CheckoutMutationVariables = {
	body: CheckoutRequest;
	idempotencyKey: string;
};

type CreateDeploymentMutationVariables = {
	body: DeployRequest;
	idempotencyKey: string;
};

const CHECKOUT_RETURN_DEPLOYMENT_PARAMS = ["deployment_id", "upgrade_deployment_id"] as const;
const CHECKOUT_RETURN_MARKER_PARAMS = [
	"session_id",
	"checkout_session_id",
	...CHECKOUT_RETURN_DEPLOYMENT_PARAMS,
	"mockCheckout",
] as const;

export function checkoutReturnMarker(searchStr: string): string | null {
	const params = new URLSearchParams(searchStr);
	const values = CHECKOUT_RETURN_MARKER_PARAMS.flatMap((key) => {
		const value = params.get(key);
		return value ? [`${key}=${value}`] : [];
	});
	return values.length > 0 ? values.join("&") : null;
}

export function checkoutReturnDeploymentId(searchStr: string): string | null {
	const params = new URLSearchParams(searchStr);
	for (const key of CHECKOUT_RETURN_DEPLOYMENT_PARAMS) {
		const value = params.get(key);
		if (value) return value;
	}
	return null;
}

function subscriptionFromAction(
	previous: HostedDeployment["compute_subscription"] | null | undefined,
	next: ComputeSubscriptionActionResult,
): NonNullable<HostedDeployment["compute_subscription"]> {
	return {
		...(previous ?? {}),
		status: next.status,
		billing_term_months: next.billing_term_months,
		currency: previous?.currency ?? "usd",
		cancel_at_period_end: next.cancel_at_period_end,
		current_period_end: next.current_period_end ?? previous?.current_period_end ?? null,
		cancel_at: next.cancel_at ?? null,
	};
}

function patchDeploymentSubscription(
	deployments: HostedDeployment[] | undefined,
	deploymentId: string,
	next: ComputeSubscriptionActionResult,
): HostedDeployment[] | undefined {
	if (!deployments) return deployments;
	let patched = false;
	const updated = deployments.map((deployment) => {
		if (deployment.id !== deploymentId) return deployment;
		patched = true;
		return {
			...deployment,
			compute_subscription: subscriptionFromAction(deployment.compute_subscription, next),
		};
	});
	return patched ? updated : deployments;
}

export function applyDeploymentSubscriptionResult(
	qc: QueryClient,
	deploymentId: string,
	next: ComputeSubscriptionActionResult,
): void {
	qc.setQueryData<HostedDeployment[]>(billingKeys.deployments, (deployments) =>
		patchDeploymentSubscription(deployments, deploymentId, next),
	);
}

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
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ body, idempotencyKey }: CheckoutMutationVariables) =>
			client.checkout(body, idempotencyKey),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			qc.invalidateQueries({ queryKey: billingKeys.wallet });
		},
	});
}

export function useCancelSubscription() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: ComputeSubscriptionCancelRequest) => client.cancelSubscription(body),
		onSuccess: (next, body) => {
			applyDeploymentSubscriptionResult(qc, body.deployment_id, next);
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
		onSuccess: (next, body) => {
			applyDeploymentSubscriptionResult(qc, body.deployment_id, next);
		},
	});
}

export function useCheckoutReturnRefresh() {
	const qc = useQueryClient();
	return useCallback(() => refreshCheckoutReturnQueries(qc), [qc]);
}

export async function refreshCheckoutReturnQueries(
	qc: QueryClient,
): Promise<HostedDeployment[] | undefined> {
	const [deploymentsResult] = await Promise.allSettled([
		(async () => {
			await qc.invalidateQueries({
				queryKey: billingKeys.deployments,
				exact: true,
				refetchType: "none",
			});
			await qc.refetchQueries(
				{ queryKey: billingKeys.deployments, exact: true, type: "all" },
				{ throwOnError: true },
			);
		})(),
		(async () => {
			await qc.invalidateQueries({
				queryKey: billingKeys.wallet,
				exact: true,
				refetchType: "none",
			});
			await qc.refetchQueries(
				{ queryKey: billingKeys.wallet, exact: true, type: "all" },
				{ throwOnError: true },
			);
		})(),
		qc.invalidateQueries({ queryKey: billingKeys.plans }),
		qc.invalidateQueries({ queryKey: ["agents"] }),
	]);
	return deploymentsResult.status === "fulfilled"
		? qc.getQueryData<HostedDeployment[]>(billingKeys.deployments)
		: undefined;
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

export function useHostedDeployments({ enabled = true }: { enabled?: boolean } = {}) {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.deployments,
		enabled: isDeployApiConfigured() && enabled,
		queryFn: () => client.listDeployments(),
		refetchInterval: (q) => (shouldPollDeployments(q.state.data) ? 10_000 : false),
	});
}

export function useCreateDeployment() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ body, idempotencyKey }: CreateDeploymentMutationVariables) =>
			client.createDeployment(body, idempotencyKey),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			qc.invalidateQueries({ queryKey: ["agents"] });
		},
	});
}
