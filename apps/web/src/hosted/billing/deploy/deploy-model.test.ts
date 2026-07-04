import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { usesActiveFreeComputeSlot } from "@/hosted/billing/deploy/deploy-model";

function deployment(
	status: string,
	computePlanSlug: "compute_free" | "compute_performance",
): HostedDeployment {
	return {
		id: `hdep_${status}_${computePlanSlug}`,
		user_id: "usr_test",
		name: "Test agent",
		app_id: "v2-test",
		status,
		created_at: "2026-06-24T00:00:00Z",
		upgrade_available: false,
		config_info: {
			compute_plan_slug: computePlanSlug,
			mux_enabled: false,
			telegram_mux_enabled: false,
			discord_mux_enabled: false,
			whatsapp_mux_enabled: false,
			imessage_mux_enabled: false,
			kobb_available: false,
			ai_provider_auth_kind: "managed",
			enable_openclaw: true,
			enable_hermes: false,
			onboarded_agents: ["openclaw"],
			configured_agents: ["openclaw"],
			clawdi_cloud_environments: {},
			ai_provider_bindings: {},
			public_ports: [],
		},
	};
}

describe("usesActiveFreeComputeSlot", () => {
	test("treats non-stopped Free deployments as occupying the user Free slot", () => {
		expect(usesActiveFreeComputeSlot([deployment("running", "compute_free")])).toBe(true);
		expect(usesActiveFreeComputeSlot([deployment("starting", "compute_free")])).toBe(true);
		expect(usesActiveFreeComputeSlot([deployment("failed", "compute_free")])).toBe(true);
		expect(usesActiveFreeComputeSlot([deployment("deleting", "compute_free")])).toBe(true);
	});

	test("does not count stopped or deleted Free deployments or Performance deployments", () => {
		expect(usesActiveFreeComputeSlot([deployment("stopped", "compute_free")])).toBe(false);
		expect(usesActiveFreeComputeSlot([deployment("deleted", "compute_free")])).toBe(false);
		expect(usesActiveFreeComputeSlot([deployment("running", "compute_performance")])).toBe(false);
	});
});
