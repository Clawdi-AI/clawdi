import { beforeAll, describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { isValidElement } from "react";
import type {
	DeploymentOperation,
	HostedComputeSubscription,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";
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
	return getRuntimeStatusView(deployment.resource.status, environment);
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

function deployment(
	overrides: {
		id?: string;
		name?: string;
		status?: HostedDeploymentStatus["summary_state"] | null;
		createdAt?: string;
		runtime?: "openclaw" | "hermes";
		computeSubscription?: HostedComputeSubscription;
		computePlanSlug?: "compute_basic" | "compute_performance";
		failureReason?: string;
		failedVerb?: DeploymentOperationVerb;
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
		currentPlanSlug: overrides.computePlanSlug,
		failure: overrides.failureReason ? deploymentFailure(overrides.failureReason) : undefined,
		acceptedOperation: overrides.failedVerb ? acceptedOperation(overrides.failedVerb) : undefined,
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
		expect(tiles.map((tile) => tile.name)).toEqual(["hosted-test"]);
		expect(tiles[0]?.href).toBe(`/agents/${openclawEnv.id}?source=on-clawdi&d=dep_123`);
		expect(tiles[0]?.env).toBe(openclawEnv);
		expectHostedTileStatus(tiles[0], "Running");
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

		expectHostedTileStatus(tile, "Failed");
	});

	test("links by deployment env identity when the cloud-api projection is missing", () => {
		const failureReason = "startup_probe_failing; restart_count=2";
		const environmentId = "env-failed-openclaw";
		const hostedDeployment = deployment({ status: "failed", failureReason, environmentId });
		const [tile] = hostedDeploymentToTiles(hostedDeployment);

		expect(tile).toMatchObject({
			id: "dep_123",
			source: "on-clawdi",
			name: "hosted-test",
			href: `/agents/${environmentId}?source=on-clawdi&d=dep_123`,
			env: null,
		});
		expect(tile?.env).toBeNull();
		expectHostedTileStatus(tile, "Failed");
		expect(tile?.action).toBeDefined();
		expect(JSON.stringify(tile)).not.toContain("/agents/dep_123");
	});

	test("gives a failed plan change its own status and confirmed-flow remediation", () => {
		const environmentId = "env-failed-plan-change";
		const reason = "Top up your Wallet and retry the plan change.";
		const [tile] = hostedDeploymentToTiles(
			deployment({
				status: "failed",
				failureReason: reason,
				failedVerb: "plan_change",
				environmentId,
			}),
		);

		expectHostedTileStatus(tile, "Failed");
		expect(
			isValidElement<{ remediationHref?: string }>(tile?.action) &&
				tile.action.props.remediationHref,
		).toBe(`/agents/${environmentId}/settings?source=on-clawdi&d=dep_123#compute-plan-controls`);
	});

	test("keeps Start and Delete actions on a stopped tile with a retained env identity", () => {
		const environmentId = "env-stopped-openclaw";
		const [tile] = hostedDeploymentToTiles(
			deployment({
				name: "deployment-create-generated-id",
				status: "stopped",
				environmentId,
			}),
		);

		expect(tile).toMatchObject({
			name: "OpenClaw",
			href: `/agents/${environmentId}?source=on-clawdi&d=dep_123`,
		});
		expectHostedTileStatus(tile, "Stopped");
		expect(tile?.action).toBeDefined();
	});

	test("keeps non-running compute primary when the joined environment has fresh sync", () => {
		for (const [status, label] of [
			["stopped", "Stopped"],
			["failed", "Failed"],
			[null, "Status unavailable"],
		] as const) {
			const environmentId = `env-${status ?? "unknown"}-with-fresh-sync`;
			const joinedEnv = env({
				id: environmentId,
				last_seen_at: new Date().toISOString(),
				last_sync_at: new Date().toISOString(),
			});
			const [tile] = hostedDeploymentToTiles(deployment({ status, environmentId }), [joinedEnv]);

			expectHostedTileStatus(tile, label);
			expect(tile?.cardStatus?.labels).not.toContain("Live");
			expect(tile?.cardStatus?.visual.dotClass).not.toContain("bg-success");
		}
	});

	test("removes deleted deployments from tiles and detail membership", () => {
		const environmentId = "env-deleted-openclaw";
		const deleted = deployment({ status: "deleted", environmentId });

		expect(hostedDeploymentToTiles(deleted)).toEqual([]);
		expect(resolveAgentDeployment([deleted], environmentId).match).toBeNull();
	});

	test("removes an accepted delete from tiles before teardown completes", () => {
		const environmentId = "env-deleting-openclaw";
		const deleting = deployment({ status: "deleting", failedVerb: "delete", environmentId });

		expect(hostedDeploymentToTiles(deleting)).toEqual([]);
		expect(resolveAgentDeployment([deleting], environmentId).match).toBeNull();
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
			name: "hosted-test",
			href: null,
			env: null,
		});
		expectHostedTileStatus(tile, "Failed");
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

	test("shows failed deployment reason as secondary status", () => {
		const view = hostedRuntimeStatusView(
			"failed",
			null,
			" startup_probe_failing;   restart_count=2 ",
		);

		expect(view.primary.label).toBe("Failed");
		expect(view.secondary).toEqual({
			kind: "failure_reason",
			label: "Failure: The Clawdi service could not complete this request.",
			tooltip: "The Clawdi service could not complete this request.",
			textClass: "text-destructive-muted-foreground font-medium",
		});
	});
});
