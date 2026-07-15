import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEPLOY_AI_ACCESS_MODE,
	DEFAULT_DEPLOY_AI_PROVIDER_CHOICES,
	DEFAULT_DEPLOY_PRIMARY_MODEL,
	DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE,
	DEFAULT_DEPLOY_RUNTIME,
	defaultManagedDeployAiFields,
	defaultManagedPrimaryModel,
} from "@/hosted/billing/deploy/deploy-defaults";
import { MANAGED_AI_CHOICE, MANAGED_PROVIDER_ID } from "@/hosted/v2/ai-providers/model-binding";

describe("deploy wizard defaults", () => {
	test("default to the hermes runtime and managed AI mode", () => {
		expect(DEFAULT_DEPLOY_RUNTIME).toBe("hermes");
		expect(DEFAULT_DEPLOY_AI_ACCESS_MODE).toBe("configured");
		expect(DEFAULT_DEPLOY_AI_PROVIDER_CHOICES).toEqual([MANAGED_AI_CHOICE]);
		expect(DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE).toBe(MANAGED_AI_CHOICE);
		expect(DEFAULT_DEPLOY_PRIMARY_MODEL).toBe("gpt-5.5");
	});

	test("build the explicit managed deploy fields used by the default wizard state", () => {
		expect(defaultManagedPrimaryModel()).toEqual({
			provider_id: MANAGED_PROVIDER_ID,
			model: DEFAULT_DEPLOY_PRIMARY_MODEL,
		});
		expect(defaultManagedDeployAiFields()).toEqual({
			ai_provider_id: null,
			ai_provider_auth_kind: "managed",
			provider_ids: [MANAGED_PROVIDER_ID],
			primary_model: {
				provider_id: MANAGED_PROVIDER_ID,
				model: DEFAULT_DEPLOY_PRIMARY_MODEL,
			},
		});
	});
});
