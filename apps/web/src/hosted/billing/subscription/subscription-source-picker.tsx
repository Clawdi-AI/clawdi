import { subscriptionSourcePickerClasses as styles } from "@clawdi/shared/ui";
import {
	subscriptionSourceCopy as copy,
	reusableSubscriptionChoiceView,
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
import {
	isWebSelectableSubscription,
	type SubscriptionSource,
} from "@/hosted/billing/subscription/subscription-create-adapter";

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
	const view = reusableSubscriptionChoiceView(subscription);
	const PaymentIcon =
		view.payment.kind === "store"
			? Smartphone
			: view.payment.kind === "wallet"
				? WalletCards
				: CreditCard;
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
			title={view.title}
			description={view.description}
			badge={<StatusBadge status={view.status.tone}>{view.status.label}</StatusBadge>}
			detailsPlacement="responsive"
			details={
				<dl className={styles.existingFacts}>
					{view.facts.map((fact) => (
						<div key={fact.id} className={styles.fact}>
							<dt className={styles.factLabel}>{fact.label}</dt>
							{fact.id === "payment" ? (
								<dd className={styles.payment}>
									<PaymentIcon className={styles.paymentIcon} />
									<span className={styles.price}>{fact.value}</span>
								</dd>
							) : (
								<dd className={fact.id === "price" ? styles.nowrap : styles.factValue}>
									{fact.value}
								</dd>
							)}
						</div>
					))}
				</dl>
			}
			className={styles.choice}
		/>
	);
}
