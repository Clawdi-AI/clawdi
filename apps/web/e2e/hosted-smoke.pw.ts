import type { DeploymentRead } from "@clawdi/shared/api";
import { expect, type Page, type Route, test } from "@playwright/test";

// HOSTED (Clawdi Cloud) smoke against the vite dev server with dev-auth-bypass
// (NO Clerk key needed) + deploy-api enabled so /deploy renders. Exercises the
// deploy wizard's Base UI Select asserting ZERO browser console/page errors.
//
// IMPORTANT: stub by API HOST, never with broad "**/v2/**" globs — the app's
// own modules live under /src/hosted/v2/... and a path glob would intercept
// them and break module loading.

function hostedUser(canUsePlanCBilling = true) {
	return {
		capabilities: {
			can_use_v1: false,
			can_use_v2: true,
			can_use_plan_c_billing: canUsePlanCBilling,
		},
	};
}
const emptyPage = { items: [], total: 0, page: 1, page_size: 25 };

// Must match the API hosts configured in playwright.hosted.config.ts.
const CLOUD_API = "http://127.0.0.1:8000";
const DEPLOY_API = "http://127.0.0.1:8001";

type DeploymentComputeSubscription = NonNullable<
	NonNullable<DeploymentRead["commercial_display"]>["compute_subscription"]
>;

type DeploymentMutationFixture = {
	id: string;
	user_id: string;
	name: string;
	app_id: string;
	status: string;
	created_at: string;
	upgrade_available: boolean;
	compute_subscription: DeploymentComputeSubscription | null;
	config_info: {
		compute_plan_slug: string;
		runtime: "openclaw" | "hermes";
		ai_provider_auth_kind: "unmanaged" | "managed" | "api_key" | "codex_oauth";
		ai_provider_bindings?: Record<string, { auth_kind?: string | null }>;
		clawdi_cloud_environments?: Record<string, string>;
		mux_enabled?: boolean;
		telegram_mux_enabled?: boolean;
		discord_mux_enabled?: boolean;
		whatsapp_mux_enabled?: boolean;
		imessage_mux_enabled?: boolean;
		kobb_available?: boolean;
		public_ports?: number[];
	};
	endpoints?: string[];
	failure_reason?: string | null;
	hermes_control_ui_url?: string | null;
	openclaw_control_ui_url?: string | null;
	last_funding_event?: {
		funding_source: "stripe" | "wallet";
		reason: "payment_failure" | "canceled" | "refunded" | "disputed" | "admin_forced";
		prior_plan_slug: string;
		occurred_at: string;
		subscription_id: number;
	} | null;
};

const basicPlan = {
	slug: "compute_basic",
	name: "Compute Basic",
	price_cents: 900,
	points_per_usd: 100,
	signup_grant_credits: 500,
	subscription_grant_credits: 0,
	vcpu: 2,
	ram_gb: 4,
	disk_size: 20,
	instance_type: null,
	offers: [
		{
			billing_term_months: 1,
			price_cents: 900,
			effective_monthly_price_cents: 900,
			discount_percent: 0,
		},
		{
			billing_term_months: 12,
			price_cents: 8_640,
			effective_monthly_price_cents: 720,
			discount_percent: 20,
		},
	],
};

const performancePlan = {
	slug: "compute_performance",
	name: "Compute Performance",
	price_cents: 1_900,
	points_per_usd: 100,
	signup_grant_credits: 500,
	subscription_grant_credits: 500,
	vcpu: 4,
	ram_gb: 8,
	disk_size: 40,
	instance_type: "tdx.large",
	offers: [
		{
			billing_term_months: 1,
			price_cents: 1_900,
			effective_monthly_price_cents: 1_900,
			discount_percent: 0,
		},
		{
			billing_term_months: 12,
			price_cents: 18_000,
			effective_monthly_price_cents: 1_500,
			discount_percent: 21,
		},
	],
};

const includedBasicDeployment: DeploymentMutationFixture = {
	id: "hdep_included",
	user_id: "usr_browser",
	name: "Included Basic",
	app_id: "v2-browser",
	status: "running",
	created_at: "2026-07-15T00:00:00Z",
	upgrade_available: true,
	compute_subscription: {
		subscription_id: 7,
		status: "active",
		funding_source: null,
		payment_state: "ok",
		billing_term_months: 1,
		price_cents: 0,
		currency: "usd",
		cancel_at_period_end: false,
		current_period_end: "2026-08-15T00:00:00Z",
	},
	config_info: {
		compute_plan_slug: "compute_basic",
		mux_enabled: false,
		telegram_mux_enabled: false,
		discord_mux_enabled: false,
		whatsapp_mux_enabled: false,
		imessage_mux_enabled: false,
		kobb_available: false,
		ai_provider_auth_kind: "managed",
		runtime: "hermes",
		clawdi_cloud_environments: {},
		ai_provider_bindings: {},
		public_ports: [],
	},
};

const paidBasicDeployment = {
	...includedBasicDeployment,
	id: "hdep_paid",
	name: "Paid Basic",
	compute_subscription: {
		subscription_id: 42,
		status: "active",
		funding_source: "stripe",
		payment_state: "ok",
		billing_term_months: 12,
		price_cents: 8_640,
		currency: "usd",
		cancel_at_period_end: false,
		current_period_end: "2027-07-15T00:00:00Z",
	},
};

const performanceDeployment = {
	...paidBasicDeployment,
	id: "hdep_performance",
	name: "Performance agent",
	compute_subscription: {
		...paidBasicDeployment.compute_subscription,
		price_cents: 18_000,
	},
	config_info: {
		...paidBasicDeployment.config_info,
		compute_plan_slug: "compute_performance",
	},
};

const stoppedIncludedBasicDeployment = {
	...includedBasicDeployment,
	id: "hdep_stopped",
	name: "Stopped Basic",
	status: "stopped",
};

const missingProjectionEnvironmentId = "55555555-5555-4555-8555-555555555555";
const missingProjectionFailureReason =
	"startup_probe_failing; restart_count=2; container failed readiness probe after the runtime bridge exhausted every startup attempt";
const failedMissingProjectionDeployment = {
	...includedBasicDeployment,
	id: "hdep_failed_projection",
	name: "Failed projection agent",
	status: "failed",
	failure_reason: missingProjectionFailureReason,
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: missingProjectionEnvironmentId },
	},
};

const runningMissingProjectionDeployment = {
	...includedBasicDeployment,
	id: "hdep_running_projection",
	name: "Running projection agent",
	hermes_control_ui_url: "https://runtime.example/hermes",
	runtime_ui_endpoint: {
		runtime: "hermes",
		role: "control_ui",
		url: "https://runtime.example/hermes",
		auth_mode: "password",
		browser_mode: "top_level",
	},
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: missingProjectionEnvironmentId },
	},
};

const openClawNativeEnvironmentId = "88888888-8888-4888-8888-888888888888";
const runningOpenClawNativeDeployment = {
	...includedBasicDeployment,
	id: "hdep_openclaw_native",
	name: "OpenClaw native auth agent",
	runtime_ui_endpoint: {
		runtime: "openclaw",
		role: "control_ui",
		url: "https://runtime.example/openclaw/",
		auth_mode: "openclaw_device",
		browser_mode: "top_level",
	},
	config_info: {
		...includedBasicDeployment.config_info,
		runtime: "openclaw",
		clawdi_cloud_environments: { openclaw: openClawNativeEnvironmentId },
	},
};

function runtimeUiDeploymentRead(input: {
	id: string;
	name: string;
	runtime: "openclaw" | "hermes";
	environmentId: string;
	endpoint: Record<string, unknown>;
}) {
	return {
		resource: {
			id: input.id,
			owner_user_id: "usr_browser",
			deploy_request_id: null,
			deployment_target: "v2-browser",
			metadata: {
				generation: 1,
				manifestETag: '"runtime-ui-e2e"',
				resourceVersion: "1",
				createdAt: "2026-07-15T00:00:00Z",
				updatedAt: "2026-07-15T00:00:00Z",
			},
			spec: {
				schema_version: 1,
				desired_lifecycle: "running",
				runtime: input.runtime,
				runtime_version: "test",
				name: input.name,
				resources: { vcpu: 2, memory_mib: 4096, disk_gib: 20 },
				agents: [],
				ports: [],
				runtime_configuration: { providers: [], primary_model: null },
				rollout_nonce: 0,
				secret_references: [],
			},
			status: {
				summary_state: "running",
				observedGeneration: 1,
				conditions: [],
				failure: null,
				backing_infrastructure: "present",
				driver_acknowledged_generation: 1,
				driver_applied_generation: 1,
				endpoints: [],
			},
		},
		current_plan_slug: "compute_basic",
		ai_provider_auth_kinds: { [input.runtime]: "managed" },
		clawdi_cloud_environments: { [input.runtime]: input.environmentId },
		commercial_display: null,
		upgrade_available: false,
		runtime_ui_endpoint: input.endpoint,
	};
}

const retainedProjectionEnvironmentId = "66666666-6666-4666-8666-666666666666";
const retainedProjectionFailureReason =
	"startup_probe_failing; restart_count=4; runtime daemon exited and is no longer reachable";
const failedRetainedProjectionDeployment = {
	...includedBasicDeployment,
	id: "hdep_failed_retained_projection",
	name: "Failed retained projection agent",
	status: "failed",
	failure_reason: retainedProjectionFailureReason,
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: retainedProjectionEnvironmentId },
	},
};

const sharedLegacyEnvironmentId = "77777777-7777-4777-8777-777777777777";
const newerSharedEnvironmentDeployment = {
	...includedBasicDeployment,
	id: "hdep_shared_newer",
	name: "Newer twin",
	created_at: "2026-07-15T00:00:00Z",
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: sharedLegacyEnvironmentId },
	},
};
const olderSharedEnvironmentDeployment = {
	...newerSharedEnvironmentDeployment,
	id: "hdep_shared_older",
	name: "Older twin",
	status: "stopped",
	created_at: "2026-07-14T00:00:00Z",
};
const sharedLegacyCloudAgent = {
	id: sharedLegacyEnvironmentId,
	name: "shared-legacy-agent",
	default_name: "shared-legacy-agent",
	machine_name: "shared-legacy-agent",
	display_name: null,
	avatar_url: null,
	sort_order: 0,
	agent_type: "hermes",
	agent_version: "1.0.0",
	os: "linux",
	last_seen_at: "2026-07-15T00:00:00Z",
	last_sync_at: "2026-07-15T00:00:00Z",
	last_sync_error: null,
	last_revision_seen: 1,
	queue_depth_high_water: 0,
	dropped_count: 0,
	sync_enabled: true,
	explicit_identity: true,
	default_project_id: "project-hosted",
};

const interruptedIdentitylessDeployment = {
	...includedBasicDeployment,
	id: "hdep_creation_interrupted",
	name: "Interrupted deployment",
	status: "failed",
	failure_reason: "creation_interrupted",
};

const walletState = {
	balance_credits: 25_000,
	overdraft_credits: 0,
	balance_snapshot_at: "2026-07-15T00:00:00Z",
	payment_mode: "card",
	x402_enabled: false,
	auto_reload_enabled: false,
	auto_reload_threshold_credits: 5_000,
	auto_reload_amount_cents: 2_500,
	auto_reload_monthly_cap_cents: 10_000,
	auto_reload_action: null,
	points_per_usd: 1_000,
};

