"use client";

import {
	keepPreviousData,
	type QueryClient,
	type UseQueryOptions,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import type {
	CheckoutRequest,
	ComputeFixPaymentRequest,
	ComputeSubscriptionActionResult,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionResumeRequest,
	DeployRequest,
	HostedDeployment,
	PortalRequest,
	WalletAutoReloadRequest,
	WalletComputeActivateRequest,
	WalletComputeCancelPendingPlanRequest,
	WalletComputePlanChangeRequest,
	WalletComputeQuoteRequest,
	WalletComputeRetryRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import { billingQueryRetry } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";
import { deploymentRefetchInterval } from "@/hosted/deployment-status";

export { billingKeys } from "@/hosted/billing/query-keys";

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
	if (checkoutReturnWasCanceled(searchStr)) values.push("checkout=cancel");
	return values.length > 0 ? values.join("&") : null;
}

export function checkoutReturnWasCanceled(searchStr: string): boolean {
	return new URLSearchParams(searchStr).get("checkout") === "cancel";
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
	const paymentState =
		next.status === "past_due"
			? (previous?.payment_state ?? "past_due")
			: next.status === "unpaid"
				? "unpaid"
				: "ok";
	return {
		...(previous ?? {}),
		funding_source: next.funding_source ?? previous?.funding_source ?? "stripe",
		status: next.status,
		payment_state: paymentState,
		billing_term_months: next.billing_term_months,
		currency: previous?.currency ?? "usd",
		cancel_at_period_end: next.cancel_at_period_end,
		current_period_end: next.current_period_end ?? previous?.current_period_end ?? null,
		cancel_at: next.cancel_at ?? null,
		latest_failed_invoice_id:
			paymentState === "ok" ? null : (previous?.latest_failed_invoice_id ?? null),
		latest_failed_invoice_hosted_url:
			paymentState === "ok" ? null : (previous?.latest_failed_invoice_hosted_url ?? null),
		next_payment_attempt_at:
			paymentState === "ok" ? null : (previous?.next_payment_attempt_at ?? null),
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
export function useWallet({ enabled = true }: { enabled?: boolean } = {}) {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.wallet,
		queryFn: () => client.getWallet(),
		enabled: isDeployApiConfigured() && enabled,
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

export function useFixPayment() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (body: ComputeFixPaymentRequest) => client.fixPayment(body),
	});
}

export function useComputeInvoices(limit = 12) {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.invoices(limit),
		queryFn: () => client.getInvoices(limit),
		staleTime: 60_000,
	});
}

export function useComputeBillingHistory(limit = 20) {
	const client = useBillingClient();
	return useInfiniteQuery({
		queryKey: billingKeys.billingHistory(limit),
		queryFn: ({ pageParam }) => client.getBillingHistory(limit, pageParam),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) =>
			lastPage.has_more && lastPage.next_cursor ? lastPage.next_cursor : undefined,
		enabled: isDeployApiConfigured(),
		retry: billingQueryRetry,
		staleTime: 60_000,
	});
}

export function useWalletComputeQuote(body: WalletComputeQuoteRequest | null) {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.walletComputeQuote(
			body?.plan_slug ?? "unselected",
			body?.billing_term_months ?? 1,
		),
		queryFn: () => {
			if (!body) throw new Error("Wallet compute quote requires a plan.");
			return client.quoteWalletCompute(body);
		},
		enabled: isDeployApiConfigured() && body !== null,
		staleTime: 15_000,
	});
}

function invalidateWalletCompute(qc: QueryClient): void {
	qc.invalidateQueries({ queryKey: billingKeys.wallet });
	qc.invalidateQueries({ queryKey: ["billing", "ledger"] });
	qc.invalidateQueries({ queryKey: billingKeys.deployments });
	qc.invalidateQueries({ queryKey: ["billing", "history"] });
	qc.invalidateQueries({ queryKey: ["agents"] });
}

export function useActivateWalletCompute() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: WalletComputeActivateRequest) => client.activateWalletCompute(body),
		onSuccess: () => invalidateWalletCompute(qc),
	});
}

