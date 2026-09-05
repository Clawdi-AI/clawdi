"use client";

import { CreditCard, History } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { EmptyState } from "@/components/empty-state";
import { entityCardChassisClass } from "@/components/entity-card";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type { ComputeSubscriptionListItem, HostedDeployment } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useHostedDeployments, usePlans, useSubscriptions } from "@/hosted/billing/hooks";
import { ComputeSubscriptionActionList } from "@/hosted/billing/subscription/compute-subscription-action-list";
import { resolveComputeSubscriptionActions } from "@/hosted/billing/subscription/compute-subscription-actions";
import {
	ComputeSubscriptionCard,
	type ComputeSubscriptionIdentity,
	computeSubscriptionCardView,
	computeSubscriptionPlanLabel,
} from "@/hosted/billing/subscription/compute-subscription-card";
import {
	type ComputeSubscriptionManagementResult,
	computeSubscriptionManagement,
} from "@/hosted/billing/subscription/compute-subscription-management";
import { computeSubscriptionRecoveryPresentation } from "@/hosted/billing/subscription/compute-subscription-recovery";
import { PlanChangeController } from "@/hosted/billing/subscription/plan-change-controller";
import { useReusableSubscriptions } from "@/hosted/billing/subscription/reusable-subscriptions-query";
import {
	computeFundingSource,
	computeSubscriptionCancellationCopy,
	computeSubscriptionCancellationSuccessCopy,
	computeSubscriptionLifecycle,
	isHistoricalAccountSubscription,
	pendingComputePlanSlug,
	pendingPlanScheduleCopy,
	resolvePerformancePlan,
} from "@/hosted/billing/subscription/subscription-utils";
import { agentSectionHref } from "@/lib/agent-routes";
import { formatShortDate } from "@/lib/format";
import { useProductAccess } from "@/lib/product-access";
import { shouldBlockQueryError } from "@/lib/query-state";

function subscriptionAgentHref(
	subscription: ComputeSubscriptionListItem,
	deployment: HostedDeployment | undefined,
): string | null {
	if (subscription.is_orphan || !deployment) return null;
	return agentSectionHref(deployment.agent_id, "settings", {
		settings: "billing-plan",
	});
}

function subscriptionStartNewHref(
	subscription: ComputeSubscriptionListItem,
	deployment: HostedDeployment | undefined,
): string | null {
	if (subscription.is_orphan || !deployment) return null;
	return agentSectionHref(deployment.agent_id, "settings", {
		settings: "billing-plan",
		subscription_action: "start_new",
	});
}

function subscriptionManagement(
	subscription: ComputeSubscriptionListItem,
	deployment: HostedDeployment | undefined,
	{
		canCreateCloudAgents,
		plansLoading,
		performancePlanAvailable,
	}: {
		canCreateCloudAgents: boolean;
		plansLoading: boolean;
		performancePlanAvailable: boolean;
	},
): ComputeSubscriptionManagementResult {
	return computeSubscriptionManagement({
		entitlement: {
			subscriptionKind: subscription.subscription_kind,
			deploymentId: subscription.deployment_id,
			planSlug: subscription.plan_slug,
			fundingSource: subscription.funding_source,
			priceCents: subscription.price_cents,
			billingTermMonths: subscription.billing_term_months,
			status: subscription.status,
			paymentState: subscription.payment_state,
			cancelAtPeriodEnd: subscription.cancel_at_period_end,
			recoveryAction: subscription.recovery_action,
			pendingPlanSlug: pendingComputePlanSlug(subscription),
			isOrphan: subscription.is_orphan,
		},
		deployment,
		canCreateCloudAgents,
		plansLoading,
		performancePlanAvailable,
	});
}

export function computeSubscriptionAssignment(
	subscription: Pick<
		ComputeSubscriptionListItem,
		"deployment_id" | "is_orphan" | "subscription_id" | "subscription_kind"
	>,
	reusableSubscriptionIds: ReadonlySet<string>,
): "available" | "assigned" | "unavailable" {
	if (subscription.subscription_kind === "included_basic") {
		return subscription.deployment_id && !subscription.is_orphan ? "assigned" : "unavailable";
	}
	if (reusableSubscriptionIds.has(subscription.subscription_id)) return "available";
	return subscription.deployment_id && !subscription.is_orphan ? "assigned" : "unavailable";
}

