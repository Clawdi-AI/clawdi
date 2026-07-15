import { beforeAll, describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import type { AgentTile } from "@/components/dashboard/agents-card";
import type { HostedDeployment } from "@/hosted/billing/contracts";

type HostedAgentTileStatus = typeof import("@/hosted/use-hosted-agent-tiles").hostedAgentTileStatus;
type DeploymentToTiles = typeof import("@/hosted/use-hosted-agent-tiles").deploymentToTiles;
type HostedRuntimeStatusView =
	typeof import("@/hosted/use-hosted-agent-tiles").hostedRuntimeStatusView;
type UnifiedHostedAgentTiles =
	typeof import("@/hosted/use-hosted-agent-tiles").unifiedHostedAgentTiles;
type Env = components["schemas"]["AgentResponse"];

let getTileStatus: HostedAgentTileStatus | null = null;
let getDeploymentToTiles: DeploymentToTiles | null = null;
let getRuntimeStatusView: HostedRuntimeStatusView | null = null;
let getUnifiedHostedAgentTiles: UnifiedHostedAgentTiles | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/use-hosted-agent-tiles");
	getTileStatus = module.hostedAgentTileStatus;
	getDeploymentToTiles = module.deploymentToTiles;
	getRuntimeStatusView = module.hostedRuntimeStatusView;
	getUnifiedHostedAgentTiles = module.unifiedHostedAgentTiles;
});

function hostedAgentTileStatus(rawStatus: string) {
	if (!getTileStatus) throw new Error("hostedAgentTileStatus was not loaded");
	return getTileStatus(rawStatus);
}

function hostedRuntimeStatusView(
	rawStatus: string,
	environment: Env | null | undefined,
	failureReason?: string | null,
) {
	if (!getRuntimeStatusView) throw new Error("hostedRuntimeStatusView was not loaded");
	return getRuntimeStatusView({ status: rawStatus, failure_reason: failureReason }, environment);
}

function hostedDeploymentToTiles(deployment: HostedDeployment, envs: Env[] = []) {
	if (!getDeploymentToTiles) throw new Error("deploymentToTiles was not loaded");
	return getDeploymentToTiles(
		deployment,
		new Map(envs.map((item) => [item.id.toLowerCase(), item])),
	);
}

