import { billingTermSuffix, formatCurrencyCents } from "./billing-format";
import { computeTierLabel } from "./compute-subscriptions";
import { formatShortDate } from "./format";
export type ComputeSubscriptionCardView = {
	status: { label: string; tone: "neutral" | "success" | "warning" | "destructive" | "info" };
	plan: string;
	commercialFacts: readonly { label: string; value: string; emphasis?: boolean }[];
};

export type ComputeSubscriptionPaymentSource = "included" | "stripe" | "wallet" | "unavailable";

export function computeSubscriptionPlanLabel(planSlug: string): string {
	if (planSlug === "compute_basic" || planSlug === "compute_performance") {
		return `${computeTierLabel(planSlug)} plan`;
	}
	return planSlug.replace(/^compute_/, "").replaceAll("_", " ");
}

export function computeSubscriptionCardView({
	status,
	planSlug,
	fundingSource,
	priceCents,
	currency,
	billingTermMonths,
	scheduleVerb,
	scheduleAt,
	scheduleFallback,
	includeSchedule = true,
	formatPrice = formatCurrencyCents,
}: {
	status: ComputeSubscriptionCardView["status"];
	planSlug: string;
	fundingSource: ComputeSubscriptionPaymentSource;
	priceCents: number | null | undefined;
	currency: string;
	billingTermMonths: number;
	scheduleVerb: string | null;
	scheduleAt: string | null | undefined;
	scheduleFallback?: string;
	includeSchedule?: boolean;
	/** Mobile store builds pass a credits formatter. */
	formatPrice?: (cents: number, currency: string) => string;
}): ComputeSubscriptionCardView {
	const included = fundingSource === "included";
	const schedule =
		scheduleVerb && scheduleAt
			? `${scheduleVerb} ${formatShortDate(scheduleAt)}`
			: scheduleFallback || "Unavailable";
	return {
		status,
		plan: computeSubscriptionPlanLabel(planSlug),
		commercialFacts: included
			? [{ label: "Price", value: "Free", emphasis: true }]
			: [
					{
						label: "Price",
						value:
							priceCents == null
								? "Unavailable"
								: `${formatPrice(priceCents, currency)}${billingTermSuffix(billingTermMonths)}`,
					},
					{
						label: "Payment",
						value:
							fundingSource === "wallet"
								? "Wallet"
								: fundingSource === "stripe"
									? "Card"
									: "Unavailable",
					},
					...(includeSchedule ? [{ label: "Schedule", value: schedule }] : []),
				],
	};
}
