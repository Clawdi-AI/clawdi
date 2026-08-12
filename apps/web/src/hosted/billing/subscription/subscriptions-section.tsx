"use client";

import { Link } from "@tanstack/react-router";
import { CreditCard, Link2Off, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import type { ComputeSubscriptionListItem } from "@/hosted/billing/contracts";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import { billingTermLabel, billingTermSuffix, formatCents } from "@/hosted/billing/format";
import {
	useCancelSubscription,
	useResumeSubscription,
	useSubscriptions,
} from "@/hosted/billing/hooks";
import {
	canCancelAccountSubscription,
	canResumeAccountSubscription,
	computeTierLabel,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { agentSectionLink } from "@/lib/agent-routes";
import { formatShortDate } from "@/lib/format";
import { shouldBlockQueryError } from "@/lib/query-state";

const SUBSCRIPTION_GRID_CLASS =
	"grid gap-4 lg:grid-cols-[minmax(10rem,1.35fr)_minmax(8rem,1fr)_minmax(7rem,.7fr)_minmax(7rem,.65fr)_minmax(8rem,.8fr)_minmax(9rem,auto)] lg:items-center";

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
	if (subscription.currency.toLowerCase() === "usd") {
		return `${formatCents(subscription.price_cents)}${billingTermSuffix(subscription.billing_term_months)}`;
	}
	try {
		const amount = new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: subscription.currency,
		}).format(subscription.price_cents / 100);
		return `${amount}${billingTermSuffix(subscription.billing_term_months)}`;
	} catch {
		return `${(subscription.price_cents / 100).toFixed(2)} ${subscription.currency.toUpperCase()}${billingTermSuffix(subscription.billing_term_months)}`;
	}
}

function periodLabel(subscription: ComputeSubscriptionListItem): string {
	if (!subscription.current_period_end) return "Unavailable";
	const date = formatShortDate(subscription.current_period_end);
	if (subscription.status === "canceling") return `Ends ${date}`;
	if (subscription.status === "canceled") return `Ended ${date}`;
	if (subscription.status === "past_due") return `Due ${date}`;
	return `Renews ${date}`;
}

function FieldLabel({ children }: { children: ReactNode }) {
	return <div className="mb-1 text-xs font-medium text-muted-foreground lg:hidden">{children}</div>;
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
		return <span className="hidden text-muted-foreground lg:inline">-</span>;
	}

	return (
		<div className="flex flex-wrap gap-2 lg:justify-end">
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
}: {
	deploymentId: ComputeSubscriptionListItem["deployment_id"];
}) {
	return deploymentId ? (
		<Link
			{...agentSectionLink(deploymentId, "settings", {
				source: "on-clawdi",
				settings: "billing-plan",
			})}
			className="font-medium text-primary underline-offset-4 hover:underline"
		>
			View agent
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

	return (
		<li className={`${SUBSCRIPTION_GRID_CLASS} px-3 py-4`}>
			<div className="min-w-0">
				<FieldLabel>Subscription</FieldLabel>
				<div className="font-medium capitalize">{planLabel(subscription.plan_slug)}</div>
				<div className="mt-1 flex flex-wrap items-center gap-1.5">
					<StatusBadge status={status.tone}>{status.label}</StatusBadge>
					{subscription.is_orphan ? <Badge variant="outline">Orphaned</Badge> : null}
				</div>
			</div>
			<div className="min-w-0">
				<FieldLabel>Agent</FieldLabel>
				<SubscriptionAgentLink deploymentId={subscription.deployment_id} />
			</div>
			<div>
				<FieldLabel>Payment source</FieldLabel>
				<span className="text-sm font-medium">
					{subscriptionPaymentSourceLabel(subscription.funding_source)}
				</span>
			</div>
			<div>
				<FieldLabel>Price</FieldLabel>
				<div className="font-medium tabular-nums">{priceLabel(subscription)}</div>
				<div className="mt-0.5 text-xs text-muted-foreground">
					{billingTermLabel(subscription.billing_term_months)}
				</div>
			</div>
			<div>
				<FieldLabel>Renewal / end</FieldLabel>
				<span className="text-sm text-muted-foreground">{periodLabel(subscription)}</span>
			</div>
			<div>
				<FieldLabel>Actions</FieldLabel>
				<SubscriptionActions subscription={subscription} />
			</div>
		</li>
	);
}

function SubscriptionListSkeleton() {
	return (
		<div className="divide-y overflow-hidden rounded-lg border">
			{Array.from({ length: 3 }, (_, index) => `subscription-skeleton-${index}`).map((key) => (
				<div key={key} className={`${SUBSCRIPTION_GRID_CLASS} px-3 py-4`}>
					<Skeleton className="h-9 w-36" />
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-16" />
					<Skeleton className="h-9 w-20" />
					<Skeleton className="h-4 w-28" />
					<Skeleton className="h-8 w-20 lg:justify-self-end" />
				</div>
			))}
		</div>
	);
}

export function SubscriptionsSection() {
	const subscriptions = useSubscriptions();
	const rows = subscriptions.data?.pages.flatMap((page) => page.items ?? []) ?? [];

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
			) : rows.length ? (
				<>
					<div className="overflow-hidden rounded-lg border">
						<div
							aria-hidden
							className={`${SUBSCRIPTION_GRID_CLASS} hidden border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground lg:grid`}
						>
							<span>Subscription</span>
							<span>Agent</span>
							<span>Payment source</span>
							<span>Price</span>
							<span>Renewal / end</span>
							<span className="text-right">Actions</span>
						</div>
						<ul className="divide-y">
							{rows.map((subscription) => (
								<SubscriptionRow key={subscription.subscription_id} subscription={subscription} />
							))}
						</ul>
					</div>
					{subscriptions.hasNextPage && !subscriptions.isFetchNextPageError ? (
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
