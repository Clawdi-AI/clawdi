import { describe, expect, test } from "bun:test";
import {
	apiKeyEditState,
	derivedProviderFields,
	modelsFromText,
	providerAuthForSubmit,
	providerFormIdentity,
	shouldUseCatalogModels,
} from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import type { AiProviderAuth } from "@/hosted/v2/ai-providers/types";

describe("providerAuthForSubmit", () => {
	test("preserves env-source API key auth when editing with a blank key", () => {
		const auth = {
			type: "api_key",
			source: "env",
			ref: "env:OPENAI_API_KEY",
		} satisfies AiProviderAuth;

		expect(
			providerAuthForSubmit({
				authMethod: "api_key",
				editingAuth: auth,
				hasNewManagedKey: false,
			}),
		).toBe(auth);
		expect(apiKeyEditState("api_key", auth)).toMatchObject({
			canKeepManagedApiKey: false,
			canKeepExternalApiKeyRef: true,
			keyRequired: false,
			labelSuffix: " (leave blank to keep current env reference)",
		});
	});

	test("preserves vault-source API key auth when editing with a blank key", () => {
		const auth = {
			type: "api_key",
			source: "vault",
			ref: "clawdi://project/proj_1/vault/ai-providers/section/onboarding/field/openai_api_key",
		} satisfies AiProviderAuth;

		expect(
			providerAuthForSubmit({
				authMethod: "api_key",
				editingAuth: auth,
				hasNewManagedKey: false,
			}),
		).toBe(auth);
		expect(apiKeyEditState("api_key", auth)).toMatchObject({
			canKeepManagedApiKey: false,
			canKeepExternalApiKeyRef: true,
			keyRequired: false,
			labelSuffix: " (leave blank to keep current vault reference)",
		});
	});

	test("switches to managed auth when the edit supplies a new key", () => {
		const auth = {
			type: "api_key",
			source: "env",
			ref: "env:OPENAI_API_KEY",
		} satisfies AiProviderAuth;

		expect(
			providerAuthForSubmit({
				authMethod: "api_key",
				editingAuth: auth,
				hasNewManagedKey: true,
			}),
		).toEqual({ type: "api_key", source: "managed" });
	});
});

describe("providerFormIdentity", () => {
	test("derives a stable label and provider id for known providers", () => {
		expect(
			providerFormIdentity({
				type: "openai",
				authMethod: "api_key",
				labelInput: "",
				existingProviderIds: [],
			}),
		).toEqual({
			providerId: "openai",
			label: "OpenAI",
		});
	});

	test("suffixes duplicate known providers instead of requiring a manual name", () => {
		expect(
			providerFormIdentity({
				type: "openai",
				authMethod: "api_key",
				labelInput: "",
				existingProviderIds: ["openai", "openai-2"],
			}),
		).toEqual({
			providerId: "openai-3",
			label: "OpenAI 3",
		});
	});

	test("pins Codex OAuth to the canonical provider identity", () => {
		expect(
			providerFormIdentity({
				type: "openai",
				authMethod: "oauth",
				labelInput: "",
				existingProviderIds: ["openai", "openai-2"],
			}),
		).toEqual({
			providerId: "openai-codex",
			label: "Codex (ChatGPT)",
		});
	});

	test("preserves provider id while allowing label edits", () => {
		expect(
			providerFormIdentity({
				type: "custom_openai_compatible",
				authMethod: "api_key",
				labelInput: "Team proxy",
				existingProviderIds: ["team-proxy"],
				editing: {
					provider_id: "legacy-proxy",
					label: "Legacy proxy",
				},
			}),
		).toEqual({
			providerId: "legacy-proxy",
			label: "Team proxy",
		});
	});
});

describe("derivedProviderFields", () => {
	test("uses shared defaults for known providers", () => {
		expect(derivedProviderFields("openai", "api_key")).toEqual({
			baseUrl: "https://api.openai.com/v1",
			apiMode: "openai_responses",
			runtimeEnv: "OPENAI_API_KEY",
			modelsText: "gpt-5.5\ngpt-5.4\ngpt-5.4-mini",
		});
		expect(shouldUseCatalogModels("openai", "api_key")).toBe(true);
	});

	test("uses the Codex catalog for ChatGPT sign-in", () => {
		expect(derivedProviderFields("openai", "oauth")).toEqual({
			baseUrl: "https://api.openai.com/v1",
			apiMode: "openai_responses",
			runtimeEnv: "OPENAI_API_KEY",
			modelsText: "gpt-5.5\ngpt-5.4\ngpt-5.3-codex\ngpt-5.4-mini",
		});
		expect(shouldUseCatalogModels("openai", "oauth")).toBe(true);
	});

	test("leaves custom providers empty until the user fills advanced fields", () => {
		expect(derivedProviderFields("custom_openai_compatible", "api_key")).toEqual({
			baseUrl: "",
			apiMode: "openai_chat",
			runtimeEnv: "CUSTOM_API_KEY",
			modelsText: "",
		});
		expect(shouldUseCatalogModels("custom_openai_compatible", "api_key")).toBe(false);
	});
});

describe("modelsFromText", () => {
	test("deduplicates model ids while preserving known metadata", () => {
		expect(
			modelsFromText("gpt-5.5\ngpt-5.4\ngpt-5.5", [
				{ id: "gpt-5.4", label: "GPT-5.4" },
				{ id: "gpt-5.5", label: "GPT-5.5" },
			]),
		).toEqual([
			{ id: "gpt-5.5", label: "GPT-5.5" },
			{ id: "gpt-5.4", label: "GPT-5.4" },
		]);
	});
});
