import { describe, expect, test } from "bun:test";
import {
	type AiProviderCatalog,
	CODEX_OAUTH_MODEL_CATALOG,
	defaultAiProviderApiMode,
	defaultAiProviderBaseUrl,
	defaultAiProviderModels,
	defaultAiProviderRuntimeEnvName,
} from "@clawdi/shared";
import { buildAgentTargetProjection } from "./ai-provider-projection";

const byokOpenAiCatalog: AiProviderCatalog = {
	schema_version: 1,
	providers: [
		{
			id: "openai-main",
			type: "openai",
			label: "OpenAI",
			base_url: defaultAiProviderBaseUrl("openai") ?? "https://api.openai.com/v1",
			api_mode: defaultAiProviderApiMode("openai") ?? "openai_responses",
			auth: { type: "api_key", source: "managed" },
			managed_by: "user",
			runtime_env_name: defaultAiProviderRuntimeEnvName("openai") ?? "OPENAI_API_KEY",
			models: defaultAiProviderModels("openai").map((model) => ({ ...model })),
		},
	],
	defaults: { chat_provider_id: "openai-main" },
};

const codexOAuthCatalog: AiProviderCatalog = {
	schema_version: 1,
	providers: [
		{
			id: "openai-codex",
			type: "openai",
			label: "Codex (ChatGPT)",
			base_url: defaultAiProviderBaseUrl("openai") ?? "https://api.openai.com/v1",
			api_mode: "openai_responses",
			auth: { type: "agent_profile", tool: "codex", profile: "default" },
			managed_by: "user",
			models: CODEX_OAUTH_MODEL_CATALOG.map((model) => ({ ...model })),
		},
	],
	defaults: { chat_provider_id: "openai-codex" },
};

describe("AI provider projection", () => {
	test("maps known BYOK OpenAI providers to all runtime targets without extra user fields", () => {
		const openclaw = buildAgentTargetProjection("openclaw", byokOpenAiCatalog);
		expect(openclaw.provider_ids).toEqual(["openai-main"]);
		expect(openclaw.primary_model).toEqual({ provider_id: "openai-main", model: "gpt-5.5" });
		expect(openclaw.files[0]?.content).toContain('"baseUrl": "https://api.openai.com/v1"');
		expect(openclaw.files[0]?.content).toContain('"api": "openai-responses"');
		expect(openclaw.files[0]?.content).toContain('"id": "OPENAI_API_KEY"');

		const hermes = buildAgentTargetProjection("hermes", byokOpenAiCatalog);
		expect(hermes.files[0]?.content).toContain('provider: "custom:openai-main"');
		expect(hermes.files[0]?.content).toContain('api: "https://api.openai.com/v1"');
		expect(hermes.files[0]?.content).toContain('transport: "codex_responses"');
		expect(hermes.files[0]?.content).toContain('key_env: "OPENAI_API_KEY"');

		const codex = buildAgentTargetProjection("codex", byokOpenAiCatalog);
		expect(codex.files[0]?.content).toContain('model = "gpt-5.5"');
		expect(codex.files[0]?.content).toContain('model_provider = "openai-main"');
		expect(codex.files[0]?.content).toContain('[model_providers."openai-main"]');
		expect(codex.files[0]?.content).toContain('env_key = "OPENAI_API_KEY"');
	});

	test("keeps native Codex OAuth projections on the verified OpenAI/Codex path", () => {
		const openclaw = buildAgentTargetProjection("openclaw", codexOAuthCatalog);
		expect(openclaw.files[0]?.content).toContain('"plugins": {');
		expect(openclaw.files[0]?.content).toContain('"primary": "openai/gpt-5.5"');

		const hermes = buildAgentTargetProjection("hermes", codexOAuthCatalog);
		expect(hermes.files[0]?.content).toContain('provider: "openai-codex"');
		expect(hermes.files[0]?.content).toContain('default: "gpt-5.5"');
		expect(hermes.files[0]?.content).toContain('base_url: "https://chatgpt.com/backend-api/codex"');

		const codex = buildAgentTargetProjection("codex", codexOAuthCatalog);
		expect(codex.files[0]?.content).toContain('model = "gpt-5.5"');
		expect(codex.files[0]?.content).toContain('model_provider = "openai"');
		expect(codex.files[0]?.content).not.toContain('[model_providers."openai-codex"]');
	});
});
