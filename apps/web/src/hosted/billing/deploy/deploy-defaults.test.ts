import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEPLOY_AI_ACCESS_MODE,
	DEFAULT_DEPLOY_AI_PROVIDER_CHOICES,
	DEFAULT_DEPLOY_PRIMARY_MODEL,
	DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE,
	DEFAULT_DEPLOY_RUNTIME,
	deployAssistantNameAfterRuntimeChange,
} from "@/hosted/billing/deploy/deploy-defaults";
import { MANAGED_AI_CHOICE } from "@/hosted/v2/ai-providers/model-binding";

describe("deploy wizard defaults", () => {
	test("default to the hermes runtime and managed AI mode", () => {
		expect(DEFAULT_DEPLOY_RUNTIME).toBe("hermes");
		expect(DEFAULT_DEPLOY_AI_ACCESS_MODE).toBe("configured");
		expect(DEFAULT_DEPLOY_AI_PROVIDER_CHOICES).toEqual([MANAGED_AI_CHOICE]);
		expect(DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE).toBe(MANAGED_AI_CHOICE);
		expect(DEFAULT_DEPLOY_PRIMARY_MODEL).toBe("");
	});

	test("follows runtime display names until the agent name is edited", () => {
		expect(
			deployAssistantNameAfterRuntimeChange({
				currentName: "Hermes",
				hasBeenEdited: false,
				runtime: "openclaw",
			}),
		).toBe("OpenClaw");
		expect(
			deployAssistantNameAfterRuntimeChange({
				currentName: "Research Assistant",
				hasBeenEdited: true,
				runtime: "hermes",
			}),
		).toBe("Research Assistant");
	});
});
