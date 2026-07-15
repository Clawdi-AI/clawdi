import { BillingApiError, billingErrorDetail, isNetworkError } from "@/hosted/billing/errors";
import { decimalCredits } from "@/hosted/billing/wallet/wallet-compute.logic";

export type DeployPaymentMethod = "card" | "wallet";

export type WalletActivationFailure = {
	kind: "insufficient" | "conflict" | "retryable" | "other";
	code: string | null;
	shortfallCredits: number | null;
	description: string;
};

function stringField(detail: Record<string, unknown> | null, key: string): string | null {
	const value = detail?.[key];
	return typeof value === "string" ? value : null;
}

export function walletActivationFailure(error: unknown): WalletActivationFailure {
	const detail = billingErrorDetail(error);
	const code = stringField(detail, "code");
	if (error instanceof BillingApiError && error.status === 402) {
		const shortfall = stringField(detail, "shortfall_credits");
		return {
			kind: "insufficient",
			code,
			shortfallCredits: shortfall === null ? null : decimalCredits(shortfall),
			description: "Your wallet does not have enough credits for the first compute charge.",
		};
	}
	if (error instanceof BillingApiError && error.status === 409) {
		return {
			kind: "conflict",
			code,
			shortfallCredits: null,
			description:
				code === "open_refund_debt"
					? "A wallet refund is still settling. Wait for it to finish before funding compute."
					: "Another billing action owns this deploy request. Refresh the quote before trying again.",
		};
	}
	const retryablePayload = detail?.retryable === true;
	if (
		isNetworkError(error) ||
		(error instanceof BillingApiError && error.status >= 500 && retryablePayload)
	) {
		return {
			kind: "retryable",
			code,
			shortfallCredits: null,
			description:
				"The wallet charge result is temporarily unclear. Retry with the same deploy request; you will not be charged twice.",
		};
	}
	return {
		kind: "other",
		code,
		shortfallCredits: null,
		description: "Wallet funding could not be completed. Check the details and try again.",
	};
}

export function walletPaymentDisabledReason(billingTermMonths: number): string | null {
	return billingTermMonths === 1
		? null
		: "Wallet-funded compute renews monthly. Choose Monthly or use a card for Annual billing.";
}
