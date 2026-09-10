"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BillingOffer } from "@/hosted/billing/contracts";
import { billingTermLabel } from "@/hosted/billing/format";

/**
 * Billing-term selector for a plan's Stripe-priced offers (monthly /
 * quarterly / annual). Reused by the pricing page and the deploy wizard's
 * Performance deploy card. Disabled when the plan has a single term.
 */
export function TermSwitcher({
	offers,
	value,
	onChange,
	showDiscount = true,
	ariaLabel = "Billing term",
}: {
	offers: BillingOffer[];
	value: number;
	onChange: (months: number) => void;
	showDiscount?: boolean;
	ariaLabel?: string;
}) {
	if (offers.length <= 1) return null;
	const sorted = [...offers].sort((a, b) => a.billing_term_months - b.billing_term_months);
	return (
		<Tabs
			data-hosted="true"
			value={String(value)}
			onValueChange={(next) => {
				const offer = sorted.find((item) => String(item.billing_term_months) === next);
				if (offer) onChange(offer.billing_term_months);
			}}
			className="w-full"
		>
			<TabsList className="w-full" aria-label={ariaLabel}>
				{sorted.map((offer) => (
					<TabsTrigger
						key={offer.billing_term_months}
						value={String(offer.billing_term_months)}
						className="flex-1 gap-1.5"
					>
						{billingTermLabel(offer.billing_term_months)}
						{showDiscount && offer.discount_percent > 0 ? (
							<span className="text-xs text-success-muted-foreground">
								−{offer.discount_percent}%
							</span>
						) : null}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}
