import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLAWDI_MANAGED_V1_PROVIDER_ID } from "@clawdi/shared";
import type { AiProvider, AiProviderList } from "@/hosted/v2/ai-providers/types";

type SelectUserAiProviders =
	typeof import("@/hosted/v2/ai-providers/ai-providers-hooks").selectUserAiProviders;

let selectUserAiProvidersImplementation: SelectUserAiProviders | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	selectUserAiProvidersImplementation = (
		await import("@/hosted/v2/ai-providers/ai-providers-hooks")
	).selectUserAiProviders;
});

function selectUserAiProviders(data: AiProviderList): AiProvider[] {
	if (!selectUserAiProvidersImplementation) throw new Error("Provider selector was not loaded.");
	return selectUserAiProvidersImplementation(data);
}

function provider(providerId: string, managedBy: AiProvider["managed_by"]): AiProvider {
	return {
		id: `row-${providerId}`,
		provider_id: providerId,
		scope: "account_global",
		type: "openai",
		label: providerId,
		base_url: "https://provider.example.test/v1",
		managed_by: managedBy,
		auth: { type: "api_key", source: "managed" },
		usable: true,
		created_at: "2026-07-28T00:00:00Z",
		updated_at: "2026-07-28T00:00:00Z",
	};
}

describe("user AI provider query projection", () => {
	test("keeps Web provider surfaces aligned with the shared selectable inventory", () => {
		const userProvider = provider("openai-team", "user");
		const inventory = {
			providers: [
				provider(CLAWDI_MANAGED_V1_PROVIDER_ID, "user"),
				provider("custom-managed-id", "clawdi"),
				userProvider,
			],
		} satisfies AiProviderList;

		expect(selectUserAiProviders(inventory)).toEqual([userProvider]);
		expect(inventory.providers).toHaveLength(3);
	});
});

describe("provider mutation contract", () => {
	test("creates providers through atomic accept without frontend compensation", () => {
		const hooksSource = readFileSync(new URL("./ai-providers-hooks.ts", import.meta.url), "utf8");
		const dialogSource = readFileSync(
			new URL("./add-provider-dialog.tsx", import.meta.url),
			"utf8",
		);

		expect(hooksSource).toContain('api.POST("/v1/ai-providers/accept"');
		expect(hooksSource).toContain('"Idempotency-Key": idempotencyKey');
		expect(dialogSource).not.toContain("restoreEditedProvider");
		expect(dialogSource).not.toContain("deleteProviderQuiet");
	});
});
