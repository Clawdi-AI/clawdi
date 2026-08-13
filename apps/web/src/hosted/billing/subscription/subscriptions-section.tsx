"use client";

import { CreditCard, History } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { EmptyState } from "@/components/empty-state";
import { entityCardChassisClass } from "@/components/entity-card";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ComputeSubscriptionListItem, HostedDeployment } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useHostedDeployments, usePlans, useSubscriptions } from "@/hosted/billing/hooks";
import { ComputeSubscriptionActionList } from "@/hosted/billing/subscription/compute-subscription-action-list";
import { resolveComputeSubscriptionActions } from "@/hosted/billing/subscription/compute-subscription-actions";
import {
	ComputeSubscriptionCard,
	computeSubscriptionCardView,
	computeSubscriptionPlanLabel,
} from "@/hosted/billing/subscription/compute-subscription-card";
import {
	COMPUTE_PLANS_UNAVAILABLE_REASON,
	type ComputeSubscriptionManagementResult,
	computeSubscriptionManagement,
} from "@/hosted/billing/subscription/compute-subscription-management";
import { computeSubscriptionRecoveryPresentation } from "@/hosted/billing/subscription/compute-subscription-recovery";
import { PlanChangeController } from "@/hosted/billing/subscription/plan-change-controller";
import {
	computeFundingSource,
	computeSubscriptionLifecycle,
	isHistoricalAccountSubscription,
	pendingComputePlanSlug,
	pendingPlanScheduleCopy,
	resolvePerformancePlan,
} from "@/hosted/billing/subscription/subscription-utils";
import { agentSectionHref } from "@/lib/agent-routes";
import { formatShortDate } from "@/lib/format";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { shouldBlockQueryError } from "@/lib/query-state";

function subscriptionAgentHref(subscription: ComputeSubscriptionListItem): string | null {
	if (subscription.is_orphan || !subscription.deployment_id) return null;
	return agentSectionHref(subscription.deployment_id, "settings", {
		source: "on-clawdi",
		settings: "billing-plan",
	});
}

