import type { DeployComponents } from "../api";

type BillingOffer = DeployComponents["schemas"]["V2BillingOfferResponse"];

import { billingTermLabel, billingTermSuffix, formatCents } from "./billing-format";
export type ComputePricePresentation = {
	primary: string;
	secondary: string;
	savings: string | null;
};

export type DeployAmountPresentation = {
	amount: string;
	caption: string | null;
	detail: string | null;
};

export type CardTrialPricePresentation = {
	label: string;
	summary: string;
};

export function cardTrialPricePresentation(
	recurringPrice: string,
	trialDays: number | null | undefined,
): CardTrialPricePresentation | null {
	if (typeof trialDays !== "number" || !Number.isInteger(trialDays) || trialDays < 1) {
		return null;
	}
	const label = `${trialDays}-day free trial`;
	return {
		label,
		summary: `${label}, then ${recurringPrice}`,
	};
}

function monthlyPrice(offer: BillingOffer): string {
	return `${formatCents(offer.effective_monthly_price_cents)}/mo`;
}

export function computePricePresentation(
	offer: BillingOffer,
	offers: readonly BillingOffer[],
): ComputePricePresentation {
	if (offer.billing_term_months === 1) {
		return {
			primary: monthlyPrice(offer),
			secondary: "Billed monthly",
			savings: null,
		};
	}

	const monthlyOffer = offers.find((candidate) => candidate.billing_term_months === 1);
	const comparisonIsCheaper =
		monthlyOffer !== undefined &&
		offer.effective_monthly_price_cents < monthlyOffer.effective_monthly_price_cents;
	const undiscountedTermPrice = monthlyOffer
		? monthlyOffer.price_cents * offer.billing_term_months
		: null;
	const savingsCents =
		comparisonIsCheaper && undiscountedTermPrice !== null
			? undiscountedTermPrice - offer.price_cents
			: 0;
	return {
		primary: `${formatCents(offer.price_cents)}${billingTermSuffix(offer.billing_term_months)}`,
		secondary: monthlyPrice(offer),
		savings: savingsCents > 0 ? `save ${formatCents(savingsCents)}` : null,
	};
}

export function cardDeployAmountPresentation(offer: BillingOffer): DeployAmountPresentation {
	const price = `${formatCents(offer.price_cents)}${billingTermSuffix(offer.billing_term_months)}`;
	const trial = cardTrialPricePresentation(price, offer.card_trial_period_days);
	if (trial) {
		return { amount: trial.label, caption: `then ${price}`, detail: null };
	}
	if (offer.billing_term_months === 1) {
		return {
			amount: price,
			caption: "Billed monthly",
			detail: null,
		};
	}
	if (offer.billing_term_months === 12) {
		return {
			amount: price,
			caption: `${monthlyPrice(offer)}, billed annually`,
			detail: null,
		};
	}
	return {
		amount: price,
		caption: `${monthlyPrice(offer)}, billed ${billingTermLabel(offer.billing_term_months).toLowerCase()}`,
		detail: null,
	};
}
