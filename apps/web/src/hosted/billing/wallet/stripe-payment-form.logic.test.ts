import { describe, expect, test } from "bun:test";
import {
	buildSubscriptionPaymentReturnUrl,
	paymentOutcomeForStatus,
} from "./stripe-payment-form.logic";

describe("paymentOutcomeForStatus", () => {
	test("only treats terminal or settling payment states as complete", () => {
		expect(paymentOutcomeForStatus("succeeded")).toBe("succeeded");
		expect(paymentOutcomeForStatus("processing")).toBe("processing");
		expect(paymentOutcomeForStatus("requires_capture")).toBe("processing");
		expect(paymentOutcomeForStatus("requires_payment_method")).toBeNull();
		expect(paymentOutcomeForStatus(undefined)).toBeNull();
	});
});

describe("buildSubscriptionPaymentReturnUrl", () => {
	test("keeps term-change redirects on the agent and marks them for subscription refresh", () => {
		const result = new URL(
			buildSubscriptionPaymentReturnUrl(
				"https://app.clawdi.ai/agents/11111111-1111-4111-8111-111111111111/settings?settings=billing-wallet&subscription_action=start_new&topup_return=1&checkout=cancel&session_id=stale&keep=value#compute",
				"hdep_123",
			),
		);

		expect(result.pathname).toBe("/agents/11111111-1111-4111-8111-111111111111/settings");
		expect(result.search).toBe("?settings=billing-plan&deployment_id=hdep_123");
		expect(result.hash).toBe("#compute");
	});
});
