import { beforeAll, describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import type {
	DeploymentOperation,
	HostedComputeSubscription,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";
import { deploymentFailurePresentation } from "@/hosted/deployment-failure";
import type { DeploymentOperationVerb } from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type DeploymentToTiles = typeof import("@/hosted/use-hosted-agent-tiles").deploymentToTiles;
type HostedRuntimeStatusView =
	typeof import("@/hosted/use-hosted-agent-tiles").hostedRuntimeStatusView;
type ResolveAgentDeployment =
	typeof import("@/hosted/agents/deployment-hooks").resolveAgentDeployment;
type Env = components["schemas"]["AgentResponse"];

let getDeploymentToTiles: DeploymentToTiles | null = null;
let getRuntimeStatusView: HostedRuntimeStatusView | null = null;
let getAgentDeploymentResolution: ResolveAgentDeployment | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/use-hosted-agent-tiles");
	getDeploymentToTiles = module.deploymentToTiles;
	getRuntimeStatusView = module.hostedRuntimeStatusView;
	const deploymentHooks = await import("@/hosted/agents/deployment-hooks");
	getAgentDeploymentResolution = deploymentHooks.resolveAgentDeployment;
});

function hostedRuntimeStatusView(
	rawStatus: HostedDeploymentStatus["summary_state"],
	environment: Env | null | undefined,
	failureReason?: string | null,
) {
	if (!getRuntimeStatusView) throw new Error("hostedRuntimeStatusView was not loaded");
	const deployment = hostedDeploymentFixture({
		status: rawStatus,
		failure: failureReason ? deploymentFailure(failureReason) : null,
	});
	return getRuntimeStatusView(
		deployment.resource.status,
		environment,
		deploymentFailurePresentation(deployment),
	);
}

function hostedDeploymentToTiles(deployment: HostedDeployment, envs: Env[] = []) {
	if (!getDeploymentToTiles) throw new Error("deploymentToTiles was not loaded");
	return getDeploymentToTiles(
		deployment,
		new Map(envs.map((item) => [item.id.toLowerCase(), item])),
	);
}

function expectHostedTileStatus(
	tile: ReturnType<DeploymentToTiles>[number] | undefined,
	label: string,
) {
	expect(tile).toBeDefined();
	expect(tile?.cardStatus?.visual.label).toBe(label);
	expect(tile?.cardStatus?.labels[0]).toBe(label);
	expect((tile as { action?: unknown } | undefined)?.action).toBeUndefined();
}

function resolveAgentDeployment(deployments: readonly HostedDeployment[], agentId: string) {
	if (!getAgentDeploymentResolution) throw new Error("resolveAgentDeployment was not loaded");
	return getAgentDeploymentResolution(deployments, agentId);
}

function env(overrides: Partial<Env> = {}): Env {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "hosted-openclaw",
		default_name: "hosted-openclaw",
		machine_id: "hosted-openclaw-machine",
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
		type: "https://api.clawdi.ai/problems/runtime-readiness-timeout",
		title: reason,
		status: 504,
		detail: "The runtime did not report ready before the startup deadline.",
		instance: "dep_123",
		code: "runtime_readiness_timeout",
		conditionReason: "RuntimeReadinessTimeout",
		conditionMessage: reason,
		observedGeneration: 1,
	};
}

function acceptedOperation(verb: DeploymentOperationVerb): DeploymentOperation {
	return {
		name: `operations/${verb}-failed`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "dep_123",
			verb: verb as DeploymentOperation["metadata"]["verb"],
			targetGeneration: 2,
			manifestETag: "manifest-failed",
			createTime: "2026-07-25T00:00:00Z",
			updateTime: "2026-07-25T00:01:00Z",
		},
		done: false,
		response: null,
	};
}

function failedOperation(verb: DeploymentOperationVerb): DeploymentOperation {
	return {
		...acceptedOperation(verb),
		done: true,
		error: {
			code: 13,
			message: "operation failed",
			details: [
				{
					"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
					type: "https://api.clawdi.ai/problems/operation-failed",
					title: "Operation failed",
					status: 500,
					detail: "Internal operation failure",
					code: "operation_failed",
					retryable: true,
					conditionReason: "OperationFailed",
					conditionMessage: "Internal operation failure",
					observedGeneration: 2,
				},
			],
		},
		response: null,
	};
}

