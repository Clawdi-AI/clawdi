import { describe, expect, test } from "bun:test";
import { buildHostedDeployRequest } from "@/hosted/billing/deploy/deploy-request";

describe("buildHostedDeployRequest", () => {
	test("serializes v2 hosted deploys without legacy deploy profile", () => {
		const request = buildHostedDeployRequest({
			computePlanSlug: "compute_performance",
			engines: { openclaw: true, hermes: false },
			persona: {
				assistantName: "  Test Agent  ",
				personality: "concise",
				language: "en",
				timezone: "America/Los_Angeles",
			},
			aiFields: { ai_provider_auth_kind: "managed" },
		});

		expect("profile" in request).toBe(false);
		expect(request).toMatchObject({
			compute_plan_slug: "compute_performance",
			channel: null,
			enable_openclaw: true,
			enable_hermes: false,
			assistant_name: "Test Agent",
			personality: "concise",
			language: "en",
			timezone: "America/Los_Angeles",
			ai_provider_auth_kind: "managed",
			config: {
				channel: null,
				enable_openclaw: true,
				enable_hermes: false,
				assistant_name: "Test Agent",
			},
		});
	});
});
