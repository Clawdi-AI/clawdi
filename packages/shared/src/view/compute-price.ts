import type { DeployComponents } from "../api";

type BillingOffer = DeployComponents["schemas"]["V2BillingOfferResponse"];

import {
	billingTermLabel,
	billingTermSuffix,
	formatCents,
	formatUsdExact,
	negativeDecimalMagnitude,
} from "./billing-format";
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

function monthlyPrice(
	offer: BillingOffer,
	format: (cents: number) => string = formatCents,
): string {
	return `${format(offer.effective_monthly_price_cents)}/mo`;
}

/** `format` renders an amount in minor units; mobile store builds pass a credits formatter. */
export function computePricePresentation(
	offer: BillingOffer,
	offers: readonly BillingOffer[],
	format: (cents: number) => string = formatCents,
): ComputePricePresentation {
	if (offer.billing_term_months === 1) {
		return {
			primary: monthlyPrice(offer, format),
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
		primary: `${format(offer.price_cents)}${billingTermSuffix(offer.billing_term_months)}`,
		secondary: monthlyPrice(offer, format),
		savings: savingsCents > 0 ? `save ${format(savingsCents)}` : null,
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

/** Exact Wallet debit asserted by a subscription quote. */
export type WalletDebitSummary = {
	balanceBeforeUsd: string;
	debitAmountUsd: string;
	balanceAfterUsd: string;
};

export function walletDebitShortfallUsd(
	summary: WalletDebitSummary | null | undefined,
): string | null {
	if (!summary) return null;
	return negativeDecimalMagnitude(summary.balanceAfterUsd);
}

export const walletDebitEquationCopy = {
	balanceBefore: "Balance before",
	exactDebit: "Exact debit",
	balanceAfter: "Balance after",
} as const;

/** `format` renders exact decimal USD strings (default `$`); store builds pass credits. */
export function walletDebitEquationLabel(
	summary: WalletDebitSummary,
	format: (usd: string) => string = formatUsdExact,
): string {
	return `${format(summary.balanceBeforeUsd)} minus ${format(summary.debitAmountUsd)} equals ${format(summary.balanceAfterUsd)}`;
}

export function walletDeployAmountPresentation({
	billingTermMonths,
	state,
	walletDebit,
	format = formatUsdExact,
}: {
	billingTermMonths: number;
	state: "loading" | "error" | "ready";
	walletDebit: WalletDebitSummary | null;
	format?: (usd: string) => string;
}): DeployAmountPresentation {
	if (state === "error") {
		return { amount: "Quote unavailable", caption: null, detail: null };
	}
	if (state === "loading" || !walletDebit) {
		return { amount: "Debit today: —", caption: "Getting quote…", detail: null };
	}

	const shortfallUsd = walletDebitShortfallUsd(walletDebit);
	return {
		amount: `Debit today: ${format(walletDebit.debitAmountUsd)}`,
		caption: `From wallet · renews ${billingTermMonths === 12 ? "yearly" : "monthly"}`,
		detail:
			shortfallUsd === null
				? null
				: `Available ${format(walletDebit.balanceBeforeUsd)} · short ${format(shortfallUsd)}`,
	};
}
