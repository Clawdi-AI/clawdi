import { describe, expect, test } from "bun:test";
import type { RebindAgentAiProviderRequest } from "@/hosted/billing/contracts";

describe("RebindAgentAiProviderRequest", () => {
	test("serializes provider pool and structured primary model fields", () => {
		const request: RebindAgentAiProviderRequest = {
			ai_provider_id: "anthropic-prod",
			ai_provider_auth_kind: "api_key",
			provider_ids: ["openai-prod", "anthropic-prod"],
			primary_model: {
				provider_id: "anthropic-prod",
				model: "claude-sonnet-5",
			},
			ai_provider_bootstrap: { schema_version: 1 },
		};

		expect(request).toEqual({
			ai_provider_id: "anthropic-prod",
			ai_provider_auth_kind: "api_key",
			provider_ids: ["openai-prod", "anthropic-prod"],
			primary_model: {
				provider_id: "anthropic-prod",
				model: "claude-sonnet-5",
			},
			ai_provider_bootstrap: { schema_version: 1 },
		});
	});
});
