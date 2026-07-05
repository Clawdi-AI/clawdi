import { describe, expect, test } from "bun:test";
import { buildHostedDeployRequest } from "@/hosted/billing/deploy/deploy-request";

describe("buildHostedDeployRequest", () => {
	test("serializes v2 hosted deploys without legacy deploy profile", () => {
		const request = buildHostedDeployRequest({
			computePlanSlug: "compute_performance",
			engines: { openclaw: true, hermes: false },
			persona: {
				language: "en",
				timezone: "America/Los_Angeles",
			},
			aiFields: { ai_provider_auth_kind: "managed" },
		});

		expect("profile" in request).toBe(false);
		expect("assistant_name" in request).toBe(false);
		expect("personality" in request).toBe(false);
		expect(request).toMatchObject({
			compute_plan_slug: "compute_performance",
			channel: null,
			enable_openclaw: true,
			enable_hermes: false,
			language: "en",
			timezone: "America/Los_Angeles",
			ai_provider_auth_kind: "managed",
			config: {
				channel: null,
				enable_openclaw: true,
				enable_hermes: false,
				language: "en",
				timezone: "America/Los_Angeles",
			},
		});
		expect("assistant_name" in (request.config ?? {})).toBe(false);
		expect("personality" in (request.config ?? {})).toBe(false);
	});

	test("rejects deploys without an execution engine", () => {
		expect(() =>
			buildHostedDeployRequest({
				computePlanSlug: "compute_free",
				engines: { openclaw: false, hermes: false },
				persona: {
					language: "",
					timezone: "",
				},
				aiFields: { ai_provider_auth_kind: "managed" },
			}),
		).toThrow("Select at least one execution engine.");
	});
});
