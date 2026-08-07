import { describe, expect, test } from "bun:test";
import { hostedEnvironmentHref } from "@/hosted/billing/deployment-links";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

describe("hostedEnvironmentHref", () => {
	test("links to the stored Cloud API environment identity", () => {
		expect(
			hostedEnvironmentHref(
				hostedDeploymentFixture({
					id: "dep_123",
					cloudEnvironments: { openclaw: "env 1" },
				}),
			),
		).toBe("/agents/env%201?source=on-clawdi&d=dep_123");
	});

	test("uses the environment stored for the selected runtime", () => {
		expect(
			hostedEnvironmentHref(
				hostedDeploymentFixture({
					id: "dep_123",
					runtime: "hermes",
					cloudEnvironments: {
						openclaw: "env-openclaw",
						hermes: "env-hermes",
					},
				}),
			),
		).toBe("/agents/env-hermes?source=on-clawdi&d=dep_123");
	});

	test("does not invent an environment id when the projection is missing", () => {
		expect(hostedEnvironmentHref(hostedDeploymentFixture({ id: "dep_123" }))).toBeNull();
		expect(
			hostedEnvironmentHref(hostedDeploymentFixture({ id: "dep_123", cloudEnvironments: {} })),
		).toBeNull();
	});
});
