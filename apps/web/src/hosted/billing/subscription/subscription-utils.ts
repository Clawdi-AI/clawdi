import { toast } from "sonner";
import type { BillingOffer, Plan, PortalResult, Subscription } from "@/hosted/billing/contracts";

export type StatusTone = "success" | "warning" | "destructive" | "neutral";

/** Human label for a Stripe subscription status. */
export function subscriptionStatusLabel(sub: Subscription): string {
	if (sub.cancel_at_period_end || sub.pending_downgrade_plan_slug) return "Ending";
	switch (sub.status) {
		case "active":
			return "Active";
		case "trialing":
			return "Trial";
		case "past_due":
			return "Past due";
		case "incomplete":
		case "incomplete_expired":
			return "Incomplete";
		case "canceled":
			return "Canceled";
		case "unpaid":
			return "Unpaid";
		default:
			return sub.status;
	}
}

export function subscriptionStatusTone(sub: Subscription): StatusTone {
	if (sub.status === "past_due" || sub.status === "unpaid") return "destructive";
	if (sub.cancel_at_period_end || sub.pending_downgrade_plan_slug) return "warning";
	if (sub.status === "active" || sub.status === "trialing") return "success";
	return "neutral";
}

/** Is the subscription currently in dunning (payment failed, in grace)? */
export function isInDunning(sub: Subscription): boolean {
	return sub.status === "past_due" || sub.status === "unpaid";
}

/** Format an ISO date as a short, local calendar date. */
export function shortDate(iso: string | null): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The plan's offer for a billing term, with a synthetic monthly offer when the
 * backend returns no offers — so callers always have a price to show.
 */
export function selectOfferForTerm(plan: Plan, term: number): BillingOffer {
	const offers = plan.offers.length
		? plan.offers
		: [
				{
					billing_term_months: 1,
					price_cents: plan.price_cents,
					effective_monthly_price_cents: plan.price_cents,
					discount_percent: 0,
				},
			];
	return offers.find((o) => o.billing_term_months === term) ?? offers[0];
}

/**
 * Apply a `change_plan_without_portal` PortalResult. Decision table mirroring
 * the backend's statuses (services/subscription.py): redirect_url → interactive
 * payment page; payment_intent_client_secret → SCA needed, send to the billing
 * portal to finish; blocked → not allowed; everything else (applied / scheduled
 * / processing / noop) is settled server-side. `refetch` resyncs the local
 * subscription cache after a settled or pending change.
 */
export function handlePortalResult(res: PortalResult, refetch: () => void) {
	if (res.redirect_url) {
		window.location.href = res.redirect_url;
		return;
	}
	if (res.payment_intent_client_secret) {
		if (res.url || res.portal_url) {
			window.location.href = res.url || res.portal_url;
			return;
		}
		toast.message("Payment confirmation needed", {
			description: res.message ?? "Finish the pending payment to apply this change.",
		});
		refetch();
		return;
	}
	if (res.status === "blocked") {
		toast.error(res.message ?? "This change isn’t available right now.");
		return;
	}
	toast.success(res.message ?? "Subscription updated");
	refetch();
}
