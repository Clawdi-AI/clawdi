import { describe, expect, test } from "bun:test";
import {
	aiProviderRuntimeId,
	buildAiProviderBootstrap,
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
	default_model: "gpt-5.1",
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
			default_model: null,
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
});
