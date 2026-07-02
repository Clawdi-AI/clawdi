import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	defaultDeploymentRuntimeTarget,
	deploymentRuntimeTargets,
	enabledDeploymentRuntimeTargets,
	runtimeConsoleUrl,
} from "@/hosted/runtimes";

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
		enable_openclaw: false,
		enable_hermes: false,
		onboarded_agents: [],
		configured_agents: [],
		clawdi_cloud_environments: {},
		runtime_targets: {},
		vcpu: null,
		ram_gb: null,
		disk_gb: null,
		...overrides,
	};
}

function target(
	id: string,
	type: "codex" | "openclaw" | "hermes",
	overrides: Partial<
		NonNullable<NonNullable<HostedDeployment["config_info"]>["runtime_targets"]>[string]
	> = {},
): NonNullable<NonNullable<HostedDeployment["config_info"]>["runtime_targets"]>[string] {
	return {
		id,
		type,
		display_name: null,
		enabled: true,
		environment_id: `env-${id}`,
		control_ui_url: type === "codex" ? null : `https://${id}.example.test`,
		image: null,
		version: null,
		...overrides,
	};
}

describe("deploymentRuntimeTargets", () => {
	test("sorts explicit runtime targets by runtime type and target id", () => {
		const targets = deploymentRuntimeTargets(
			deployment(
				configInfo({
					runtime_targets: {
						"openclaw-b": target("openclaw-b", "openclaw"),
						hermes: target("hermes", "hermes"),
						codex: target("codex", "codex"),
						"openclaw-a": target("openclaw-a", "openclaw"),
					},
				}),
			),
		);

		expect(targets.map((item) => item.id)).toEqual(["codex", "openclaw-a", "openclaw-b", "hermes"]);
		expect(targets.map((item) => item.type)).toEqual(["codex", "openclaw", "openclaw", "hermes"]);
	});

	test("does not infer targets from legacy enable flags or environment maps", () => {
		expect(
			deploymentRuntimeTargets(
				deployment(
					configInfo({
						enable_openclaw: true,
						enable_hermes: true,
						onboarded_agents: ["openclaw", "hermes"],
						configured_agents: ["openclaw", "hermes"],
						clawdi_cloud_environments: {
							openclaw: "env-openclaw",
							hermes: "env-hermes",
						},
						runtime_targets: {},
					}),
				),
			),
		).toEqual([]);
	});

	test("filters enabled targets without falling back to same-type siblings", () => {
		const enabled = enabledDeploymentRuntimeTargets(
			deployment(
				configInfo({
					runtime_targets: {
						codex: target("codex", "codex"),
						"openclaw-a": target("openclaw-a", "openclaw", { enabled: false }),
						"openclaw-b": target("openclaw-b", "openclaw"),
					},
				}),
			),
		);

		expect(enabled.map((item) => item.id)).toEqual(["codex", "openclaw-b"]);
	});

	test("rejects malformed target records instead of repairing them", () => {
		const malformed = target("wrong-id", "openclaw");
		const targets = deploymentRuntimeTargets(
			deployment(
				configInfo({
					runtime_targets: {
						"openclaw-a": malformed,
					},
				}),
			),
		);

		expect(targets).toEqual([]);
	});

	test("selects a default only from explicit enabled targets", () => {
		const empty = defaultDeploymentRuntimeTarget(deployment(configInfo({ runtime_targets: {} })));
		const selected = defaultDeploymentRuntimeTarget(
			deployment(
				configInfo({
					runtime_targets: {
						codex: target("codex", "codex", { enabled: false }),
						hermes: target("hermes", "hermes"),
					},
				}),
			),
		);

		expect(empty).toBeNull();
		expect(selected?.id).toBe("hermes");
	});

	test("uses the target control UI URL and never deployment-level legacy URLs", () => {
		const targets = deploymentRuntimeTargets(
			deployment(
				configInfo({
					runtime_targets: {
						codex: target("codex", "codex"),
						"openclaw-a": target("openclaw-a", "openclaw", {
							control_ui_url: "https://openclaw-a.example.test",
						}),
					},
				}),
			),
		);
		const codex = targets[0];
		const openclaw = targets[1];
		if (!codex || !openclaw) throw new Error("expected test runtime targets");

		expect(runtimeConsoleUrl(codex)).toBeNull();
		expect(runtimeConsoleUrl(openclaw)).toBe("https://openclaw-a.example.test");
	});
});
