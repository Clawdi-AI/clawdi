import { describe, expect, test } from "bun:test";
import {
	BillingApiError,
	BillingNetworkError,
	billingQueryRetry,
	DeploymentRequestTerminalError,
	deploymentRequestTerminalOutcome,
	deploySubmissionErrorPresentation,
	isAuthError,
	isForbiddenError,
	isInsufficientBalanceError,
	isNetworkError,
	isPaymentMethodRequiredError,
	isRetryableError,
	isServerError,
	normalizeBillingError,
} from "@/hosted/billing/errors";

describe("error classification", () => {
	test("401 is an auth error, not forbidden/server/retryable", () => {
		const e = new BillingApiError(401, "token expired");
		expect(isAuthError(e)).toBe(true);
		expect(isForbiddenError(e)).toBe(false);
		expect(isServerError(e)).toBe(false);
		expect(isRetryableError(e)).toBe(false);
	});

	test("403 is forbidden, not auth", () => {
		const e = new BillingApiError(403, "nope");
		expect(isForbiddenError(e)).toBe(true);
		expect(isAuthError(e)).toBe(false);
	});

	test("5xx and 429 are server errors and retryable", () => {
		for (const status of [500, 502, 503, 429]) {
			const e = new BillingApiError(status, "boom");
			expect(isServerError(e)).toBe(true);
			expect(isRetryableError(e)).toBe(true);
		}
	});

	test("4xx (other than 429) are not retryable", () => {
		for (const status of [400, 401, 403, 404, 409, 422]) {
			expect(isRetryableError(new BillingApiError(status, "x"))).toBe(false);
		}
	});

	test("network errors are retryable transport failures", () => {
		const offline = new BillingNetworkError("offline");
		const timeout = new BillingNetworkError("timeout");
		expect(isNetworkError(offline)).toBe(true);
		expect(isNetworkError(timeout)).toBe(true);
		expect(isRetryableError(offline)).toBe(true);
		expect(isRetryableError(timeout)).toBe(true);
	});

	test("non-billing errors classify as nothing", () => {
		const e = new Error("random");
		expect(isAuthError(e)).toBe(false);
		expect(isServerError(e)).toBe(false);
		expect(isNetworkError(e)).toBe(false);
		expect(isRetryableError(e)).toBe(false);
	});
});

describe("billingQueryRetry", () => {
	test("network errors get a third retry to ride over the deploy swap window", () => {
		const e = new BillingNetworkError("offline");
		expect(billingQueryRetry(0, e)).toBe(true);
		expect(billingQueryRetry(1, e)).toBe(true);
		expect(billingQueryRetry(2, e)).toBe(true);
		expect(billingQueryRetry(3, e)).toBe(false);
	});

	test("server errors keep the shorter two-retry budget", () => {
		const e = new BillingApiError(503, "unavailable");
		expect(billingQueryRetry(0, e)).toBe(true);
		expect(billingQueryRetry(1, e)).toBe(true);
		expect(billingQueryRetry(2, e)).toBe(false);
	});

	test("never retries deterministic 4xx", () => {
		expect(billingQueryRetry(0, new BillingApiError(403, "Clawdi v2 is not enabled"))).toBe(false);
		expect(billingQueryRetry(0, new BillingApiError(401, "expired"))).toBe(false);
	});
});

describe("normalizeBillingError", () => {
	test("network offline → connection guidance", () => {
		expect(normalizeBillingError(new BillingNetworkError("offline"))).toMatch(
			/couldn't reach the billing service/i,
		);
	});

	test("timeout → try-again guidance", () => {
		expect(normalizeBillingError(new BillingNetworkError("timeout"))).toMatch(
			/taking longer than usual/i,
		);
	});

	test("401 → session expired prompt", () => {
		expect(normalizeBillingError(new BillingApiError(401, "jwt expired"))).toMatch(
			/session has expired/i,
		);
	});

	test("5xx → transient service message, not the raw detail", () => {
		const msg = normalizeBillingError(new BillingApiError(503, "upstream connect error"));
		expect(msg).toMatch(/couldn’t be completed/i);
		expect(msg).not.toMatch(/upstream connect error/);
	});

	test("insufficient balance keeps the product narrative for the structured 402 code", () => {
		const e = new BillingApiError(
			402,
			'{"code":"insufficient_wallet_balance","required_usd":"5.00","available_usd":"1.00","shortfall_usd":"4.00"}',
			{
				detail: {
					code: "insufficient_wallet_balance",
					required_usd: "5.00",
					available_usd: "1.00",
					shortfall_usd: "4.00",
				},
			},
		);
		expect(isInsufficientBalanceError(e)).toBe(true);
		expect(normalizeBillingError(e)).toMatch(/balance is too low/i);
	});

	test("message-text matching alone never triggers the insufficient-balance narrative", () => {
		const gatewayText = new BillingApiError(403, "INSUFFICIENT_BALANCE");
		const missingCode = new BillingApiError(402, "The wallet balance is insufficient. Top up.");
		expect(isInsufficientBalanceError(gatewayText)).toBe(false);
		expect(isInsufficientBalanceError(missingCode)).toBe(false);
	});

	test("backend details stay internal", () => {
		const paymentMethodRequired = new BillingApiError(400, "payment_method_required");
		expect(normalizeBillingError(paymentMethodRequired)).toBe(
			"Add a payment method and try again.",
		);
		expect(isPaymentMethodRequiredError(paymentMethodRequired)).toBe(true);
		expect(
			isPaymentMethodRequiredError(
				new BillingApiError(409, "Request failed", { detail: { code: "payment_method_required" } }),
			),
		).toBe(true);
		expect(normalizeBillingError(new BillingApiError(400, "bridge_internal_17"))).not.toContain(
			"bridge_internal_17",
		);
		expect(
			normalizeBillingError(new BillingApiError(400, "That code has already been used.")),
		).toBe("The billing request could not be completed. Review the details and try again.");
	});

	test("structured wallet errors never expose raw JSON or internal codes", () => {
		const known = new BillingApiError(409, '{"detail":{"code":"open_refund_debt"}}', {
			detail: { code: "open_refund_debt" },
		});
		const unknown = new BillingApiError(409, '{"detail":{"code":"bridge_internal_17"}}', {
			detail: { code: "bridge_internal_17" },
		});
		expect(normalizeBillingError(known)).toContain("outstanding balance");
		expect(normalizeBillingError(unknown)).toBe(
			"The billing request could not be completed. Refresh and try again.",
		);
	});

	test("maps funding authority conflicts by stable code without exposing internals", () => {
		const error = new BillingApiError(
			409,
			"Stripe and local funding-source authority are inconsistent",
			{ detail: { code: "funding_authority_inconsistent" } },
		);
		const message = normalizeBillingError(error);
		expect(message).toBe(
			"Billing for this subscription needs review. Contact support before making changes.",
		);
		expect(message).not.toContain("Stripe");
		expect(message).not.toContain("authority");
	});

	test("unknown shapes get a safe message", () => {
		expect(normalizeBillingError(null)).toMatch(/something went wrong/i);
	});
});

