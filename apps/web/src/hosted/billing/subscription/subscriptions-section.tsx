"use client";

import { Link } from "@tanstack/react-router";
import { CreditCard, History, Link2Off, RefreshCw, Settings } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { EmptyState } from "@/components/empty-state";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { StatusTone } from "@/components/ui/status-badge";
import type { ComputeSubscriptionListItem } from "@/hosted/billing/contracts";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import {
	useCancelSubscription,
	useResumeSubscription,
	useSubscriptions,
} from "@/hosted/billing/hooks";
import {
	ComputeSubscriptionCard,
	computeSubscriptionCardView,
	computeSubscriptionPlanLabel,
} from "@/hosted/billing/subscription/compute-subscription-card";
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
	manageHref,
}: {
	subscription: ComputeSubscriptionListItem;
	manageHref: string | null;
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

	if (!manageHref && !canCancel && !canResume) {
		return null;
	}

	return (
		<>
			{manageHref ? (
				<Button
					render={<Link to={manageHref} />}
					nativeButton={false}
					type="button"
					variant="outline"
					size="sm"
				>
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

function subscriptionManageHref(subscription: ComputeSubscriptionListItem): string | null {
	if (subscription.is_orphan || !subscription.deployment_id || !subscription.agent_name)
		return null;
	return agentSectionHref(subscription.deployment_id, "settings", {
		source: "on-clawdi",
		settings: "billing-plan",
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
}: {
	subscription: ComputeSubscriptionListItem;
	agentTile?: AgentTile;
}) {
	const status = STATUS_PRESENTATION[subscription.status];
	const manageHref = subscriptionManageHref(subscription);
	const hasActions =
		manageHref !== null ||
		canCancelAccountSubscription(subscription) ||
		canResumeAccountSubscription(subscription);
	const view = computeSubscriptionCardView({
		identity: manageHref
			? {
					kind: "agent",
					name: agentTile?.name ?? subscription.agent_name ?? "Agent",
					agentType: agentTile?.agentType ?? null,
					avatarUrl: agentTile?.avatarUrl,
					href: manageHref,
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
						<SubscriptionActions subscription={subscription} manageHref={manageHref} />
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
				<div key={key} className="overflow-hidden rounded-lg border bg-card">
					<div className="flex items-start justify-between gap-3 p-4">
						<Skeleton className="h-5 w-36" />
						<Skeleton className="h-5 w-16" />
					</div>
					<div className="grid grid-cols-2 gap-4 border-t px-4 py-3">
						{Array.from({ length: 4 }, (_, detailIndex) => `${key}-${detailIndex}`).map(
							(detailKey) => (
								<div key={detailKey} className="space-y-1.5">
									<Skeleton className="h-3 w-12" />
									<Skeleton className="h-4 w-20 max-w-full" />
								</div>
							),
						)}
					</div>
				</div>
			))}
		</div>
	);
}

export function SubscriptionsSection({ agentTiles }: { agentTiles: readonly AgentTile[] }) {
	const subscriptions = useSubscriptions();
	const [showHistory, setShowHistory] = useState(false);
	const [historyCutoffMs] = useState(Date.now);
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

	return (
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
	);
}
