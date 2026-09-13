import { describe, expect, test } from "bun:test";
import type { CheckoutOperationResult } from "@/hosted/billing/billing-client";
import { checkoutSessionClientSecret } from "@/hosted/billing/stripe-client-secret";

function checkoutResult(clientSecret: string | null): CheckoutOperationResult {
	return {
		flow_type: "checkout_session",
		funding_source: "stripe",
		action_url: null,
		checkout_url: "",
		client_secret: clientSecret,
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
});
