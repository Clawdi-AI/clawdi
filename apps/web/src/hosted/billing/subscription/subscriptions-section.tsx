"use client";

import { CreditCard, History, Link2Off, RefreshCw, Settings } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { EmptyState } from "@/components/empty-state";
import { entityCardChassisClass } from "@/components/entity-card";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { StatusTone } from "@/components/ui/status-badge";
import type { ComputePlanSlug, ComputeSubscriptionListItem } from "@/hosted/billing/contracts";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import {
	useCancelSubscription,
	useHostedDeployments,
	usePlans,
	useResumeSubscription,
	useSubscriptions,
} from "@/hosted/billing/hooks";
import {
	ComputeSubscriptionCard,
	computeSubscriptionCardView,
	computeSubscriptionPlanLabel,
} from "@/hosted/billing/subscription/compute-subscription-card";
import { activePlanChangeOperationName } from "@/hosted/billing/subscription/plan-change.logic";
import {
	PlanChangeController,
	type PlanChangeTarget,
} from "@/hosted/billing/subscription/plan-change-controller";
import {
	canCancelAccountSubscription,
	canResumeAccountSubscription,
	isEndedAccountSubscription,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { agentSectionHref } from "@/lib/agent-routes";
import { formatShortDate } from "@/lib/format";
import { shouldBlockQueryError } from "@/lib/query-state";

const STATUS_PRESENTATION: Record<
	ComputeSubscriptionListItem["status"],
	{ label: string; tone: StatusTone }
> = {
	active: { label: "Active", tone: "success" },
	canceling: { label: "Canceling", tone: "warning" },
	past_due: { label: "Past due", tone: "destructive" },
	canceled: { label: "Canceled", tone: "neutral" },
};

function subscriptionScheduleVerb(status: ComputeSubscriptionListItem["status"]): string {
	if (status === "canceling") return "Ends";
	if (status === "canceled") return "Ended";
	if (status === "past_due") return "Due";
	return "Renews";
}

function SubscriptionActions({
	subscription,
	canManage,
	onManage,
}: {
	subscription: ComputeSubscriptionListItem;
	canManage: boolean;
	onManage: () => void;
}) {
	const cancelSubscription = useCancelSubscription();
	const resumeSubscription = useResumeSubscription();
	const runAction = useActionLock();
	const canCancel = canCancelAccountSubscription(subscription);
	const canResume = canResumeAccountSubscription(subscription);
	const pending = cancelSubscription.isPending || resumeSubscription.isPending;

	async function cancel() {
		try {
			const result = await cancelSubscription.mutateAsync({
				subscription_id: subscription.subscription_id,
			});
			toast.success(
				result.cancel_at_period_end ? "Cancellation scheduled" : "Subscription canceled",
				{
					description: result.current_period_end
						? `Access continues through ${formatShortDate(result.current_period_end)}.`
						: undefined,
				},
			);
		} catch (error) {
			toast.error("Couldn't cancel subscription", { description: normalizeBillingError(error) });
			throw error;
		}
	}

	async function resume() {
		try {
			await resumeSubscription.mutateAsync({ subscription_id: subscription.subscription_id });
			toast.success("Subscription resumed");
		} catch (error) {
			toast.error("Couldn't resume subscription", { description: normalizeBillingError(error) });
			throw error;
		}
	}

	if (!canManage && !canCancel && !canResume) {
		return null;
	}

	return (
		<>
			{canManage ? (
				<Button type="button" variant="outline" size="sm" onClick={onManage}>
					<Settings data-icon="inline-start" />
					Manage
				</Button>
			) : null}
			{canResume ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={pending}
					onClick={() => void runAction(resume).catch(() => undefined)}
				>
					{resumeSubscription.isPending ? <Spinner /> : <RefreshCw />}
					Resume subscription
				</Button>
			) : null}
			{canCancel ? (
				<ConfirmAction
					title={`Cancel ${computeSubscriptionPlanLabel(subscription.plan_slug)} subscription?`}
					description={
						<p>
							The subscription will stop renewing
							{subscription.current_period_end
								? ` and remain active through ${formatShortDate(subscription.current_period_end)}`
								: ""}
							. This cannot restore a deleted agent.
						</p>
					}
					confirmLabel="Cancel subscription"
					destructive
					onConfirm={() => runAction(cancel)}
				>
					<Button type="button" variant="outline" size="sm" disabled={pending}>
						{cancelSubscription.isPending ? <Spinner /> : <Link2Off />}
						Cancel subscription
					</Button>
				</ConfirmAction>
			) : null}
		</>
	);
}

function subscriptionAgentHref(subscription: ComputeSubscriptionListItem): string | null {
	if (subscription.is_orphan || !subscription.deployment_id || !subscription.agent_name)
		return null;
	return agentSectionHref(subscription.deployment_id, "settings", {
		source: "on-clawdi",
		settings: "billing-plan",
	});
}

function computePlanSlug(value: string): ComputePlanSlug | null {
	return value === "compute_basic" || value === "compute_performance" ? value : null;
}

export function canManageAccountSubscription(subscription: ComputeSubscriptionListItem): boolean {
	return (
		!subscription.is_orphan &&
		Boolean(subscription.deployment_id?.trim()) &&
		!subscription.cancel_at_period_end &&
		(subscription.status === "active" || subscription.status === "past_due") &&
		computePlanSlug(subscription.plan_slug) !== null &&
		(subscription.funding_source === "stripe" || subscription.funding_source === "wallet")
	);
}