function deployment(
	overrides: {
		id?: string;
		agentId?: string;
		name?: string;
		status?: HostedDeploymentStatus["summary_state"] | null;
		createdAt?: string;
		runtime?: "openclaw" | "hermes";
		computeSubscription?: HostedComputeSubscription;
		computePlanSlug?: "compute_basic" | "compute_performance";
		failureReason?: string;
		failedVerb?: DeploymentOperationVerb;
		environmentId?: string | null;
		filesEndpoint?: HostedDeployment["files_endpoint"];
	} = {},
): HostedDeployment {
	const id = overrides.id ?? "dep_123";
	const runtime = overrides.runtime ?? "openclaw";
	const environmentId = overrides.environmentId ?? `env_${id}_${runtime}`;
	return hostedDeploymentFixture({
		id,
		agentId: overrides.agentId,
		name: overrides.name ?? "hosted-test",
		status: overrides.status,
		createdAt: overrides.createdAt ?? "2026-06-22T00:00:00Z",
		runtime,
		cloudEnvironments: overrides.environmentId === null ? {} : { [runtime]: environmentId },
		computeSubscription: overrides.computeSubscription,
		currentPlanSlug: overrides.computePlanSlug,
		failure: overrides.failureReason ? deploymentFailure(overrides.failureReason) : undefined,
		acceptedOperation: overrides.failedVerb ? acceptedOperation(overrides.failedVerb) : undefined,
		filesEndpoint: overrides.filesEndpoint,
	});
}

