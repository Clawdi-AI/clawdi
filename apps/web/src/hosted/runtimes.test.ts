import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { deploymentRuntimes } from "@/hosted/runtimes";

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
		enable_openclaw: true,
		enable_hermes: false,
		onboarded_agents: ["openclaw"],
		configured_agents: ["openclaw"],
		clawdi_cloud_environments: {},
		vcpu: null,
		ram_gb: null,
		disk_gb: null,
		...overrides,
	};
}

describe("deploymentRuntimes", () => {
	test("always includes Codex before enabled runtime environments", () => {
		expect(
			deploymentRuntimes(
				deployment(
					configInfo({
						enable_hermes: true,
						clawdi_cloud_environments: {
							hermes: "env-hermes",
							openclaw: "env-openclaw",
						},
					}),
				),
			),
		).toEqual(["codex", "openclaw", "hermes"]);
	});

	test("does not surface disabled runtimes just because they remain configured", () => {
		expect(
			deploymentRuntimes(
				deployment(
					configInfo({
						enable_openclaw: true,
						enable_hermes: false,
						onboarded_agents: ["openclaw"],
						configured_agents: ["openclaw", "hermes"],
						clawdi_cloud_environments: {
							hermes: "env-hermes",
							openclaw: "env-openclaw",
						},
					}),
				),
			),
		).toEqual(["codex", "openclaw"]);
	});

	test("falls back to legacy enable flags when explicit runtime lists are absent", () => {
		expect(
			deploymentRuntimes(
				deployment(
					configInfo({
						enable_openclaw: false,
						enable_hermes: true,
						onboarded_agents: [],
						configured_agents: [],
						clawdi_cloud_environments: {},
					}),
				),
			),
		).toEqual(["codex", "hermes"]);
	});
});
