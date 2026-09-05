import {
	type BillingOffer,
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	type ComputePlanSlug,
	type ComputeSubscriptionActionResult,
	type ComputeSubscriptionListItem,
	type HostedComputeSubscription,
	type Plan,
} from "@/hosted/billing/contracts";

export { COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG };

export type ResolvedBillingOffer = {
	offer: BillingOffer;
	billingTermMonths: number;
};

export function isHistoricalAccountSubscription(
	subscription: Pick<ComputeSubscriptionListItem, "status" | "recovery_action" | "actions">,
): boolean {
	return (
		subscription.actions?.command_state == null && subscription.recovery_action === "start_new"
	);
}

export function isComputeSubscriptionActionUnconfirmed(
	result: ComputeSubscriptionActionResult,
): boolean {
	return result.action_state === "pending" || result.action_state === "reconciling";
}

export function computeSubscriptionCancellationCopy({
	isTrial,
	periodEndLabel,
	hasRetainedDeployment,
}: {
	isTrial: boolean;
	periodEndLabel: string | null;
	hasRetainedDeployment: boolean;
}): { description: string; confirmLabel: string } {
	if (isTrial) {
		return {
			description: hasRetainedDeployment
				? "The trial ends immediately and the agent stops. Your saved data is kept."
				: "The trial ends immediately. This cannot restore a deleted agent.",
			confirmLabel: "End trial now",
		};
	}
	const ending = periodEndLabel
		? `The subscription will stop renewing and remain active through ${periodEndLabel}.`
		: "The subscription will stop renewing at the end of the current billing period.";
	return {
		description: hasRetainedDeployment
			? `${ending} The agent stops when the period ends. Your saved data is kept.`
			: `${ending} This cannot restore a deleted agent.`,
		confirmLabel: "Cancel at period end",
	};
}

export function computeSubscriptionCancellationSuccessCopy({
	isTrial,
	cancelAtPeriodEnd,
	periodEndLabel,
	hasRetainedDeployment,
}: {
	isTrial: boolean;
	cancelAtPeriodEnd: boolean;
	periodEndLabel: string | null;
	hasRetainedDeployment: boolean;
}): string {
	if (!cancelAtPeriodEnd) {
		const ending = isTrial ? "The trial has ended." : "The subscription has ended.";
		return hasRetainedDeployment
			? `${ending} The agent will stop. Your saved data is kept.`
			: ending;
	}
	if (!hasRetainedDeployment) {
		return periodEndLabel
			? `The subscription remains active through ${periodEndLabel} and will not renew.`
			: "The subscription will not renew after the current billing period.";
	}
	return periodEndLabel
		? `The subscription remains active through ${periodEndLabel}. The agent will then stop. Your saved data is kept.`
		: "The agent will stop when the current billing period ends. Your saved data is kept.";
}

export function resolveBasicPlan(plans: Plan[] | undefined): Plan | undefined {
	return plans?.find((plan) => plan.slug === COMPUTE_BASIC_SLUG);
}

export function resolvePerformancePlan(plans: Plan[] | undefined): Plan | undefined {
	return plans?.find((plan) => plan.slug === COMPUTE_PERFORMANCE_SLUG);
}

export function isBasicCompute(planSlug: string | null | undefined): boolean {
	return planSlug === COMPUTE_BASIC_SLUG;
}

export type ComputeFundingMode = "included_basic" | "subscription" | "unknown";

export type ComputeFundingSource = "included_basic" | "stripe" | "wallet" | "unknown";

type ComputeFundingSubscription = Pick<HostedComputeSubscription, "funding_source" | "price_cents">;

export function isIncludedBasicSubscription(
	planSlug: string | null | undefined,
	computeSubscription: ComputeFundingSubscription | null | undefined,
): boolean {
	return (
		isBasicCompute(planSlug) &&
		computeSubscription != null &&
		computeSubscription.funding_source == null &&
		computeSubscription.price_cents === 0
	);
}

export function computeFundingMode(
	planSlug: string | null | undefined,
	computeSubscription: ComputeFundingSubscription | null | undefined,
): ComputeFundingMode {
	const source = computeFundingSource(planSlug, computeSubscription);
	if (source === "included_basic") return "included_basic";
	return source === "stripe" || source === "wallet" ? "subscription" : "unknown";
}

