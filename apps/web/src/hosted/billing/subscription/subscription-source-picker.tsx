import { Cpu, CreditCard, Plus, WalletCards, Zap } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EntityChoiceCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ReusableSubscription } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { billingTermLabel, billingTermSuffix, formatCurrencyCents } from "@/hosted/billing/format";
import type { SubscriptionSource } from "@/hosted/billing/subscription/subscription-create-adapter";
import { computeTierLabel } from "@/hosted/billing/subscription/subscription-utils";
import { formatShortDate } from "@/lib/format";

export function SubscriptionSourcePicker({
	disabled = false,
	error,
	isLoading,
	onChange,
	onRetry,
	reusableSubscriptions,
	showIncluded = false,
	value,
}: {
	disabled?: boolean;
	error: unknown;
	isLoading: boolean;
	onChange: (source: SubscriptionSource) => void;
	onRetry: () => void;
	reusableSubscriptions: readonly ReusableSubscription[];
	showIncluded?: boolean;
	value: SubscriptionSource | null;
}) {
	const onlyNewSubscription =
		value?.mode === "new" &&
		!isLoading &&
		error == null &&
		!showIncluded &&
		reusableSubscriptions.length === 0;

	if (onlyNewSubscription) return null;

	const paidDisabled = disabled || error != null || isLoading;
	return (
		<div data-hosted="true" className="@container/subscription-source flex min-w-0 flex-col gap-3">
			<div className="grid min-w-0 items-start gap-2 @3xl/subscription-source:grid-cols-2">
				{showIncluded ? (
					<EntityChoiceCard
						selected={value?.mode === "included"}
						onClick={disabled ? undefined : () => onChange({ mode: "included" })}
						disabled={disabled}
						icon={
							<IconChip size="sm" tint="bg-identity-3-bg text-identity-3-fg">
								<Cpu />
							</IconChip>
						}
						title="Basic compute"
						description="Use your free compute entitlement."
						details={<span className="text-xs font-medium text-foreground">$0 due now</span>}
						badge={<Badge variant="secondary">Free</Badge>}
						className="items-start p-3"
					/>
				) : null}
				{reusableSubscriptions.map((subscription) => (
					<ExistingSubscriptionChoice
						key={subscription.subscription_id}
						subscription={subscription}
						selected={
							value?.mode === "existing" && value.subscriptionId === subscription.subscription_id
						}
						disabled={paidDisabled}
						onSelect={() =>
							onChange({ mode: "existing", subscriptionId: subscription.subscription_id })
						}
					/>
				))}
				<EntityChoiceCard
					selected={value?.mode === "new"}
					onClick={paidDisabled ? undefined : () => onChange({ mode: "new" })}
					disabled={paidDisabled}
					icon={
						<IconChip size="sm" tint="bg-muted text-muted-foreground">
							<Plus />
						</IconChip>
					}
					title="New paid subscription"
					description="Choose a plan, billing term, and payment source."
					className="items-start p-3"
				/>
			</div>
			{isLoading ? (
				<p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
					<Spinner className="size-3.5" /> Checking compute availability…
				</p>
			) : error != null ? (
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={error}
					onRetry={onRetry}
					title="Couldn’t load reusable subscriptions"
				/>
			) : null}
		</div>
	);
}

function ExistingSubscriptionChoice({
	disabled,
	onSelect,
	selected,
	subscription,
}: {
	disabled: boolean;
	onSelect: () => void;
	selected: boolean;
	subscription: ReusableSubscription;
}) {
	const paymentLabel = subscription.funding_source === "wallet" ? "Wallet" : "Card";
	const canceling = subscription.status === "canceling" || subscription.cancel_at_period_end;
	const dateLabel = formatShortDate(subscription.current_period_end ?? subscription.entitled_until);
	const priceLabel =
		subscription.price_cents == null
			? null
			: `${formatCurrencyCents(subscription.price_cents, subscription.currency)}${billingTermSuffix(subscription.billing_term_months)}`;
	const statusBadge = canceling ? (
		<StatusBadge status="warning">Canceling</StatusBadge>
	) : subscription.status === "trialing" ? (
		<StatusBadge status="info">Trial</StatusBadge>
	) : (
		<StatusBadge status="success">Active</StatusBadge>
	);
	return (
		<EntityChoiceCard
			selected={selected}
			onClick={disabled ? undefined : onSelect}
			disabled={disabled}
			icon={
				<IconChip
					size="sm"
					tint={
						subscription.plan_slug === "compute_performance"
							? "bg-identity-8-bg text-identity-8-fg"
							: "bg-identity-3-bg text-identity-3-fg"
					}
				>
					{subscription.plan_slug === "compute_performance" ? <Zap /> : <Cpu />}
				</IconChip>
			}
			title={computeTierLabel(subscription.plan_slug)}
			description="$0 due now"
			badge={statusBadge}
			detailsPlacement="responsive"
			details={
				<dl className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-1 text-[11px] @md/choice:gap-x-3 @md/choice:text-xs">
					<div className="min-w-0">
						<dt className="text-muted-foreground">Term</dt>
						<dd className="whitespace-nowrap text-foreground">
							{billingTermLabel(subscription.billing_term_months)}
						</dd>
					</div>
					<div className="min-w-0">
						<dt className="text-muted-foreground">Payment</dt>
						<dd className="flex min-w-0 items-center gap-1 text-foreground">
							{subscription.funding_source === "wallet" ? (
								<WalletCards className="size-3 shrink-0" />
							) : (
								<CreditCard className="size-3 shrink-0" />
							)}
							<span className="whitespace-nowrap">{paymentLabel}</span>
						</dd>
					</div>
					<div className="min-w-0">
						<dt className="text-muted-foreground">{canceling ? "Ends" : "Renews"}</dt>
						<dd className="whitespace-nowrap text-foreground">{dateLabel}</dd>
					</div>
					{priceLabel ? (
						<div className="min-w-0">
							<dt className="text-muted-foreground">Plan price</dt>
							<dd className="whitespace-nowrap text-foreground tabular-nums">{priceLabel}</dd>
						</div>
					) : null}
				</dl>
			}
			className="items-start p-3"
		/>
	);
}
