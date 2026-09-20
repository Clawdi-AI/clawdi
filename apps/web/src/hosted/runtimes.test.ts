import { describe, expect, test } from "bun:test";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	deploymentFilesUrl,
	deploymentRuntime,
	hermesOidcLoginUrl,
	observedCloudProjectionId,
	runtimeAiProviderAuthKind,
	runtimeConsoleUrl,
	runtimeDashboardUrl,
} from "@/hosted/runtimes";

describe("deploymentFilesUrl", () => {
	test("accepts only the generated owner-scoped HTTPS endpoint shape", () => {
		expect(
			deploymentFilesUrl(
				hostedDeploymentFixture({
					filesEndpoint: { url: "https://abc-9120.prod12.clawdi.ai/" },
				}),
			),
		).toBe("https://abc-9120.prod12.clawdi.ai/");
		expect(
			deploymentFilesUrl(
				hostedDeploymentFixture({
					filesEndpoint: { url: "https://abc-9120.prod12.clawdi.ai/deep" },
				}),
			),
		).toBeNull();
		expect(deploymentFilesUrl(hostedDeploymentFixture())).toBeNull();
	});
});

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
						auth_mode: "openclaw_token",
						browser_mode: "embedded_and_top_level",
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
						auth_mode: "oidc",
						browser_session_url:
							"https://api.example.test/v2/deployments/hdep_fixture/hermes-oidc/session",
						access_revision: 1,
						browser_mode: "embedded_and_top_level",
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

describe("runtimeDashboardUrl", () => {
	test.each([
		["https://runtime.example", "https://runtime.example/chat"],
		[
			"https://runtime.example/?next=one%2Ftwo#section",
			"https://runtime.example/chat?next=one%2Ftwo#section",
		],
		["https://runtime.example/settings/", "https://runtime.example/settings/"],
		["https://runtime.example/chat?session=123", "https://runtime.example/chat?session=123"],
		["https://proxy.example/app-9119/chat", "https://proxy.example/app-9119/chat"],
		["https://proxy.example/app-9119", "https://proxy.example/app-9119/chat"],
		["https://proxy.example/app-9119/", "https://proxy.example/app-9119/chat"],
		[
			"https://proxy.example/app-9119/settings?tab=model",
			"https://proxy.example/app-9119/settings?tab=model",
		],
	])("defaults Hermes root to Chat without changing explicit targets: %s", (url, expected) => {
		expect(runtimeDashboardUrl(url, "hermes")).toBe(expected);
		expect(runtimeDashboardUrl(url, "openclaw")).toBe(url);
	});
});

describe("hermesOidcLoginUrl", () => {
	test.each([
		[
			"https://runtime.example",
			"https://runtime.example/auth/login?provider=self-hosted&next=%2Fchat",
		],
		[
			"https://proxy.example/app-9119/",
			"https://proxy.example/app-9119/auth/login?provider=self-hosted&next=%2Fapp-9119%2Fchat",
		],
		[
			"https://proxy.example/app-9119/chat",
			"https://proxy.example/app-9119/auth/login?provider=self-hosted&next=%2Fapp-9119%2Fchat",
		],
	])("starts Hermes OIDC at the dashboard login route: %s", (url, expected) => {
		expect(hermesOidcLoginUrl(url)).toBe(expected);
	});

	test("preserves an explicit non-chat Hermes target", () => {
		const url = "https://runtime.example/settings?tab=model";
		expect(hermesOidcLoginUrl(url)).toBe(url);
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

describe("observedCloudProjectionId", () => {
	test("reads the observed Cloud projection without treating it as Agent identity", () => {
		const deployment = hostedDeploymentFixture({
			runtime: "hermes",
			cloudEnvironments: { hermes: "env-hermes" },
		});

		expect(observedCloudProjectionId(deployment)).toBe("env-hermes");
		expect(observedCloudProjectionId(deployment, "openclaw")).toBeUndefined();
	});

	test("returns undefined when the backend has not projected an environment id", () => {
		expect(observedCloudProjectionId(hostedDeploymentFixture())).toBeUndefined();
	});
});