export function computeSubscriptionIdentity(
	subscription: Pick<ComputeSubscriptionListItem, "agent_name" | "subscription_kind">,
	assignment: "available" | "assigned" | "unavailable",
	agentTile: AgentTile | undefined,
	href: string | null,
	inventoryUncertain = false,
): ComputeSubscriptionIdentity | undefined {
	if (subscription.subscription_kind === "included_basic" && assignment !== "assigned") {
		return undefined;
	}
	if (assignment === "available") {
		return { kind: "available", label: "Available for a new agent" };
	}
	if (assignment === "unavailable") {
		if (inventoryUncertain) return undefined;
		return { kind: "unavailable", label: "Deleted agent" };
	}
	return {
		kind: "agent",
		name: agentTile?.name ?? subscription.agent_name ?? "Agent",
		agentType: agentTile?.agentType ?? null,
		avatarUrl: agentTile?.avatarUrl,
		href: href ?? undefined,
	};
}

export function SubscriptionLoadMore({
	isLoading,
	onLoadMore,
}: {
	isLoading: boolean;
	onLoadMore: () => void;
}) {
	return (
		<div className="flex justify-center">
			<Button variant="outline" onClick={onLoadMore} disabled={isLoading}>
				{isLoading ? "Loading…" : "Load more"}
			</Button>
		</div>
	);
}