const walletActiveDeployment = {
	...paidBasicDeployment,
	id: "hdep_wallet_due",
	name: "Wallet-funded Basic",
	compute_subscription: {
		subscription_id: 42,
		status: "active",
		funding_source: "wallet",
		payment_state: "ok",
		billing_term_months: 1,
		price_cents: 900,
		currency: "usd",
		cancel_at_period_end: false,
		current_period_end: "2026-08-15T00:00:00Z",
	},
};

const walletPastDueDeployment = {
	...walletActiveDeployment,
	compute_subscription: {
		...walletActiveDeployment.compute_subscription,
		status: "past_due",
		payment_state: "past_due",
		latest_failed_invoice_id: "in_wallet_open",
		next_payment_attempt_at: "2026-07-16T00:00:00Z",
	},
};

const cardPastDueDeployment = {
	...paidBasicDeployment,
	id: "hdep_card_due",
	name: "Card-funded Basic",
	compute_subscription: {
		...paidBasicDeployment.compute_subscription,
		status: "past_due",
		payment_state: "past_due",
		latest_failed_invoice_id: "in_card_open",
		latest_failed_invoice_hosted_url: null,
		next_payment_attempt_at: "2026-07-16T00:00:00Z",
	},
};

const terminalFallbackDeployment = {
	...includedBasicDeployment,
	id: "hdep_terminal_fallback",
	name: "Fallback Basic",
	upgrade_available: false,
	compute_subscription: { ...includedBasicDeployment.compute_subscription },
	last_funding_event: {
		type: "compute_subscription_fallback",
		funding_source: "stripe",
		reason: "payment_failure",
		prior_plan_slug: "compute_performance",
		occurred_at: "2026-07-16T00:00:00Z",
		subscription_id: 42,
	},
};

const cancelPendingBasicDeployment = {
	...paidBasicDeployment,
	id: "hdep_cancel_pending",
	name: "Cancel-pending Basic",
	compute_subscription: {
		...paidBasicDeployment.compute_subscription,
		cancel_at_period_end: true,
		cancel_at: "2027-07-15T00:00:00Z",
	},
};

const walletAnnualDeployment = {
	...paidBasicDeployment,
	id: "hdep_wallet_created",
	name: "Annual Wallet Basic",
	compute_subscription: {
		...walletActiveDeployment.compute_subscription,
		billing_term_months: 12,
		price_cents: 8_640,
		current_period_end: "2027-07-15T00:00:00Z",
	},
};

function walletSubscriptionQuote({
	planSlug,
	billingTermMonths,
	termPriceCents,
	exactDebitCredits,
	balanceBeforeCredits,
	balanceAfterCredits,
}: {
	planSlug: "compute_basic" | "compute_performance";
	billingTermMonths: 1 | 12;
	termPriceCents: number;
	exactDebitCredits: string;
	balanceBeforeCredits: string;
	balanceAfterCredits: string;
}) {
	return {
		plan_slug: planSlug,
		billing_term_months: billingTermMonths,
		funding_source: "wallet",
		currency: "usd",
		term_price_cents: termPriceCents,
		preview_invoice_id: `upcoming_${planSlug}_${billingTermMonths}`,
		expires_at: "2026-07-16T00:15:00Z",
		debit_credits: exactDebitCredits,
		points_per_usd: 1_000,
		balance_before_credits: balanceBeforeCredits,
		balance_after_credits: balanceAfterCredits,
	};
}

function planChangeQuoteResponse({
	operationId,
	subscriptionId,
	fundingSource,
	currentPlanSlug,
	targetPlanSlug,
	currentBillingTermMonths,
	targetBillingTermMonths,
	changeKind,
	effectiveAt,
	amountCents,
	amountCredits,
}: {
	operationId: string;
	subscriptionId: number;
	fundingSource: "stripe" | "wallet";
	currentPlanSlug: "compute_basic" | "compute_performance";
	targetPlanSlug: "compute_basic" | "compute_performance";
	currentBillingTermMonths: 1 | 12;
	targetBillingTermMonths: 1 | 12;
	changeKind: "immediate_upgrade" | "scheduled_downgrade";
	effectiveAt: string;
	amountCents: number;
	amountCredits: string | null;
}) {
	return {
		operation_id: operationId,
		subscription_id: subscriptionId,
		funding_source: fundingSource,
		current_plan_slug: currentPlanSlug,
		target_plan_slug: targetPlanSlug,
		current_billing_term_months: currentBillingTermMonths,
		target_billing_term_months: targetBillingTermMonths,
		change_kind: changeKind,
		status: "quoted",
		effective_at: effectiveAt,
		proration_date: "2026-07-16T00:00:00Z",
		expires_at: "2026-07-16T00:15:00Z",
		amount_cents: amountCents,
		amount_credits: amountCredits,
		points_per_usd: fundingSource === "wallet" ? 1_000 : null,
		currency: "usd",
		stripe_invoice_preview_id: "in_preview_browser",
	};
}

function planChangeResponse({
	operationId,
	subscriptionId,
	fundingSource,
	currentPlanSlug,
	targetPlanSlug,
	targetBillingTermMonths,
	status,
	effectiveAt,
}: {
	operationId: string;
	subscriptionId: number;
	fundingSource: "stripe" | "wallet";
	currentPlanSlug: "compute_basic" | "compute_performance";
	targetPlanSlug: "compute_basic" | "compute_performance";
	targetBillingTermMonths: 1 | 12;
	status: "awaiting_payment" | "awaiting_projection" | "scheduled" | "complete";
	effectiveAt: string;
}) {
	return {
		operation_id: operationId,
		subscription_id: subscriptionId,
		funding_source: fundingSource,
		current_plan_slug: currentPlanSlug,
		target_plan_slug: targetPlanSlug,
		target_billing_term_months: targetBillingTermMonths,
		status,
		effective_at: effectiveAt,
		funding_invoice_id: status === "scheduled" ? null : "in_plan_browser",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeploymentMutationFixture(value: unknown): value is DeploymentMutationFixture {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.user_id === "string" &&
		typeof value.name === "string" &&
		typeof value.app_id === "string" &&
		typeof value.status === "string" &&
		typeof value.created_at === "string" &&
		isRecord(value.config_info) &&
		typeof value.config_info.compute_plan_slug === "string" &&
		(value.config_info.runtime === "openclaw" || value.config_info.runtime === "hermes")
	);
}

function readSummaryState(status: string): DeploymentRead["resource"]["status"]["summary_state"] {
	switch (status) {
		case "creating":
		case "starting":
		case "running":
		case "stopping":
		case "stopped":
		case "restarting":
		case "updating":
		case "deleting":
		case "deleted":
		case "failed":
			return status;
		case "provisioning":
			return "creating";
		case "ready":
			return "running";
		default:
			throw new Error(`Unsupported deployment fixture status: ${status}`);
	}
}

function readProviderAuthKind(
	value: string | null | undefined,
): DeploymentRead["ai_provider_auth_kinds"][string] {
	switch (value) {
		case "unmanaged":
		case "managed":
		case "api_key":
		case "codex_oauth":
			return value;
		default:
			throw new Error(`Unsupported deployment fixture provider mode: ${value ?? "missing"}`);
	}
}

function mutationDeploymentReadFixture(deployment: DeploymentMutationFixture): DeploymentRead {
	const config = deployment.config_info;
	const runtime = config.runtime;
	if (runtime !== "openclaw" && runtime !== "hermes") {
		throw new Error(`Unsupported deployment fixture runtime: ${runtime}`);
	}
	const summaryState = readSummaryState(deployment.status);
	const backingInfrastructure =
		summaryState === "stopped" || summaryState === "deleted" ? "absent" : "present";
	const runtimeBinding = config.ai_provider_bindings?.[runtime];
	const providerAuthKind = readProviderAuthKind(
		runtimeBinding?.auth_kind ?? config.ai_provider_auth_kind,
	);
	const runtimeUiUrl =
		runtime === "openclaw" ? deployment.openclaw_control_ui_url : deployment.hermes_control_ui_url;
	const failure = deployment.failure_reason
		? {
				type: "https://api.clawdi.ai/problems/runtime-readiness-timeout",
				title: deployment.failure_reason,
				status: 504,
				detail: "The runtime did not become ready before the startup deadline.",
				instance: deployment.id,
				code: "runtime_readiness_timeout",
				phase: "readiness",
				retryable: true,
				conditionReason: "RuntimeReadinessTimeout",
				conditionMessage: deployment.failure_reason,
				observedGeneration: 1,
			}
		: null;
	const fundingFact = deployment.last_funding_event
		? {
				fact_kind: "funding_revoked" as const,
				commercial_revision: 1,
				compute_subscription_id: deployment.last_funding_event.subscription_id,
				compute_plan_slug: null,
				funding_source: deployment.last_funding_event.funding_source,
				reason: deployment.last_funding_event.reason,
				prior_plan_slug: deployment.last_funding_event.prior_plan_slug,
				occurred_at: deployment.last_funding_event.occurred_at,
				emitted_at: deployment.last_funding_event.occurred_at,
			}
		: null;

	return {
		resource: {
			id: deployment.id,
			owner_user_id: deployment.user_id,
			commercial_revision: 1,
			deployment_target: "saas",
			metadata: {
				generation: 1,
				manifestETag: `etag_${deployment.id}`,
				resourceVersion: `rv_${deployment.id}`,
				createdAt: deployment.created_at,
				updatedAt: deployment.created_at,
			},
			spec: {
				schema_version: 1,
				desired_lifecycle:
					summaryState === "stopped"
						? "stopped"
						: summaryState === "deleted"
							? "deleted"
							: "running",
				runtime,
				runtime_version: "latest",
				name: deployment.name,
				resources: {
					vcpu: config.compute_plan_slug === "compute_performance" ? 4 : 2,
					memory_mib: config.compute_plan_slug === "compute_performance" ? 8192 : 4096,
					disk_gib: config.compute_plan_slug === "compute_performance" ? 40 : 20,
				},
				agents: [],
				ports: [],
				runtime_configuration: { providers: [], features: [] },
				rollout_nonce: 0,
				secret_references: [],
			},
			status: {
				summary_state: summaryState,
				observedGeneration: 1,
				conditions: [],
				failure,
				backing_infrastructure: backingInfrastructure,
				driver_acknowledged_generation: 1,
				driver_applied_generation: 1,
				driver_observation_sequence: 1,
				endpoints: (deployment.endpoints ?? []).map((url, index) => ({
					name: `endpoint-${index + 1}`,
					url,
				})),
			},
		},
		clawdi_cloud_environments: config.clawdi_cloud_environments ?? {},
		ai_provider_auth_kinds: { [runtime]: providerAuthKind },
		runtime_ui_endpoint: runtimeUiUrl
			? { runtime, role: "control_ui", url: runtimeUiUrl, requires_bridge_token: true }
			: null,
		accepted_operation: null,
		commercial_display: {
			compute_subscription: deployment.compute_subscription ?? null,
			latest_funding_fact: fundingFact,
		},
		current_plan_slug: config.compute_plan_slug,
		upgrade_available: deployment.upgrade_available,
		compute_slot_occupancy: {
			occupies_slot: backingInfrastructure === "present",
			backing_infra: backingInfrastructure,
			reason:
				backingInfrastructure === "present" ? "backing_infra_present" : "authoritative_absence",
		},
	};
}

function completedDeploymentOperation(
	deployment: DeploymentMutationFixture,
	verb: "create" | "start" | "stop" | "restart" | "delete",
) {
	const resource = mutationDeploymentReadFixture(deployment).resource;
	return {
		name: `operations/e2e-${verb}-${resource.id}`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: resource.id,
			verb,
			targetGeneration: resource.metadata.generation + 1,
			manifestETag: resource.metadata.manifestETag,
			createTime: resource.metadata.updatedAt,
			updateTime: resource.metadata.updatedAt,
		},
		done: true,
		response: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
			deployment: resource,
		},
	};
}

