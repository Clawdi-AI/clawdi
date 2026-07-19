import { describe, expect, test } from "bun:test";
import { hostedEnvironmentHref } from "@/hosted/billing/deployment-links";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

describe("hostedEnvironmentHref", () => {
	test("links to the deterministic Cloud API environment identity", () => {
		expect(hostedEnvironmentHref(hostedDeploymentFixture({ id: "dep_123" }))).toBe(
			"/agents/21637a57-08b6-598a-8369-870ddc5ee4a2?source=on-clawdi&d=dep_123",
		);
	});

	test("includes the selected runtime in the environment identity", () => {
		expect(
			hostedEnvironmentHref(hostedDeploymentFixture({ id: "dep_123", runtime: "hermes" })),
		).toBe("/agents/d1dbf281-8cd4-50f5-b909-b595e0accd83?source=on-clawdi&d=dep_123");
	});
});