export function computeFundingSource(
	planSlug: string | null | undefined,
	computeSubscription: ComputeFundingSubscription | null | undefined,
): ComputeFundingSource {
	if (isIncludedBasicSubscription(planSlug, computeSubscription)) return "included_basic";
	if (computeSubscription?.funding_source === "stripe") return "stripe";
	if (computeSubscription?.funding_source === "wallet") return "wallet";
	// Pre-wallet deployment projections can omit Card funding. A positive paid price
	// disambiguates that legacy shape from Included Basic and malformed null funding.
	if (computeSubscription?.funding_source == null && (computeSubscription?.price_cents ?? 0) > 0) {
		return "stripe";
	}
	return "unknown";
}

export function computeSubscriptionId(
	subscription: HostedComputeSubscription | null | undefined,
): number | null {
	if (!subscription) return null;
	return typeof subscription.subscription_id === "number" &&
		Number.isInteger(subscription.subscription_id) &&
		subscription.subscription_id > 0
		? subscription.subscription_id
		: null;
}

export function pendingComputePlanSlug(
	subscription: Pick<HostedComputeSubscription, "pending_plan_slug"> | null | undefined,
): ComputePlanSlug | null {
	if (!subscription) return null;
	return subscription.pending_plan_slug === COMPUTE_BASIC_SLUG ||
		subscription.pending_plan_slug === COMPUTE_PERFORMANCE_SLUG
		? subscription.pending_plan_slug
		: null;
}

export function resolveSubscriptionCreatePlanSlug(
	priorPlanSlug: string | null | undefined,
	{
		basicAvailable,
		performanceAvailable,
	}: { basicAvailable: boolean; performanceAvailable: boolean },
): ComputePlanSlug {
	const preferredPlanSlug =
		priorPlanSlug === COMPUTE_BASIC_SLUG || priorPlanSlug === COMPUTE_PERFORMANCE_SLUG
			? priorPlanSlug
			: COMPUTE_PERFORMANCE_SLUG;
	if (preferredPlanSlug === COMPUTE_PERFORMANCE_SLUG && !performanceAvailable && basicAvailable) {
		return COMPUTE_BASIC_SLUG;
	}
	if (preferredPlanSlug === COMPUTE_BASIC_SLUG && !basicAvailable && performanceAvailable) {
		return COMPUTE_PERFORMANCE_SLUG;
	}
	return preferredPlanSlug;
}

const COMPUTE_RENEWING_STATUSES = new Set(["trialing", "active", "past_due"]);

export function isComputeSubscriptionRenewing(
	subscription: HostedComputeSubscription | null | undefined,
): boolean {
	if (!subscription || subscription.cancel_at_period_end) return false;
	return (
		COMPUTE_RENEWING_STATUSES.has(subscription.status.toLowerCase()) &&
		subscription.payment_state !== "unpaid"
	);
}

export type ComputeSubscriptionLifecycle = {
	badgeLabel: string;
	badgeTone: "success" | "warning" | "destructive" | "neutral";
	dateAt: string | null;
	dateVerb: string | null;
	renews: boolean;
};

type ComputeSubscriptionLifecycleInput = {
	lifecycle_status?: string | null;
	status: string;
	cancel_at_period_end: boolean;
	current_period_end?: string | null;
	cancel_at?: string | null;
	canceled_at?: string | null;
	pending_plan_slug?: string | null;
};

