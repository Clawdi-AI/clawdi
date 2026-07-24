import { describe, expect, test } from "bun:test";
import { buildHostedDeployRequest } from "@/hosted/billing/deploy/deploy-request";

describe("buildHostedDeployRequest", () => {
	test("serializes the real managed Luna catalog selection", () => {
		const request = buildHostedDeployRequest({
			computePlanSlug: "compute_basic",
			runtime: "hermes",
			persona: {
				assistantName: "Hermes",
				language: "",
				timezone: "",
			},
			aiFields: {
				ai_provider_id: null,
				ai_provider_auth_kind: "managed",
				provider_ids: ["clawdi-v2"],
				primary_model: {
					provider_id: "clawdi-v2",
					model: "gpt-5.6-luna",
				},
			},
		});

		expect(request.primary_model).toEqual({
			provider_id: "clawdi-v2",
			model: "gpt-5.6-luna",
		});
	});

	test("serializes v2 hosted deploys without legacy deploy profile", () => {
		const request = buildHostedDeployRequest({
			computePlanSlug: "compute_performance",
			runtime: "openclaw",
			persona: {
				assistantName: "  OpenClaw Studio  ",
				language: "en",
				timezone: "America/Los_Angeles",
			},
			aiFields: { ai_provider_auth_kind: "managed" },
		});

		expect("profile" in request).toBe(false);
		expect("personality" in request).toBe(false);
		expect(request).toMatchObject({
			compute_plan_slug: "compute_performance",
			runtime: "openclaw",
			assistant_name: "OpenClaw Studio",
			language: "en",
			timezone: "America/Los_Angeles",
			ai_provider_auth_kind: "managed",
			config: {
				runtime: "openclaw",
				assistant_name: "OpenClaw Studio",
				language: "en",
				timezone: "America/Los_Angeles",
			},
		});
		expect("personality" in (request.config ?? {})).toBe(false);
		expect("telegram_bot_token" in request).toBe(false);
		expect("telegram_bot_token" in (request.config ?? {})).toBe(false);
		expect("discord_bot_token" in request).toBe(false);
		expect("discord_bot_token" in (request.config ?? {})).toBe(false);
		expect("slack_bot_token" in request).toBe(false);
		expect("slack_bot_token" in (request.config ?? {})).toBe(false);
	});

	test("serializes paid Basic deploy config for checkout auto-deploy", () => {
		const request = buildHostedDeployRequest({
			computePlanSlug: "compute_basic",
			runtime: "hermes",
			persona: {
				assistantName: "Hermes",
				language: "en",
				timezone: "Etc/UTC",
			},
			aiFields: { ai_provider_auth_kind: "managed" },
		});

		expect(request).toMatchObject({
			compute_plan_slug: "compute_basic",
			runtime: "hermes",
			assistant_name: "Hermes",
			language: "en",
			timezone: "Etc/UTC",
			config: {
				runtime: "hermes",
				assistant_name: "Hermes",
				language: "en",
				timezone: "Etc/UTC",
			},
		});
	});

	test("serializes backend provider pool contract at the deploy body boundary", () => {
		const request = buildHostedDeployRequest({
			computePlanSlug: "compute_performance",
			runtime: "hermes",
			persona: {
				assistantName: "Hermes",
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

	test("serializes explicit unmanaged deploys without provider material", () => {
		const request = buildHostedDeployRequest({
			computePlanSlug: "compute_basic",
			runtime: "hermes",
			persona: {
				assistantName: "Hermes",
				language: "",
				timezone: "",
			},
			aiFields: { ai_provider_auth_kind: "unmanaged" },
		});

		expect(request).toEqual({
			compute_plan_slug: "compute_basic",
			runtime: "hermes",
			assistant_name: "Hermes",
			language: null,
			timezone: null,
			ai_provider_auth_kind: "unmanaged",
			config: {
				runtime: "hermes",
				assistant_name: "Hermes",
				language: null,
				timezone: null,
			},
		});
	});
});
