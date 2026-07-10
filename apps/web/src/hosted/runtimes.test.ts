import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { deploymentRuntime, deploymentRuntimes, runtimeConsoleUrl } from "@/hosted/runtimes";

function deployment(configInfo: HostedDeployment["config_info"]): HostedDeployment {
	return {
		id: "dep_123",
		user_id: "user_123",
		name: "hosted-test",
		app_id: "app_123",
		backend: null,
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
		compute_plan_slug: "compute_free",
		mux_enabled: true,
		telegram_mux_enabled: false,
		discord_mux_enabled: false,
		whatsapp_mux_enabled: false,
		imessage_mux_enabled: false,
		kobb_available: false,
		channel: null,
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

	test("selects the dashboard URL for the chosen runtime", () => {
		expect(
			runtimeConsoleUrl({
				...deployment(configInfo({ runtime: "openclaw" })),
				native_url: "https://app-native.example/control/",
				openclaw_control_ui_url: "https://app-18789.example/control/",
			}),
		).toBe("https://app-native.example/control/");
		expect(
			runtimeConsoleUrl({
				...deployment(configInfo({ runtime: "openclaw" })),
				openclaw_control_ui_url: "https://app-18789.example/control/",
				hermes_control_ui_url: "https://app-9119.example/dashboard",
			}),
		).toBe("https://app-18789.example/control/");
		expect(
			runtimeConsoleUrl({
				...deployment(configInfo({ runtime: "hermes" })),
				openclaw_control_ui_url: "https://app-18789.example/control/",
				hermes_control_ui_url: "https://app-9119.example/dashboard",
			}),
		).toBe("https://app-9119.example/dashboard");
	});
});
