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
	ComputeFixPaymentRequest,
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeRequest,
	ComputePlanChangeResponse,
	ComputeSubscriptionActionResult,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionResumeRequest,
	HostedComputeSubscription,
	HostedDeployment,
	PortalRequest,
	WalletAutoReloadRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import { billingQueryRetry } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	type SubscriptionCreateOutcomeView,
	type SubscriptionCreateQuoteView,
	type SubscriptionCreateRequestView,
	type SubscriptionCreateSelection,
	subscriptionCreateOutcome,
	subscriptionCreateQuoteRequest,
	subscriptionCreateQuoteView,
	subscriptionCreateRequest,
} from "@/hosted/billing/subscription/subscription-create-adapter";
import { deploymentRefetchInterval } from "@/hosted/deployment-status";
import { runtimeEnvironmentId } from "@/hosted/runtimes";

export { billingKeys } from "@/hosted/billing/query-keys";

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
	previous: HostedComputeSubscription | null | undefined,
	next: ComputeSubscriptionActionResult,
): HostedComputeSubscription {
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
		if (deployment.resource.id !== deploymentId) return deployment;
		patched = true;
		return {
			...deployment,
			commercial_display: {
				...(deployment.commercial_display ?? {}),
				compute_subscription: subscriptionFromAction(
					deployment.commercial_display?.compute_subscription,
					next,
				),
			},
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

export function useManagedModelCatalog() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.managedModelCatalog,
		queryFn: () => client.getManagedModelCatalog(),
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

export function useCreateSubscription() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation<SubscriptionCreateOutcomeView, Error, SubscriptionCreateRequestView>({
		mutationFn: async (request) => {
			const apiRequest = subscriptionCreateRequest(request);
			return subscriptionCreateOutcome(
				await client.checkout(apiRequest.body, apiRequest.idempotencyKey),
			);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			qc.invalidateQueries({ queryKey: billingKeys.wallet });
			qc.invalidateQueries({ queryKey: ["billing", "history"] });
			qc.invalidateQueries({ queryKey: ["agents"] });
		},
	});
}

export function useSubscriptionCreateQuote(
	selection: SubscriptionCreateSelection | null,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const client = useBillingClient();
	const quoteBody = subscriptionCreateQuoteRequest(selection);
	return useBillingQuery<SubscriptionCreateQuoteView>({
		queryKey: selection
			? billingKeys.subscriptionCreateQuote(
					selection.planSlug,
					selection.billingTermMonths,
					selection.fundingSource,
				)
			: [...billingKeys.subscriptionCreateQuotes, "disabled"],
		queryFn: async () => {
			if (!selection || !quoteBody) {
				throw new Error("Subscription creation quote is unavailable.");
			}
			return subscriptionCreateQuoteView(selection, await client.quoteSubscription(quoteBody));
		},
		enabled: isDeployApiConfigured() && enabled && quoteBody !== null,
		staleTime: 30_000,
	});
}

export function useQuotePlanChange() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (body: ComputePlanChangeQuoteRequest) => client.quotePlanChange(body),
	});
}

export function useChangePlan() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation<ComputePlanChangeResponse, Error, ComputePlanChangeRequest>({
		mutationFn: (body) => client.changePlan(body),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			qc.invalidateQueries({ queryKey: billingKeys.wallet });
			qc.invalidateQueries({ queryKey: ["billing", "history"] });
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

const BILLING_RECOVERY_POLL_INTERVAL_MS = 30_000;

export function billingRecoveryRefetchIntervalFor(
	deployments: readonly HostedDeployment[] | undefined,
	targetId: string | null | undefined,
): number | false {
	const target = targetId?.toLowerCase();
	if (!target) return false;
	const deployment = (deployments ?? []).find((candidate) => {
		const matchesTarget =
			candidate.resource.id.toLowerCase() === target ||
			runtimeEnvironmentId(candidate)?.toLowerCase() === target;
		return matchesTarget;
	});
	const subscription = deployment?.commercial_display?.compute_subscription;
	if (!subscription) return false;
	return subscription.payment_state === "past_due" ||
		subscription.payment_state === "requires_action"
		? BILLING_RECOVERY_POLL_INTERVAL_MS
		: false;
}

export function shouldPollBillingRecoveryFor(
	deployments: readonly HostedDeployment[] | undefined,
	targetId: string | null | undefined,
): boolean {
	return (
		billingRecoveryRefetchIntervalFor(deployments, targetId) === BILLING_RECOVERY_POLL_INTERVAL_MS
	);
}

export function useHostedDeployments({
	enabled = true,
	pollBillingRecoveryFor = null,
}: {
	enabled?: boolean;
	pollBillingRecoveryFor?: string | null;
} = {}) {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.deployments,
		enabled: isDeployApiConfigured() && enabled,
		queryFn: () => client.listDeployments(),
		refetchInterval: (q) => {
			const inventoryInterval = deploymentRefetchInterval(
				q.state.data?.map((deployment) => ({
					status: deployment.resource.status.summary_state,
				})),
			);
			const billingInterval = billingRecoveryRefetchIntervalFor(
				q.state.data,
				pollBillingRecoveryFor,
			);
			return typeof billingInterval === "number"
				? Math.min(inventoryInterval, billingInterval)
				: inventoryInterval;
		},
		refetchIntervalInBackground: false,
	});
}

export function useResolveDeploymentRequest() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (deployRequestId: string) => client.waitForDeploymentRequest(deployRequestId),
	});
}