export function useRetryWalletCompute() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: WalletComputeRetryRequest) => client.retryWalletCompute(body),
		onSuccess: () => invalidateWalletCompute(qc),
	});
}

export function useQuoteWalletPlanChange() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (body: WalletComputePlanChangeRequest) => client.quoteWalletPlanChange(body),
	});
}

export function useChangeWalletPlan() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: WalletComputePlanChangeRequest) => client.changeWalletPlan(body),
		onSuccess: () => invalidateWalletCompute(qc),
	});
}

export function useCancelPendingWalletPlan() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: WalletComputeCancelPendingPlanRequest) =>
			client.cancelPendingWalletPlan(body),
		onSettled: () => invalidateWalletCompute(qc),
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

const WALLET_DUNNING_POLL_INTERVAL_MS = 30_000;
const WALLET_DUNNING_LEAD_TIME_MS = 60_000;
const WALLET_DUNNING_MAX_WAKE_INTERVAL_MS = 2_000_000_000;

export function walletDunningRefetchIntervalFor(
	deployments: readonly HostedDeployment[] | undefined,
	targetId: string | null | undefined,
	now = Date.now(),
): number | false {
	const target = targetId?.toLowerCase();
	if (!target) return false;
	const deployment = (deployments ?? []).find((candidate) => {
		const matchesTarget =
			candidate.id.toLowerCase() === target ||
			Object.values(candidate.config_info?.clawdi_cloud_environments ?? {}).some(
				(environmentId) => environmentId?.toLowerCase() === target,
			);
		return matchesTarget;
	});
	const subscription = deployment?.compute_subscription;
	const walletFunded =
		subscription?.funding_source === "wallet" || subscription?.recovery_action === "top_up";
	if (!subscription || !walletFunded) return false;
	if (subscription.payment_state === "past_due") return WALLET_DUNNING_POLL_INTERVAL_MS;
	if (subscription.payment_state !== "ok") return false;
	const status = subscription.status.toLowerCase();
	if (status !== "active" && status !== "trialing") return false;
	const collectionBoundary =
		subscription.next_collection_attempt_at ?? subscription.current_period_end ?? null;
	if (!collectionBoundary) return false;
	const boundaryMs = Date.parse(collectionBoundary);
	if (!Number.isFinite(boundaryMs)) return false;
	const untilPollingWindow = boundaryMs - now - WALLET_DUNNING_LEAD_TIME_MS;
	if (untilPollingWindow <= 0) return WALLET_DUNNING_POLL_INTERVAL_MS;
	// Wake the query up before the cached boundary even when the page opened
	// earlier in the billing period. Cap long timers below the browser's signed
	// 32-bit timeout limit; ordinary query invalidations still reconcile a
	// changed backend boundary sooner.
	return Math.min(untilPollingWindow, WALLET_DUNNING_MAX_WAKE_INTERVAL_MS);
}

export function shouldPollWalletDunningFor(
	deployments: readonly HostedDeployment[] | undefined,
	targetId: string | null | undefined,
	now = Date.now(),
): boolean {
	return (
		walletDunningRefetchIntervalFor(deployments, targetId, now) === WALLET_DUNNING_POLL_INTERVAL_MS
	);
}

export function useHostedDeployments({
	enabled = true,
	pollWalletDunningFor = null,
}: {
	enabled?: boolean;
	pollWalletDunningFor?: string | null;
} = {}) {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.deployments,
		enabled: isDeployApiConfigured() && enabled,
		queryFn: () => client.listDeployments(),
		refetchInterval: (q) => {
			const inventoryInterval = deploymentRefetchInterval(q.state.data);
			const walletInterval = walletDunningRefetchIntervalFor(q.state.data, pollWalletDunningFor);
			return typeof walletInterval === "number"
				? Math.min(inventoryInterval, walletInterval)
				: inventoryInterval;
		},
		refetchIntervalInBackground: false,
	});
}

export function useCreateDeployment() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ body, idempotencyKey }: CreateDeploymentMutationVariables) =>
			client.createDeployment(body, idempotencyKey),
		onSettled: () => {
			void qc.invalidateQueries({ queryKey: billingKeys.deployments });
			void qc.invalidateQueries({ queryKey: ["agents"] });
		},
	});
}
