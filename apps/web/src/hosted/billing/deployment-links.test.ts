import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { hostedEnvironmentHref } from "@/hosted/billing/deployment-links";

type RuntimeTarget = NonNullable<
	NonNullable<HostedDeployment["config_info"]>["runtime_targets"]
>[string];

function runtimeTarget(
	id: string,
	type: RuntimeTarget["type"],
	overrides: Partial<RuntimeTarget> = {},
): RuntimeTarget {
	return {
		id,
		type,
		display_name: null,
		enabled: true,
		environment_id: null,
		control_ui_url: null,
		image: null,
		version: null,
		...overrides,
	};
}

function deployment(runtimeTargets: Record<string, RuntimeTarget> | null): HostedDeployment {
	return {
		id: "dep_123",
		user_id: "user_123",
		name: "openclaw-test",
		app_id: "app_123",
		backend: null,
		status: "provisioning",
		endpoints: [],
		openclaw_control_ui_url: null,
		hermes_control_ui_url: null,
		config_info: runtimeTargets
			? {
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
					enable_openclaw: false,
					enable_hermes: false,
					onboarded_agents: [],
					configured_agents: [],
					clawdi_cloud_environments: {},
					runtime_targets: runtimeTargets,
					vcpu: null,
					ram_gb: null,
					disk_gb: null,
				}
			: null,
		created_at: "2026-06-22T00:00:00Z",
		upgrade_available: false,
	};
}

describe("hostedEnvironmentHref", () => {
	test("links to the minted cloud environment when available", () => {
		expect(
			hostedEnvironmentHref(
				deployment({
					"openclaw-a": runtimeTarget("openclaw-a", "openclaw", {
						environment_id: "env 1",
					}),
				}),
			),
		).toBe("/agents/env%201?source=on-clawdi");
	});

	test("uses an explicit deployment-target route while env id is not minted", () => {
		expect(
			hostedEnvironmentHref(
				deployment({
					"openclaw-a": runtimeTarget("openclaw-a", "openclaw"),
				}),
			),
		).toBe("/agents/dep_123%3Aopenclaw-a?source=on-clawdi");
	});

	test("prefers the first enabled explicit runtime target", () => {
		expect(
			hostedEnvironmentHref(
				deployment({
					"openclaw-a": runtimeTarget("openclaw-a", "openclaw", { enabled: false }),
					codex: runtimeTarget("codex", "codex", { environment_id: "env codex" }),
					hermes: runtimeTarget("hermes", "hermes", { environment_id: "env hermes" }),
				}),
			),
		).toBe("/agents/env%20codex?source=on-clawdi");
	});

	test("returns null when no explicit runtime target exists", () => {
		expect(hostedEnvironmentHref(deployment(null))).toBeNull();
		expect(hostedEnvironmentHref(deployment({}))).toBeNull();
	});
});
