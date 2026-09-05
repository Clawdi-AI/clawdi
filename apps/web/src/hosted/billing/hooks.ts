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
	ComputeCancelScheduledPlanChangeRequest,
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeRequest,
	ComputePlanChangeResult,
	ComputeSubscriptionActionResult,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionResumeRequest,
	HostedComputeSubscription,
	HostedDeployment,
} from "@/hosted/billing/contracts";
import { billingQueryRetry, PlanChangeTerminalError } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	type SubscriptionCreateQuoteView,
	type SubscriptionCreateSelection,
	subscriptionCreateQuoteRequest,
	subscriptionCreateQuoteView,
} from "@/hosted/billing/subscription/subscription-create-adapter";
import { isComputeSubscriptionActionUnconfirmed } from "@/hosted/billing/subscription/subscription-utils";
import {
	deploymentPollingState,
	deploymentStatusFromResource,
	isTransitionalStatus,
	type SettlingTracker,
} from "@/hosted/deployment-status";
import { eventStreamFallbackInterval } from "@/lib/event-stream-refresh";

export { billingKeys } from "@/hosted/billing/query-keys";

function subscriptionFromAction(
	previous: HostedComputeSubscription | null | undefined,
	next: ComputeSubscriptionActionResult,
): HostedComputeSubscription {
	return {
		...(previous ?? {}),
		actions: null,
		recovery_action: next.recovery_action,
		funding_source: next.funding_source ?? previous?.funding_source ?? "stripe",
		status: next.status,
		payment_state: previous?.payment_state ?? "ok",
		billing_term_months: next.billing_term_months,
		currency: previous?.currency ?? "usd",
		cancel_at_period_end: next.cancel_at_period_end,
		pending_plan_slug:
			next.pending_plan_slug === undefined
				? (previous?.pending_plan_slug ?? null)
				: next.pending_plan_slug,
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
		if (deployment.resource.id !== deploymentId) return deployment;
		patched = true;
		return {
			...deployment,
			start_action: null,
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

export async function invalidateComputeSubscriptionInventory(
	qc: QueryClient,
	refetchType: "active" | "all" = "active",
): Promise<void> {
	await Promise.all(
		[
			billingKeys.deployments,
			billingKeys.subscriptions,
			billingKeys.includedBasicAvailability,
			billingKeys.reusableSubscriptions,
		].map((queryKey) => qc.invalidateQueries({ queryKey, refetchType })),
	);
}

export async function applySubscriptionActionSuccess(
	qc: QueryClient,
	body: ComputeSubscriptionCancelRequest | ComputeSubscriptionResumeRequest,
	next: ComputeSubscriptionActionResult,
): Promise<void> {
	if (body.deployment_id && !isComputeSubscriptionActionUnconfirmed(next)) {
		applyDeploymentSubscriptionResult(qc, body.deployment_id, next);
	}
	await invalidateComputeSubscriptionInventory(qc);
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

export function billingNextPageParam(page: {
	has_more: boolean;
	next_cursor?: string | null;
}): string | undefined {
	return page.has_more && page.next_cursor ? page.next_cursor : undefined;
}

export function useHostedUser() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.me,
		queryFn: () => client.getMe(),
		staleTime: 5 * 60_000,
	});
}

export function useManagedModelCatalog({ enabled = true }: { enabled?: boolean } = {}) {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.managedModelCatalog,
		queryFn: () => client.getManagedModelCatalog(),
		staleTime: 5 * 60_000,
		enabled,
	});
}

// ── Wallet ───────────────────────────────────────────────────────────────────

export function useWalletTransactions() {
	const client = useBillingClient();
	return useInfiniteQuery({
		queryKey: billingKeys.transactions,
		queryFn: ({ pageParam }) => client.getTransactions(50, pageParam),
		initialPageParam: null as string | null,
		getNextPageParam: billingNextPageParam,
		enabled: isDeployApiConfigured(),
		retry: billingQueryRetry,
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

export function useSubscriptions() {
	const client = useBillingClient();
	return useInfiniteQuery({
		queryKey: billingKeys.subscriptions,
		queryFn: ({ pageParam }) => client.getSubscriptions(20, pageParam),
		initialPageParam: null as string | null,
		getNextPageParam: billingNextPageParam,
		enabled: isDeployApiConfigured(),
		retry: billingQueryRetry,
		refetchIntervalInBackground: false,
		refetchInterval: (query) =>
			query.state.data?.pages.some((page) =>
				page.items?.some(
					(subscription) =>
						subscription.actions?.command_state != null ||
						subscription.recovery_blocked_reason === "payment_pending",
				),
			)
				? BILLING_RECOVERY_POLL_INTERVAL_MS
				: false,
	});
}

export function useIncludedBasicAvailability() {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.includedBasicAvailability,
		queryFn: () => client.getIncludedBasicAvailability(),
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

export function invalidatePlanChangeQueries(qc: QueryClient): void {
	qc.invalidateQueries({ queryKey: billingKeys.deployments });
	qc.invalidateQueries({ queryKey: billingKeys.wallet });
	qc.invalidateQueries({ queryKey: billingKeys.transactions });
	qc.invalidateQueries({ queryKey: billingKeys.subscriptions });
	qc.invalidateQueries({ queryKey: billingKeys.includedBasicAvailability });
}

export function invalidateSettledPlanChangeQueries(qc: QueryClient, error: Error | null): void {
	if (error && !(error instanceof PlanChangeTerminalError)) return;
	invalidatePlanChangeQueries(qc);
}

export function useChangePlan(onAccepted?: (operationName: string) => void) {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation<ComputePlanChangeResult, Error, ComputePlanChangeRequest>({
		mutationFn: (body) => client.changePlan(body, onAccepted),
		onSettled: (_result, error) => invalidateSettledPlanChangeQueries(qc, error),
	});
}

export function useCheckPlanChange() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation<ComputePlanChangeResult, Error, string>({
		mutationFn: (operationName) => client.checkPlanChange(operationName),
		onSettled: (_result, error) => invalidateSettledPlanChangeQueries(qc, error),
	});
}

export function useCancelSubscription() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: ComputeSubscriptionCancelRequest) => client.cancelSubscription(body),
		onSuccess: (next, body) => applySubscriptionActionSuccess(qc, body, next),
	});
}