export function computeSubscriptionLifecycle(
	subscription: ComputeSubscriptionLifecycleInput,
): ComputeSubscriptionLifecycle {
	const status = (subscription.lifecycle_status ?? subscription.status).toLowerCase();
	const canceledAt = subscription.canceled_at ?? subscription.current_period_end ?? null;
	if (
		status === "canceling" ||
		(subscription.cancel_at_period_end && COMPUTE_RENEWING_STATUSES.has(status))
	) {
		return {
			badgeLabel: "Canceling",
			badgeTone: "warning",
			dateAt: subscription.cancel_at ?? subscription.current_period_end ?? null,
			dateVerb: "Ends",
			renews: false,
		};
	}
	if (status === "active") {
		return {
			badgeLabel: "Active",
			badgeTone: subscription.pending_plan_slug ? "warning" : "success",
			dateAt: subscription.current_period_end ?? null,
			dateVerb: "Renews",
			renews: true,
		};
	}
	if (status === "trialing") {
		return {
			badgeLabel: "Trial",
			badgeTone: subscription.pending_plan_slug ? "warning" : "success",
			dateAt: subscription.current_period_end ?? null,
			dateVerb: "Renews",
			renews: true,
		};
	}
	if (status === "past_due") {
		return {
			badgeLabel: "Past due",
			badgeTone: "destructive",
			dateAt: null,
			dateVerb: null,
			renews: true,
		};
	}
	if (status === "unpaid") {
		return {
			badgeLabel: "Unpaid",
			badgeTone: "destructive",
			dateAt: null,
			dateVerb: null,
			renews: false,
		};
	}
	if (status === "paused") {
		return {
			badgeLabel: "Paused",
			badgeTone: "neutral",
			dateAt: null,
			dateVerb: null,
			renews: false,
		};
	}
	if (status === "incomplete") {
		return {
			badgeLabel: "Setup incomplete",
			badgeTone: "warning",
			dateAt: null,
			dateVerb: null,
			renews: false,
		};
	}
	if (status === "canceled") {
		return {
			badgeLabel: "Ended",
			badgeTone: "neutral",
			dateAt: null,
			dateVerb: null,
			renews: false,
		};
	}
	if (status === "expired" || status === "incomplete_expired") {
		return {
			badgeLabel: "Expired",
			badgeTone: "neutral",
			dateAt: canceledAt,
			dateVerb: "Expired",
			renews: false,
		};
	}
	return {
		badgeLabel: "Status unavailable",
		badgeTone: "neutral",
		dateAt: null,
		dateVerb: null,
		renews: false,
	};
}

export function pendingPlanScheduleCopy(
	planSlug: ComputePlanSlug,
	effectiveAt: string | null | undefined,
	dateLabel: string,
): string {
	const planLabel = computeTierLabel(planSlug);
	return effectiveAt
		? `${planLabel} scheduled for ${dateLabel}.`
		: `${planLabel} scheduled for the next billing date.`;
}

export function computeTierLabel(
	planSlug: ComputePlanSlug | null | undefined,
): "Basic" | "Performance" {
	return planSlug === COMPUTE_PERFORMANCE_SLUG ? "Performance" : "Basic";
}

/**
 * The plan's offer for a billing term, with a synthetic monthly offer when the
 * backend returns no offers — so callers always have a price to show.
 */
export function planOffers(plan: Plan): BillingOffer[] {
	return plan.offers?.length
		? plan.offers
		: [
				{
					billing_term_months: 1,
					price_cents: plan.price_cents,
					effective_monthly_price_cents: plan.price_cents,
					discount_percent: 0,
				},
			];
}

/** Offers explicitly advertised by the plans API; an empty list is not purchasable. */
export function explicitPlanOffers(plan: Plan): BillingOffer[] {
	return plan.offers ?? [];
}

/**
 * Explicit offers from the first plan whose terms are also explicitly offered
 * by every other plan. Prices remain plan-specific; callers use this list only
 * to drive a synchronized billing-term control.
 */
export function commonExplicitBillingOffers(plans: readonly Plan[]): BillingOffer[] {
	const [firstPlan, ...otherPlans] = plans;
	if (!firstPlan || otherPlans.length === 0) return [];

	const firstOffers = explicitPlanOffers(firstPlan);
	const otherTermSets = otherPlans.map(
		(plan) => new Set(explicitPlanOffers(plan).map((offer) => offer.billing_term_months)),
	);
	if (firstOffers.length === 0 || otherTermSets.some((terms) => terms.size === 0)) return [];

	const seenTerms = new Set<number>();
	return firstOffers
		.filter((offer) => {
			const term = offer.billing_term_months;
			if (seenTerms.has(term) || !otherTermSets.every((terms) => terms.has(term))) return false;
			seenTerms.add(term);
			return true;
		})
		.sort((a, b) => a.billing_term_months - b.billing_term_months);
}

export function selectExplicitOfferForTerm(plan: Plan, term: number): ResolvedBillingOffer | null {
	const offers = explicitPlanOffers(plan);
	const offer = offers.find((candidate) => candidate.billing_term_months === term) ?? offers[0];
	return offer ? { offer, billingTermMonths: offer.billing_term_months } : null;
}

export function selectOfferForTerm(plan: Plan, term: number): ResolvedBillingOffer {
	const offers = planOffers(plan);
	const offer = offers.find((o) => o.billing_term_months === term) ?? offers[0];
	return { offer, billingTermMonths: offer.billing_term_months };
}