function readDeploymentFixture(value: unknown): unknown {
	return isDeploymentMutationFixture(value) ? mutationDeploymentReadFixture(value) : value;
}

type StubResponse = { body: unknown; status: number; delayMs?: number };

function isStubResponse(value: unknown): value is StubResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"body" in value &&
		"status" in value &&
		typeof value.status === "number"
	);
}

type HostedApiStubOptions = {
	autoReloadRequests?: string[];
	autoReloadResponses?: StubResponse[];
	billingHistoryRequests?: string[];
	billingHistoryResponses?: unknown[];
	canUsePlanCBilling?: boolean;
	planBillingCapability?: { enabled: boolean };
	productAccessRequests?: string[];
	cancelRequests?: string[];
	checkoutRequests?: string[];
	checkoutResponses?: StubResponse[];
	cloudAgentOverrides?: Record<string, unknown>;
	cloudAgents?: readonly unknown[];
	cloudAgentsResponse?: StubResponse;
	cloudAgentErrors?: Record<string, { detail: string; status: number }>;
	cloudAgentNotFoundIds?: readonly string[];
	cloudAgentResponses?: Record<string, StubResponse[]>;
	deleteRequests?: string[];
	deployments?: readonly unknown[];
	deploymentsResponse?: StubResponse;
	fixPaymentRequests?: string[];
	ledgerResponseForRequest?: (limit: number) => unknown;
	ledgerRequests?: string[];
	ledgerResponses?: unknown[];
	plans?: readonly unknown[];
	planCMutationRequests?: string[];
	planChangeRequests?: string[];
	planChangeResponses?: unknown[];
	planQuoteRequests?: string[];
	planQuoteResponses?: unknown[];
	restartRequests?: string[];
	runtimeUiCredentials?: Record<string, unknown>;
	resumeRequests?: string[];
	subscriptionQuoteRequests?: string[];
	subscriptionQuoteResponses?: unknown[];
	startError?: { status: number; detail: string };
	startRequests?: string[];
	topUpIdempotencyKeys?: string[];
	topUpRequests?: string[];
	topUpResponses?: StubResponse[];
	walletState?: typeof walletState;
	onTopUpSuccess?: () => void;
	onWalletCheckoutSuccess?: () => void;
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubHostedApi(page: Page, options: HostedApiStubOptions = {}) {
	const deployments = options.deployments ?? [];
	const plans = options.plans ?? [];
	let currentWallet = options.walletState ?? walletState;
	const deploymentRequests = new Map<string, DeploymentMutationFixture>();
	// Deploy API (/me, /v2/*).
	await page.route(`${DEPLOY_API}/**`, async (r) => {
		const p = new URL(r.request().url()).pathname;
		const method = r.request().method();
		if (method !== "GET" && (p === "/v2/deployments" || p.startsWith("/v2/subscription/"))) {
			options.planCMutationRequests?.push(`${method} ${p}`);
		}
		if (p === "/me" || p === "/v1/me") {
			options.productAccessRequests?.push(`DEPLOY ${p}`);
			return fulfillJson(
				r,
				hostedUser(options.planBillingCapability?.enabled ?? options.canUsePlanCBilling ?? true),
			);
		}
		if (p === "/v2/subscription/plans") return fulfillJson(r, plans);
		if (p === "/v2/wallet" && r.request().method() === "GET") {
			return fulfillJson(r, currentWallet);
		}
		if (p === "/v2/wallet/auto-reload" && r.request().method() === "PUT") {
			const requestBody = r.request().postData() ?? "";
			options.autoReloadRequests?.push(requestBody);
			const response = options.autoReloadResponses?.shift();
			if (response?.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
			if (response) {
				if (response.status < 400) currentWallet = response.body as typeof walletState;
				return fulfillJson(r, response.body, response.status);
			}
			const request = JSON.parse(requestBody) as Partial<typeof walletState>;
			currentWallet = { ...currentWallet, ...request };
			return fulfillJson(r, currentWallet);
		}
		if (p === "/v2/wallet/ledger" && r.request().method() === "GET") {
			options.ledgerRequests?.push(r.request().url());
			const limit = Number(new URL(r.request().url()).searchParams.get("limit"));
			const response = options.ledgerResponseForRequest?.(limit) ??
				options.ledgerResponses?.shift() ?? { items: [], has_more: false };
			return isStubResponse(response)
				? fulfillJson(r, response.body, response.status)
				: fulfillJson(r, response);
		}
		if (p === "/v2/deployments" && r.request().method() === "GET") {
			if (options.deploymentsResponse) {
				return fulfillJson(r, options.deploymentsResponse.body, options.deploymentsResponse.status);
			}
			return fulfillJson(r, deployments.map(readDeploymentFixture));
		}
		if (p.startsWith("/v2/deployments/by-request/") && r.request().method() === "GET") {
			const deployRequestId = decodeURIComponent(p.slice("/v2/deployments/by-request/".length));
			const deployment = deploymentRequests.get(deployRequestId);
			return deployment
				? fulfillJson(r, {
						deploy_request_id: deployRequestId,
						request_status: "succeeded",
						lineage_tail: {
							deployment_id: deployment.id,
							lineage_version: 1,
							lineage_state: "succeeded",
							operation: completedDeploymentOperation(deployment, "create"),
						},
					})
				: fulfillJson(r, { detail: "Deployment request not found" }, 404);
		}
		if (p.startsWith("/v2/deployments/") && r.request().method() === "GET") {
			const deploymentId = decodeURIComponent(p.slice("/v2/deployments/".length));
			const deployment = deployments.find(
				(candidate): candidate is DeploymentMutationFixture =>
					isDeploymentMutationFixture(candidate) && candidate.id === deploymentId,
			);
			return deployment
				? fulfillJson(r, readDeploymentFixture(deployment))
				: fulfillJson(r, { detail: "Deployment not found" }, 404);
		}
		const runtimeUiCredentialMatch = p.match(
			/^\/v2\/deployments\/([^/]+)\/runtime-ui\/credentials$/,
		);
		if (runtimeUiCredentialMatch && method === "POST") {
			const deploymentId = runtimeUiCredentialMatch[1];
			const credentials = deploymentId ? options.runtimeUiCredentials?.[deploymentId] : undefined;
			return credentials
				? fulfillJson(r, credentials)
				: fulfillJson(r, { detail: "Runtime UI credential is unavailable" }, 409);
		}
		if (p === "/v2/subscription/checkout" && r.request().method() === "POST") {
			const requestBody = r.request().postData() ?? "";
			options.checkoutRequests?.push(requestBody);
			const request = JSON.parse(requestBody) as {
				funding_source?: string;
				deploy_config?: { deploy_request_id?: string };
			};
			const deployRequestId = request.deploy_config?.deploy_request_id;
			const createdDeployment: DeploymentMutationFixture = {
				...includedBasicDeployment,
				id: request.funding_source === "wallet" ? "hdep_wallet_created" : "hdep_created",
				name: "Created Basic",
				status: "running",
			};
			if (deployRequestId) deploymentRequests.set(deployRequestId, createdDeployment);
			const response =
				options.checkoutResponses?.shift() ??
				(request.funding_source === "wallet"
					? {
							status: 200,
							body: {
								flow_type: "subscription_activation",
								funding_source: "wallet",
								checkout_url: "",
								subscription_id: 42,
								invoice_id: "in_wallet_browser",
								deploy_request_id: deployRequestId,
								deployment_id: "hdep_wallet_created",
								debited_credits: "86400",
								balance_after_credits: "13600",
								current_period_start: "2026-07-15T00:00:00Z",
								current_period_end: "2027-07-15T00:00:00Z",
								entitled_until: "2027-07-15T00:00:00Z",
							},
						}
					: {
							status: 200,
							body: {
								flow_type: "checkout_session",
								funding_source: "stripe",
								action_url: null,
								checkout_url: "#mock-checkout",
								client_secret: null,
							},
						});
			if (response.status < 400 && request.funding_source === "wallet") {
				options.onWalletCheckoutSuccess?.();
			}
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v2/subscription/quote" && r.request().method() === "POST") {
			options.subscriptionQuoteRequests?.push(r.request().postData() ?? "");
			const response =
				options.subscriptionQuoteResponses?.shift() ??
				walletSubscriptionQuote({
					planSlug: "compute_basic",
					billingTermMonths: 1,
					termPriceCents: 900,
					exactDebitCredits: "9000",
					balanceBeforeCredits: "25000",
					balanceAfterCredits: "16000",
				});
			return isStubResponse(response)
				? fulfillJson(r, response.body, response.status)
				: fulfillJson(r, response);
		}
		if (p === "/v2/subscription/plan/quote" && r.request().method() === "POST") {
			options.planQuoteRequests?.push(r.request().postData() ?? "");
			const response = options.planQuoteResponses?.shift() ?? {
				operation_id: "op_plan_browser",
				subscription_id: 42,
				funding_source: "stripe",
				current_plan_slug: "compute_basic",
				target_plan_slug: "compute_performance",
				current_billing_term_months: 1,
				target_billing_term_months: 1,
				change_kind: "immediate_upgrade",
				status: "quoted",
				effective_at: "2026-07-16T00:00:00Z",
				proration_date: "2026-07-16T00:00:00Z",
				expires_at: "2026-07-16T00:15:00Z",
				amount_cents: 1_000,
				amount_credits: null,
				points_per_usd: null,
				currency: "usd",
				stripe_invoice_preview_id: "in_preview_browser",
			};
			return isStubResponse(response)
				? fulfillJson(r, response.body, response.status)
				: fulfillJson(r, response);
		}
		if (p === "/v2/subscription/plan/change" && r.request().method() === "POST") {
			options.planChangeRequests?.push(r.request().postData() ?? "");
			const response = options.planChangeResponses?.shift() ?? {
				operation_id: "op_plan_browser",
				subscription_id: 42,
				funding_source: "stripe",
				current_plan_slug: "compute_basic",
				target_plan_slug: "compute_performance",
				target_billing_term_months: 1,
				status: "complete",
				effective_at: "2026-07-16T00:00:00Z",
				funding_invoice_id: "in_plan_browser",
			};
			return isStubResponse(response)
				? fulfillJson(r, response.body, response.status)
				: fulfillJson(r, response);
		}
		if (p === "/v2/wallet/topup" && r.request().method() === "POST") {
			options.topUpRequests?.push(r.request().postData() ?? "");
			options.topUpIdempotencyKeys?.push(r.request().headers()["idempotency-key"] ?? "");
			const response = options.topUpResponses?.shift() ?? {
				status: 200,
				body: {
					status: "succeeded",
					flow_type: "mock",
					payment_intent_id: null,
					client_secret: null,
					credits_added: 25_000,
				},
			};
			if (response.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
			if (response.status < 400) options.onTopUpSuccess?.();
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v2/subscription/fix-payment" && r.request().method() === "POST") {
			options.fixPaymentRequests?.push(r.request().postData() ?? "");
			return fulfillJson(r, { message: "Payment recovery started." });
		}
		if (p === "/v2/subscription/billing-history" && r.request().method() === "GET") {
			options.billingHistoryRequests?.push(r.request().url());
			const response = options.billingHistoryResponses?.shift() ?? {
				data: [],
				has_more: false,
				next_cursor: null,
			};
			return isStubResponse(response)
				? fulfillJson(r, response.body, response.status)
				: fulfillJson(r, response);
		}
		if (p === "/v2/subscription/cancel" && r.request().method() === "POST") {
			options.cancelRequests?.push(r.request().postData() ?? "");
			return fulfillJson(r, {
				status: "active",
				billing_term_months: 12,
				cancel_at_period_end: true,
				current_period_end: "2026-08-15T00:00:00Z",
				cancel_at: "2026-08-15T00:00:00Z",
			});
		}
		if (p === "/v2/subscription/resume" && r.request().method() === "POST") {
			options.resumeRequests?.push(r.request().postData() ?? "");
			return fulfillJson(r, {
				status: "active",
				billing_term_months: 12,
				cancel_at_period_end: false,
				current_period_end: "2027-07-15T00:00:00Z",
				cancel_at: null,
			});
		}
		if (p.endsWith("/restart") && r.request().method() === "POST") {
			options.restartRequests?.push(p);
			const deploymentId = p.split("/")[3] ?? "";
			const deployment = deployments.find(
				(candidate): candidate is DeploymentMutationFixture =>
					isDeploymentMutationFixture(candidate) && candidate.id === deploymentId,
			);
			return deployment
				? fulfillJson(r, completedDeploymentOperation(deployment, "restart"), 202)
				: fulfillJson(r, { detail: "Deployment not found" }, 404);
		}
		if (p.endsWith("/start") && r.request().method() === "POST") {
			options.startRequests?.push(r.request().postData() ?? "");
			if (options.startError) {
				return fulfillJson(r, { detail: options.startError.detail }, options.startError.status);
			}
			const deploymentId = p.split("/")[3] ?? "";
			const deployment = deployments.find(
				(candidate): candidate is DeploymentMutationFixture =>
					isDeploymentMutationFixture(candidate) && candidate.id === deploymentId,
			);
			return deployment
				? fulfillJson(r, completedDeploymentOperation(deployment, "start"), 202)
				: fulfillJson(r, { detail: "Deployment not found" }, 404);
		}
		if (p.endsWith("/stop") && r.request().method() === "POST") {
			const deploymentId = p.split("/")[3] ?? "";
			const deployment = deployments.find(
				(candidate): candidate is DeploymentMutationFixture =>
					isDeploymentMutationFixture(candidate) && candidate.id === deploymentId,
			);
			return deployment
				? fulfillJson(r, completedDeploymentOperation(deployment, "stop"), 202)
				: fulfillJson(r, { detail: "Deployment not found" }, 404);
		}
		if (p.startsWith("/v2/deployments/") && r.request().method() === "DELETE") {
			options.deleteRequests?.push(p);
			const deploymentId = p.slice("/v2/deployments/".length);
			const deployment = deployments.find(
				(candidate): candidate is DeploymentMutationFixture =>
					isDeploymentMutationFixture(candidate) && candidate.id === deploymentId,
			);
			return deployment
				? fulfillJson(r, completedDeploymentOperation(deployment, "delete"), 202)
				: fulfillJson(r, { detail: "Deployment not found" }, 404);
		}
		return fulfillJson(r, {});
	});
	// Cloud API (/v1/*).
	await page.route(`${CLOUD_API}/**`, (r) => {
		const p = new URL(r.request().url()).pathname;
		if (p === "/v1/me") {
			options.productAccessRequests?.push(`CLOUD ${p}`);
			return fulfillJson(
				r,
				hostedUser(options.planBillingCapability?.enabled ?? options.canUsePlanCBilling ?? true),
			);
		}
		if (p === "/v1/agents") {
			return options.cloudAgentsResponse
				? fulfillJson(r, options.cloudAgentsResponse.body, options.cloudAgentsResponse.status)
				: fulfillJson(r, options.cloudAgents ?? []);
		}
		if (p.startsWith("/v1/agents/") && r.request().method() === "GET") {
			const id = decodeURIComponent(p.slice("/v1/agents/".length));
			const response = options.cloudAgentResponses?.[id]?.shift();
			if (response) return fulfillJson(r, response.body, response.status);
			const error = options.cloudAgentErrors?.[id];
			if (error) return fulfillJson(r, { detail: error.detail }, error.status);
			if (options.cloudAgentNotFoundIds?.includes(id)) {
				return fulfillJson(r, { detail: "Agent not found" }, 404);
			}
			return fulfillJson(r, {
				id,
				name: id,
				default_name: "Hosted agent",
				machine_name: "hosted.local",
				display_name: null,
				avatar_url: null,
				sort_order: 0,
				agent_type: "hermes",
				agent_version: "1.0.0",
				os: "linux",
				last_seen_at: "2026-07-15T00:00:00Z",
				last_sync_at: "2026-07-15T00:00:00Z",
				last_sync_error: null,
				last_revision_seen: 1,
				queue_depth_high_water: 0,
				dropped_count: 0,
				sync_enabled: true,
				explicit_identity: true,
				default_project_id: "project-hosted",
				...options.cloudAgentOverrides,
			});
		}
		if (p === "/v1/ai-providers") return fulfillJson(r, { providers: [] });
		if (p === "/v1/channels") return fulfillJson(r, []);
		if (p === "/v1/channels/bot-pool") return fulfillJson(r, { providers: {} });
		if (p === "/v1/channels/health") return fulfillJson(r, { items: [] });
		if (p === "/v1/projects") return fulfillJson(r, []);
		if (p === "/v1/sessions") return fulfillJson(r, emptyPage);
		if (p === "/v1/auth/keys") return fulfillJson(r, []);
		return fulfillJson(r, {});
	});
}

async function expectNoQuarterlyCopy(page: Page) {
	await expect(page.getByText("Quarterly", { exact: true })).toHaveCount(0);
	await expect(page.getByText(/\/qtr/)).toHaveCount(0);
}

async function capturePricingScreenshot(page: Page, path: string) {
	await page.addStyleTag({
		content: `
			* { animation: none !important; transition: none !important; }
			::view-transition-old(root), ::view-transition-new(root) {
				animation: none !important;
			}
		`,
	});
	const basicCard = page.getByRole("button", { name: /^Basic/ });
	await basicCard.evaluate((element) => {
		element.scrollIntoView({ block: "center", inline: "nearest" });
	});
	await page.waitForTimeout(1_000);
	await basicCard.locator("xpath=ancestor::section[1]").screenshot({ path });
}

function collectBrowserErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	page.on("pageerror", (e) => {
		errors.push(e.message);
	});
	return errors;
}

async function stubStripeCheckout(page: Page) {
	await page.addInitScript(() => {
		const stripeWindow = window as typeof window & { __stripeConfirmCalls?: number };
		stripeWindow.__stripeConfirmCalls = 0;
		const paymentElement = {
			destroy() {},
			mount(node: HTMLElement) {
				node.textContent = "Mock secure payment form";
			},
			off() {},
			on() {},
			update() {},
		};
		const checkoutSdk = {
			changeAppearance() {},
			createPaymentElement: () => paymentElement,
			loadActions: async () => ({
				type: "success",
				actions: {
					confirm: async () => {
						stripeWindow.__stripeConfirmCalls = (stripeWindow.__stripeConfirmCalls ?? 0) + 1;
						return { type: "success", session: { status: { type: "complete" } } };
					},
					getSession: () => ({ canConfirm: true, status: { type: "open" } }),
				},
			}),
			loadFonts: async () => {},
			on() {},
		};
		const stripe = {
			_registerWrapper() {},
			confirmCardPayment: async () => ({}),
			createPaymentMethod: async () => ({}),
			createToken: async () => ({}),
			elements: () => ({}),
			initCheckoutElementsSdk: () => checkoutSdk,
			registerAppInfo() {},
		};
		Object.defineProperty(window, "Stripe", {
			configurable: true,
			value: Object.assign(() => stripe, { version: "dahlia" }),
		});
	});
}

async function expectNonZeroBox(locator: ReturnType<Page["locator"]>, label: string) {
	const box = await locator.boundingBox();
	expect(box, `${label} should render a layout box`).not.toBeNull();
	expect(box?.width, `${label} width`).toBeGreaterThan(0);
	expect(box?.height, `${label} height`).toBeGreaterThan(0);
}

async function gotoHostedAgentSettings(
	page: Page,
	deploymentId: string,
	tier: "Basic" | "Performance",
	search = "",
) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await page.goto(`/agents/${deploymentId}/settings${search}`);
		try {
			await expect(page.getByText(`${tier} compute`, { exact: true })).toBeVisible();
			// Do not open a modal while React is still hydrating the sidebar; Base UI's
			// focus isolation mutates aria-hidden and can create a false mismatch.
			await page.waitForLoadState("networkidle");
			return;
		} catch (error) {
			if (attempt === 1) throw error;
		}
	}
}

