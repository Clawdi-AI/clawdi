import { beforeAll, describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import type { HostedDeployment } from "@/hosted/billing/contracts";

type HostedAgentTileStatus = typeof import("@/hosted/use-hosted-agent-tiles").hostedAgentTileStatus;
type DeploymentToTiles = typeof import("@/hosted/use-hosted-agent-tiles").deploymentToTiles;
type HostedRuntimeStatusView =
	typeof import("@/hosted/use-hosted-agent-tiles").hostedRuntimeStatusView;
type Env = components["schemas"]["AgentResponse"];

let getTileStatus: HostedAgentTileStatus | null = null;
let getDeploymentToTiles: DeploymentToTiles | null = null;
let getRuntimeStatusView: HostedRuntimeStatusView | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/use-hosted-agent-tiles");
	getTileStatus = module.hostedAgentTileStatus;
	getDeploymentToTiles = module.deploymentToTiles;
	getRuntimeStatusView = module.hostedRuntimeStatusView;
});

function hostedAgentTileStatus(rawStatus: string) {
	if (!getTileStatus) throw new Error("hostedAgentTileStatus was not loaded");
	return getTileStatus(rawStatus);
}

function hostedRuntimeStatusView(rawStatus: string, environment: Env | null | undefined) {
	if (!getRuntimeStatusView) throw new Error("hostedRuntimeStatusView was not loaded");
	return getRuntimeStatusView({ status: rawStatus }, environment);
}

function hostedDeploymentToTiles(deployment: HostedDeployment, envs: Env[] = []) {
	if (!getDeploymentToTiles) throw new Error("deploymentToTiles was not loaded");
	return getDeploymentToTiles(
		deployment,
		new Map(envs.map((item) => [item.id.toLowerCase(), item])),
	);
}

function env(overrides: Partial<Env> = {}): Env {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "hosted-openclaw",
		default_name: "hosted-openclaw",
		machine_name: "hosted-openclaw",
		agent_type: "openclaw",
		agent_version: null,
		os: "linux",
		last_seen_at: null,
		last_sync_at: new Date().toISOString(),
		last_sync_error: null,
		last_revision_seen: null,
		sort_order: 0,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: false,
		default_project_id: "22222222-2222-4222-8222-222222222222",
		...overrides,
	};
}

function deployment(
	overrides: Partial<HostedDeployment> = {},
	configInfoOverrides: Partial<NonNullable<HostedDeployment["config_info"]>> = {},
): HostedDeployment {
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
		config_info: {
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
			...configInfoOverrides,
		},
		created_at: "2026-06-22T00:00:00Z",
		upgrade_available: false,
		...overrides,
	};
}

describe("deploymentToTiles", () => {
	test("renders only the selected runtime even when stale environment mappings remain", () => {
		const openclawEnv = env({
			id: "33333333-3333-4333-8333-333333333333",
			name: "hosted-openclaw",
			default_name: "hosted-openclaw",
			machine_name: "hosted-openclaw",
			agent_type: "openclaw",
			last_seen_at: new Date().toISOString(),
		});
		const tiles = hostedDeploymentToTiles(
			deployment(
				{},
				{
					runtime: "openclaw",
					clawdi_cloud_environments: {
						openclaw: openclawEnv.id,
						hermes: "44444444-4444-4444-8444-444444444444",
					},
				},
			),
			[openclawEnv],
		);

		expect(tiles.map((tile) => tile.agentType)).toEqual(["openclaw"]);
		expect(tiles.map((tile) => tile.id)).toEqual(["dep_123"]);
	});
});

describe("hostedAgentTileStatus", () => {
	test("marks running deployments active and normalizes the ready alias", () => {
		expect(hostedAgentTileStatus("running")).toEqual({ label: "Running", active: true });
		expect(hostedAgentTileStatus("ready")).toEqual({ label: "Running", active: true });
	});

	test("keeps transitional and failed deployments inactive with readable labels", () => {
		expect(hostedAgentTileStatus("creating")).toEqual({
			label: "Provisioning",
			active: false,
		});
		expect(hostedAgentTileStatus("starting")).toEqual({
			label: "Starting",
			active: false,
		});
		expect(hostedAgentTileStatus("failed")).toEqual({ label: "Failed", active: false });
	});

	test("passes unknown deploy-api statuses through as readable labels", () => {
		expect(hostedAgentTileStatus("queued_for_drain")).toEqual({
			label: "Queued For Drain",
			active: false,
		});
	});
});

describe("hostedRuntimeStatusView", () => {
	test("keeps compute primary and sync paused secondary while running", () => {
		const view = hostedRuntimeStatusView(
			"running",
			env({ last_sync_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
		);

		expect(view.primary.label).toBe("Running");
		expect(view.active).toBe(true);
		expect(view.sync?.kind).toBe("paused");
		expect(view.secondary?.label).toBe("Sync paused");
	});

	test("suppresses reassuring live sync when compute is stopped", () => {
		const view = hostedRuntimeStatusView("stopped", env());

		expect(view.primary.label).toBe("Stopped");
		expect(view.active).toBe(false);
		expect(view.sync?.kind).toBe("live");
		expect(view.secondary).toBeNull();
	});

	test("counts a hosted runtime active when its joined environment is fresh", () => {
		const view = hostedRuntimeStatusView(
			"stopped",
			env({ last_seen_at: new Date().toISOString() }),
		);

		expect(view.primary.label).toBe("Stopped");
		expect(view.active).toBe(true);
		expect(view.secondary).toBeNull();
	});

	test("suppresses live sync when compute is running", () => {
		const view = hostedRuntimeStatusView("running", env());

		expect(view.primary.label).toBe("Running");
		expect(view.sync?.kind).toBe("live");
		expect(view.secondary).toBeNull();
	});

	test("shows pending sync only when running without a registered environment", () => {
		const running = hostedRuntimeStatusView("running", null);
		const creating = hostedRuntimeStatusView("creating", null);

		expect(running.secondary?.label).toBe("Sync pending");
		expect(creating.primary.label).toBe("Provisioning");
		expect(creating.secondary).toBeNull();
	});
});
