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
	name?: string;
	status?: HostedDeploymentStatus["summary_state"];
	createdAt?: string;
	runtime?: HostedDeploymentSpec["runtime"];
	runtimeVersion?: string;
	desiredLifecycle?: HostedDeploymentSpec["desired_lifecycle"];
	runtimeConfiguration?: HostedRuntimeConfiguration;
	resources?: HostedDeploymentSpec["resources"];
	endpoints?: HostedDeploymentStatus["endpoints"];
	failure?: HostedDeploymentStatus["failure"];
	backingInfrastructure?: HostedDeploymentStatus["backing_infrastructure"];
	computeSubscription?: HostedComputeSubscription | null;
	fundingFact?: HostedFundingFact | null;
	occupiesSlot?: boolean;
	upgradeAvailable?: boolean;
	acceptedOperation?: HostedDeployment["accepted_operation"];
	cloudEnvironments?: HostedDeployment["clawdi_cloud_environments"];
	aiProviderAuthKinds?: HostedDeployment["ai_provider_auth_kinds"];
	runtimeUiEndpoint?: HostedDeployment["runtime_ui_endpoint"];
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

	return {
		resource: {
			id: options.id ?? "dep_test",
			owner_user_id: "usr_test",
			commercial_revision: 0,
			deployment_target: "saas",
			metadata: {
				generation: 1,
				manifestETag: "etag_test",
				resourceVersion: "rv_test",
				createdAt,
				updatedAt: createdAt,
			},
			spec: {
				schema_version: 1,
				desired_lifecycle: options.desiredLifecycle ?? "running",
				runtime,
				runtime_version: options.runtimeVersion ?? "latest",
				name: options.name ?? "Test deployment",
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
			status: {
				summary_state: options.status ?? "running",
				observedGeneration: 1,
				conditions: [],
				failure: options.failure,
				backing_infrastructure: backingInfrastructure,
				driver_acknowledged_generation: 1,
				driver_applied_generation: 1,
				driver_observation_sequence: 1,
				endpoints: options.endpoints ?? [],
			},
		},
		clawdi_cloud_environments: options.cloudEnvironments,
		ai_provider_auth_kinds: options.aiProviderAuthKinds ?? { [runtime]: "managed" },
		runtime_ui_endpoint: options.runtimeUiEndpoint,
		accepted_operation: options.acceptedOperation,
		commercial_display: {
			compute_subscription: options.computeSubscription ?? null,
			latest_funding_fact: options.fundingFact ?? null,
		},
		current_plan_slug: options.currentPlanSlug ?? "compute_basic",
		upgrade_available: options.upgradeAvailable ?? false,
		compute_slot_occupancy: {
			occupies_slot: occupiesSlot,
			backing_infra: backingInfrastructure,
			reason: occupiesSlot ? "backing_infra_present" : "authoritative_absence",
		},
	};
}