export function useResumeSubscription() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: ComputeSubscriptionResumeRequest) => client.resumeSubscription(body),
		onSuccess: (next, body) => applySubscriptionActionSuccess(qc, body, next),
	});
}

export function useCancelScheduledPlanChange() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: ComputeCancelScheduledPlanChangeRequest) =>
			client.cancelScheduledPlanChange(body),
		onSettled: () => invalidateComputeSubscriptionInventory(qc, "all"),
	});
}

export function useCheckoutReturnRefresh() {
	const queryClient = useQueryClient();
	return useCallback(
		(options?: CheckoutReturnRefreshOptions) => refreshCheckoutReturnQueries(queryClient, options),
		[queryClient],
	);
}

type CheckoutReturnRefreshOptions = {
	includeDeployments?: boolean;
};

async function refetchExactCheckoutQuery(qc: QueryClient, queryKey: readonly unknown[]) {
	await qc.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
	await qc.refetchQueries({ queryKey, exact: true, type: "all" }, { throwOnError: true });
}

export async function refreshCheckoutReturnQueries(
	qc: QueryClient,
	{ includeDeployments = true }: CheckoutReturnRefreshOptions = {},
): Promise<HostedDeployment[] | undefined> {
	const requiredRefreshes = [
		refetchExactCheckoutQuery(qc, billingKeys.wallet),
		refetchExactCheckoutQuery(qc, billingKeys.plans),
		refetchExactCheckoutQuery(qc, billingKeys.subscriptions),
	];
	if (includeDeployments) {
		requiredRefreshes.push(refetchExactCheckoutQuery(qc, billingKeys.deployments));
	}
	const results = await Promise.allSettled([
		...requiredRefreshes,
		qc.invalidateQueries({ queryKey: billingKeys.subscriptionCreateQuotes }),
		qc.invalidateQueries({ queryKey: billingKeys.reusableSubscriptions }),
		qc.invalidateQueries({ queryKey: billingKeys.includedBasicAvailability }),
		qc.invalidateQueries({ queryKey: billingKeys.transactions }),
		qc.invalidateQueries({ queryKey: ["get", "/v1/agents"] }),
	]);
	const requiredRefreshFailures = results
		.slice(0, requiredRefreshes.length)
		.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (requiredRefreshFailures.length > 0) {
		throw new AggregateError(
			requiredRefreshFailures,
			"Couldn’t refresh required checkout return data.",
		);
	}
	return qc.getQueryData<HostedDeployment[]>(billingKeys.deployments);
}

// ── Usage ────────────────────────────────────────────────────────────────────

export function useUsage(
	days: number | null,
	agentId: string | null = null,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const client = useBillingClient();
	return useBillingQuery({
		queryKey: billingKeys.usage(days, agentId),
		queryFn: () => client.getUsage(days, agentId),
		enabled,
		placeholderData: keepPreviousData,
	});
}

// ── Deployments ────────────────────────────────────────────────────────────────

const BILLING_RECOVERY_POLL_INTERVAL_MS = 30_000;

/** Foreground polling is a bridge for live updates; no background polling. */
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
			candidate.resource.id.toLowerCase() === target || candidate.agent_id.toLowerCase() === target;
		return matchesTarget;
	});
	if (deployment?.start_action === "wait") return BILLING_RECOVERY_POLL_INTERVAL_MS;
	const subscription = deployment?.commercial_display?.compute_subscription;
	if (!subscription) return false;
	return subscription.payment_state === "past_due" ||
		subscription.payment_state === "requires_action" ||
		subscription.actions?.command_state != null ||
		subscription.recovery_blocked_reason === "payment_pending"
		? BILLING_RECOVERY_POLL_INTERVAL_MS
		: false;
}

export function useHostedDeployments({
	enabled = true,
	pollBillingRecoveryFor = null,
	eventStreamActive = false,
}: {
	enabled?: boolean;
	pollBillingRecoveryFor?: string | null;
	eventStreamActive?: boolean;
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
			return shortestRefetchInterval(
				eventStreamFallbackInterval(inventoryInterval, eventStreamActive),
				billingInterval,
			);
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
