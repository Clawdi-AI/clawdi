import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { hostedEnvironmentHref } from "@/hosted/billing/deployment-links";

function deployment(envs: Record<string, string> | null): HostedDeployment {
	return {
		id: "dep_123",
		user_id: "user_123",
		name: "openclaw-test",
		app_id: "app_123",
		backend: null,
		status: "provisioning",
		endpoints: [],
		ui_access_token: null,
		openclaw_ui_url: null,
		hermes_ui_url: null,
		config_info: envs
			? {
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
					onboarded_agents: [],
					configured_agents: [],
					clawdi_cloud_environments: envs,
					vcpu: null,
					ram_gb: null,
					disk_gb: null,
				}
			: null,
		created_at: "2026-06-22T00:00:00Z",
		upgrade_available: false,
		profile: "free",
	};
}

describe("hostedEnvironmentHref", () => {
	test("links to the minted cloud environment when available", () => {
		expect(hostedEnvironmentHref(deployment({ openclaw: "env 1" }))).toBe(
			"/agents/env%201?source=on-clawdi",
		);
	});

	test("does not treat the deployment id as an agent environment id", () => {
		expect(hostedEnvironmentHref(deployment(null))).toBeNull();
		expect(hostedEnvironmentHref(deployment({}))).toBeNull();
	});
});