describe("deploySubmissionErrorPresentation", () => {
	test("makes a failed card checkout start explicit, charge-safe, and retryable", () => {
		const presentation = deploySubmissionErrorPresentation(
			new BillingApiError(503, "stripe_proxy_internal tenant=usr_secret"),
			"card_checkout",
		);

		expect(presentation.title).toBe("Checkout didn’t open");
		expect(presentation.description).toContain("No payment was submitted");
		expect(presentation.description).toContain("Retry");
		expect(presentation.description).not.toContain("stripe_proxy_internal");
		expect(presentation.description).not.toContain("usr_secret");
		expect(presentation.description).not.toContain("billing service is having trouble");
	});

	test("handles card network failures without pretending checkout opened", () => {
		const presentation = deploySubmissionErrorPresentation(
			new BillingNetworkError("offline"),
			"card_checkout",
		);

		expect(presentation.title).toBe("Checkout didn’t open");
		expect(presentation.description).toContain("connection dropped");
		expect(presentation.description).toContain("No payment was submitted");
	});

	test("keeps ambiguous assignment, wallet, and create failures on the idempotent retry path", () => {
		const assignment = deploySubmissionErrorPresentation(
			new BillingNetworkError("offline"),
			"subscription_assignment",
		);
		const wallet = deploySubmissionErrorPresentation(
			new BillingNetworkError("timeout"),
			"wallet_creation",
		);
		const included = deploySubmissionErrorPresentation(
			new BillingApiError(502, "raw deployment driver failure"),
			"included_creation",
		);

		expect(assignment.title).toBe("We couldn’t confirm this attempt");
		expect(assignment.description).toContain("safely resume the same attempt");
		expect(assignment.description).not.toMatch(/payment|wallet/i);
		expect(wallet.title).toBe("We couldn’t confirm this attempt");
		expect(wallet.description).toContain("safely resume the same attempt");
		expect(wallet.description).not.toContain("No Wallet payment was made");
		expect(included.title).toBe("We couldn’t confirm agent creation");
		expect(included.description).toContain("safely resume the same attempt");
		expect(included.description).not.toContain("raw deployment driver failure");
	});

	test("states when an explicit wallet rejection did not start payment", () => {
		const presentation = deploySubmissionErrorPresentation(
			new BillingApiError(422, "internal validation trace"),
			"wallet_creation",
		);

		expect(presentation.title).toBe("Payment and creation didn’t start");
		expect(presentation.description).toContain("No Wallet payment was made");
		expect(presentation.description).not.toContain("internal validation trace");
	});
});

describe("deployment request terminal outcome", () => {
	test("distinguishes a new attempt, superseded review, and existing deployment", () => {
		const withoutLineage = deploymentRequestTerminalOutcome(
			new DeploymentRequestTerminalError(
				{
					deploy_request_id: "checkout-expired",
					request_status: "expired",
					lineage_tail: null,
				},
				"expired",
			),
		);
		const superseded = deploymentRequestTerminalOutcome(
			new DeploymentRequestTerminalError(
				{
					deploy_request_id: "checkout-superseded",
					request_status: "superseded",
					lineage_tail: null,
				},
				"superseded",
			),
		);
		const withLineage = deploymentRequestTerminalOutcome(
			new DeploymentRequestTerminalError(
				{
					deploy_request_id: "checkout-failed",
					request_status: "failed",
					lineage_tail: {
						deployment_id: "hdep_failed",
						lineage_version: 1,
						lineage_state: "failed",
					},
				},
				"failed",
			),
		);

		expect(withoutLineage?.kind).toBe("new_attempt");
		expect(superseded?.kind).toBe("review_agents");
		expect(withLineage).toEqual({ kind: "open_deployment", deploymentId: "hdep_failed" });
	});

	test("presents trial ineligibility without exposing the anti-abuse reason", () => {
		const outcome = deploymentRequestTerminalOutcome(
			new DeploymentRequestTerminalError(
				{
					deploy_request_id: "checkout-trial-ineligible",
					request_status: "failed",
					failure_code: "trial_ineligible",
					lineage_tail: null,
				},
				"failed",
			),
		);

		expect(outcome).toEqual({
			kind: "trial_ineligible",
			title: "Free trial unavailable",
			description:
				"This payment method isn’t eligible for a free trial. You can still deploy at the regular price.",
		});
		expect(JSON.stringify(outcome)).not.toContain("trial_card_ineligible");
	});
});
