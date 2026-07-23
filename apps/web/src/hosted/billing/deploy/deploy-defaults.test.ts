import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEPLOY_AI_ACCESS_MODE,
	DEFAULT_DEPLOY_AI_PROVIDER_CHOICES,
	DEFAULT_DEPLOY_PRIMARY_MODEL,
	DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE,
	DEFAULT_DEPLOY_RUNTIME,
	defaultManagedDeployAiFields,
} from "@/hosted/billing/deploy/deploy-defaults";
import {
	MANAGED_AI_CHOICE,
	MANAGED_DEFAULT_MODEL_CHOICE,
	MANAGED_PROVIDER_ID,
} from "@/hosted/v2/ai-providers/model-binding";

describe("deploy wizard defaults", () => {
	test("default to the hermes runtime and managed AI mode", () => {
		expect(DEFAULT_DEPLOY_RUNTIME).toBe("hermes");
		expect(DEFAULT_DEPLOY_AI_ACCESS_MODE).toBe("configured");
		expect(DEFAULT_DEPLOY_AI_PROVIDER_CHOICES).toEqual([MANAGED_AI_CHOICE]);
		expect(DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE).toBe(MANAGED_AI_CHOICE);
		expect(DEFAULT_DEPLOY_PRIMARY_MODEL).toBe(MANAGED_DEFAULT_MODEL_CHOICE);
	});

	test("omits primary_model so hosted resolves the canonical Luna default", () => {
		expect(defaultManagedDeployAiFields()).toEqual({
			ai_provider_id: null,
			ai_provider_auth_kind: "managed",
			provider_ids: [MANAGED_PROVIDER_ID],
		});
		expect(defaultManagedDeployAiFields()).not.toHaveProperty("primary_model");
		expect(JSON.stringify(defaultManagedDeployAiFields())).not.toContain("gpt-5.5");
	});
});
