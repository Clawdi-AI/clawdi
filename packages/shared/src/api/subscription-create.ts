import type { components as DeployComponents } from "./deploy.generated";
import type { HostedDeploySubscriptionQuote } from "./deploy-wizard";

type Schemas = DeployComponents["schemas"];

export type HostedCheckoutResponse = Schemas["V2CheckoutResponse"];
export type HostedSubscriptionActivation = Schemas["V2SubscriptionActivationResponse"];

/** The exact Wallet debit a server quote asserts; confirmation must send that quote back. */
export type HostedWalletQuoteDebit = {
	balanceBeforeUsd: string;
	debitAmountUsd: string;
	balanceAfterUsd: string;
};

function quoteDecimal(value: string | null | undefined, field: string): string {
	if (value === null || value === undefined || value.trim() === "") {
		throw new Error(`Subscription quote is missing ${field}.`);
	}
	return value;
}

/** Card quotes carry no debit. A Wallet quote without its exact amounts is unusable. */
export function hostedSubscriptionQuoteWalletDebit(
	quote: HostedDeploySubscriptionQuote,
): HostedWalletQuoteDebit | null {
	if (quote.funding_source !== "wallet") return null;
	return {
		balanceBeforeUsd: quoteDecimal(quote.balance_before_usd, "the wallet balance"),
		debitAmountUsd: quoteDecimal(quote.debit_amount_usd, "the exact wallet debit"),
		balanceAfterUsd: quoteDecimal(quote.balance_after_usd, "the post-debit wallet balance"),
	};
}

function decimalKey(value: string | number | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(String(value).trim());
	if (!match) return String(value);
	const whole = (match[2] ?? "").replace(/^0+(?=\d)/, "");
	const fraction = (match[3] ?? "").replace(/0+$/, "");
	const sign = match[1] === "-" && (whole !== "0" || fraction) ? "-" : "";
	return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Whether two quotes assert the same terms, compared on the fields hosted checks when a
 * Wallet subscription is confirmed. Expiry and preview identity are not terms.
 */
export function sameHostedSubscriptionQuoteTerms(
	a: HostedDeploySubscriptionQuote,
	b: HostedDeploySubscriptionQuote,
): boolean {
	return (
		a.plan_slug === b.plan_slug &&
		a.billing_term_months === b.billing_term_months &&
		a.funding_source === b.funding_source &&
		a.currency === b.currency &&
		a.term_price_cents === b.term_price_cents &&
		decimalKey(a.debit_amount_usd) === decimalKey(b.debit_amount_usd) &&
		decimalKey(a.balance_before_usd) === decimalKey(b.balance_before_usd) &&
		decimalKey(a.balance_after_usd) === decimalKey(b.balance_after_usd)
	);
}

/** Where an activated subscription's new Agent can be found. */
export type HostedAcceptedDeployTarget =
	| { kind: "deploy_request"; deployRequestId: string }
	| { kind: "deployment"; deploymentId: string };

/**
 * Hosted accepts the new deployment in the same request when it can; otherwise the
 * durable deploy request resolves it later. An activation with neither is invalid.
 */
export function hostedSubscriptionActivationTarget(
	result: Pick<HostedSubscriptionActivation, "deployment_id" | "deploy_request_id">,
): HostedAcceptedDeployTarget {
	const deploymentId = result.deployment_id?.trim();
	if (deploymentId) return { kind: "deployment", deploymentId };
	const deployRequestId = result.deploy_request_id?.trim();
	if (deployRequestId) return { kind: "deploy_request", deployRequestId };
	throw new Error("Activation did not return an agent request.");
}

export type HostedWalletFundingErrorKind = "insufficient_balance" | "open_refund_debt" | "other";

/** Wallet funding refusals that a top-up resolves, keyed on hosted's structured codes. */
export function hostedWalletFundingErrorKind(code: unknown): HostedWalletFundingErrorKind {
	if (code === "insufficient_wallet_balance" || code === "insufficient_balance") {
		return "insufficient_balance";
	}
	return code === "open_refund_debt" ? "open_refund_debt" : "other";
}

export const HOSTED_WALLET_FUNDING_ERROR_COPY = {
	insufficientBalanceTitle: "Not enough wallet balance",
	refundDebtTitle: "Refund debt must be repaid",
	subscription: {
		insufficientBalance: "Top up the shortfall, then review a fresh wallet quote.",
		refundDebt: "Top up before starting this wallet subscription.",
	},
} as const;