function subscriptionStartNewHref(subscription: ComputeSubscriptionListItem): string | null {
	if (subscription.is_orphan || !subscription.deployment_id) return null;
	return agentSectionHref(subscription.deployment_id, "settings", {
		source: "on-clawdi",
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
		plansError,
		performancePlanAvailable,
	}: {
		canCreateCloudAgents: boolean;
		plansLoading: boolean;
		plansError: boolean;
		performancePlanAvailable: boolean;
	},
): ComputeSubscriptionManagementResult {
	return computeSubscriptionManagement({
		entitlement: {
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
		plansError,
		performancePlanAvailable,
	});
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
	agentTile,
	management,
	onManage,
}: {
	subscription: ComputeSubscriptionListItem;
	agentTile?: AgentTile;
	management: ComputeSubscriptionManagementResult;
	onManage: (subscription: ComputeSubscriptionListItem) => void;
}) {
	const lifecycle = computeSubscriptionLifecycle(subscription);
	const recovery = computeSubscriptionRecoveryPresentation(subscription, {
		label: lifecycle.badgeLabel,
		tone: lifecycle.badgeTone,
	});
	const agentHref = subscriptionAgentHref(subscription);
	const startNewHref = subscriptionStartNewHref(subscription);
	const pendingPlanSlug = pendingComputePlanSlug(subscription);
	const actions = resolveComputeSubscriptionActions({
		entitlement: {
			deploymentId: subscription.deployment_id,
			planSlug: subscription.plan_slug,
			fundingSource: subscription.funding_source,
			priceCents: subscription.price_cents,
			status: subscription.status,
			paymentState: subscription.payment_state,
			cancelAtPeriodEnd: subscription.cancel_at_period_end,
			pendingPlanSlug,
			isOrphan: subscription.is_orphan,
		},
		management,
		recoveryTarget: recovery.recoveryTarget,
		hasPendingOperation: management.target?.projectedOperationName != null,
	});
	const pendingPlanCopy = pendingPlanSlug
		? pendingPlanScheduleCopy(
				pendingPlanSlug,
				subscription.current_period_end,
				formatShortDate(subscription.current_period_end),
			)
		: null;
	const recoveryNotice = (() => {
		switch (recovery.recoveryTarget?.kind) {
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
	const fundingSource = computeFundingSource(subscription.plan_slug, subscription);
	const managementReason =
		actions.find((candidate) => candidate.kind === "manage")?.disabledReason ===
		COMPUTE_PLANS_UNAVAILABLE_REASON
			? null
			: (actions.find((candidate) => candidate.kind === "manage")?.disabledReason ?? null);
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

	return (
		<li className="min-w-0">
			<ComputeSubscriptionCard
				headingLevel={4}
				view={view}
				identity={
					agentHref
						? {
								kind: "agent",
								name: agentTile?.name ?? subscription.agent_name ?? "Agent",
								agentType: agentTile?.agentType ?? null,
								avatarUrl: agentTile?.avatarUrl,
								href: agentHref,
							}
						: { kind: "unavailable", label: "Deleted agent" }
				}
				badges={subscription.is_orphan ? <Badge variant="outline">Orphaned</Badge> : null}
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
							onManage={() => onManage(subscription)}
							onStartNew={
								startNewHref
									? { kind: "link", href: startNewHref, label: "Open Agent settings" }
									: null
							}
							cancelCopy={{
								title: `Cancel ${computeSubscriptionPlanLabel(subscription.plan_slug)} subscription?`,
								description: (
									<p>
										The subscription will stop renewing
										{subscription.current_period_end
											? ` and remain active through ${formatShortDate(subscription.current_period_end)}`
											: ""}
										. This cannot restore a deleted agent.
									</p>
								),
								confirmLabel: "Cancel subscription",
								successDescription: (result) =>
									result.current_period_end
										? `Access continues through ${formatShortDate(result.current_period_end)}.`
										: undefined,
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

function SubscriptionListSkeleton() {
	return (
		<div className="grid gap-3 lg:grid-cols-2" role="status">
			<span className="sr-only">Loading subscriptions</span>
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
	const subscriptions = useSubscriptions();
	const plans = usePlans();
	const deployments = useHostedDeployments();
	const hostedAccess = useHostedProductAccess();
	const [showHistory, setShowHistory] = useState(false);
	const [selectedSubscription, setSelectedSubscription] =
		useState<ComputeSubscriptionListItem | null>(null);
	const [planChangeOpen, setPlanChangeOpen] = useState(false);
	const rows = subscriptions.data?.pages.flatMap((page) => page.items ?? []) ?? [];
	const orderedRows = sortLoadedSubscriptions(rows);
	const agentTilesByDeploymentId = new Map(
		agentTiles
			.filter((tile) => tile.source === "on-clawdi")
			.map((tile) => [tile.id.toLowerCase(), tile] as const),
	);
	const endedRows = rows.filter(isHistoricalAccountSubscription);
	const visibleRows = showHistory
		? orderedRows
		: orderedRows.filter((subscription) => !isHistoricalAccountSubscription(subscription));
	const canLoadMore = subscriptions.hasNextPage && !subscriptions.isFetchNextPageError;
	const historyControlVisible = endedRows.length > 0 || showHistory;
	const blockingPlansError = shouldBlockQueryError(plans.error, plans.data) ? plans.error : null;
	const deploymentsById = new Map(
		(deployments.data ?? []).map((deployment) => [
			deployment.resource.id.toLowerCase(),
			deployment,
		]),
	);
	const managementOptions = {
		canCreateCloudAgents: hostedAccess.canCreateCloudAgents,
		plansLoading: plans.isLoading,
		plansError: blockingPlansError !== null,
		performancePlanAvailable: Boolean(resolvePerformancePlan(plans.data)),
	};
	const selectedDeployment = selectedSubscription?.deployment_id
		? deploymentsById.get(selectedSubscription.deployment_id.toLowerCase())
		: undefined;
	const selectedManagement = selectedSubscription
		? subscriptionManagement(selectedSubscription, selectedDeployment, managementOptions)
		: null;
	const plansErrorBlocksVisibleIncluded =
		blockingPlansError !== null &&
		visibleRows.some((subscription) => {
			const deployment = subscription.deployment_id
				? deploymentsById.get(subscription.deployment_id.toLowerCase())
				: undefined;
			return (
				subscriptionManagement(subscription, deployment, managementOptions).unavailableReason ===
				COMPUTE_PLANS_UNAVAILABLE_REASON
			);
		});

	function manageSubscription(subscription: ComputeSubscriptionListItem) {
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
				) : rows.length || subscriptions.hasNextPage ? (
					<>
						{plansErrorBlocksVisibleIncluded ? (
							<ApiErrorPanel
								normalizer={billingErrorNormalizer}
								error={blockingPlansError}
								onRetry={() => void plans.refetch()}
								title="Couldn't load compute plans"
							/>
						) : null}
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
							<ul className="grid gap-3 lg:grid-cols-2">
								{visibleRows.map((subscription) => (
									<SubscriptionRow
										key={subscription.subscription_id}
										subscription={subscription}
										agentTile={
											subscription.deployment_id
												? agentTilesByDeploymentId.get(subscription.deployment_id.toLowerCase())
												: undefined
										}
										management={subscriptionManagement(
											subscription,
											subscription.deployment_id
												? deploymentsById.get(subscription.deployment_id.toLowerCase())
												: undefined,
											managementOptions,
										)}
										onManage={manageSubscription}
									/>
								))}
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