async function gotoHostedSettingsDialog(page: Page, section: string) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await page.goto(`/channels?settings=${section}`);
		const dialog = page.getByTestId("settings-dialog");
		try {
			await expect(dialog).toBeVisible();
			await page.waitForLoadState("networkidle");
			return dialog;
		} catch (error) {
			if (attempt === 1) throw error;
		}
	}
	throw new Error("Settings dialog did not open.");
}

test("deploy wizard Select opens without browser errors", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page);
	await page.goto("/deploy");

	// The Personalize section's language select is always present.
	const languageSelect = page.locator("#agent-language");
	await expect(languageSelect).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `deploy render: ${errors.join(" | ")}`).toEqual([]);

	// Open the Base UI Select popup and pick an option.
	await languageSelect.click();
	await expect(page.getByRole("option").first()).toBeVisible();
	await page.getByRole("option").first().click();
	await page.waitForTimeout(150);
	expect(errors, `language select: ${errors.join(" | ")}`).toEqual([]);
});

test("Plan C gate off blocks acquisition while existing subscriptions remain serviceable", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const planCMutationRequests: string[] = [];
	const cancelRequests: string[] = [];
	const fixPaymentRequests: string[] = [];
	const resumeRequests: string[] = [];
	await stubHostedApi(page, {
		canUsePlanCBilling: false,
		cancelRequests,
		deployments: [
			includedBasicDeployment,
			paidBasicDeployment,
			cancelPendingBasicDeployment,
			cardPastDueDeployment,
			terminalFallbackDeployment,
		],
		fixPaymentRequests,
		plans: [basicPlan, performancePlan],
		planCMutationRequests,
		resumeRequests,
	});

	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");
	await expect(page.getByTestId("plan-c-unavailable")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Deployment temporarily unavailable" }),
	).toBeDisabled();
	await expect(page.getByText("Card subscription", { exact: true })).toBeVisible();
	await expect(page.getByText("Wallet balance", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Card subscription/ })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Wallet balance/ })).toHaveCount(0);

	await gotoHostedAgentSettings(page, "hdep_paid", "Basic");
	await expect(page.getByText("Basic compute", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Change plan or billing term" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Cancel subscription" })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Resume subscription" })).toHaveCount(0);
	await expect(page.getByText("Plan changes are temporarily unavailable.")).toBeVisible();
	await page.getByRole("button", { name: "Cancel subscription" }).click();
	await page.getByRole("alertdialog").getByRole("button", { name: "Cancel at period end" }).click();
	await expect.poll(() => cancelRequests.length).toBe(1);

	await gotoHostedAgentSettings(page, "hdep_cancel_pending", "Basic");
	await expect(page.getByRole("button", { name: "Resume subscription" })).toBeEnabled();
	await page.getByRole("button", { name: "Resume subscription" }).click();
	await expect.poll(() => resumeRequests.length).toBe(1);

	await gotoHostedAgentSettings(page, "hdep_card_due", "Basic");
	const pastDueAlert = page.getByRole("alert").filter({ hasText: "Payment past due" });
	await expect(pastDueAlert.getByRole("button", { name: "Fix payment" })).toBeEnabled();
	await pastDueAlert.getByRole("button", { name: "Fix payment" }).click();
	await expect.poll(() => fixPaymentRequests.length).toBe(1);

	await gotoHostedAgentSettings(page, "hdep_included", "Basic");
	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toBeDisabled();
	await expect(page.getByText("Upgrades are temporarily unavailable.")).toBeVisible();

	await gotoHostedAgentSettings(page, "hdep_terminal_fallback", "Basic");
	await expect(page.getByRole("button", { name: "Start a new subscription" })).toBeDisabled();
	await expect(page.getByText("New subscriptions are temporarily unavailable.")).toBeVisible();

	expect(
		planCMutationRequests,
		"gate-off UI must allow servicing mutations but no acquisition or plan-change mutations",
	).toEqual([
		"POST /v2/subscription/cancel",
		"POST /v2/subscription/resume",
		"POST /v2/subscription/fix-payment",
	]);
	expect(errors, `Plan C gate off: ${errors.join(" | ")}`).toEqual([]);
});

