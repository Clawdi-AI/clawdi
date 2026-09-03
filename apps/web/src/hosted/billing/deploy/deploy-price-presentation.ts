import type { BillingOffer } from "@/hosted/billing/contracts";
import {
	billingTermLabel,
	billingTermSuffix,
	formatCents,
	formatUsdExact,
} from "@/hosted/billing/format";
import type { WalletDebitSummary } from "@/hosted/billing/wallet/wallet-debit-summary";
import { walletDebitShortfallUsd } from "@/hosted/billing/wallet/wallet-debit-summary";

export type ComputePricePresentation = {
	primary: string;
	secondary: string;
	savings: string | null;
	trial: CardTrialPricePresentation | null;
};

export type DeployAmountPresentation = {
	amount: string;
	badge: string | null;
	caption: string | null;
	detail: string | null;
};

export type CardTrialPricePresentation = {
	badge: string;
	afterTrial: string;
};

export const COMPUTE_CARD_TRIAL_ELIGIBILITY =
	"For eligible accounts on their first Basic or Performance card subscription. One trial per account.";

export function cardTrialPricePresentation(
	recurringPrice: string,
	trialDays: number | null | undefined,
): CardTrialPricePresentation | null {
	if (typeof trialDays !== "number" || !Number.isInteger(trialDays) || trialDays < 1) {
		return null;
	}
	return {
		badge: `${trialDays} ${trialDays === 1 ? "day" : "days"} free`,
		afterTrial: `Then ${recurringPrice}`,
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
		const primary = monthlyPrice(offer);
		return {
			primary,
			secondary: "Billed monthly",
			savings: null,
			trial: cardTrialPricePresentation(primary, offer.card_trial_period_days),
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
	const primary = `${formatCents(offer.price_cents)}${billingTermSuffix(offer.billing_term_months)}`;
	return {
		primary,
		secondary: monthlyPrice(offer),
		savings: savingsCents > 0 ? `save ${formatCents(savingsCents)}` : null,
		trial: cardTrialPricePresentation(primary, offer.card_trial_period_days),
	};
}

export function cardDeployAmountPresentation(offer: BillingOffer): DeployAmountPresentation {
	const price = `${formatCents(offer.price_cents)}${billingTermSuffix(offer.billing_term_months)}`;
	const trial = cardTrialPricePresentation(price, offer.card_trial_period_days);
	if (offer.billing_term_months === 1) {
		return {
			amount: price,
			badge: trial?.badge ?? null,
			caption: trial?.afterTrial ?? "Billed monthly",
			detail: null,
		};
	}
	if (offer.billing_term_months === 12) {
		return {
			amount: price,
			badge: trial?.badge ?? null,
			caption: trial
				? `${trial.afterTrial} · ${monthlyPrice(offer)}`
				: `${monthlyPrice(offer)}, billed annually`,
			detail: null,
		};
	}
	return {
		amount: price,
		badge: trial?.badge ?? null,
		caption: trial
			? `${trial.afterTrial} · ${monthlyPrice(offer)}`
			: `${monthlyPrice(offer)}, billed ${billingTermLabel(offer.billing_term_months).toLowerCase()}`,
		detail: null,
	};
}

export function walletDeployAmountPresentation({
	billingTermMonths,
	state,
	walletDebit,
}: {
	billingTermMonths: number;
	state: "loading" | "error" | "ready";
	walletDebit: WalletDebitSummary | null;
}): DeployAmountPresentation {
	if (state === "error") {
		return { amount: "Quote unavailable", badge: null, caption: null, detail: null };
	}
	if (state === "loading" || !walletDebit) {
		return { amount: "Debit today: —", badge: null, caption: "Getting quote…", detail: null };
	}

	const shortfallUsd = walletDebitShortfallUsd(walletDebit);
	return {
		amount: `Debit today: ${formatUsdExact(walletDebit.debitAmountUsd)}`,
		badge: null,
		caption: `From Wallet · renews ${billingTermMonths === 12 ? "yearly" : "monthly"}`,
		detail:
			shortfallUsd === null
				? null
				: `Available ${formatUsdExact(walletDebit.balanceBeforeUsd)} · short ${formatUsdExact(shortfallUsd)}`,
	};
}