function SubscriptionRow({
	subscription,
	deployment,
	agentTile,
	management,
	onPlanChange,
	reusableSubscriptionIds,
	reusableInventoryUncertain,
}: {
	subscription: ComputeSubscriptionListItem;
	deployment?: HostedDeployment;
	agentTile?: AgentTile;
	management: ComputeSubscriptionManagementResult;
	onPlanChange: (subscription: ComputeSubscriptionListItem) => void;
	reusableSubscriptionIds: ReadonlySet<string>;
	reusableInventoryUncertain: boolean;
}) {
	const lifecycle = computeSubscriptionLifecycle(subscription);
	const recovery = computeSubscriptionRecoveryPresentation(subscription, {
		label: lifecycle.badgeLabel,
		tone: lifecycle.badgeTone,
	});
	const assignment = computeSubscriptionAssignment(subscription, reusableSubscriptionIds);
	const deploymentBound = assignment === "assigned";
	const agentHref = deploymentBound ? subscriptionAgentHref(subscription, deployment) : null;
	const startNewHref = deploymentBound ? subscriptionStartNewHref(subscription, deployment) : null;
	const recoveryTarget =
		assignment === "available" && recovery.recoveryTarget?.kind === "start_new"
			? null
			: recovery.recoveryTarget;
	const pendingPlanSlug = pendingComputePlanSlug(subscription);
	const actions = resolveComputeSubscriptionActions({
		entitlement: {
			subscriptionKind: subscription.subscription_kind,
			deploymentId: subscription.deployment_id,
			planSlug: subscription.plan_slug,
			fundingSource: subscription.funding_source,
			priceCents: subscription.price_cents,
			status: subscription.status,
			paymentState: subscription.payment_state,
			cancelAtPeriodEnd: subscription.cancel_at_period_end,
			pendingPlanSlug,
			isOrphan: !deploymentBound,
			actions: subscription.actions,
		},
		management,
		recoveryTarget,
		hasPendingOperation: deploymentBound && management.target?.projectedOperationName != null,
	});
	const pendingPlanCopy = pendingPlanSlug
		? pendingPlanScheduleCopy(
				pendingPlanSlug,
				subscription.current_period_end,
				formatShortDate(subscription.current_period_end),
			)
		: null;
	const recoveryNotice = (() => {
		switch (recoveryTarget?.kind) {
			case "top_up":
				return "Top up Wallet to settle the outstanding balance. Payment source changes apply to future renewals.";
			case "invoice":
			case "fix_payment":
				return "Resolve the outstanding payment to restore this subscription. Payment source changes apply to future renewals.";
			case "start_new":
				return startNewHref ? "Start a new subscription from Agent settings." : null;
			case undefined:
				return null;
		}
	})();
	const hasActions =
		actions.some((candidate) => candidate.kind !== "start_new") || startNewHref !== null;
	const fundingSource =
		subscription.subscription_kind === "included_basic"
			? "included_basic"
			: computeFundingSource(subscription.plan_slug, subscription);
	const managementReason =
		actions.find((candidate) => candidate.kind === "upgrade" || candidate.kind === "manage")
			?.disabledReason ?? null;
	const view = computeSubscriptionCardView({
		status: recovery.status,
		planSlug: subscription.plan_slug,
		fundingSource:
			fundingSource === "included_basic"
				? "included"
				: fundingSource === "stripe" || fundingSource === "wallet"
					? fundingSource
					: "unavailable",
		priceCents: subscription.price_cents,
		currency: subscription.currency,
		billingTermMonths: subscription.billing_term_months,
		scheduleVerb: recovery.schedule?.verb ?? lifecycle.dateVerb,
		scheduleAt: recovery.schedule?.at ?? lifecycle.dateAt,
		scheduleFallback: recovery.schedule?.fallback ?? undefined,
		includeSchedule: !isHistoricalAccountSubscription(subscription),
	});
	const identity = computeSubscriptionIdentity(
		subscription,
		assignment,
		agentTile,
		agentHref,
		reusableInventoryUncertain,
	);
	const hasRetainedDeployment = !subscription.is_orphan && subscription.deployment_id !== null;
	const cancellationCopy = computeSubscriptionCancellationCopy({
		isTrial: subscription.actions?.cancel === "end_trial",
		periodEndLabel: subscription.current_period_end
			? formatShortDate(subscription.current_period_end)
			: null,
		hasRetainedDeployment,
	});

	return (
		<li className="grid min-w-0 lg:row-span-5 lg:grid-rows-subgrid">
			<ComputeSubscriptionCard
				headingLevel={4}
				view={view}
				identity={identity}
				className="lg:row-span-full lg:grid-rows-subgrid lg:[&>[data-slot=compute-subscription-actions]]:row-start-5"
				notice={
					recoveryNotice || pendingPlanCopy || managementReason ? (
						<div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
							{recoveryNotice ? <p>{recoveryNotice}</p> : null}
							{managementReason ? <p>{managementReason}</p> : null}
							{pendingPlanCopy ? (
								<p className="font-medium text-warning-muted-foreground">{pendingPlanCopy}</p>
							) : null}
						</div>
					) : null
				}
				actions={
					hasActions ? (
						<ComputeSubscriptionActionList
							actions={actions}
							target={{
								kind: "subscription",
								subscriptionId: subscription.subscription_id,
								deploymentId: subscription.deployment_id ?? null,
							}}
							onPlanChange={() => onPlanChange(subscription)}
							onStartNew={
								startNewHref
									? { kind: "link", href: startNewHref, label: "Open Agent settings" }
									: null
							}
							cancelCopy={{
								title: `Cancel ${computeSubscriptionPlanLabel(subscription.plan_slug)} subscription?`,
								description: <p>{cancellationCopy.description}</p>,
								confirmLabel: cancellationCopy.confirmLabel,
								successDescription: (result) =>
									computeSubscriptionCancellationSuccessCopy({
										isTrial: subscription.actions?.cancel === "end_trial",
										cancelAtPeriodEnd: result.cancel_at_period_end,
										periodEndLabel: result.current_period_end
											? formatShortDate(result.current_period_end)
											: null,
										hasRetainedDeployment,
									}),
							}}
						/>
					) : null
				}
			/>
		</li>
	);
}

function subscriptionStatusPriority(status: string): number {
	switch (status) {
		case "trialing":
		case "active":
			return 0;
		case "past_due":
			return 1;
		case "canceling":
			return 2;
		case "canceled":
			return 3;
		default:
			return 4;
	}
}

