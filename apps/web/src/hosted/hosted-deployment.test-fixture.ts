import type {
	HostedComputeSubscription,
	HostedDeployment,
	HostedDeploymentSpec,
	HostedDeploymentStatus,
	HostedFundingFact,
	HostedRuntimeConfiguration,
} from "@/hosted/billing/contracts";

type HostedDeploymentFixtureOptions = {
	id?: string;
	agentId?: string;
	name?: string;
	status?: HostedDeploymentStatus["summary_state"] | null;
	createdAt?: string;
	runtime?: HostedDeploymentSpec["runtime"];
	runtimeVersion?: string;
	resourceVersion?: string;
	desiredLifecycle?: HostedDeploymentSpec["desired_lifecycle"];
	runtimeConfiguration?: HostedRuntimeConfiguration;
	resources?: HostedDeploymentSpec["resources"];
	endpoints?: HostedDeploymentStatus["endpoints"];
	failure?: HostedDeploymentStatus["failure"];
	backingInfrastructure?: NonNullable<HostedDeployment["compute_slot_occupancy"]>["backing_infra"];
	computeSubscription?: HostedComputeSubscription | null;
	fundingFact?: HostedFundingFact | null;
	occupiesSlot?: boolean;
	computeSlotOccupancy?: HostedDeployment["compute_slot_occupancy"];
	upgradeAvailable?: boolean;
	upgradeEligibility?: HostedDeployment["upgrade_eligibility"];
	acceptedOperation?: HostedDeployment["accepted_operation"];
	startAction?: HostedDeployment["start_action"];
	recoveryAction?: NonNullable<HostedDeployment["commercial_display"]>["recovery_action"];
	cloudEnvironments?: HostedDeployment["clawdi_cloud_environments"];
	aiProviderAuthKinds?: HostedDeployment["ai_provider_auth_kinds"];
	runtimeUiEndpoint?: HostedDeployment["runtime_ui_endpoint"];
	filesEndpoint?: HostedDeployment["files_endpoint"];
	currentPlanSlug?: HostedDeployment["current_plan_slug"];
};

const DEFAULT_CREATED_AT = "2026-01-01T00:00:00Z";

export function hostedDeploymentFixture(
	options: HostedDeploymentFixtureOptions = {},
): HostedDeployment {
	const createdAt = options.createdAt ?? DEFAULT_CREATED_AT;
	const occupiesSlot = options.occupiesSlot ?? true;
	const backingInfrastructure =
		options.backingInfrastructure ?? (occupiesSlot ? "present" : "absent");
	const runtime = options.runtime ?? "openclaw";
	const upgradeAvailable = options.upgradeAvailable ?? false;

	return {
		agent_id: options.agentId ?? "11111111-1111-4111-8111-111111111111",
		resource: {
			id: options.id ?? "dep_test",
			name: options.name ?? "Test deployment",
			commercial_revision: 0,
			deployment_target: "saas",
			metadata: {
				generation: 1,
				manifestETag: "etag_test",
				resourceVersion: options.resourceVersion ?? "rv_test",
				createdAt,
				updatedAt: createdAt,
			},
			spec: {
				schema_version: 1,
				desired_lifecycle: options.desiredLifecycle ?? "running",
				runtime,
				runtime_version: options.runtimeVersion ?? "latest",
				resources: options.resources ?? { vcpu: 1, memory_mib: 1024, disk_gib: 10 },
				agents: [],
				ports: [],
				runtime_configuration: options.runtimeConfiguration ?? {
					providers: [],
					features: [],
				},
				rollout_nonce: 0,
				secret_references: [],
			},
			status:
				options.status === null
					? null
					: {
							summary_state: options.status ?? "running",
							observedGeneration: 1,
							conditions: [],
							failure: options.failure,
							driver_acknowledged_generation: 1,
							driver_applied_generation: 1,
							driver_observation_sequence: 1,
							endpoints: options.endpoints ?? [],
						},
		},
		clawdi_cloud_environments: options.cloudEnvironments,
		ai_provider_auth_kinds: options.aiProviderAuthKinds ?? { [runtime]: "managed" },
		runtime_ui_endpoint: options.runtimeUiEndpoint,
		files_endpoint: options.filesEndpoint,
		accepted_operation: options.acceptedOperation,
		start_action: options.startAction,
		commercial_display: {
			compute_subscription: options.computeSubscription ?? null,
			latest_funding_fact: options.fundingFact ?? null,
			recovery_action: options.recoveryAction,
		},
		current_plan_slug: options.currentPlanSlug ?? "compute_basic",
		upgrade_available: upgradeAvailable,
		upgrade_eligibility: options.upgradeEligibility ?? {
			eligible: upgradeAvailable,
			reason: null,
		},
		compute_slot_occupancy:
			options.computeSlotOccupancy === undefined
				? {
						occupies_slot: occupiesSlot,
						backing_infra: backingInfrastructure,
						reason: occupiesSlot ? "backing_infra_present" : "authoritative_absence",
					}
				: options.computeSlotOccupancy,
	};
}
