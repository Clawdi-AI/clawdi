import { describe, expect, test } from "bun:test";
import { providerTypeMeta } from "@/hosted/v2/ai-providers/provider-types";
import {
	aiProviderRuntimeId,
	buildAiProviderBootstrap,
	buildAiProviderPoolBootstrap,
	toRuntimeAiProvider,
} from "@/hosted/v2/ai-providers/runtime-bootstrap";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

const provider: AiProvider = {
	id: "db-record-uuid",
	provider_id: "openai-codex",
	scope: "user",
	type: "openai",
	label: "ChatGPT",
	base_url: "https://api.openai.com/v1",
	models: [{ id: "gpt-5.1" }],
	api_mode: "openai_responses",
	auth: { type: "agent_profile", tool: "codex", profile: "default" },
	managed_by: "user",
	runtime_env_name: null,
	capabilities: { chat: true, responses: true, ignored: "yes" },
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

describe("AI provider runtime bootstrap", () => {
	test("uses stable provider_id instead of the response row id", () => {
		const bootstrap = buildAiProviderBootstrap(provider, "codex_oauth");

		expect(aiProviderRuntimeId(provider)).toBe("openai-codex");
		expect(bootstrap.selected_provider_id).toBe("openai-codex");
		expect(bootstrap.catalog.defaults?.chat_provider_id).toBe("openai-codex");
		expect(bootstrap.catalog.providers[0]?.id).toBe("openai-codex");
		expect(bootstrap.catalog.providers[0]?.id).not.toBe("db-record-uuid");
	});

	test("normalizes generated nullable fields into the runtime catalog shape", () => {
		const runtimeProvider = toRuntimeAiProvider({
			...provider,
			label: null,
			models: null,
			api_mode: null,
			runtime_env_name: null,
		});

		expect(runtimeProvider).toEqual({
			id: "openai-codex",
			type: "openai",
			base_url: "https://api.openai.com/v1",
			auth: { type: "agent_profile", tool: "codex", profile: "default" },
			managed_by: "user",
			capabilities: { chat: true, responses: true },
		});
	});

	test("builds a provider-pool bootstrap with the selected provider as chat default", () => {
		const secondary: AiProvider = {
			...provider,
			id: "db-record-secondary",
			provider_id: "anthropic-prod",
			type: "anthropic",
			label: "Anthropic",
			base_url: "https://api.anthropic.com",
			models: [{ id: "claude-sonnet-5" }],
			api_mode: "anthropic_messages",
			auth: { type: "api_key", source: "managed" },
		};

		const bootstrap = buildAiProviderPoolBootstrap(
			[provider, secondary],
			"anthropic-prod",
			"api_key",
		);

		expect(bootstrap.selected_provider_id).toBe("anthropic-prod");
		expect(bootstrap.catalog.defaults?.chat_provider_id).toBe("anthropic-prod");
		expect(bootstrap.catalog.providers.map((item) => item.id)).toEqual([
			"openai-codex",
			"anthropic-prod",
		]);
	});

	test("rejects malformed auth before building a bootstrap payload", () => {
		expect(() =>
			buildAiProviderBootstrap(
				{
					...provider,
					auth: { type: "api_key" },
				},
				"api_key",
			),
		).toThrow("Invalid AI provider auth source.");
	});

	test("rejects public no-auth provider endpoints", () => {
		expect(() =>
			buildAiProviderBootstrap(
				{
					...provider,
					provider_id: "public-no-auth",
					type: "custom_openai_compatible",
					base_url: "https://example.com/v1",
					api_mode: "openai_chat",
					auth: { type: "none" },
				},
				"api_key",
			),
		).toThrow("uses no auth on a public URL");
	});

	test("allows local no-auth provider endpoints", () => {
		const bootstrap = buildAiProviderBootstrap(
			{
				...provider,
				provider_id: "local-no-auth",
				type: "custom_openai_compatible",
				base_url: "http://127.0.0.1:11434/v1",
				api_mode: "openai_chat",
				auth: { type: "none" },
			},
			"api_key",
		);

		expect(bootstrap.selected_provider_id).toBe("local-no-auth");
	});

	test("passes through the derived catalog and runtime env for known providers", () => {
		const defaults = providerTypeMeta("openai");
		const bootstrap = buildAiProviderBootstrap(
			{
				...provider,
				provider_id: "openai-main",
				label: "OpenAI",
				auth: { type: "api_key", source: "managed" },
				models: defaults.defaultModels.map((model) => ({ ...model })),
				runtime_env_name: defaults.defaultRuntimeEnv,
			},
			"api_key",
		);

		expect(bootstrap.catalog.providers[0]).toMatchObject({
			id: "openai-main",
			models: defaults.defaultModels,
			runtime_env_name: "OPENAI_API_KEY",
		});
	});
});