function accountPlanChangeTarget(
	subscription: ComputeSubscriptionListItem,
	projectedOperationName: string | null,
): PlanChangeTarget | null {
	const deploymentId = subscription.deployment_id?.trim();
	const planSlug = computePlanSlug(subscription.plan_slug);
	const fundingSource = subscription.funding_source;
	if (
		!canManageAccountSubscription(subscription) ||
		!deploymentId ||
		!planSlug ||
		(fundingSource !== "stripe" && fundingSource !== "wallet")
	) {
		return null;
	}
	return {
		deploymentId,
		currentPlanSlug: planSlug,
		initialPlanSlug: planSlug,
		currentBillingTermMonths: subscription.billing_term_months,
		currentFundingSource: fundingSource,
		status: subscription.status,
		paymentSourceOnly: subscription.status === "past_due",
		cancelAtPeriodEnd: subscription.cancel_at_period_end,
		isPaidCompute: true,
		allowCombinedChange: false,
		projectedOperationName,
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
	agentTile,
	onManage,
}: {
	subscription: ComputeSubscriptionListItem;
	agentTile?: AgentTile;
	onManage: (subscription: ComputeSubscriptionListItem) => void;
}) {
	const status = STATUS_PRESENTATION[subscription.status];
	const agentHref = subscriptionAgentHref(subscription);
	const canManage = canManageAccountSubscription(subscription);
	const hasActions =
		canManage ||
		canCancelAccountSubscription(subscription) ||
		canResumeAccountSubscription(subscription);
	const view = computeSubscriptionCardView({
		identity: agentHref
			? {
					kind: "agent",
					name: agentTile?.name ?? subscription.agent_name ?? "Agent",
					agentType: agentTile?.agentType ?? null,
					avatarUrl: agentTile?.avatarUrl,
					href: agentHref,
				}
			: { kind: "unavailable", label: "Deleted agent" },
		status,
		planSlug: subscription.plan_slug,
		fundingSource: subscription.funding_source === null ? "included" : subscription.funding_source,
		priceCents: subscription.price_cents,
		currency: subscription.currency,
		billingTermMonths: subscription.billing_term_months,
		scheduleVerb: subscriptionScheduleVerb(subscription.status),
		scheduleAt: subscription.current_period_end,
	});

	return (
		<li className="min-w-0">
			<ComputeSubscriptionCard
				headingLevel={4}
				view={view}
				badges={subscription.is_orphan ? <Badge variant="outline">Orphaned</Badge> : null}
				actions={
					hasActions ? (
						<SubscriptionActions
							subscription={subscription}
							canManage={canManage}
							onManage={() => onManage(subscription)}
						/>
					) : null
				}
			/>
		</li>
	);
}

const SUBSCRIPTION_STATUS_PRIORITY: Record<ComputeSubscriptionListItem["status"], number> = {
	active: 0,
	past_due: 1,
	canceling: 2,
	canceled: 3,
};

export function sortLoadedSubscriptions(
	subscriptions: readonly ComputeSubscriptionListItem[],
): ComputeSubscriptionListItem[] {
	return subscriptions
		.map((subscription, index) => ({ subscription, index }))
		.sort(
			(a, b) =>
				SUBSCRIPTION_STATUS_PRIORITY[a.subscription.status] -
					SUBSCRIPTION_STATUS_PRIORITY[b.subscription.status] || a.index - b.index,
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
						<div className="flex min-w-0 items-center gap-3">
							<Skeleton className="size-8 shrink-0 rounded-md" />
							<Skeleton className="h-5 w-36 max-w-full" />
						</div>
						<Skeleton className="h-5 w-16" />
					</div>
					<div className="space-y-2.5">
						<Skeleton className="h-5 w-28" />
						<div className="flex flex-wrap gap-x-4 gap-y-1.5">
							<Skeleton className="h-4 w-12" />
							<Skeleton className="h-4 w-20" />
							<Skeleton className="h-4 w-24" />
						</div>
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
	const [showHistory, setShowHistory] = useState(false);
	const [historyCutoffMs] = useState(Date.now);
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
	const endedRows = rows.filter((subscription) =>
		isEndedAccountSubscription(subscription, historyCutoffMs),
	);
	const visibleRows = showHistory
		? orderedRows
		: orderedRows.filter(
				(subscription) => !isEndedAccountSubscription(subscription, historyCutoffMs),
			);
	const canLoadMore = subscriptions.hasNextPage && !subscriptions.isFetchNextPageError;
	const historyControlVisible = endedRows.length > 0 || showHistory;
	const selectedDeployment = selectedSubscription?.deployment_id
		? deployments.data?.find(
				(deployment) =>
					deployment.resource.id.toLowerCase() ===
					selectedSubscription.deployment_id?.toLowerCase(),
			)
		: undefined;
	const selectedTarget = selectedSubscription
		? accountPlanChangeTarget(
				selectedSubscription,
				selectedDeployment ? activePlanChangeOperationName(selectedDeployment) : null,
			)
		: null;

	function manageSubscription(subscription: ComputeSubscriptionListItem) {
		if (!canManageAccountSubscription(subscription)) return;
		setSelectedSubscription(subscription);
		setPlanChangeOpen(true);
	}

	return (
		<>
			{selectedTarget ? (
				<PlanChangeController
					open={planChangeOpen}
					onOpenChange={setPlanChangeOpen}
					target={selectedTarget}
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
