import { describe, expect, test } from "bun:test";
import {
	buildHostedCheckoutFallbackRequest,
	checkoutRedirectUrl,
	findNewDeploymentId,
	hasEmbeddedCheckoutClientSecret,
} from "@/hosted/billing/components/embedded-checkout.logic";
import type { CheckoutRequest, CheckoutResult, HostedDeployment } from "@/hosted/billing/contracts";

describe("embedded checkout logic", () => {
	test("prefers the action_url for hosted fallback redirects", () => {
		const result: CheckoutResult = {
			flow_type: "checkout_session",
			action_url: "https://checkout.stripe.com/primary",
			checkout_url: "https://checkout.stripe.com/secondary",
			client_secret: null,
		};

		expect(checkoutRedirectUrl(result)).toBe("https://checkout.stripe.com/primary");
	});

	test("detects embedded checkout responses from a client secret", () => {
		const result: CheckoutResult = {
			flow_type: "checkout_session",
			action_url: null,
			checkout_url: "",
			client_secret: "cs_test_embedded",
		};

		expect(hasEmbeddedCheckoutClientSecret(result)).toBe(true);
	});

	test("builds an explicit hosted fallback request", () => {
		const request: CheckoutRequest = {
			plan_slug: "compute_performance",
			billing_term_months: 12,
			ui_mode: "embedded",
			deploy_config: { compute_plan_slug: "compute_performance" },
		};

		expect(buildHostedCheckoutFallbackRequest(request)).toEqual({
			...request,
			ui_mode: "hosted",
		});
	});

	test("finds a deployment created after embedded checkout completes", () => {
		const deployments = [{ id: "dep_old" }, { id: "dep_new" }] as HostedDeployment[];

		expect(findNewDeploymentId(["dep_old"], deployments)).toBe("dep_new");
		expect(findNewDeploymentId(["dep_old", "dep_new"], deployments)).toBeNull();
	});
});
