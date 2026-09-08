import { describe, expect, test } from "bun:test";
import type { StripeCheckoutStatus } from "@stripe/stripe-js";
import type { CheckoutOperationResult } from "@/hosted/billing/billing-client";
import {
	checkoutRedirectUrl,
	checkoutUiModeForPublishableKey,
	completedCheckoutPaymentStatus,
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

	test("reads payment settlement only from a completed Checkout Session", () => {
		const cases: ReadonlyArray<
			[StripeCheckoutStatus, ReturnType<typeof completedCheckoutPaymentStatus>]
		> = [
			[{ type: "open" }, null],
			[{ type: "expired" }, null],
			[{ type: "complete", paymentStatus: "paid" }, "paid"],
			[{ type: "complete", paymentStatus: "unpaid" }, "unpaid"],
			[{ type: "complete", paymentStatus: "no_payment_required" }, "no_payment_required"],
		];

		for (const [status, expected] of cases) {
			expect(completedCheckoutPaymentStatus(status)).toBe(expected);
		}
	});

	test("starts with hosted Checkout when Stripe.js cannot be configured", () => {
		expect(checkoutUiModeForPublishableKey(undefined)).toBe("hosted");
		expect(checkoutUiModeForPublishableKey("pk_test_browser")).toBe("custom");
	});
});
