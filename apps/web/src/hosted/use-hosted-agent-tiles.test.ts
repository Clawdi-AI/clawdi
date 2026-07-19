import { beforeAll, describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import type {
	HostedComputeSubscription,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type HostedAgentTileStatus = typeof import("@/hosted/use-hosted-agent-tiles").hostedAgentTileStatus;
type DeploymentToTiles = typeof import("@/hosted/use-hosted-agent-tiles").deploymentToTiles;
type HostedRuntimeStatusView =
	typeof import("@/hosted/use-hosted-agent-tiles").hostedRuntimeStatusView;
type ResolveAgentDeployment =
	typeof import("@/hosted/agents/deployment-hooks").resolveAgentDeployment;
type Env = components["schemas"]["AgentResponse"];

let getTileStatus: HostedAgentTileStatus | null = null;
let getDeploymentToTiles: DeploymentToTiles | null = null;
let getRuntimeStatusView: HostedRuntimeStatusView | null = null;
let getAgentDeploymentResolution: ResolveAgentDeployment | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/use-hosted-agent-tiles");
	getTileStatus = module.hostedAgentTileStatus;
	getDeploymentToTiles = module.deploymentToTiles;
	getRuntimeStatusView = module.hostedRuntimeStatusView;
	const deploymentHooks = await import("@/hosted/agents/deployment-hooks");
	getAgentDeploymentResolution = deploymentHooks.resolveAgentDeployment;
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
	return getRuntimeStatusView(
		{
			summary_state: rawStatus,
			failure: failureReason ? deploymentFailure(failureReason) : null,
		},
		environment,
	);
}

function hostedDeploymentToTiles(deployment: HostedDeployment, envs: Env[] = []) {
	if (!getDeploymentToTiles) throw new Error("deploymentToTiles was not loaded");
	return getDeploymentToTiles(
		deployment,
		new Map(envs.map((item) => [item.id.toLowerCase(), item])),
	);
}

function resolveAgentDeployment(
	deployments: readonly HostedDeployment[],
	environmentId: string,
	deploymentSelector?: string,
) {
	if (!getAgentDeploymentResolution) throw new Error("resolveAgentDeployment was not loaded");
	return getAgentDeploymentResolution(deployments, environmentId, deploymentSelector);
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

function deploymentFailure(reason: string): NonNullable<HostedDeploymentStatus["failure"]> {
	return {
		type: "https://api.clawdi.ai/problems/deployment-failed",
		title: "Deployment failed",
		status: 500,
		detail: reason,
		instance: "dep_123",
		code: "deployment_failed",
		conditionReason: "DeploymentFailed",
		conditionMessage: reason,
		observedGeneration: 1,
	};
}

function deployment(
	overrides: {
		id?: string;
		name?: string;
		status?: HostedDeploymentStatus["summary_state"];
		createdAt?: string;
		runtime?: "openclaw" | "hermes";
		computeSubscription?: HostedComputeSubscription;
		computePlanSlug?: "compute_basic" | "compute_performance";
		failureReason?: string;
		environmentId?: string | null;
	} = {},
): HostedDeployment {
	const id = overrides.id ?? "dep_123";
	const runtime = overrides.runtime ?? "openclaw";
	const environmentId = overrides.environmentId ?? `env_${id}_${runtime}`;
	return hostedDeploymentFixture({
		id,
		name: overrides.name ?? "hosted-test",
		status: overrides.status,
		createdAt: overrides.createdAt ?? "2026-06-22T00:00:00Z",
		runtime,
		cloudEnvironments: overrides.environmentId === null ? {} : { [runtime]: environmentId },
		computeSubscription: overrides.computeSubscription,
		fundingFact: overrides.computePlanSlug
			? {
					fact_kind: "funding_ready",
					commercial_revision: 1,
					compute_plan_slug: overrides.computePlanSlug,
					emitted_at: "2026-06-22T00:00:00Z",
				}
			: undefined,
		failure: overrides.failureReason ? deploymentFailure(overrides.failureReason) : undefined,
	});
}

describe("deploymentToTiles", () => {
	test("renders the runtime selected by the deployment spec", () => {
		const environmentId = "env-openclaw";
		const hostedDeployment = deployment({ runtime: "openclaw", environmentId });
		const openclawEnv = env({
			id: environmentId,
			name: "hosted-openclaw",
			default_name: "hosted-openclaw",
			machine_name: "hosted-openclaw",
			agent_type: "openclaw",
			last_seen_at: new Date().toISOString(),
		});
		const tiles = hostedDeploymentToTiles(hostedDeployment, [openclawEnv]);

		expect(tiles.map((tile) => tile.agentType)).toEqual(["openclaw"]);
		expect(tiles.map((tile) => tile.id)).toEqual(["dep_123"]);
		expect(tiles[0]?.href).toBe(`/agents/${openclawEnv.id}?source=on-clawdi&d=dep_123`);
		expect(tiles[0]?.manageHref).toBe(
			`/agents/${openclawEnv.id}/settings?source=on-clawdi&d=dep_123`,
		);
	});

	test("projects dunning state as the hosted tile secondary status", () => {
		const [tile] = hostedDeploymentToTiles(
			deployment({
				computePlanSlug: "compute_basic",
				computeSubscription: {
					status: "past_due",
					funding_source: "stripe",
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
				failureReason: "startup_probe_failing; restart_count=2; container failed readiness probe",
				computeSubscription: {
					status: "past_due",
					funding_source: "stripe",
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

	test("links by deployment env identity when the cloud-api projection is missing", () => {
		const failureReason = "startup_probe_failing; restart_count=2";
		const environmentId = "env-failed-openclaw";
		const hostedDeployment = deployment({ status: "failed", failureReason, environmentId });
		const [tile] = hostedDeploymentToTiles(hostedDeployment);

		expect(tile).toMatchObject({
			id: "dep_123",
			source: "on-clawdi",
			href: `/agents/${environmentId}?source=on-clawdi&d=dep_123`,
			env: null,
			contextLabel: "hosted-test",
			secondaryStatus: {
				label: "Failure: startup_probe_failing; restart_count=2",
				title: failureReason,
				textClass: "text-destructive-muted-foreground font-medium",
			},
		});
		expect(tile?.manageHref).toBe(`/agents/${environmentId}/settings?source=on-clawdi&d=dep_123`);
		expect(tile?.action).toBeUndefined();
		expect(JSON.stringify(tile)).not.toContain("/agents/dep_123");
	});

	test("removes deleted deployments from tiles and detail membership", () => {
		const environmentId = "env-deleted-openclaw";
		const deleted = deployment({ status: "deleted", environmentId });

		expect(hostedDeploymentToTiles(deleted)).toEqual([]);
		expect(resolveAgentDeployment([deleted], environmentId).match).toBeNull();
	});

	test("keeps a deployment without an env identity non-navigable but exposes delete", () => {
		const hostedDeployment = deployment({
			status: "failed",
			failureReason: "creation_interrupted",
			environmentId: null,
		});
		const [tile] = hostedDeploymentToTiles(hostedDeployment);

		expect(tile).toMatchObject({
			id: "dep_123",
			href: null,
			env: null,
			secondaryStatus: {
				label: "Failure: creation_interrupted",
				title: "creation_interrupted",
			},
		});
		expect(tile?.action).toBeDefined();
		expect(JSON.stringify(tile)).not.toContain("/agents/dep_123");
	});
});

describe("resolveAgentDeployment", () => {
	const sharedEnvironmentId = "env-shared-openclaw";
	const newer = deployment({
		id: "dep_newer",
		name: "Newer twin",
		createdAt: "2026-07-15T00:00:00Z",
		environmentId: sharedEnvironmentId,
	});
	const older = deployment({
		id: "dep_older",
		name: "Older twin",
		createdAt: "2026-07-14T00:00:00Z",
		environmentId: sharedEnvironmentId,
	});

	test("resolves a deployment from its stored environment identity", () => {
		const resolution = resolveAgentDeployment([newer], sharedEnvironmentId);

		expect(resolution.match?.deployment.resource.id).toBe("dep_newer");
		expect(resolution.match?.runtime).toBe("openclaw");
		expect(resolution.ambiguousMatches).toEqual([]);
	});

	test("detects every deployment sharing an environment instead of picking newest", () => {
		const resolution = resolveAgentDeployment([newer, older], sharedEnvironmentId);

		expect(resolution.match).toBeNull();
		expect(resolution.ambiguousMatches.map((match) => match.deployment.resource.id)).toEqual([
			"dep_newer",
			"dep_older",
		]);
	});

	test("prefers an explicit deployment selector within the environment matches", () => {
		const resolution = resolveAgentDeployment([newer, older], sharedEnvironmentId, "dep_older");

		expect(resolution.match?.deployment.resource.id).toBe("dep_older");
		expect(resolution.match?.runtime).toBe("openclaw");
		expect(resolution.ambiguousMatches).toEqual([]);
	});

	test("continues to resolve direct deployment-id routes", () => {
		const resolution = resolveAgentDeployment([newer, older], "dep_older", "dep_older");

		expect(resolution.match?.deployment.resource.id).toBe("dep_older");
		expect(resolution.match?.runtime).toBeNull();
		expect(resolution.ambiguousMatches).toEqual([]);
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

	test("keeps a failed deployment inactive when its joined environment is fresh", () => {
		const view = hostedRuntimeStatusView("failed", env({ last_seen_at: new Date().toISOString() }));

		expect(view.primary.label).toBe("Failed");
		expect(view.active).toBe(false);
	});

	test("keeps a stopped deployment inactive when its joined environment is fresh", () => {
		const view = hostedRuntimeStatusView(
			"stopped",
			env({ last_seen_at: new Date().toISOString() }),
		);

		expect(view.primary.label).toBe("Stopped");
		expect(view.active).toBe(false);
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
