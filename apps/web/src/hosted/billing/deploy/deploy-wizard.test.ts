import { describe, expect, test } from "bun:test";
import { validateHostedDeployPersona } from "@clawdi/shared/api";
import { DEPLOY_AGENT_NAME_MAX_LENGTH } from "@/hosted/billing/deploy/deploy-request";

describe("deploy wizard personalization", () => {
	test("uses a stable dashboard name within the strictest backend limit", () => {
		expect(DEPLOY_AGENT_NAME_MAX_LENGTH).toBe(64);
		expect(
			validateHostedDeployPersona({ agentName: "", language: "en", timezone: "Etc/UTC" }),
		).toContainEqual({ field: "agentName", message: "Enter a name for this agent." });
	});
});
