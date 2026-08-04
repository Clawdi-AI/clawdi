import type { BillingOffer } from "@/hosted/billing/contracts";
import {
	billingTermLabel,
	billingTermSuffix,
	formatCents,
	formatUsd,
	formatUsdExact,
} from "@/hosted/billing/format";
import type { WalletDebitSummary } from "@/hosted/billing/wallet/wallet-debit-summary";
import { walletDebitShortfallUsd } from "@/hosted/billing/wallet/wallet-debit-summary";

export type ComputePricePresentation = {
	primary: string;
	secondary: string | null;
	savings: string | null;
};

export type DeployAmountPresentation = {
	amount: string;
	caption: string | null;
	detail: string | null;
};

function monthlyPrice(offer: BillingOffer): string {
	return `${formatCents(offer.effective_monthly_price_cents)}/mo`;
}

function termPrice(offer: BillingOffer): string {
	return `${formatCents(offer.price_cents)}${billingTermSuffix(offer.billing_term_months)}`;
}

export function computePricePresentation(
	offer: BillingOffer,
	offers: readonly BillingOffer[],
): ComputePricePresentation {
	if (offer.billing_term_months === 1) {
		return {
			primary: termPrice(offer),
			secondary: null,
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
		primary: termPrice(offer),
		secondary: monthlyPrice(offer),
		savings: savingsCents > 0 ? `save ${formatCents(savingsCents)}` : null,
	};
}

export function cardDeployAmountPresentation(offer: BillingOffer): DeployAmountPresentation {
	if (offer.billing_term_months === 1) {
		return {
			amount: termPrice(offer),
			caption: "Billed monthly",
			detail: null,
		};
	}
	if (offer.billing_term_months === 12) {
		return {
			amount: termPrice(offer),
			caption: `${monthlyPrice(offer)}, billed annually`,
			detail: null,
		};
	}
	return {
		amount: termPrice(offer),
		caption: `${monthlyPrice(offer)}, billed ${billingTermLabel(offer.billing_term_months).toLowerCase()}`,
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
		return { amount: "Quote unavailable", caption: null, detail: null };
	}
	if (state === "loading" || !walletDebit) {
		return { amount: "Debit today: —", caption: "Getting quote…", detail: null };
	}

	const shortfallUsd = walletDebitShortfallUsd(walletDebit);
	return {
		amount: `Debit today: ${formatUsdExact(walletDebit.debitAmountUsd)}`,
		caption: `From Wallet · renews ${billingTermMonths === 12 ? "yearly" : "monthly"}`,
		detail:
			shortfallUsd === null
				? null
				: `Available ${formatUsdExact(walletDebit.balanceBeforeUsd)} · short ${formatUsd(shortfallUsd)}`,
	};
}