describe("deploymentToTiles", () => {
	test("renders the runtime selected by the deployment spec", () => {
		const agentId = "11111111-1111-4111-8111-111111111111";
		const hostedDeployment = deployment({ runtime: "openclaw", agentId, environmentId: agentId });
		const openclawEnv = env({
			id: agentId,
			name: "hosted-openclaw",
			display_name: "Research Agent",
			default_name: "hosted-openclaw",
			machine_name: "hosted-openclaw",
			agent_type: "openclaw",
			last_seen_at: new Date().toISOString(),
		});
		const tiles = hostedDeploymentToTiles(hostedDeployment, [openclawEnv]);

		expect(tiles.map((tile) => tile.agentType)).toEqual(["openclaw"]);
		expect(tiles.map((tile) => tile.id)).toEqual([agentId]);
		expect(tiles.map((tile) => tile.name)).toEqual(["Research Agent"]);
		expect(tiles[0]?.href).toBe(`/agents/${agentId}`);
		expect(tiles[0]?.env).toBe(openclawEnv);
		expect(tiles[0]?.filesAvailable).toBe(false);
		expectHostedTileStatus(tiles[0], "Running");
	});

	test("projects Files eligibility only from the authoritative endpoint", () => {
		const [eligible] = hostedDeploymentToTiles(
			deployment({ filesEndpoint: { url: "https://agent-9120.node.clawdi.ai/" } }),
		);
		const [malformed] = hostedDeploymentToTiles(
			deployment({ filesEndpoint: { url: "http://agent-9120.node.clawdi.ai/" } }),
		);

		expect(eligible?.filesAvailable).toBe(true);
		expect(malformed?.filesAvailable).toBe(false);
	});

	test("keeps dunning state off the hosted tile", () => {
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

		expectHostedTileStatus(tile, "Running");
	});

	test("keeps backend failure detail off the hosted tile", () => {
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

		expectHostedTileStatus(tile, "Temporarily unavailable");
		expect(tile?.cardStatus?.visual.dotClass).toContain("bg-warning");
		expect(tile?.cardStatus?.labels).toEqual(["Temporarily unavailable"]);
	});

	test("links by authoritative Agent identity when the Cloud projection is missing", () => {
		const failureReason = "startup_probe_failing; restart_count=2";
		const agentId = "22222222-2222-4222-8222-222222222222";
		const hostedDeployment = deployment({
			status: "failed",
			failureReason,
			agentId,
			environmentId: null,
		});
		const [tile] = hostedDeploymentToTiles(hostedDeployment);

		expect(tile).toMatchObject({
			id: agentId,
			source: "on-clawdi",
			name: "hosted-test",
			href: `/agents/${agentId}`,
			env: null,
		});
		expect(tile?.env).toBeNull();
		expectHostedTileStatus(tile, "Temporarily unavailable");
		expect(JSON.stringify(tile)).not.toContain("/agents/dep_123");
	});

	test("does not flash pending sync while the environment join is unresolved", () => {
		const [tile] = hostedDeploymentToTiles(
			deployment({ status: "running", environmentId: "env-lagging-join" }),
		);

		expect(tile?.env).toBeNull();
		expect(tile?.cardStatus?.labels).toEqual(["Running"]);
	});

	test("keeps a failed plan change on a summary-only tile", () => {
		const reason = "Top up your Wallet and retry the plan change.";
		const planFailure = deployment({ status: "failed" });
		if (!planFailure.resource.status) throw new Error("Expected deployment status");
		planFailure.resource.status.failure = {
			...deploymentFailure(reason),
			code: "operation_aborted",
			phase: "plan_change",
		};
		const [tile] = hostedDeploymentToTiles(planFailure);

		expectHostedTileStatus(tile, "Failed");
		expect(tile?.href).toBe(`/agents/${planFailure.agent_id}`);
	});

	test("keeps the exact name, stopped status, and navigation on a summary-only tile", () => {
		const stopped = deployment({
			name: "deployment-create-generated-id",
			status: "stopped",
			environmentId: null,
		});
		const [tile] = hostedDeploymentToTiles(stopped);

		expect(tile).toMatchObject({
			name: "deployment-create-generated-id",
			href: `/agents/${stopped.agent_id}`,
		});
		expectHostedTileStatus(tile, "Stopped");
	});

	test("never projects card actions for any deployment lifecycle state", () => {
		const lifecycleStates = [
			"creating",
			"starting",
			"running",
			"stopping",
			"stopped",
			"restarting",
			"updating",
			"deleting",
			"deleted",
			"failed",
			null,
		] satisfies readonly (HostedDeploymentStatus["summary_state"] | null)[];

		for (const status of lifecycleStates) {
			const tiles = hostedDeploymentToTiles(deployment({ status }));
			if (status === "deleting" || status === "deleted") {
				expect(tiles).toEqual([]);
				continue;
			}
			expect((tiles[0] as { action?: unknown } | undefined)?.action).toBeUndefined();
		}
	});

	test("keeps non-running compute primary when the joined environment has fresh sync", () => {
		for (const [status, label] of [
			["stopped", "Stopped"],
			["failed", "Failed"],
			[null, "Status unavailable"],
		] as const) {
			const joinedEnv = env({
				last_seen_at: new Date().toISOString(),
				last_sync_at: new Date().toISOString(),
			});
			const [tile] = hostedDeploymentToTiles(
				deployment({ status, agentId: joinedEnv.id, environmentId: joinedEnv.id }),
				[joinedEnv],
			);

			expectHostedTileStatus(tile, label);
			expect(tile?.cardStatus?.labels).not.toContain("Live");
			expect(tile?.cardStatus?.visual.dotClass).not.toContain("bg-success");
		}
	});

	test("removes deleted deployments from tiles and detail membership", () => {
		const deleted = deployment({ status: "deleted" });

		expect(hostedDeploymentToTiles(deleted)).toEqual([]);
		expect(resolveAgentDeployment([deleted], deleted.agent_id)).toBeNull();
	});

	test("removes an accepted delete from tiles before teardown completes", () => {
		const deleting = deployment({ status: "deleting", failedVerb: "delete" });

		expect(hostedDeploymentToTiles(deleting)).toEqual([]);
		expect(resolveAgentDeployment([deleting], deleting.agent_id)).toBeNull();
	});

	test("keeps a provisioning deployment navigable before projection exists", () => {
		const agentId = "33333333-3333-4333-8333-333333333333";
		const hostedDeployment = deployment({
			status: "failed",
			failureReason: "creation_interrupted",
			agentId,
			environmentId: null,
		});
		const [tile] = hostedDeploymentToTiles(hostedDeployment);

		expect(tile).toMatchObject({
			id: agentId,
			name: "hosted-test",
			href: `/agents/${agentId}`,
			env: null,
		});
		expectHostedTileStatus(tile, "Temporarily unavailable");
	});
});

