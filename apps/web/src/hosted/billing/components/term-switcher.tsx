"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
}: {
	offers: BillingOffer[];
	value: number;
	onChange: (months: number) => void;
}) {
	if (offers.length <= 1) return null;
	const sorted = [...offers].sort((a, b) => a.billing_term_months - b.billing_term_months);
	return (
		<ToggleGroup
			data-hosted="true"
			type="single"
			value={String(value)}
			onValueChange={(next) => {
				if (next) onChange(Number(next));
			}}
			variant="outline"
			size="sm"
			className="w-full"
		>
			{sorted.map((offer) => (
				<ToggleGroupItem
					key={offer.billing_term_months}
					value={String(offer.billing_term_months)}
					className="flex-1 gap-1.5"
				>
					{billingTermLabel(offer.billing_term_months)}
					{offer.discount_percent > 0 ? (
						<span className="text-xs text-success-muted-foreground">
							−{offer.discount_percent}%
						</span>
					) : null}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}
