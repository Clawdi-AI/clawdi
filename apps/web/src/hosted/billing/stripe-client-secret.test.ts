import { describe, expect, test } from "bun:test";
import type { CheckoutOperationResult } from "@/hosted/billing/billing-client";
import type { WalletTopupResult } from "@/hosted/billing/contracts";
import {
	checkoutSessionClientSecret,
	stripeReturnPaymentIntentClientSecret,
	walletTopupPaymentIntentClientSecret,
} from "@/hosted/billing/stripe-client-secret";

function checkoutResult(clientSecret: string | null): CheckoutOperationResult {
	return {
		flow_type: "checkout_session",
		funding_source: "stripe",
		action_url: null,
		checkout_url: "",
		client_secret: clientSecret,
	};
}

function walletTopupResult(
	flowType: string | null,
	clientSecret: string | null,
): WalletTopupResult {
	return {
		status: "requires_payment_method",
		flow_type: flowType,
		payment_intent_id: null,
		client_secret: clientSecret,
		amount_usd: null,
	};
}

describe("Stripe client secret semantic refinement", () => {
	test("accepts opaque checkout values only from the checkout arm", () => {
		expect(
			checkoutSessionClientSecret(checkoutResult("opaque checkout value")) ===
				"opaque checkout value",
		).toBe(true);
		expect(
			checkoutSessionClientSecret({
				flow_type: "subscription_activation",
				funding_source: "stripe",
				checkout_url: "",
				subscription_id: "csub_contract",
				invoice_id: null,
				deployment_id: null,
				deployment_name: null,
				metadata_generation: null,
				deploy_request_id: null,
				debited_usd: null,
				balance_after_usd: null,
				current_period_start: null,
				current_period_end: null,
				entitled_until: null,
			}),
		).toBeNull();
	});

	test("accepts opaque payment values only from PaymentIntent provenance", () => {
		expect(
			walletTopupPaymentIntentClientSecret(
				walletTopupResult("payment_intent", "opaque payment value"),
			) === "opaque payment value",
		).toBe(true);
		expect(
			walletTopupPaymentIntentClientSecret(
				walletTopupResult("checkout_session", "opaque but wrong flow"),
			),
		).toBeNull();
		expect(stripeReturnPaymentIntentClientSecret("   ")).toBeNull();
	});
});