describe("resolveAgentDeployment", () => {
	const sharedProjectionId = "77777777-7777-4777-8777-777777777777";
	const newer = deployment({
		id: "dep_newer",
		agentId: "44444444-4444-4444-8444-444444444444",
		name: "Newer twin",
		createdAt: "2026-07-15T00:00:00Z",
		environmentId: sharedProjectionId,
	});
	const older = deployment({
		id: "dep_older",
		agentId: "55555555-5555-4555-8555-555555555555",
		name: "Older twin",
		createdAt: "2026-07-14T00:00:00Z",
		environmentId: sharedProjectionId,
	});

	test("resolves only authoritative Agent ids despite a shared observed projection", () => {
		expect(resolveAgentDeployment([newer, older], newer.agent_id)?.deployment).toBe(newer);
		expect(resolveAgentDeployment([newer, older], older.agent_id)?.deployment).toBe(older);
		expect(resolveAgentDeployment([newer, older], sharedProjectionId)).toBeNull();
		expect(resolveAgentDeployment([newer, older], older.resource.id)).toBeNull();
	});
});

describe("hostedRuntimeStatusView", () => {
	test("renders unavailable status without treating fresh sync as healthy", () => {
		if (!getRuntimeStatusView) throw new Error("hostedRuntimeStatusView was not loaded");
		const view = getRuntimeStatusView(null, env({ last_seen_at: new Date().toISOString() }));

		expect(view.primary).toMatchObject({ label: "Status unavailable", tone: "warning" });
		expect(view.active).toBe(false);
		expect(view.sync?.kind).toBe("live");
		expect(view.secondary).toBeNull();
	});

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

	test("shows current runtime health degradation as a warning while staying active", () => {
		if (!getRuntimeStatusView) throw new Error("hostedRuntimeStatusView was not loaded");
		const deployment = hostedDeploymentFixture({ status: "running" });
		const status = deployment.resource.status;
		if (!status) throw new Error("Expected fixture status");
		const view = getRuntimeStatusView(
			{
				...status,
				conditions: [
					{
						type: "Degraded",
						status: "True",
						observedGeneration: status.observedGeneration,
						lastTransitionTime: "2026-08-02T12:00:00Z",
						reason: "RuntimeHealthDegraded",
						message: "Fresh runtime health is temporarily unavailable",
					},
				],
			},
			env(),
		);

		expect(view.primary).toMatchObject({ label: "Temporarily unavailable", tone: "warning" });
		expect(view.active).toBe(true);
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
		expect(creating.primary.label).toBe("Starting");
		expect(creating.secondary).toBeNull();
	});

	test("shows a safe runtime failure summary without exposing internal details", () => {
		const view = hostedRuntimeStatusView(
			"failed",
			null,
			" startup_probe_failing;   restart_count=2 ",
		);

		expect(view.primary).toMatchObject({ label: "Temporarily unavailable", tone: "warning" });
		expect(view.secondary).toBeNull();
	});

	test("keeps a terminal operation failure destructive", () => {
		if (!getRuntimeStatusView) throw new Error("hostedRuntimeStatusView was not loaded");
		const deployment = hostedDeploymentFixture({
			status: "failed",
			acceptedOperation: failedOperation("restart"),
		});
		const view = getRuntimeStatusView(
			deployment.resource.status,
			null,
			deploymentFailurePresentation(deployment),
		);

		expect(view.primary).toMatchObject({ label: "Failed", tone: "destructive" });
		expect(view.secondary?.label).toBe("Agent restart failed");
	});
});
