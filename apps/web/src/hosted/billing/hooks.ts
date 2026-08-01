"use client";

import {
	keepPreviousData,
	type QueryClient,
	replaceEqualDeep,
	type UseQueryOptions,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import type {
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeRequest,
	ComputePlanChangeResult,
	ComputeSubscriptionActionResult,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionResumeRequest,
	HostedComputeSubscription,
	HostedDeployment,
} from "@/hosted/billing/contracts";
import { billingQueryRetry } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	type SubscriptionCreateQuoteView,
	type SubscriptionCreateSelection,
	subscriptionCreateQuoteRequest,
	subscriptionCreateQuoteView,
} from "@/hosted/billing/subscription/subscription-create-adapter";
import {
	deploymentPollingState,
	deploymentStatusFromResource,
	isTransitionalStatus,
	type SettlingTracker,
} from "@/hosted/deployment-status";
import { runtimeEnvironmentId } from "@/hosted/runtimes";

export { billingKeys } from "@/hosted/billing/query-keys";

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

// ── Subscription / compute ────────────────────────────────────────────────────

export function usePlans() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.plans,
		queryFn: () => client.getPlans(),
		staleTime: 5 * 60_000,
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

export function useChangePlan(onAccepted?: (operationName: string) => void) {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation<ComputePlanChangeResult, Error, ComputePlanChangeRequest>({
		mutationFn: (body) => client.changePlan(body, onAccepted),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			qc.invalidateQueries({ queryKey: billingKeys.wallet });
			qc.invalidateQueries({ queryKey: billingKeys.billingHistoryRoot });
		},
	});
}

export function useCheckPlanChange() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation<ComputePlanChangeResult, Error, string>({
		mutationFn: (operationName) => client.checkPlanChange(operationName),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			qc.invalidateQueries({ queryKey: billingKeys.wallet });
			qc.invalidateQueries({ queryKey: billingKeys.billingHistoryRoot });
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
	const queryClient = useQueryClient();
	return useCallback(
		(options?: CheckoutReturnRefreshOptions) => refreshCheckoutReturnQueries(queryClient, options),
		[queryClient],
	);
}

export type CheckoutReturnRefreshOptions = {
	includeDeployments?: boolean;
};

export async function refreshCheckoutReturnQueries(
	qc: QueryClient,
	{ includeDeployments = true }: CheckoutReturnRefreshOptions = {},
): Promise<HostedDeployment[] | undefined> {
	const [deploymentsResult, walletResult] = await Promise.allSettled([
		includeDeployments
			? (async () => {
					await qc.invalidateQueries({
						queryKey: billingKeys.deployments,
						exact: true,
						refetchType: "none",
					});
					await qc.refetchQueries(
						{ queryKey: billingKeys.deployments, exact: true, type: "all" },
						{ throwOnError: true },
					);
				})()
			: Promise.resolve(),
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
	const requiredRefreshFailures = [deploymentsResult, walletResult].flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (requiredRefreshFailures.length > 0) {
		throw new AggregateError(
			requiredRefreshFailures,
			"Couldn’t refresh required checkout return data.",
		);
	}
	return qc.getQueryData<HostedDeployment[]>(billingKeys.deployments);
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

/** Foreground polling is a bridge until deployment SSE is wired into this client. */
export const HOSTED_DEPLOYMENTS_REFRESH_POLICY = {
	refetchIntervalInBackground: false,
	refetchOnWindowFocus: true,
} as const;

export function reconcileDeploymentSnapshots(
	previous: readonly HostedDeployment[] | undefined,
	incoming: HostedDeployment[],
): HostedDeployment[] {
	const previousById = new Map(
		(previous ?? []).map((deployment) => [deployment.resource.id, deployment]),
	);
	const reconciled = incoming.map((deployment) => {
		const acceptedOperation = previousById.get(deployment.resource.id)?.accepted_operation;
		if (acceptedOperation?.metadata.verb === "delete" && !acceptedOperation.done) {
			if (
				deployment.accepted_operation?.name === acceptedOperation.name ||
				deployment.resource.metadata.generation > acceptedOperation.metadata.targetGeneration
			) {
				return deployment;
			}
			return { ...deployment, accepted_operation: acceptedOperation };
		}
		if (deployment.accepted_operation) return deployment;
		if (!acceptedOperation) return deployment;

		const resourceStatus = deployment.resource.status;
		const status = deploymentStatusFromResource(resourceStatus);
		const failure = resourceStatus === null ? null : resourceStatus.failure;
		const operationApplies = isTransitionalStatus(status)
			? true
			: status.kind === "failed" &&
				failure !== null &&
				failure !== undefined &&
				failure.observedGeneration >= acceptedOperation.metadata.targetGeneration;
		return operationApplies ? { ...deployment, accepted_operation: acceptedOperation } : deployment;
	});
	return replaceEqualDeep(previous, reconciled) as HostedDeployment[];
}

function reconcileDeploymentQueryData(previous: unknown, incoming: unknown): unknown {
	if (!Array.isArray(incoming)) return incoming;
	return reconcileDeploymentSnapshots(Array.isArray(previous) ? previous : undefined, incoming);
}

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

export function useHostedDeployments({
	enabled = true,
	pollBillingRecoveryFor = null,
}: {
	enabled?: boolean;
	pollBillingRecoveryFor?: string | null;
} = {}) {
	const client = useBillingClient();
	const transitionTrackersRef = useRef<ReadonlyMap<string, SettlingTracker>>(new Map());
	const deriveDeploymentPollingState = useCallback(
		(deployments: readonly HostedDeployment[] | undefined, nowMs: number) =>
			deploymentPollingState(deployments, transitionTrackersRef.current, nowMs),
		[],
	);
	const query = useBillingQuery({
		queryKey: billingKeys.deployments,
		enabled: isDeployApiConfigured() && enabled,
		queryFn: () => client.listDeployments(),
		structuralSharing: reconcileDeploymentQueryData,
		refetchInterval: (q) => {
			const inventoryInterval = deriveDeploymentPollingState(
				q.state.data,
				Date.now(),
			).refetchInterval;
			const billingInterval = billingRecoveryRefetchIntervalFor(
				q.state.data,
				pollBillingRecoveryFor,
			);
			return shortestRefetchInterval(inventoryInterval, billingInterval);
		},
		...HOSTED_DEPLOYMENTS_REFRESH_POLICY,
	});
	const deploymentPolling = deriveDeploymentPollingState(query.data, Date.now());

	useEffect(() => {
		transitionTrackersRef.current = deploymentPolling.trackers;
	}, [deploymentPolling.trackers]);

	return { ...query, deploymentTransitions: deploymentPolling.transitions };
}

function shortestRefetchInterval(...intervals: readonly (number | false)[]): number | false {
	let shortest: number | false = false;
	for (const interval of intervals) {
		if (typeof interval !== "number") continue;
		shortest = typeof shortest === "number" ? Math.min(shortest, interval) : interval;
	}
	return shortest;
}

export function useResolveDeploymentRequest() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (deployRequestId: string) => client.waitForDeploymentRequest(deployRequestId),
	});
}
