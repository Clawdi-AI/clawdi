import { describe, expect, test } from "bun:test";
import {
	buildHostedCheckoutFallbackRequest,
	CHECKOUT_ELEMENTS_UI_MODE,
	checkoutRedirectUrl,
	findNewDeploymentId,
	hasCheckoutClientSecret,
} from "@/hosted/billing/components/stripe-checkout.logic";
import type { CheckoutRequest, CheckoutResult, HostedDeployment } from "@/hosted/billing/contracts";

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

	test("builds an explicit hosted fallback request", () => {
		const request: CheckoutRequest = {
			plan_slug: "compute_basic",
			billing_term_months: 12,
			funding_source: "stripe",
			ui_mode: CHECKOUT_ELEMENTS_UI_MODE,
			deploy_config: {
				compute_plan_slug: "compute_basic",
				runtime: "hermes",
				ai_provider_auth_kind: "unmanaged",
			},
		};

		expect(buildHostedCheckoutFallbackRequest(request)).toEqual({
			...request,
			ui_mode: "hosted",
		});
		expect(buildHostedCheckoutFallbackRequest(request).deploy_config?.compute_plan_slug).toBe(
			"compute_basic",
		);
	});

	test("finds a deployment created after checkout completes", () => {
		const deployments = [{ id: "dep_old" }, { id: "dep_new" }] as HostedDeployment[];

		expect(findNewDeploymentId(["dep_old"], deployments)).toBe("dep_new");
		expect(findNewDeploymentId(["dep_old", "dep_new"], deployments)).toBeNull();
	});
});
