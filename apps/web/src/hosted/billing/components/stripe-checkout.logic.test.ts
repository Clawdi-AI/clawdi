import { describe, expect, test } from "bun:test";
import type { CheckoutOperationResult } from "@/hosted/billing/billing-client";
import {
	CHECKOUT_ELEMENTS_UI_MODE,
	checkoutRedirectUrl,
	checkoutSessionClientSecret,
	checkoutUiModeForPublishableKey,
} from "@/hosted/billing/components/stripe-checkout.logic";

describe("stripe checkout logic", () => {
	function checkoutResult(
		overrides: Partial<Extract<CheckoutOperationResult, { flow_type: "checkout_session" }>>,
	): CheckoutOperationResult {
		return {
			flow_type: "checkout_session",
			funding_source: "stripe",
			action_url: null,
			checkout_url: "",
			client_secret: null,
			...overrides,
		};
	}

	test("prefers the action_url for hosted Checkout redirects", () => {
		const result = checkoutResult({
			action_url: "https://checkout.stripe.com/primary",
			checkout_url: "https://checkout.stripe.com/secondary",
		});

		expect(checkoutRedirectUrl(result)).toBe("https://checkout.stripe.com/primary");
	});

	test("detects elements checkout responses from a client secret", () => {
		const result = checkoutResult({
			client_secret: "cs_test_elements",
		});

		expect(checkoutSessionClientSecret(result) === "cs_test_elements").toBe(true);
	});

	test("documents the checkout elements ui mode for the installed Stripe SDK", () => {
		expect(CHECKOUT_ELEMENTS_UI_MODE).toBe("custom");
	});

	test("starts with hosted Checkout when Stripe.js cannot be configured", () => {
		expect(checkoutUiModeForPublishableKey(undefined)).toBe("hosted");
		expect(checkoutUiModeForPublishableKey("pk_test_browser")).toBe("custom");
	});
});
