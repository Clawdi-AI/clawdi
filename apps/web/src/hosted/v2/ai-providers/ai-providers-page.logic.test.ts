import { describe, expect, test } from "bun:test";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	providerRemovalImpact,
	providerUsage,
} from "@/hosted/v2/ai-providers/ai-providers-page.logic";

describe("providerUsage", () => {
	test("reports unresolved inventory as unknown instead of unused", () => {
		expect(providerUsage("openai", null)).toEqual({ known: false, agentCount: 0 });
	});

	test("counts agents whose runtime provider pool contains the provider", () => {
		const deployments = [
			hostedDeploymentFixture({
				id: "dep_openai",
				runtimeConfiguration: {
					providers: [{ provider_id: "openai", auth_kind: "secret_reference", models: [] }],
					features: [],
				},
			}),
			hostedDeploymentFixture({
				id: "dep_other",
				runtimeConfiguration: {
					providers: [{ provider_id: "anthropic", auth_kind: "secret_reference", models: [] }],
					features: [],
				},
			}),
		];

		expect(providerUsage("openai", deployments)).toEqual({ known: true, agentCount: 1 });
	});

	test("detects a primary-model reference even when the provider pool is incomplete", () => {
		const deployment = hostedDeploymentFixture({
			runtimeConfiguration: {
				primary_model: { provider_id: "openai", model: "gpt-5.5" },
				providers: [],
				features: [],
			},
		});

		expect(providerUsage("openai", [deployment])).toEqual({ known: true, agentCount: 1 });
	});
});

describe("providerRemovalImpact", () => {
	test("requires acknowledgement and warns against automatic fallback when the provider is used", () => {
		const impact = providerRemovalImpact({ known: true, agentCount: 2 });

		expect(impact.acknowledgementRequired).toBe(true);
		expect(impact.warning).toContain("2 agents currently use it");
		expect(impact.warning).toContain("no automatic fallback");
	});

	test("requires acknowledgement when usage could not be checked", () => {
		expect(providerRemovalImpact({ known: false, agentCount: 0 }).acknowledgementRequired).toBe(
			true,
		);
	});

	test("does not require extra acknowledgement for a known-unused provider", () => {
		expect(providerRemovalImpact({ known: true, agentCount: 0 }).acknowledgementRequired).toBe(
			false,
		);
	});
});