export function sortLoadedSubscriptions(
	subscriptions: readonly ComputeSubscriptionListItem[],
): ComputeSubscriptionListItem[] {
	return subscriptions
		.map((subscription, index) => ({ subscription, index }))
		.sort(
			(a, b) =>
				subscriptionStatusPriority(a.subscription.status) -
					subscriptionStatusPriority(b.subscription.status) || a.index - b.index,
		)
		.map(({ subscription }) => subscription);
}

export function reusableInventoryState(
	error: unknown,
	data: readonly unknown[] | undefined,
): "loading" | "error" | "ready" {
	if (shouldBlockQueryError(error, data)) return "error";
	return data === undefined ? "loading" : "ready";
}

const SUBSCRIPTION_CARD_GRID_CLASS = "grid gap-2 lg:grid-cols-2";

function SubscriptionListSkeleton({ label = "Loading subscriptions" }: { label?: string }) {
	return (
		<div className={SUBSCRIPTION_CARD_GRID_CLASS} role="status">
			<span className="sr-only">{label}</span>
			{Array.from({ length: 3 }, (_, index) => `subscription-skeleton-${index}`).map((key) => (
				<div key={key} className={entityCardChassisClass({ variant: "compact" })}>
					<div className="flex items-start justify-between gap-3">
						<Skeleton className="h-5 w-36 max-w-full" />
						<Skeleton className="h-5 w-16" />
					</div>
					<div className="flex flex-wrap gap-x-4 gap-y-1.5">
						<Skeleton className="h-4 w-16" />
						<Skeleton className="h-4 w-12" />
						<Skeleton className="h-4 w-24" />
					</div>
					<div className="flex items-center gap-3">
						<Skeleton className="h-4 w-12" />
						<Skeleton className="size-6 shrink-0 rounded-md" />
						<Skeleton className="h-4 w-28 max-w-full" />
					</div>
				</div>
			))}
		</div>
	);
}