test("embedded checkout rechecks Plan C capability before confirm", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const capability = { enabled: true };
	const checkoutRequests: string[] = [];
	const productAccessRequests: string[] = [];
	await stubStripeCheckout(page);
	await stubHostedApi(page, {
		checkoutRequests,
		checkoutResponses: [
			{
				status: 200,
				body: {
					flow_type: "checkout_session",
					funding_source: "stripe",
					action_url: null,
					checkout_url: "",
					client_secret: "cs_test_plan_c_flip",
				},
			},
		],
		deployments: [includedBasicDeployment],
		planBillingCapability: capability,
		plans: [basicPlan, performancePlan],
		productAccessRequests,
	});

	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "Continue to checkout" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	const checkoutDialog = page.getByRole("dialog", { name: /Complete Basic checkout/ });
	await expect(checkoutDialog).toBeVisible();
	await expect(checkoutDialog.getByText("Mock secure payment form", { exact: true })).toBeVisible();
	await expect(checkoutDialog.getByRole("button", { name: "Subscribe" })).toBeEnabled();

	const accessChecksBeforeConfirm = productAccessRequests.filter(
		(request) => request === "DEPLOY /v1/me",
	).length;
	capability.enabled = false;
	await checkoutDialog.getByRole("button", { name: "Subscribe" }).click();

	await expect
		.poll(() => productAccessRequests.filter((request) => request === "DEPLOY /v1/me").length)
		.toBe(accessChecksBeforeConfirm + 1);
	await expect(checkoutDialog).toHaveCount(0);
	await expect(page.getByTestId("plan-c-unavailable")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Deployment temporarily unavailable" }),
	).toBeDisabled();
	expect(
		await page.evaluate(
			() => (window as typeof window & { __stripeConfirmCalls?: number }).__stripeConfirmCalls ?? 0,
		),
	).toBe(0);
	expect(checkoutRequests).toHaveLength(1);
	expect(errors, `mid-checkout Plan C flip: ${errors.join(" | ")}`).toEqual([]);
});

