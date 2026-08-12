"use client";

import { Link } from "@tanstack/react-router";
import { CreditCard, History, Link2Off, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
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
import { billingTermLabel, billingTermSuffix, formatCurrencyCents } from "@/hosted/billing/format";
import {
	useCancelSubscription,
	useResumeSubscription,
	useSubscriptions,
} from "@/hosted/billing/hooks";
import { ComputeSubscriptionCard } from "@/hosted/billing/subscription/compute-subscription-card";
import {
	canCancelAccountSubscription,
	canResumeAccountSubscription,
	computeTierLabel,
	isEndedAccountSubscription,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { agentSectionLink } from "@/lib/agent-routes";
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

function planLabel(planSlug: string): string {
	if (planSlug === "compute_basic" || planSlug === "compute_performance") {
		return `Compute ${computeTierLabel(planSlug)}`;
	}
	return planSlug.replace(/^compute_/, "").replaceAll("_", " ");
}

export function subscriptionPaymentSourceLabel(
	fundingSource: ComputeSubscriptionListItem["funding_source"],
): string {
	if (fundingSource === null) return "Included";
	if (fundingSource === "stripe") return "Card";
	if (fundingSource === "wallet") return "Wallet";
	return "Unavailable";
}

function priceLabel(subscription: ComputeSubscriptionListItem): string {
	if (subscription.price_cents == null) return "Unavailable";
	return `${formatCurrencyCents(subscription.price_cents, subscription.currency)}${billingTermSuffix(subscription.billing_term_months)}`;
}

function periodLabel(subscription: ComputeSubscriptionListItem): string {
	if (!subscription.current_period_end) return "Unavailable";
	const date = formatShortDate(subscription.current_period_end);
	if (subscription.status === "canceling") return `Ends ${date}`;
	if (subscription.status === "canceled") return `Ended ${date}`;
	if (subscription.status === "past_due") return `Due ${date}`;
	return `Renews ${date}`;
}

function SubscriptionActions({ subscription }: { subscription: ComputeSubscriptionListItem }) {
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

	if (!canCancel && !canResume) {
		return null;
	}

	return (
		<div className="flex flex-wrap gap-2 sm:justify-end">
			{canResume ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={pending}
					onClick={() => void runAction(resume).catch(() => undefined)}
				>
					{resumeSubscription.isPending ? <Spinner /> : <RefreshCw />}
					Resume
				</Button>
			) : null}
			{canCancel ? (
				<ConfirmAction
					title={`Cancel ${planLabel(subscription.plan_slug)} subscription?`}
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
						Cancel
					</Button>
				</ConfirmAction>
			) : null}
		</div>
	);
}

export function SubscriptionAgentLink({
	deploymentId,
	agentName,
}: {
	deploymentId: ComputeSubscriptionListItem["deployment_id"];
	agentName: ComputeSubscriptionListItem["agent_name"];
}) {
	return deploymentId && agentName ? (
		<Link
			{...agentSectionLink(deploymentId, "settings", {
				source: "on-clawdi",
				settings: "billing-plan",
			})}
			className="block min-w-0 truncate font-medium text-primary underline-offset-4 hover:underline"
			title={agentName}
		>
			{agentName}
		</Link>
	) : (
		<span className="font-medium text-muted-foreground">Deleted agent</span>
	);
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

function SubscriptionRow({ subscription }: { subscription: ComputeSubscriptionListItem }) {
	const status = STATUS_PRESENTATION[subscription.status];
	const hasActions =
		canCancelAccountSubscription(subscription) || canResumeAccountSubscription(subscription);

	return (
		<li className="min-w-0">
			<ComputeSubscriptionCard
				headingLevel={4}
				title={planLabel(subscription.plan_slug)}
				status={status}
				badges={subscription.is_orphan ? <Badge variant="outline">Orphaned</Badge> : null}
				details={[
					{
						label: "Agent",
						value: (
							<SubscriptionAgentLink
								deploymentId={subscription.deployment_id}
								agentName={subscription.agent_name}
							/>
						),
					},
					{
						label: "Payment",
						value: subscriptionPaymentSourceLabel(subscription.funding_source),
					},
					{
						label: "Billing",
						value: (
							<>
								<span className="tabular-nums">{priceLabel(subscription)}</span>
								<span className="mt-0.5 block text-xs font-normal text-muted-foreground">
									{billingTermLabel(subscription.billing_term_months)}
								</span>
							</>
						),
					},
					{ label: "Schedule", value: periodLabel(subscription) },
				]}
				actions={hasActions ? <SubscriptionActions subscription={subscription} /> : null}
			/>
		</li>
	);
}

function SubscriptionListSkeleton() {
	return (
		<div className="space-y-3" role="status">
			<span className="sr-only">Loading subscriptions</span>
			{Array.from({ length: 3 }, (_, index) => `subscription-skeleton-${index}`).map((key) => (
				<div key={key} className="overflow-hidden rounded-lg border bg-card">
					<div className="flex items-start justify-between gap-3 p-4">
						<Skeleton className="h-5 w-36" />
						<Skeleton className="h-5 w-16" />
					</div>
					<div className="grid grid-cols-2 gap-4 border-t px-4 py-3 sm:grid-cols-4">
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

export function SubscriptionsSection() {
	const subscriptions = useSubscriptions();
	const [showHistory, setShowHistory] = useState(false);
	const [historyCutoffMs] = useState(Date.now);
	const rows = subscriptions.data?.pages.flatMap((page) => page.items ?? []) ?? [];
	const endedRows = rows.filter((subscription) =>
		isEndedAccountSubscription(subscription, historyCutoffMs),
	);
	const visibleRows = showHistory
		? rows
		: rows.filter((subscription) => !isEndedAccountSubscription(subscription, historyCutoffMs));
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
						<ul className="space-y-3">
							{visibleRows.map((subscription) => (
								<SubscriptionRow key={subscription.subscription_id} subscription={subscription} />
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
