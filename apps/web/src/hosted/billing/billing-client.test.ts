import { describe, expect, it } from "bun:test";
import { unwrapDeploy } from "@/hosted/billing/billing-client";
import { hostedApiBaseUrl } from "@/hosted/billing/billing-url";
import { BillingApiError } from "@/hosted/billing/errors";

describe("hostedApiBaseUrl", () => {
	it("normalizes a deploy API origin for shared routes", () => {
		expect(hostedApiBaseUrl("https://api.clawdi.ai/")).toBe("https://api.clawdi.ai");
	});

	it("strips an existing v2 suffix for shared routes", () => {
		expect(hostedApiBaseUrl("https://api.clawdi.ai/backend/v2/")).toBe(
			"https://api.clawdi.ai/backend",
		);
	});
});

describe("unwrapDeploy", () => {
	it("throws on parsed API errors", () => {
		expect(() =>
			unwrapDeploy({
				error: { detail: "insufficient_balance" },
				response: new Response(JSON.stringify({ detail: "insufficient_balance" }), {
					status: 403,
					statusText: "Forbidden",
				}),
			}),
		).toThrow(BillingApiError);
	});

	it("throws on empty-bodied non-2xx responses", () => {
		expect(() =>
			unwrapDeploy({
				response: new Response(null, { status: 503, statusText: "Service Unavailable" }),
			}),
		).toThrow("Billing API 503: Service Unavailable");
	});
});
