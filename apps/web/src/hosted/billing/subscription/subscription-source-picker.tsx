import { subscriptionSourcePickerClasses as styles } from "@clawdi/shared/ui";
import {
	subscriptionSourceCopy as copy,
	formatShortDate,
	storeProviderLabel,
	storeSubscriptionCopy,
	storeSubscriptionDate,
	storeSubscriptionStatus,
} from "@clawdi/shared/view";
import { Cpu, CreditCard, Plus, Smartphone, WalletCards, Zap } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EntityChoiceCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ReusableSubscription } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { billingTermLabel, billingTermSuffix, formatCurrencyCents } from "@/hosted/billing/format";
import {
	isWebSelectableSubscription,
	type SubscriptionSource,
} from "@/hosted/billing/subscription/subscription-create-adapter";
import { computeTierLabel } from "@/hosted/billing/subscription/subscription-utils";

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
		<div data-hosted="true" className={styles.root}>
			<div className={styles.grid}>
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
						title={copy.includedTitle}
						description={copy.includedDescription}
						details={<span className={styles.dueNow}>{copy.dueNow}</span>}
						badge={<Badge variant="secondary">{copy.included}</Badge>}
						className={styles.choice}
					/>
				) : null}
				{reusableSubscriptions.map((subscription) => (
					<ExistingSubscriptionChoice
						key={subscription.subscription_id}
						subscription={subscription}
						selected={
							value?.mode === "existing" && value.subscriptionId === subscription.subscription_id
						}
						disabled={paidDisabled || !isWebSelectableSubscription(subscription)}
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
					title={copy.newTitle}
					description={copy.newDescription}
					className={styles.choice}
				/>
			</div>
			{isLoading ? (
				<p className={styles.loading} role="status">
					<Spinner className={styles.icon} /> Checking compute availability…
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
	const store = subscription.funding_source === "store";
	const storeManagement = store ? subscription.store_management : null;
	const paymentLabel = store
		? storeProviderLabel(storeManagement)
		: subscription.funding_source === "wallet"
			? "Wallet"
			: "Card";
	const PaymentIcon = store
		? Smartphone
		: subscription.funding_source === "wallet"
			? WalletCards
			: CreditCard;
	const canceling = subscription.status === "canceling" || subscription.cancel_at_period_end;
	const storeDate = storeSubscriptionDate(storeManagement);
	const dateLabel = formatShortDate(
		storeDate?.at ?? subscription.current_period_end ?? subscription.entitled_until,
	);
	const dateTitle = store
		? storeDate?.kind === "renews"
			? "Renews"
			: "Ends"
		: canceling
			? "Ends"
			: "Renews";
	// Store prices are set per storefront; Web shows no Clawdi price for them.
	const priceLabel =
		store || subscription.price_cents == null
			? null
			: `${formatCurrencyCents(subscription.price_cents, subscription.currency)}${billingTermSuffix(subscription.billing_term_months)}`;
	const fallbackStatus = canceling
		? ({ label: "Canceling", tone: "warning" } as const)
		: subscription.status === "trialing"
			? ({ label: "Trial", tone: "info" } as const)
			: ({ label: "Active", tone: "success" } as const);
	const status = store ? storeSubscriptionStatus(storeManagement, fallbackStatus) : fallbackStatus;
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
			description={store ? storeSubscriptionCopy.availableInApp : copy.dueNow}
			badge={<StatusBadge status={status.tone}>{status.label}</StatusBadge>}
			detailsPlacement="responsive"
			details={
				<dl className={styles.existingFacts}>
					<div className={styles.fact}>
						<dt className={styles.factLabel}>Term</dt>
						<dd className={styles.factValue}>
							{billingTermLabel(subscription.billing_term_months)}
						</dd>
					</div>
					<div className={styles.fact}>
						<dt className={styles.factLabel}>Payment</dt>
						<dd className={styles.payment}>
							<PaymentIcon className={styles.paymentIcon} />
							<span className={styles.price}>{paymentLabel}</span>
						</dd>
					</div>
					<div className={styles.fact}>
						<dt className={styles.factLabel}>{dateTitle}</dt>
						<dd className={styles.factValue}>{dateLabel}</dd>
					</div>
					{priceLabel ? (
						<div className={styles.fact}>
							<dt className={styles.factLabel}>Plan price</dt>
							<dd className={styles.nowrap}>{priceLabel}</dd>
						</div>
					) : null}
				</dl>
			}
			className={styles.choice}
		/>
	);
}