function unifiedHostedAgentTiles(args: Parameters<UnifiedHostedAgentTiles>[0]) {
	if (!getUnifiedHostedAgentTiles) throw new Error("unifiedHostedAgentTiles was not loaded");
	return getUnifiedHostedAgentTiles(args);
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
			compute_plan_slug: "compute_basic",
			mux_enabled: true,
			telegram_mux_enabled: false,
			discord_mux_enabled: false,
			whatsapp_mux_enabled: false,
			imessage_mux_enabled: false,
			kobb_available: false,
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

function agentTile(overrides: Partial<AgentTile> = {}): AgentTile {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		source: "self-managed",
		name: "connected-agent",
		agentType: "openclaw",
		statusLabel: "Never seen",
		href: "/agents/11111111-1111-4111-8111-111111111111",
		active: false,
		env: null,
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

	test("projects dunning state as the hosted tile secondary status", () => {
		const [tile] = hostedDeploymentToTiles(
			deployment({
				compute_subscription: {
					status: "past_due",
					payment_state: "requires_action",
					billing_term_months: 1,
					price_cents: 1_900,
					currency: "usd",
					cancel_at_period_end: false,
					current_period_end: "2026-08-01T00:00:00Z",
					cancel_at: null,
					canceled_at: null,
					latest_failed_invoice_id: "in_action_required",
					latest_failed_invoice_hosted_url: "https://invoice.stripe.test/action",
					next_payment_attempt_at: null,
				},
			}),
		);

		expect(tile?.secondaryStatus).toEqual({
			label: "Payment action required",
			title: "Complete payment authentication to keep Basic compute active.",
			textClass: "text-warning-muted-foreground",
		});
	});

	test("projects failed deployment reasons ahead of dunning state", () => {
		const [tile] = hostedDeploymentToTiles(
			deployment({
				status: "failed",
				failure_reason: "startup_probe_failing; restart_count=2; container failed readiness probe",
				compute_subscription: {
					status: "past_due",
					payment_state: "requires_action",
					billing_term_months: 1,
					price_cents: 1_900,
					currency: "usd",
					cancel_at_period_end: false,
					current_period_end: "2026-08-01T00:00:00Z",
					cancel_at: null,
					canceled_at: null,
					latest_failed_invoice_id: "in_action_required",
					latest_failed_invoice_hosted_url: "https://invoice.stripe.test/action",
					next_payment_attempt_at: null,
				},
			}),
		);

		expect(tile?.secondaryStatus).toEqual({
			label: "Failure: startup_probe_failing; restart_count=2; container failed readiness probe",
			title: "startup_probe_failing; restart_count=2; container failed readiness probe",
			textClass: "text-destructive-muted-foreground font-medium",
		});
	});

	test("routes a failed never-provisioned deployment by deployment id so delete stays reachable", () => {
		const failureReason = "startup_probe_failing; restart_count=2";
		const [tile] = hostedDeploymentToTiles(
			deployment(
				{
					status: "failed",
					failure_reason: failureReason,
				},
				{
					clawdi_cloud_environments: {},
				},
			),
		);

		expect(tile).toMatchObject({
			id: "dep_123",
			source: "on-clawdi",
			href: "/agents/dep_123",
			manageHref: "/agents/dep_123/settings",
			env: null,
			secondaryStatus: {
				label: "Failure: startup_probe_failing; restart_count=2",
				title: failureReason,
				textClass: "text-destructive-muted-foreground font-medium",
			},
		});
	});
});

describe("unifiedHostedAgentTiles", () => {
	test("keeps hosted tiles visible while legacy ownership is unresolved", () => {
		const claimedEnv = "33333333-3333-4333-8333-333333333333";
		const hostedTile = agentTile({
			id: "dep_failed",
			source: "on-clawdi",
			name: "OpenClaw",
			href: "/agents/dep_failed",
			manageHref: "/agents/dep_failed/settings",
			statusLabel: "Failed",
			secondaryStatus: {
				label: "Failure: startup_probe_failing",
				title: "startup_probe_failing",
				textClass: "text-destructive-muted-foreground font-medium",
			},
		});
		const claimedSelfManaged = agentTile({
			id: claimedEnv,
			name: "cloud-env",
			href: `/agents/${claimedEnv}`,
		});
		const connected = agentTile({
			id: "44444444-4444-4444-8444-444444444444",
			name: "connected-agent",
			href: "/agents/44444444-4444-4444-8444-444444444444",
		});

		const tiles = unifiedHostedAgentTiles({
			selfManagedTiles: [claimedSelfManaged, connected],
			hostedTiles: [hostedTile],
			claimedEnvIds: new Set([claimedEnv.toLowerCase()]),
			legacyEnvIds: null,
			cloudEnvs: [],
			showLegacyAgents: true,
		});

		expect(tiles.map((tile) => tile.id)).toEqual(["dep_failed", connected.id]);
		expect(tiles[0]?.secondaryStatus?.label).toBe("Failure: startup_probe_failing");
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

	test("shows failed deployment reason as secondary status", () => {
		const view = hostedRuntimeStatusView(
			"failed",
			null,
			" startup_probe_failing;   restart_count=2 ",
		);

		expect(view.primary.label).toBe("Failed");
		expect(view.secondary).toEqual({
			kind: "failure_reason",
			label: "Failure: startup_probe_failing; restart_count=2",
			tooltip: "startup_probe_failing; restart_count=2",
			textClass: "text-destructive-muted-foreground font-medium",
		});
	});
});
