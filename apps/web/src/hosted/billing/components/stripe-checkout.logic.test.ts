import { describe, expect, test } from "bun:test";
import {
	CHECKOUT_ELEMENTS_UI_MODE,
	checkoutRedirectUrl,
	findNewDeploymentId,
	hasCheckoutClientSecret,
} from "@/hosted/billing/components/stripe-checkout.logic";
import type { CheckoutResult } from "@/hosted/billing/contracts";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

describe("stripe checkout logic", () => {
	test("prefers the action_url for hosted fallback redirects", () => {
		const result: CheckoutResult = {
			flow_type: "checkout_session",
			funding_source: "stripe",
			action_url: "https://checkout.stripe.com/primary",
			checkout_url: "https://checkout.stripe.com/secondary",
			client_secret: null,
		};

		expect(checkoutRedirectUrl(result)).toBe("https://checkout.stripe.com/primary");
	});

	test("detects elements checkout responses from a client secret", () => {
		const result: CheckoutResult = {
			flow_type: "checkout_session",
			funding_source: "stripe",
			action_url: null,
			checkout_url: "",
			client_secret: "cs_test_elements",
		};

		expect(hasCheckoutClientSecret(result)).toBe(true);
	});

	test("documents the checkout elements ui mode for the installed Stripe SDK", () => {
		expect(CHECKOUT_ELEMENTS_UI_MODE).toBe("custom");
	});

	test("finds a deployment created after checkout completes", () => {
		const deployments = [
			hostedDeploymentFixture({ id: "dep_old" }),
			hostedDeploymentFixture({ id: "dep_new" }),
		];

		expect(findNewDeploymentId(["dep_old"], deployments)).toBe("dep_new");
		expect(findNewDeploymentId(["dep_old", "dep_new"], deployments)).toBeNull();
	});
});
