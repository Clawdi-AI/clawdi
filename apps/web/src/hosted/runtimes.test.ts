import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	deploymentRuntime,
	deploymentRuntimes,
	runtimeConsoleUrl,
	runtimeUiAuthFlow,
} from "@/hosted/runtimes";

test("uses the persisted endpoint auth mode instead of inferring from runtime", () => {
	const hermes = deployment(configInfo({ runtime: "hermes" }));
	expect(
		runtimeUiAuthFlow(
			deploymentWithEndpoint(hermes, {
				runtime: "hermes",
				url: "https://agent.example.test/prefix",
				auth_mode: "password",
				browser_mode: "top_level",
			}),
		),
	).toBe("password");
	const openclaw = deployment(configInfo({ runtime: "openclaw" }));
	expect(
		runtimeUiAuthFlow(
			deploymentWithEndpoint(openclaw, {
				runtime: "openclaw",
				url: "https://openclaw.example.test/",
				auth_mode: "openclaw_device",
				browser_mode: "top_level",
			}),
		),
	).toBe("openclaw_device");
	expect(runtimeUiAuthFlow(hermes)).toBeNull();
	const prefixed = deploymentWithEndpoint(hermes, {
		runtime: "hermes",
		url: "https://dstack.example.test/deployments/agent/hermes",
		auth_mode: "password",
		browser_mode: "top_level",
	});
	expect(runtimeConsoleUrl(prefixed, "hermes")).toBe(
		"https://dstack.example.test/deployments/agent/hermes",
	);
});

test("fails closed on unsafe or mismatched native endpoint metadata", () => {
	const openclaw = deployment(configInfo({ runtime: "openclaw" }));
	const hermes = deployment(configInfo({ runtime: "hermes" }));

	expect(
		runtimeUiAuthFlow(
			deploymentWithEndpoint(openclaw, {
				runtime: "openclaw",
				url: "https://openclaw.example.test/?token=logged-token",
				auth_mode: "openclaw_device",
				browser_mode: "top_level",
			}),
		),
	).toBeNull();
	expect(
		runtimeUiAuthFlow(
			deploymentWithEndpoint(openclaw, {
				runtime: "openclaw",
				url: "https://openclaw.example.test/#token=token&extra=value",
				auth_mode: "openclaw_device",
				browser_mode: "top_level",
			}),
		),
	).toBeNull();
	expect(
		runtimeUiAuthFlow(
			deploymentWithEndpoint(openclaw, {
				runtime: "openclaw",
				url: "https://openclaw.example.test/",
				auth_mode: "password",
				browser_mode: "top_level",
			}),
		),
	).toBeNull();
	expect(
		runtimeUiAuthFlow(
			deploymentWithEndpoint(hermes, {
				runtime: "openclaw",
				url: "https://openclaw.example.test/#token=token",
				auth_mode: "openclaw_device",
				browser_mode: "top_level",
			}),
		),
	).toBeNull();
});

function deploymentWithEndpoint(
	base: HostedDeployment,
	runtimeUiEndpoint: {
		runtime: "openclaw" | "hermes";
		url: string;
		auth_mode: "openclaw_device" | "password";
		browser_mode: "top_level";
	},
): HostedDeployment {
	const deploymentWithEndpoint = {
		...base,
		runtime_ui_endpoint: { role: "control_ui" as const, ...runtimeUiEndpoint },
	};
	return deploymentWithEndpoint;
}

function deployment(configInfo: HostedDeployment["config_info"]): HostedDeployment {
	return {
		id: "dep_123",
		resource_version: "test-resource-version",
		user_id: "user_123",
		name: "hosted-test",
		app_id: "app_123",
		status: "running",
		endpoints: [],
		openclaw_control_ui_url: null,
		hermes_control_ui_url: null,
		config_info: configInfo,
		created_at: "2026-06-22T00:00:00Z",
		upgrade_available: false,
	};
}

function configInfo(
	overrides: Partial<NonNullable<HostedDeployment["config_info"]>>,
): NonNullable<HostedDeployment["config_info"]> {
	return {
		compute_plan_slug: "compute_basic",
		primary_model: null,
		ai_provider_id: null,
		ai_provider_auth_kind: "managed",
		public_ports: [],
		runtime: "openclaw",
		clawdi_cloud_environments: {},
		vcpu: null,
		ram_gb: null,
		disk_gb: null,
		...overrides,
	};
}

describe("deploymentRuntime", () => {
	test("returns the selected execution runtime", () => {
		expect(
			deploymentRuntime(
				deployment(
					configInfo({
						runtime: "hermes",
						clawdi_cloud_environments: {
							hermes: "env-hermes",
						},
					}),
				),
			),
		).toBe("hermes");
	});

	test("does not infer extra runtimes from stale environment mappings", () => {
		expect(
			deploymentRuntimes(
				deployment(
					configInfo({
						runtime: "openclaw",
						clawdi_cloud_environments: {
							hermes: "env-hermes",
							openclaw: "env-openclaw",
						},
					}),
				),
			),
		).toEqual(["openclaw"]);
	});

	test("does not surface Codex from stale hosted environment mappings", () => {
		expect(
			deploymentRuntimes(
				deployment(
					configInfo({
						runtime: "openclaw",
						clawdi_cloud_environments: {
							codex: "env-codex",
							openclaw: "env-openclaw",
						},
					}),
				),
			),
		).toEqual(["openclaw"]);
	});

	test("does not fall back to legacy untyped runtime URLs", () => {
		expect(
			runtimeConsoleUrl({
				...deployment(configInfo({ runtime: "openclaw" })),
				native_url: "https://app-native.example/control/",
				openclaw_control_ui_url: "https://app-18789.example/control/",
			}),
		).toBeNull();
		expect(
			runtimeConsoleUrl({
				...deployment(configInfo({ runtime: "openclaw" })),
				openclaw_control_ui_url: "https://app-18789.example/control/",
				hermes_control_ui_url: "https://app-9119.example/dashboard",
			}),
		).toBeNull();
		expect(
			runtimeConsoleUrl({
				...deployment(configInfo({ runtime: "hermes" })),
				openclaw_control_ui_url: "https://app-18789.example/control/",
				hermes_control_ui_url: "https://app-9119.example/dashboard",
			}),
		).toBeNull();
	});
});
