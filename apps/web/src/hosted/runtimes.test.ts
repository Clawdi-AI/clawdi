import { describe, expect, test } from "bun:test";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import { deploymentRuntime, runtimeConsoleUrl } from "@/hosted/runtimes";

describe("deploymentRuntime", () => {
	test("returns the selected execution runtime", () => {
		expect(deploymentRuntime(hostedDeploymentFixture({ runtime: "hermes" }))).toBe("hermes");
	});

	test("selects the dashboard URL for the chosen runtime", () => {
		expect(
			runtimeConsoleUrl(
				hostedDeploymentFixture({
					runtime: "openclaw",
					endpoints: [{ name: "endpoint-1", url: "https://app-18789.example/control/" }],
				}),
			),
		).toBe("https://app-18789.example/control/");
		expect(
			runtimeConsoleUrl(
				hostedDeploymentFixture({
					runtime: "hermes",
					endpoints: [{ name: "endpoint-1", url: "https://app-9119.example/dashboard" }],
				}),
			),
		).toBe("https://app-9119.example/dashboard");
	});
});
