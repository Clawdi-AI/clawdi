import { describe, expect, test } from "bun:test";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	deploymentRuntime,
	runtimeAiProviderAuthKind,
	runtimeConsoleUrl,
	runtimeEnvironmentId,
} from "@/hosted/runtimes";

describe("deploymentRuntime", () => {
	test("returns the selected execution runtime", () => {
		expect(deploymentRuntime(hostedDeploymentFixture({ runtime: "hermes" }))).toBe("hermes");
	});

	test("selects the dashboard URL for the chosen runtime", () => {
		expect(
			runtimeConsoleUrl(
				hostedDeploymentFixture({
					runtime: "openclaw",
					runtimeUiEndpoint: {
						runtime: "openclaw",
						role: "control_ui",
						url: "https://app-18789.example/control/",
						auth_mode: "openclaw_device",
						browser_mode: "top_level",
					},
				}),
			),
		).toBe("https://app-18789.example/control/");
		expect(
			runtimeConsoleUrl(
				hostedDeploymentFixture({
					runtime: "hermes",
					runtimeUiEndpoint: {
						runtime: "hermes",
						role: "control_ui",
						url: "https://app-9119.example/dashboard",
						auth_mode: "password",
						browser_mode: "top_level",
					},
				}),
			),
		).toBe("https://app-9119.example/dashboard");
	});

	test("does not fall back to an unrelated resource endpoint", () => {
		expect(
			runtimeConsoleUrl(
				hostedDeploymentFixture({
					endpoints: [{ name: "app", url: "https://app.example" }],
				}),
			),
		).toBeNull();
	});
});

describe("runtimeAiProviderAuthKind", () => {
	test("reads the authoritative per-runtime mode even when providers are empty", () => {
		const deployment = hostedDeploymentFixture({
			runtimeConfiguration: { providers: [], features: [] },
			aiProviderAuthKinds: { openclaw: "unmanaged" },
		});

		expect(runtimeAiProviderAuthKind(deployment)).toBe("unmanaged");
	});

	test("keeps every hosted authentication mode distinct", () => {
		for (const authKind of ["managed", "api_key", "codex_oauth"] as const) {
			expect(
				runtimeAiProviderAuthKind(
					hostedDeploymentFixture({ aiProviderAuthKinds: { openclaw: authKind } }),
				),
			).toBe(authKind);
		}
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
