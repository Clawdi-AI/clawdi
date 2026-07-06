import { describe, expect, test } from "bun:test";
import { buildHostedDeployRequest } from "@/hosted/billing/deploy/deploy-request";

describe("buildHostedDeployRequest", () => {
	test("serializes v2 hosted deploys without legacy deploy profile", () => {
		const request = buildHostedDeployRequest({
			computePlanSlug: "compute_performance",
			runtime: "openclaw",
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
			runtime: "openclaw",
			language: "en",
			timezone: "America/Los_Angeles",
			ai_provider_auth_kind: "managed",
			config: {
				channel: null,
				runtime: "openclaw",
				language: "en",
				timezone: "America/Los_Angeles",
			},
		});
		expect("assistant_name" in (request.config ?? {})).toBe(false);
		expect("personality" in (request.config ?? {})).toBe(false);
	});

	test("serializes backend provider pool contract at the deploy body boundary", () => {
		const request = buildHostedDeployRequest({
			computePlanSlug: "compute_performance",
			runtime: "hermes",
			persona: {
				language: "",
				timezone: "",
			},
			aiFields: {
				ai_provider_id: "anthropic-prod",
				ai_provider_auth_kind: "api_key",
				provider_ids: ["openai-prod", "anthropic-prod"],
				primary_model: {
					provider_id: "anthropic-prod",
					model: "claude-sonnet-5",
				},
			},
		});

		expect(request).toMatchObject({
			runtime: "hermes",
			ai_provider_id: "anthropic-prod",
			ai_provider_auth_kind: "api_key",
			provider_ids: ["openai-prod", "anthropic-prod"],
			primary_model: {
				provider_id: "anthropic-prod",
				model: "claude-sonnet-5",
			},
		});
		expect("provider_ids" in (request.config ?? {})).toBe(false);
		expect("ai_provider_id" in (request.config ?? {})).toBe(false);
	});
});