test("env-keyed agent route keeps failed deployment recovery available without its projection", async ({
	page,
}) => {
	const restartRequests: string[] = [];
	const deleteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [failedMissingProjectionDeployment],
		plans: [basicPlan, performancePlan],
		cloudAgentNotFoundIds: [missingProjectionEnvironmentId],
		restartRequests,
		deleteRequests,
	});

	await page.goto(`/agents/${missingProjectionEnvironmentId}?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.getByText("Agent sync record unavailable", { exact: true })).toBeVisible();
	await expect(main.getByText(missingProjectionFailureReason, { exact: true })).toBeVisible();
	await expect(main.getByText("Failed", { exact: true })).toBeVisible();
	await expect(main.getByText("Basic", { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Retry startup", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Runtime UI", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Check again", exact: true })).toBeVisible();

	await main.getByRole("button", { name: "Retry startup", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Retry startup", exact: true })
		.click();
	await expect
		.poll(() => restartRequests)
		.toEqual(["/v2/deployments/hdep_failed_projection/restart"]);

	await main.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete compute", exact: true })
		.click();
	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_failed_projection"]);
});

test("failed deployment with a retained projection keeps status-authoritative navigation", async ({
	page,
}) => {
	const restartRequests: string[] = [];
	const deleteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [failedRetainedProjectionDeployment],
		plans: [basicPlan, performancePlan],
		cloudAgentOverrides: {
			last_seen_at: new Date().toISOString(),
			last_sync_error: "daemon unreachable: connection refused",
		},
		restartRequests,
		deleteRequests,
	});

	await page.goto(`/agents/${retainedProjectionEnvironmentId}?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.getByText(retainedProjectionFailureReason, { exact: true })).toBeVisible();
	await expect(main.getByText("Failed", { exact: true })).toBeVisible();
	await expect(main.getByText("Basic", { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Retry startup", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Runtime UI", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();

	await main.getByRole("button", { name: "Retry startup", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Retry startup", exact: true })
		.click();
	await expect
		.poll(() => restartRequests)
		.toEqual(["/v2/deployments/hdep_failed_retained_projection/restart"]);

	await main.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete compute", exact: true })
		.click();
	await expect
		.poll(() => deleteRequests)
		.toEqual(["/v2/deployments/hdep_failed_retained_projection"]);
});

test("missing live projection recovers on Check again without losing deployment tools", async ({
	page,
}) => {
	await stubHostedApi(page, {
		deployments: [runningMissingProjectionDeployment],
		cloudAgentResponses: {
			[missingProjectionEnvironmentId]: [{ status: 404, body: { detail: "Agent not found" } }],
		},
	});

	await page.goto(`/agents/${missingProjectionEnvironmentId}?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.getByText("Agent sync record unavailable", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Runtime UI", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	await main.getByRole("button", { name: "Check again", exact: true }).click();
	await expect(main.getByText("Agent sync record unavailable", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("projection service errors stay visible while deployment tools remain available", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page, {
		deployments: [runningMissingProjectionDeployment],
		cloudAgentsResponse: { status: 500, body: { detail: "agent list unavailable" } },
		cloudAgentErrors: {
			[missingProjectionEnvironmentId]: { status: 500, detail: "projection gateway failed" },
		},
	});

	await page.goto(`/agents/${missingProjectionEnvironmentId}?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.getByText("Agent sync service unavailable", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Runtime UI", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	const renderErrors = errors.filter(
		(error) => error.includes("Maximum update depth") || error.includes("Too many re-renders"),
	);
	expect(renderErrors, `projection failure render: ${errors.join(" | ")}`).toEqual([]);
});

test("Hermes Runtime UI uses the official dashboard URL without a bridge", async ({ page }) => {
	await stubHostedApi(page, {
		deployments: [
			runtimeUiDeploymentRead({
				id: runningMissingProjectionDeployment.id,
				name: runningMissingProjectionDeployment.name,
				runtime: "hermes",
				environmentId: missingProjectionEnvironmentId,
				endpoint: runningMissingProjectionDeployment.runtime_ui_endpoint,
			}),
		],
	});

	await page.goto(`/agents/${missingProjectionEnvironmentId}/console?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.locator('iframe[title="Hermes Dashboard"]')).toHaveCount(0);
	await expect(
		main.getByText("Open Hermes with your dashboard password", { exact: true }),
	).toBeVisible();
});

test("OpenClaw Runtime UI uses a top-level native token handoff", async ({ page }) => {
	await page
		.context()
		.route("https://runtime.example/**", (route) =>
			route.fulfill({ status: 200, contentType: "text/html", body: "<title>OpenClaw</title>" }),
		);
	await stubHostedApi(page, {
		deployments: [
			runtimeUiDeploymentRead({
				id: runningOpenClawNativeDeployment.id,
				name: runningOpenClawNativeDeployment.name,
				runtime: "openclaw",
				environmentId: openClawNativeEnvironmentId,
				endpoint: runningOpenClawNativeDeployment.runtime_ui_endpoint,
			}),
		],
		runtimeUiCredentials: {
			[runningOpenClawNativeDeployment.id]: {
				runtime: "openclaw",
				url: "https://runtime.example/openclaw/#token=browser-native-token",
				auth_mode: "openclaw_device",
				username: null,
				password: null,
			},
		},
	});

	await page.goto(`/agents/${openClawNativeEnvironmentId}/console?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.locator('iframe[title="OpenClaw Control UI"]')).toHaveCount(0);
	await expect(main.getByText("Open OpenClaw in a new window", { exact: true })).toBeVisible();
	const popupPromise = page.waitForEvent("popup");
	await main.getByRole("button", { name: "Open OpenClaw Control UI", exact: true }).first().click();
	const popup = await popupPromise;
	await popup.waitForLoadState("domcontentloaded");
	expect(popup.url()).toBe("https://runtime.example/openclaw/#token=browser-native-token");
});

test("revoked deployment inventory never reclassifies cloud projections as connected", async ({
	page,
}) => {
	await stubHostedApi(page, {
		cloudAgents: [sharedLegacyCloudAgent],
		deploymentsResponse: { status: 403, body: { detail: "deployment access revoked" } },
	});

	await page.goto("/agents");
	const main = page.locator("main");
	await expect(main.getByText("Clawdi Cloud inventory unavailable", { exact: true })).toBeVisible();
	await expect(main.getByText("shared-legacy-agent", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Connect your first agent", { exact: true })).toHaveCount(0);
});

test("shared legacy environment routes an older tile's actions to its deployment", async ({
	page,
}) => {
	const deleteRequests: string[] = [];
	await stubHostedApi(page, {
		// The deploy API returns newest first.
		deployments: [newerSharedEnvironmentDeployment, olderSharedEnvironmentDeployment],
		plans: [basicPlan, performancePlan],
		cloudAgents: [sharedLegacyCloudAgent],
		deleteRequests,
	});

	await page.goto("/agents");
	const agents = page.locator("main");
	const newerTile = agents.getByRole("link").filter({ hasText: "Newer twin" });
	const olderTile = agents.getByRole("link").filter({ hasText: "Older twin" });
	await expect(newerTile).toBeVisible();
	await expect(olderTile).toBeVisible();
	await olderTile.click();
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(page).toHaveURL(
		new RegExp(`/agents/${sharedLegacyEnvironmentId}/settings\\?.*d=hdep_shared_older`),
	);

	const main = page.locator("main");
	await main.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete compute", exact: true })
		.click();

	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_shared_older"]);
});

test("shared legacy environment direct route asks the user to choose a deployment", async ({
	page,
}) => {
	await stubHostedApi(page, {
		deployments: [newerSharedEnvironmentDeployment, olderSharedEnvironmentDeployment],
	});

	await page.goto(`/agents/${sharedLegacyEnvironmentId}?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Choose a deployment" })).toBeVisible();
	const newerChoice = main.getByRole("link", { name: "Open Newer twin" });
	const olderChoice = main.getByRole("link", { name: "Open Older twin" });
	await expect(newerChoice).toContainText("Running");
	await expect(newerChoice).toContainText("Created Jul 15, 2026");
	await expect(olderChoice).toContainText("Stopped");
	await expect(olderChoice).toContainText("Created Jul 14, 2026");
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
	await olderChoice.click();
	await expect(page).toHaveURL(
		new RegExp(`/agents/${sharedLegacyEnvironmentId}\\?.*d=hdep_shared_older`),
	);
	await expect(main.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("identity-less interrupted deployment tile exposes delete", async ({ page }) => {
	const deleteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [interruptedIdentitylessDeployment],
		deleteRequests,
	});

	await page.goto("/agents");
	const deleteAction = page.getByRole("button", { name: "Delete Interrupted deployment" });
	await expect(deleteAction).toBeVisible();
	await deleteAction.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete deployment", exact: true })
		.click();
	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_creation_interrupted"]);
});

test("Basic create always follows the wizard-selected funding path", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	await page.setViewportSize({ width: 1_440, height: 1_100 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [paidBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await expect(page.getByText("$9/mo", { exact: true })).toBeVisible();
	await expect(page.getByText(/2 vCPU \/ 4 GB · \$9\/mo/)).toBeVisible();
	await expectNoQuarterlyCopy(page);
	await capturePricingScreenshot(page, "/tmp/basic-paid-funded-slot-available-final.png");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
		plan_slug: "compute_basic",
		funding_source: "stripe",
		deploy_config: { compute_plan_slug: "compute_basic" },
	});
	expect(errors, `funded Basic deploy: ${errors.join(" | ")}`).toEqual([]);
});

test("free-funded Basic uses annual compute_basic checkout when the included slot is occupied", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	await page.setViewportSize({ width: 1_440, height: 1_100 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await expect(page.getByText("$9/mo", { exact: true })).toBeVisible();
	await expect(page.getByText("Monthly", { exact: true })).toBeVisible();
	const annualTerm = page.getByRole("button", { name: /Annual.*%/ });
	await expect(annualTerm).toBeVisible();
	await expectNoQuarterlyCopy(page);
	await annualTerm.click();
	await expect(page.getByText("Wallet balance", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /Wallet balance/ })).toBeVisible();
	await expect(page.getByText(/2 vCPU \/ 4 GB · \$7.2\/mo, billed \$86.4\/yr/)).toBeVisible();
	await expect(page.getByText(/this Basic agent at \$7.2\/mo, billed \$86.4\/yr/)).toBeVisible();
	await capturePricingScreenshot(page, "/tmp/basic-free-funded-slot-occupied-final.png");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
		plan_slug: "compute_basic",
		billing_term_months: 12,
		funding_source: "stripe",
		deploy_config: { compute_plan_slug: "compute_basic" },
	});
	expect(errors, `paid Basic checkout: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet annual quotes the exact debit and activates the created deployment", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	const deployments: unknown[] = [includedBasicDeployment];
	const subscriptionQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments,
		plans: [basicPlan, performancePlan],
		subscriptionQuoteRequests,
		subscriptionQuoteResponses: [
			walletSubscriptionQuote({
				planSlug: "compute_basic",
				billingTermMonths: 12,
				termPriceCents: 8_640,
				exactDebitCredits: "86400",
				balanceBeforeCredits: "100000",
				balanceAfterCredits: "13600",
			}),
		],
		walletState: { ...walletState, balance_credits: 100_000 },
		onWalletCheckoutSuccess: () => deployments.push(walletAnnualDeployment),
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await page.getByRole("button", { name: /Annual.*%/ }).click();
	await page.getByRole("button", { name: /Wallet balance/ }).click();
	await expect.poll(() => subscriptionQuoteRequests.length).toBe(1);
	const equation = page.getByTestId("wallet-debit-equation");
	await expect(equation).toContainText("Balance before");
	await expect(equation).toContainText("100,000 credits");
	await expect(equation).toContainText("Exact debit");
	await expect(equation).toContainText("86,400 credits");
	await expect(equation).toContainText("$86.40");
	await expect(equation).toContainText("Balance after");
	await expect(equation).toContainText("13,600 credits");

	await page.getByRole("button", { name: "Pay $86.40 from Wallet & deploy" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	const quote = JSON.parse(subscriptionQuoteRequests[0] ?? "{}");
	const activation = JSON.parse(checkoutRequests[0] ?? "{}");
	expect(quote).toEqual({
		plan_slug: "compute_basic",
		billing_term_months: 12,
		funding_source: "wallet",
	});
	expect(activation).toMatchObject({
		plan_slug: "compute_basic",
		billing_term_months: 12,
		funding_source: "wallet",
		deploy_config: { compute_plan_slug: "compute_basic" },
		quote: {
			funding_source: "wallet",
			term_price_cents: 8_640,
			debit_credits: "86400",
			balance_after_credits: "13600",
		},
	});
	await expect(page).toHaveURL(/\/agents\/hdep_wallet_created(?:\?|\/)/);
	expect(errors, `wallet annual deploy: ${errors.join(" | ")}`).toEqual([]);
});

test("included Basic uses unified card quote and change without creating a second subscription", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	const subscriptionQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_free_card",
				subscriptionId: 7,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 12,
				status: "complete",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_free_card",
				subscriptionId: 7,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				currentBillingTermMonths: 1,
				targetBillingTermMonths: 12,
				changeKind: "immediate_upgrade",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 18_000,
				amountCredits: null,
			}),
		],
		plans: [basicPlan, performancePlan],
		subscriptionQuoteRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic");

	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);

	await page.getByRole("button", { name: "Upgrade to Performance" }).click();
	const changeDialog = page.getByRole("dialog");
	await expect(
		changeDialog.getByText("Change compute subscription", { exact: true }),
	).toBeVisible();
	await changeDialog.getByRole("button", { name: /Annual/ }).click();
	await changeDialog.getByRole("button", { name: "Review change" }).click();

	await expect.poll(() => planQuoteRequests.length).toBe(1);
	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 7,
		target_plan_slug: "compute_performance",
		target_billing_term_months: 12,
		funding_source: "stripe",
	});
	await expect(changeDialog.getByText("Confirm immediate upgrade", { exact: true })).toBeVisible();
	await expect(changeDialog.getByText("$180.00", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_free_card",
	});
	expect(checkoutRequests).toEqual([]);
	expect(subscriptionQuoteRequests).toEqual([]);
	await expect(page.getByText("Plan change started", { exact: true })).toBeVisible();
	expect(errors, `included Basic card upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("included Basic uses unified wallet quote and change with exact debit", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	const subscriptionQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_free_wallet",
				subscriptionId: 7,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 1,
				status: "awaiting_projection",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_free_wallet",
				subscriptionId: 7,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				currentBillingTermMonths: 1,
				targetBillingTermMonths: 1,
				changeKind: "immediate_upgrade",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 1_900,
				amountCredits: "19000",
			}),
		],
		plans: [basicPlan, performancePlan],
		subscriptionQuoteRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic");

	await page.getByRole("button", { name: "Upgrade to Performance" }).click();
	const changeDialog = page.getByRole("dialog");
	await changeDialog.getByRole("button", { name: "Wallet", exact: true }).click();
	const review = changeDialog.getByRole("button", { name: "Review change" });
	await expect(review).toBeEnabled();
	await review.click();

	await expect.poll(() => planQuoteRequests.length).toBe(1);
	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 7,
		target_plan_slug: "compute_performance",
		target_billing_term_months: 1,
		funding_source: "wallet",
	});
	const equation = changeDialog.getByTestId("wallet-debit-equation");
	await expect(equation).toContainText("25,000 credits");
	await expect(equation).toContainText("19,000 credits");
	await expect(equation).toContainText("6,000 credits");
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_free_wallet",
	});
	expect(checkoutRequests).toEqual([]);
	expect(subscriptionQuoteRequests).toEqual([]);
	await expect(page.getByText("Plan change started", { exact: true })).toBeVisible();
	expect(errors, `included Basic wallet upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("paid card subscription confirms an immediate quoted upgrade", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [paidBasicDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_paid_card",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 12,
				status: "complete",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_paid_card",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				currentBillingTermMonths: 12,
				targetBillingTermMonths: 12,
				changeKind: "immediate_upgrade",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 9_360,
				amountCredits: null,
			}),
		],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_paid", "Basic");

	await page.getByRole("button", { name: "Change plan or billing term" }).click();
	const changeDialog = page.getByRole("dialog");
	await expect(changeDialog.getByText("Funding source: Card", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Review change" }).click();
	await expect.poll(() => planQuoteRequests.length).toBe(1);
	await expect(changeDialog.getByText("$93.60", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 42,
		target_plan_slug: "compute_performance",
		target_billing_term_months: 12,
		funding_source: "stripe",
	});
	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_paid_card",
	});
	expect(errors, `paid card upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("paid wallet subscription confirms an immediate quoted upgrade", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	const subscriptionQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [walletActiveDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_paid_wallet",
				subscriptionId: 42,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 1,
				status: "awaiting_projection",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_paid_wallet",
				subscriptionId: 42,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				currentBillingTermMonths: 1,
				targetBillingTermMonths: 1,
				changeKind: "immediate_upgrade",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 1_000,
				amountCredits: "10000",
			}),
		],
		plans: [basicPlan, performancePlan],
		subscriptionQuoteRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_due", "Basic");

	await page.getByRole("button", { name: "Change plan or billing term" }).click();
	const changeDialog = page.getByRole("dialog");
	await expect(changeDialog.getByText("Funding source: Wallet", { exact: true })).toBeVisible();
	const review = changeDialog.getByRole("button", { name: "Review change" });
	await expect(review).toBeEnabled();
	await review.click();
	await expect.poll(() => planQuoteRequests.length).toBe(1);
	const equation = changeDialog.getByTestId("wallet-debit-equation");
	await expect(equation).toContainText("25,000 credits");
	await expect(equation).toContainText("10,000 credits");
	await expect(equation).toContainText("15,000 credits");
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 42,
		target_plan_slug: "compute_performance",
		target_billing_term_months: 1,
		funding_source: "wallet",
	});
	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_paid_wallet",
	});
	expect(subscriptionQuoteRequests).toEqual([]);
	expect(errors, `paid wallet upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("paid Performance schedules its quoted downgrade for the effective date", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [performanceDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_downgrade",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_performance",
				targetPlanSlug: "compute_basic",
				targetBillingTermMonths: 12,
				status: "scheduled",
				effectiveAt: "2027-07-15T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_downgrade",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_performance",
				targetPlanSlug: "compute_basic",
				currentBillingTermMonths: 12,
				targetBillingTermMonths: 12,
				changeKind: "scheduled_downgrade",
				effectiveAt: "2027-07-15T00:00:00Z",
				amountCents: 0,
				amountCredits: null,
			}),
		],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_performance", "Performance");

	await page.getByRole("button", { name: "Change plan or billing term" }).click();
	const changeDialog = page.getByRole("dialog");
	await changeDialog.getByRole("button", { name: "Review change" }).click();
	await expect.poll(() => planQuoteRequests.length).toBe(1);
	await expect(changeDialog.getByRole("heading", { name: "Schedule downgrade" })).toBeVisible();
	await expect(changeDialog.getByText("No charge today", { exact: true })).toBeVisible();
	await expect(changeDialog).toContainText("Jul 15, 2027");
	await changeDialog.getByRole("button", { name: "Schedule downgrade" }).click();

	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 42,
		target_plan_slug: "compute_basic",
		target_billing_term_months: 12,
		funding_source: "stripe",
	});
	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_downgrade",
	});
	await expect(page.getByText("Downgrade scheduled", { exact: true })).toBeVisible();
	expect(errors, `scheduled downgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("pending cancellation blocks plan changes and resumes through the primary CTA", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	const resumeRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [cancelPendingBasicDeployment],
		planChangeRequests,
		planQuoteRequests,
		plans: [basicPlan, performancePlan],
		resumeRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_cancel_pending", "Basic");

	await expect(page.getByRole("button", { name: "Change plan or billing term" })).toHaveCount(0);
	await expect(page.getByText(/Resume this subscription before changing/)).toBeVisible();
	await page.getByRole("button", { name: "Resume subscription" }).click();

	await expect.poll(() => resumeRequests.length).toBe(1);
	expect(JSON.parse(resumeRequests[0] ?? "{}")).toEqual({
		deployment_id: "hdep_cancel_pending",
	});
	expect(planQuoteRequests).toEqual([]);
	expect(planChangeRequests).toEqual([]);
	await expect(page.getByText("Subscription resumed", { exact: true })).toBeVisible();
	expect(errors, `pending cancellation resume: ${errors.join(" | ")}`).toEqual([]);
});

test("terminal fallback starts a new subscription against the fallback deployment", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [terminalFallbackDeployment],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_terminal_fallback", "Basic");

	await expect(page.getByText("Compute subscription ended", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("alert").getByRole("button", { name: "Start a new subscription" }),
	).toBeVisible();
	const startNewButton = page
		.locator("#compute-plan-controls")
		.getByRole("button", { name: "Start a new subscription" });
	await expect(startNewButton).toBeVisible();
	await startNewButton.click();
	const createDialog = page.getByRole("dialog");
	await expect(createDialog.getByText("Start a new subscription", { exact: true })).toBeVisible();
	await expect(createDialog.locator("#subscription-create-plan")).toContainText("Performance");
	await createDialog.getByRole("button", { name: "Continue to card checkout" }).click();

	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
		plan_slug: "compute_performance",
		billing_term_months: 1,
		funding_source: "stripe",
		upgrade_deployment_id: "hdep_terminal_fallback",
	});
	expect(errors, `terminal fallback reactivation: ${errors.join(" | ")}`).toEqual([]);
});

test("included Basic checkout abandonment preserves the current plan", async ({ page }) => {
	const checkoutRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic", "?checkout=cancel");
	const errors = collectBrowserErrors(page);

	await expect(page.getByText("Checkout canceled", { exact: true })).toBeVisible();
	await expect(
		page.getByText("You were not charged. Your compute plan is unchanged.", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
	expect(checkoutRequests).toEqual([]);
	expect(errors, `included Basic checkout abandonment: ${errors.join(" | ")}`).toEqual([]);
});

test("paid Basic cancellation stays conditional with the included slot vacant or occupied", async ({
	page,
}) => {
	const cancelRequests: string[] = [];
	const deployments: unknown[] = [paidBasicDeployment];
	await stubHostedApi(page, {
		cancelRequests,
		deployments,
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_paid", "Basic");
	const errors = collectBrowserErrors(page);

	for (const [index, label] of ["vacant", "occupied"].entries()) {
		if (label === "occupied") deployments.push(includedBasicDeployment);
		if (index > 0) await gotoHostedAgentSettings(page, "hdep_paid", "Basic");

		await expect(page.getByRole("button", { name: "Change plan or billing term" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toHaveCount(0);

		await page.getByRole("button", { name: "Cancel subscription" }).click();
		const cancelDialog = page.getByRole("alertdialog");
		await expect(
			cancelDialog.getByText("Cancel Basic subscription?", { exact: true }),
		).toBeVisible();
		await expect(
			cancelDialog.getByText(
				/falls back to included Basic funding if available; otherwise, it stops/,
			),
		).toBeVisible();
		await cancelDialog.getByRole("button", { name: "Cancel at period end" }).click();

		await expect.poll(() => cancelRequests.length, { message: label }).toBe(index + 1);
		expect(JSON.parse(cancelRequests[index] ?? "{}")).toMatchObject({
			deployment_id: "hdep_paid",
		});
		await expect(
			page.getByText("Subscription cancellation scheduled", { exact: true }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "Resume subscription" })).toBeVisible();
	}
	expect(errors, `paid Basic cancellation: ${errors.join(" | ")}`).toEqual([]);
});

test("paid Performance exposes subscription actions without a direct Basic switch", async ({
	page,
}) => {
	await stubHostedApi(page, {
		deployments: [performanceDeployment],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_performance", "Performance");
	const errors = collectBrowserErrors(page);

	await expect(page.getByRole("button", { name: "Change plan or billing term" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /switch|downgrade/i })).toHaveCount(0);
	expect(errors, `paid Performance actions: ${errors.join(" | ")}`).toEqual([]);
});

test("occupied included Basic start surfaces the backend slot entitlement error", async ({
	page,
}) => {
	const startRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [stoppedIncludedBasicDeployment, includedBasicDeployment],
		plans: [basicPlan, performancePlan],
		startError: {
			status: 403,
			detail: "The Compute Basic free slot allows only one active deployment.",
		},
		startRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_stopped", "Basic");
	const errors = collectBrowserErrors(page);

	await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Start", exact: true }).click();

	await expect.poll(() => startRequests.length).toBe(1);
	await expect(page.getByText("Couldn't update lifecycle", { exact: true })).toBeVisible();
	await expect(
		page.getByText("The Compute Basic free slot allows only one active deployment.", {
			exact: true,
		}),
	).toBeVisible();
	expect(errors.length, `included Basic start entitlement: ${errors.join(" | ")}`).toBeGreaterThan(
		0,
	);
	expect(
		errors.every((error) => /status of 403 \(Forbidden\)/.test(error)),
		`included Basic start entitlement: ${errors.join(" | ")}`,
	).toBe(true);
});

test("paid Basic checkout abandonment preserves the checkout-ready wizard", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/deploy?checkout=cancel");

	await expect(page.getByText("Checkout canceled", { exact: true })).toBeVisible();
	await expect(page.getByText("You were not charged. Your agent was not deployed.")).toBeVisible();
	await expect(page.getByText("$9/mo", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Continue to checkout" })).toBeVisible();
	await expect(page.getByText("First slot free", { exact: true })).toHaveCount(0);
	expect(checkoutRequests).toEqual([]);
	expect(errors, `checkout abandonment: ${errors.join(" | ")}`).toEqual([]);
});

test("Stripe invoice history shows both rails and a server-visible zero proration", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const billingHistoryRequests: string[] = [];
	await stubHostedApi(page, {
		billingHistoryRequests,
		billingHistoryResponses: [
			{
				data: [
					{
						id: "stripe:in_wallet",
						funding_source: "wallet",
						compute_subscription_id: 42,
						plan_slug: "compute_basic",
						status: "paid",
						amount_cents: 900,
						currency: "usd",
						period_start: "2026-07-15T00:00:00Z",
						period_end: "2026-08-15T00:00:00Z",
						created: "2026-07-15T00:00:00Z",
						stripe_invoice_id: "in_wallet",
						stripe_invoice_number: "CLAWDI-WALLET-1",
						hosted_invoice_url: "https://invoice.stripe.test/in_wallet",
					},
					{
						id: "stripe:in_1",
						funding_source: "stripe",
						compute_subscription_id: 9,
						plan_slug: "compute_performance",
						status: "paid",
						amount_cents: 1900,
						currency: "usd",
						created: "2026-07-14T00:00:00Z",
						stripe_invoice_id: "in_1",
						stripe_invoice_number: "CLAWDI-CARD-1",
						hosted_invoice_url: "https://invoice.stripe.test/in_1",
					},
					{
						id: "stripe:in_zero_proration",
						funding_source: "stripe",
						compute_subscription_id: 10,
						plan_slug: "compute_performance",
						status: "paid",
						amount_cents: 0,
						currency: "usd",
						created: "2026-07-13T00:00:00Z",
						stripe_invoice_id: "in_zero_proration",
						stripe_invoice_number: "CLAWDI-PRORATION-1",
						hosted_invoice_url: "https://invoice.stripe.test/in_zero_proration",
					},
				],
				has_more: true,
				next_cursor: "cursor_2",
			},
			{
				status: 400,
				body: { detail: "billing_history_backend_unavailable" },
			},
			{
				data: [
					{
						id: "stripe:in_refunded",
						funding_source: "stripe",
						compute_subscription_id: 9,
						plan_slug: "compute_performance",
						status: "refunded",
						amount_cents: 1_900,
						currency: "usd",
						created: "2026-06-15T00:00:00Z",
						stripe_invoice_id: "in_refunded",
						stripe_invoice_number: "CLAWDI-CARD-0",
						hosted_invoice_url: "https://invoice.stripe.test/in_refunded",
					},
				],
				has_more: false,
				next_cursor: null,
			},
		],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/channels?settings=billing-plan");
	const settingsDialog = page.getByTestId("settings-dialog");
	await expect(settingsDialog.getByText("Billing history", { exact: true })).toBeVisible();
	const billingTable = settingsDialog.getByRole("table");
	await expect(billingTable.getByText("Paid with AI Credits", { exact: true })).toBeVisible();
	await expect(billingTable.getByText("Paid by card", { exact: true })).toHaveCount(2);
	await expect(
		billingTable.locator('a[href="https://invoice.stripe.test/in_wallet"]'),
	).toBeVisible();
	await expect(billingTable.locator('a[href="https://invoice.stripe.test/in_1"]')).toBeVisible();
	await expect(
		billingTable.locator('a[href="https://invoice.stripe.test/in_zero_proration"]'),
	).toBeVisible();
	await expect(billingTable.getByText("$0.00", { exact: true })).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Load more" }).click();
	await expect.poll(() => billingHistoryRequests.length).toBe(2);
	await expect(
		settingsDialog.getByText("Couldn’t load more billing history", { exact: true }),
	).toBeVisible();
	await expect(billingTable.getByText("Paid with AI Credits", { exact: true })).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Retry" }).click();
	await expect.poll(() => billingHistoryRequests.length).toBe(3);
	expect(new URL(billingHistoryRequests[1] ?? "http://invalid").searchParams.get("cursor")).toBe(
		"cursor_2",
	);
	await expect(billingTable.getByText("Refunded", { exact: true })).toBeVisible();
	await settingsDialog.screenshot({ path: "/tmp/stripe-billing-history.png" });
	expect(
		errors.filter((error) => !error.includes("status of 400")),
		`Stripe billing history: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("Wallet activity caps show-more requests at the ledger API limit", async ({ page }) => {
	const ledgerRequests: string[] = [];
	let expandedAttempts = 0;
	const computeCharge = {
		id: "ledger-compute-charge",
		operation: "compute_charge",
		request_id: "compute-renewal-42",
		credits_amount: -9_000,
		status: "applied",
		created_at: "2026-07-15T00:00:00Z",
	};
	await stubHostedApi(page, {
		ledgerRequests,
		ledgerResponseForRequest: (limit) => {
			if (limit === 50) return { items: [computeCharge], has_more: true };
			expandedAttempts += 1;
			return expandedAttempts === 1
				? { status: 400, body: { detail: "ledger_backend_unavailable" } }
				: {
						items: [
							computeCharge,
							{
								...computeCharge,
								id: "ledger-compute-credit",
								operation: "compute_credit",
								request_id: "compute-reversal-42",
								credits_amount: 9_000,
							},
						],
						has_more: true,
					};
		},
		plans: [basicPlan, performancePlan],
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	const errors = collectBrowserErrors(page);
	const ledgerTable = settingsDialog.getByRole("table");

	await expect(ledgerTable.getByText("Compute charge", { exact: true })).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Show more" }).click();
	await expect.poll(() => ledgerRequests.length).toBe(2);
	await expect(
		settingsDialog.getByText("Couldn’t load more activity", { exact: true }),
	).toBeVisible();
	await expect(ledgerTable.getByText("Compute charge", { exact: true })).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Retry" }).click();
	await expect.poll(() => ledgerRequests.length).toBe(3);
	await expect(ledgerTable.getByText("Compute reversal", { exact: true })).toBeVisible();
	await expect(settingsDialog.getByRole("button", { name: "Show more" })).toHaveCount(0);
	await expect(settingsDialog).toContainText(
		"Showing your most recent activity. Older entries are archived.",
	);

	const limits = ledgerRequests.map((url) => Number(new URL(url).searchParams.get("limit")));
	expect([...new Set(limits)]).toEqual([50, 100]);
	expect(limits.every((limit) => limit <= 100)).toBe(true);
	expect(
		errors.filter((error) => !error.includes("status of 400")),
		`wallet ledger cap: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("auto-reload batches toggle and fields into one explicit save", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const autoReloadRequests: string[] = [];
	const savedWallet = {
		...walletState,
		auto_reload_enabled: true,
		auto_reload_threshold_credits: 7_500,
		auto_reload_amount_cents: 3_000,
		auto_reload_monthly_cap_cents: 12_500,
	};
	await stubHostedApi(page, {
		autoReloadRequests,
		autoReloadResponses: [
			{
				status: 400,
				body: { detail: "Auto reload requires a default payment method" },
				delayMs: 250,
			},
			{ status: 200, body: savedWallet },
		],
		plans: [basicPlan, performancePlan],
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	const card = settingsDialog.locator('[data-slot="card"]').filter({ hasText: "Auto-reload" });
	const enabled = card.getByRole("switch", { name: "Enabled" });
	const threshold = card.getByLabel("When balance is below (USD)");
	const amount = card.getByLabel("Amount to add (USD)");
	const cap = card.getByLabel("Monthly cap (USD)");
	const save = card.getByRole("button", { name: "Save changes" });
	const cancel = card.getByRole("button", { name: "Cancel changes" });

	await expect(card.getByText("All changes saved", { exact: true })).toBeVisible();
	await expect(save).toBeDisabled();
	await expect(cancel).toBeDisabled();

	await enabled.click();
	await threshold.fill("7.50");
	await amount.fill("30");
	await cap.fill("125");
	await expect(card.getByText("Unsaved changes", { exact: true })).toBeVisible();
	expect(autoReloadRequests).toEqual([]);

	await cancel.click();
	await expect(enabled).not.toBeChecked();
	await expect(threshold).toHaveValue("5");
	await expect(amount).toHaveValue("25");
	await expect(cap).toHaveValue("100");
	await expect(save).toBeDisabled();
	expect(autoReloadRequests).toEqual([]);

	await enabled.click();
	await threshold.fill("7.50");
	await amount.fill("30");
	await cap.fill("125");
	await settingsDialog.getByRole("button", { name: /^Compute/ }).click();
	const discardDialog = page.getByRole("alertdialog");
	await expect(discardDialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
	await discardDialog.getByRole("button", { name: "Keep editing" }).click();
	await expect(card).toBeVisible();

	await card.screenshot({ path: "/tmp/auto-reload-dirty.png" });
	await save.evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
	});
	await expect(card.getByRole("button", { name: "Saving…" })).toBeDisabled();
	await expect.poll(() => autoReloadRequests.length).toBe(1);
	await expect(
		card.getByText("Add a card before enabling auto-reload", { exact: true }),
	).toBeVisible();
	await expect(card.getByRole("button", { name: "Add a card" })).toBeVisible();
	await expect(card.getByText("Unsaved changes", { exact: true })).toBeVisible();
	await card.screenshot({ path: "/tmp/auto-reload-error.png" });

	await save.click();
	await expect.poll(() => autoReloadRequests.length).toBe(2);
	await expect(card.getByText("All changes saved", { exact: true })).toBeVisible();
	await expect(enabled).toBeChecked();
	await expect(save).toBeDisabled();
	await card.screenshot({ path: "/tmp/auto-reload-saved.png" });

	for (const raw of autoReloadRequests) {
		expect(JSON.parse(raw)).toEqual({
			auto_reload_enabled: true,
			auto_reload_threshold_credits: 7_500,
			auto_reload_amount_cents: 3_000,
			auto_reload_monthly_cap_cents: 12_500,
		});
	}
	expect(
		errors.filter((error) => !error.includes("status of 400")),
		`auto-reload save: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("top-up validates the amount and blocks duplicate submission or close in flight", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const topUpRequests: string[] = [];
	await stubHostedApi(page, {
		topUpRequests,
		topUpResponses: [
			{
				status: 200,
				delayMs: 250,
				body: {
					status: "succeeded",
					flow_type: "mock",
					payment_intent_id: null,
					client_secret: null,
					credits_added: 40_000,
				},
			},
		],
		plans: [basicPlan, performancePlan],
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	await settingsDialog.getByRole("button", { name: "Top up" }).click();
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up AI Credits" });
	const amount = topUpDialog.getByLabel("Amount (USD)");

	await amount.fill("25.50");
	await amount.blur();
	await expect(
		topUpDialog.getByText("Enter a whole-dollar amount from $10.00 to $2,000.00.", {
			exact: true,
		}),
	).toBeVisible();
	await amount.fill("40");
	const submit = topUpDialog.getByRole("button", { name: "Continue with $40.00" });
	await submit.evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
	});
	await expect(topUpDialog.getByRole("button", { name: "Starting…" })).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(topUpDialog).toBeVisible();
	await expect.poll(() => topUpRequests.length).toBe(1);
	await expect(topUpDialog).toHaveCount(0);
	expect(JSON.parse(topUpRequests[0] ?? "{}")).toEqual({ amount_cents: 4_000 });
	expect(errors, `top-up interaction: ${errors.join(" | ")}`).toEqual([]);
});

test("top-up rotates its idempotency key after an explicit reuse conflict", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const topUpIdempotencyKeys: string[] = [];
	await stubHostedApi(page, {
		plans: [basicPlan, performancePlan],
		topUpIdempotencyKeys,
		topUpResponses: [
			{
				status: 409,
				body: {
					detail: {
						code: "idempotency_key_reused",
						message: "The top-up key belongs to another amount.",
					},
				},
			},
		],
	});
	await page.goto("/channels?settings=billing-wallet");
	const settingsDialog = page.getByTestId("settings-dialog");
	await settingsDialog.getByRole("button", { name: "Top up" }).click();
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up AI Credits" });
	const submit = topUpDialog.getByRole("button", { name: "Continue" });

	await submit.click();
	await expect.poll(() => topUpIdempotencyKeys.length).toBe(1);
	await expect(page.getByText("Start a fresh top-up", { exact: true })).toBeVisible();
	await expect(topUpDialog).toBeVisible();
	await submit.click();
	await expect.poll(() => topUpIdempotencyKeys.length).toBe(2);

	expect(topUpIdempotencyKeys[0]).toMatch(/^topup-/);
	expect(topUpIdempotencyKeys[1]).toMatch(/^topup-/);
	expect(topUpIdempotencyKeys[1]).not.toBe(topUpIdempotencyKeys[0]);
	await expect(topUpDialog).toHaveCount(0);
	expect(
		errors.filter((error) => !error.includes("status of 409")),
		`top-up key rotation: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("wallet top-up completion refreshes an automatically paid open invoice", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [walletPastDueDeployment];
	const topUpRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		topUpRequests,
		onTopUpSuccess: () => deployments.splice(0, 1, walletActiveDeployment),
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_due", "Basic");

	const pastDueAlert = page.getByRole("alert").filter({ hasText: "Wallet payment past due" });
	await expect(pastDueAlert).toBeVisible();
	await expect(pastDueAlert).toContainText(
		"Stripe will keep the invoice open while funds are short",
	);
	await expect(pastDueAlert.getByRole("button", { name: "Top up" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Fix payment" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Retry payment/ })).toHaveCount(0);

	await pastDueAlert.getByRole("button", { name: "Top up" }).click();
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up AI Credits" });
	await expect(topUpDialog).toBeVisible();
	await topUpDialog.getByRole("button", { name: "Continue with $25.00" }).click();

	await expect.poll(() => topUpRequests.length).toBe(1);
	await expect(page.getByText("Top-up complete", { exact: true })).toBeVisible();
	await expect(pastDueAlert).toHaveCount(0);
	await expect(page.getByText("Wallet", { exact: true })).toBeVisible();
	expect(JSON.parse(topUpRequests[0] ?? "{}")).toEqual({ amount_cents: 2_500 });
	expect(errors, `wallet open-invoice top-up: ${errors.join(" | ")}`).toEqual([]);
});

test("card past due uses Fix payment instead of wallet recovery", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const fixPaymentRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [cardPastDueDeployment],
		fixPaymentRequests,
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_card_due", "Basic");

	const pastDueAlert = page.getByRole("alert").filter({ hasText: "Payment past due" });
	await expect(pastDueAlert).toBeVisible();
	await expect(pastDueAlert).toContainText("Update the card payment method");
	await expect(pastDueAlert.getByRole("button", { name: "Fix payment" })).toBeVisible();
	await expect(pastDueAlert.getByRole("button", { name: "Top up" })).toHaveCount(0);

	await pastDueAlert.getByRole("button", { name: "Fix payment" }).click();
	await expect.poll(() => fixPaymentRequests.length).toBe(1);
	expect(JSON.parse(fixPaymentRequests[0] ?? "{}")).toEqual({
		deployment_id: "hdep_card_due",
	});
	expect(errors, `card payment recovery: ${errors.join(" | ")}`).toEqual([]);
});

test("compute plans keep signup credits without advertising subscription credit grants", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page, {
		deployments: [paidBasicDeployment],
		plans: [
			{ ...basicPlan, subscription_grant_credits: 500 },
			{ ...performancePlan, subscription_grant_credits: 1_000 },
		],
	});
	await page.goto("/channels?settings=billing-plan");

	const settingsDialog = page.getByTestId("settings-dialog");
	await expect(settingsDialog).toBeVisible();
	await expect(
		settingsDialog.getByText("$5.00 in AI Credits on signup", { exact: true }),
	).toBeVisible();
	await expect(settingsDialog).not.toContainText("AI Credits per subscription");
	await expect(settingsDialog).not.toContainText("AI Credits added to Wallet");
	await expect(settingsDialog).not.toContainText("credits do not expire");
	expect(errors, `compute plan comparison: ${errors.join(" | ")}`).toEqual([]);
});

test("command palette opens with Ctrl+K", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page);
	await page.goto("/channels");
	await expect(page.getByTestId("app-sidebar")).toBeVisible();
	await page.waitForLoadState("networkidle");

	await page.keyboard.press("Control+K");
	await expect(page.locator('[data-slot="command"]')).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `command palette: ${errors.join(" | ")}`).toEqual([]);
});

test("channels connect dialog opens without browser errors", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page);
	await page.goto("/channels");

	const connect = page.getByRole("button", { name: /connect a bot/i }).first();
	await expect(connect).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `channels render: ${errors.join(" | ")}`).toEqual([]);

	await expect(page.locator('[data-slot="tabs-list"]')).toHaveCount(0);
	await expect(page.getByText("Your channels").first()).toBeVisible();
	await expect(page.getByText("Shared bots").first()).toBeVisible();
	await expectNonZeroBox(page.locator('[data-sidebar="separator"]').first(), "sidebar separator");

	// Open the Base UI Dialog + interact with its provider picker.
	await connect.click();
	await expect(page.locator('[data-slot="dialog-content"]').first()).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `connect dialog: ${errors.join(" | ")}`).toEqual([]);
});
