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
				"https://app.clawdi.ai/agents/11111111-1111-4111-8111-111111111111/settings?source=on-clawdi&d=hdep_123&tab=settings&topup_return=1&checkout=cancel&session_id=stale&keep=value",
				"hdep_123",
			),
		);

		expect(result.pathname).toBe("/agents/11111111-1111-4111-8111-111111111111/settings");
		expect(result.searchParams.has("source")).toBe(false);
		expect(result.searchParams.has("d")).toBe(false);
		expect(result.searchParams.has("tab")).toBe(false);
		expect(result.searchParams.get("keep")).toBe("value");
		expect(result.searchParams.get("deployment_id")).toBe("hdep_123");
		expect(result.searchParams.has("topup_return")).toBe(false);
		expect(result.searchParams.has("checkout")).toBe(false);
		expect(result.searchParams.has("session_id")).toBe(false);
	});
});