export function SubscriptionsSection({ agentTiles }: { agentTiles: readonly AgentTile[] }) {
	const billingClient = useBillingClient();
	const subscriptions = useSubscriptions();
	const reusableSubscriptions = useReusableSubscriptions(billingClient);
	const plans = usePlans();
	const deployments = useHostedDeployments();
	const hostedAccess = useProductAccess();
	const [showHistory, setShowHistory] = useState(false);
	const [selectedSubscription, setSelectedSubscription] =
		useState<ComputeSubscriptionListItem | null>(null);
	const [planChangeOpen, setPlanChangeOpen] = useState(false);
	const rows = subscriptions.data?.pages.flatMap((page) => page.items ?? []) ?? [];
	const availabilityState = reusableInventoryState(
		reusableSubscriptions.error,
		reusableSubscriptions.data,
	);
	const orderedRows = sortLoadedSubscriptions(rows);
	const agentTilesByAgentId = new Map(
		agentTiles
			.filter((tile) => tile.source === "on-clawdi")
			.map((tile) => [tile.id.toLowerCase(), tile] as const),
	);
	const reusableSubscriptionIds = new Set(
		(reusableSubscriptions.data ?? []).map((subscription) => subscription.subscription_id),
	);
	const endedRows = rows.filter(isHistoricalAccountSubscription);
	const visibleRows = showHistory
		? orderedRows
		: orderedRows.filter((subscription) => !isHistoricalAccountSubscription(subscription));
	const canLoadMore = subscriptions.hasNextPage && !subscriptions.isFetchNextPageError;
	const historyControlVisible = endedRows.length > 0 || showHistory;
	const deploymentsById = new Map(
		(deployments.data ?? []).map((deployment) => [
			deployment.resource.id.toLowerCase(),
			deployment,
		]),
	);
	const managementOptions = {
		canCreateCloudAgents: hostedAccess.canCreateCloudAgents,
		plansLoading: plans.isLoading,
		performancePlanAvailable: Boolean(resolvePerformancePlan(plans.data)),
	};
	const selectedDeployment = selectedSubscription?.deployment_id
		? deploymentsById.get(selectedSubscription.deployment_id.toLowerCase())
		: undefined;
	const selectedManagement = selectedSubscription
		? subscriptionManagement(selectedSubscription, selectedDeployment, managementOptions)
		: null;

	function openPlanChange(subscription: ComputeSubscriptionListItem) {
		const deployment = subscription.deployment_id
			? deploymentsById.get(subscription.deployment_id.toLowerCase())
			: undefined;
		if (subscriptionManagement(subscription, deployment, managementOptions).action !== "enabled")
			return;
		setSelectedSubscription(subscription);
		setPlanChangeOpen(true);
	}

	return (
		<>
			{selectedManagement?.action === "enabled" ? (
				<PlanChangeController
					open={planChangeOpen}
					onOpenChange={setPlanChangeOpen}
					target={selectedManagement.target}
					plans={plans.data ?? []}
				/>
			) : null}
			<SettingsSection
				data-hosted="true"
				headingLevel={3}
				title="Your subscriptions"
				description="Manage every compute subscription in one place."
			>
				{subscriptions.isLoading ? (
					<SubscriptionListSkeleton />
				) : shouldBlockQueryError(subscriptions.error, subscriptions.data) ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={subscriptions.error}
						onRetry={() => void subscriptions.refetch()}
						title="Couldn't load subscriptions"
					/>
				) : availabilityState === "loading" ? (
					<SubscriptionListSkeleton label="Loading subscription availability" />
				) : availabilityState === "error" ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={reusableSubscriptions.error}
						onRetry={() => void reusableSubscriptions.refetch()}
						title="Couldn't load subscription availability"
					/>
				) : rows.length || subscriptions.hasNextPage ? (
					<>
						{historyControlVisible ? (
							<div className="flex justify-end">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-pressed={showHistory}
									onClick={() => setShowHistory((current) => !current)}
								>
									<History />
									{showHistory
										? "Hide history"
										: `Show history${endedRows.length ? ` (${endedRows.length})` : ""}`}
								</Button>
							</div>
						) : null}
						{visibleRows.length ? (
							<ul className={SUBSCRIPTION_CARD_GRID_CLASS}>
								{visibleRows.map((subscription) => {
									const deployment = subscription.deployment_id
										? deploymentsById.get(subscription.deployment_id.toLowerCase())
										: undefined;
									return (
										<SubscriptionRow
											key={subscription.subscription_id}
											subscription={subscription}
											deployment={deployment}
											agentTile={
												deployment
													? agentTilesByAgentId.get(deployment.agent_id.toLowerCase())
													: undefined
											}
											management={subscriptionManagement(
												subscription,
												deployment,
												managementOptions,
											)}
											onPlanChange={openPlanChange}
											reusableSubscriptionIds={reusableSubscriptionIds}
											reusableInventoryUncertain={
												reusableSubscriptions.isFetching || reusableSubscriptions.error != null
											}
										/>
									);
								})}
							</ul>
						) : (
							<EmptyState
								variant="inset"
								icon={CreditCard}
								title="No current subscriptions"
								description={
									endedRows.length
										? "Ended subscriptions are hidden. Show history to view them."
										: "Load more records to find current subscriptions."
								}
								className="py-8 md:p-8"
							/>
						)}
						{canLoadMore ? (
							<SubscriptionLoadMore
								isLoading={subscriptions.isFetchingNextPage}
								onLoadMore={() => void subscriptions.fetchNextPage()}
							/>
						) : null}
						{subscriptions.isFetchNextPageError ? (
							<ApiErrorPanel
								normalizer={billingErrorNormalizer}
								error={subscriptions.error}
								onRetry={() => void subscriptions.fetchNextPage()}
								title="Couldn't load more subscriptions"
							/>
						) : null}
					</>
				) : (
					<EmptyState
						variant="inset"
						icon={CreditCard}
						title="No compute subscriptions"
						description="Compute subscriptions will appear here when you start a hosted agent."
						className="py-8 md:p-8"
					/>
				)}
			</SettingsSection>
		</>
	);
}
