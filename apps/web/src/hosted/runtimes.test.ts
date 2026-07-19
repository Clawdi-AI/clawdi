import { describe, expect, test } from "bun:test";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import { deploymentRuntime, runtimeConsoleUrl, runtimeEnvironmentId } from "@/hosted/runtimes";

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

describe("runtimeEnvironmentId", () => {
	test("reads the stored environment id from the top-level read projection", () => {
		const deployment = hostedDeploymentFixture({
			runtime: "hermes",
			cloudEnvironments: { hermes: "env-hermes" },
		});

		expect(runtimeEnvironmentId(deployment)).toBe("env-hermes");
		expect(runtimeEnvironmentId(deployment, "openclaw")).toBeUndefined();
	});

	test("returns undefined when the backend has not projected an environment id", () => {
		expect(runtimeEnvironmentId(hostedDeploymentFixture())).toBeUndefined();
	});
});
