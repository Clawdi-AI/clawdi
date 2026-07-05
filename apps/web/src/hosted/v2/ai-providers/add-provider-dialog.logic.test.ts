import { describe, expect, test } from "bun:test";
import {
	apiKeyEditState,
	providerAuthForSubmit,
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
