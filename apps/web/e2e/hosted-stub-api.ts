import { createHash } from "node:crypto";
import type { DeployComponents, DeploymentRead } from "@clawdi/shared/api";
import { expect, type Page, type Route } from "@playwright/test";
import type { WalletState } from "../src/hosted/billing/contracts";

export type DeploymentComputeSubscription = NonNullable<
	NonNullable<DeploymentRead["commercial_display"]>["compute_subscription"]
>;

type PlanChangeProgress = DeployComponents["schemas"]["ComputePlanChangeProgress"];
type PlanChangeKind = PlanChangeProgress["changeKind"];
type SubscriptionListResponse = DeployComponents["schemas"]["V2ComputeSubscriptionListResponse"];
type ReusableSubscriptionsResponse =
	DeployComponents["schemas"]["V2ComputeReusableSubscriptionsResponse"];
type PlanChangeBillingEffect = PlanChangeProgress["billingEffect"];
type PlanChangeQuote = DeployComponents["schemas"]["V2ComputePlanChangeQuoteResponse"];
type PlanChangeOperation = DeployComponents["schemas"]["LongRunningOperation"];
type AccountNotification = DeployComponents["schemas"]["AccountNotificationResponse"];

function planChangeBillingEffect(changeKind: PlanChangeKind): PlanChangeBillingEffect {
	switch (changeKind) {
		case "immediate_upgrade":
			return "immediate_proration";
		case "scheduled_downgrade":
			return "period_end";
		case "funding_source_switch":
			return "future_renewals";
	}
}

export type DeploymentMutationFixture = {
	id: string;
	agent_id?: string;
	user_id: string;
	name: string;
	app_id: string;
	status: string;
	created_at: string;
	upgrade_available: boolean;
	upgrade_eligibility?: DeploymentRead["upgrade_eligibility"];
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
		runtime_configuration?: DeploymentRead["resource"]["spec"]["runtime_configuration"];
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

export function fixtureAgentId(
	deployment: Pick<DeploymentMutationFixture, "id" | "agent_id" | "config_info">,
) {
	if (deployment.agent_id) return deployment.agent_id;
	const hex = createHash("sha1")
		.update(`clawdi-hosted-e2e:${deployment.id}:${deployment.config_info.runtime}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDeploymentMutationFixture(value: unknown): value is DeploymentMutationFixture {
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

export function readSummaryState(
	status: string,
): NonNullable<DeploymentRead["resource"]["status"]>["summary_state"] {
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

export function readProviderAuthKind(
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

export function mutationDeploymentReadFixture(
	deployment: DeploymentMutationFixture,
): DeploymentRead {
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
		agent_id: fixtureAgentId(deployment),
		resource: {
			id: deployment.id,
			name: deployment.name,
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
				resources: {
					vcpu: config.compute_plan_slug === "compute_performance" ? 4 : 2,
					memory_mib: config.compute_plan_slug === "compute_performance" ? 8192 : 4096,
					disk_gib: config.compute_plan_slug === "compute_performance" ? 40 : 20,
				},
				agents: [],
				ports: [],
				runtime_configuration: config.runtime_configuration ?? { providers: [], features: [] },
				rollout_nonce: 0,
				secret_references: [],
			},
			status: {
				summary_state: summaryState,
				observedGeneration: 1,
				conditions: [],
				failure,
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
			? runtime === "hermes"
				? {
						runtime,
						role: "control_ui",
						url: runtimeUiUrl,
						auth_mode: "password",
						browser_mode: "embedded_and_top_level",
					}
				: {
						runtime,
						role: "control_ui",
						url: runtimeUiUrl,
						auth_mode: "openclaw_token",
						browser_mode: "embedded_and_top_level",
					}
			: null,
		accepted_operation: null,
		start_action: "start",
		commercial_display: {
			compute_subscription: deployment.compute_subscription ?? null,
			recovery_action: deployment.compute_subscription?.funding_source
				? (deployment.compute_subscription.recovery_action ?? null)
				: fundingFact?.fact_kind === "funding_revoked"
					? "start_new"
					: null,
			latest_funding_fact: fundingFact,
		},
		current_plan_slug: config.compute_plan_slug,
		upgrade_available: deployment.upgrade_available,
		upgrade_eligibility: deployment.upgrade_eligibility ?? {
			eligible: deployment.upgrade_available,
			reason: null,
		},
		compute_slot_occupancy: {
			occupies_slot: backingInfrastructure === "present",
			backing_infra: backingInfrastructure,
			reason:
				backingInfrastructure === "present" ? "backing_infra_present" : "authoritative_absence",
		},
	};
}

export function readDeploymentFixture(value: unknown): unknown {
	return isDeploymentMutationFixture(value) ? mutationDeploymentReadFixture(value) : value;
}

// HOSTED (Clawdi Cloud) smoke against the vite dev server with dev-auth-bypass
// (NO Clerk key needed) + deploy-api enabled so /deploy renders. Exercises the
// deploy wizard's Base UI Select asserting ZERO browser console/page errors.
//
// IMPORTANT: stub by API HOST, never with broad "**/v2/**" globs â€” the app's
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
const DEPLOY_API = process.env.E2E_HOSTED_DEPLOY_API_URL ?? "http://127.0.0.1:8001";

export const basicPlan = {
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

export const performancePlan = {
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

export const includedBasicDeployment = {
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
} satisfies DeploymentMutationFixture;

export const paidBasicDeployment = {
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
		actions: { cancel: "cancel_at_period_end", resume: false, command_state: null },
		current_period_end: "2027-07-15T00:00:00Z",
	},
} satisfies DeploymentMutationFixture;

export const performanceDeployment = {
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

export const stoppedIncludedBasicDeployment = {
	...includedBasicDeployment,
	id: "hdep_stopped",
	name: "Stopped Basic",
	status: "stopped",
};

export const missingProjectionEnvironmentId = "55555555-5555-4555-8555-555555555555";
export const missingProjectionFailureReason =
	"startup_probe_failing; restart_count=2; container failed readiness probe after the runtime bridge exhausted every startup attempt";
export const failedMissingProjectionDeployment = {
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

export const runningMissingProjectionDeployment = {
	...includedBasicDeployment,
	id: "hdep_running_projection",
	name: "Running projection agent",
	hermes_control_ui_url: "https://runtime.example/hermes",
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: missingProjectionEnvironmentId },
	},
};

export const retainedProjectionEnvironmentId = "66666666-6666-4666-8666-666666666666";
export const retainedProjectionFailureReason =
	"startup_probe_failing; restart_count=4; runtime daemon exited and is no longer reachable";
export const failedRetainedProjectionDeployment = {
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
export const newerSharedEnvironmentDeployment = {
	...includedBasicDeployment,
	id: "hdep_shared_newer",
	name: "Newer twin",
	created_at: "2026-07-15T00:00:00Z",
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: sharedLegacyEnvironmentId },
	},
};
export const olderSharedEnvironmentDeployment = {
	...newerSharedEnvironmentDeployment,
	id: "hdep_shared_older",
	name: "Older twin",
	status: "stopped",
	created_at: "2026-07-14T00:00:00Z",
};
export const sharedLegacyCloudAgent = {
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

export const interruptedIdentitylessDeployment = {
	...includedBasicDeployment,
	id: "hdep_creation_interrupted",
	name: "Interrupted deployment",
	status: "failed",
	failure_reason: "creation_interrupted",
};

export const walletState: WalletState = {
	balance_usd: "25.00",
	x402_enabled: false,
	x402_payment_authority: null,
	x402_payment_status: "idle",
	auto_reload_enabled: false,
	auto_reload_has_payment_method: false,
	auto_reload_card: null,
	auto_reload_currency: "usd",
	auto_reload_required_consent_version: "wallet_auto_reload_off_session_v2",
	auto_reload_amount_policy: "wallet_reload_configured_plus_negative_balance_v1",
	auto_reload_consent_version: null,
	auto_reload_consented_at: null,
	auto_reload_threshold_usd: "5.00",
	auto_reload_amount_cents: 2_500,
	auto_reload_monthly_cap_cents: 10_000,
	auto_reload_monthly_spent_cents: 0,
	auto_reload_period_end: "2026-09-01T00:00:00Z",
	auto_reload_status: "off",
	auto_reload_action: null,
};

export const walletActiveDeployment = {
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
		actions: { cancel: "cancel_at_period_end", resume: false, command_state: null },
		current_period_end: "2026-08-15T00:00:00Z",
	},
} satisfies DeploymentMutationFixture;

export const walletPastDueDeployment = {
	...walletActiveDeployment,
	compute_subscription: {
		...walletActiveDeployment.compute_subscription,
		status: "past_due",
		payment_state: "past_due",
		recovery_action: "top_up",
		latest_failed_invoice_id: "in_wallet_open",
		next_payment_attempt_at: "2026-07-16T00:00:00Z",
	},
};

export const cardPastDueDeployment = {
	...paidBasicDeployment,
	id: "hdep_card_due",
	name: "Card-funded Basic",
	compute_subscription: {
		...paidBasicDeployment.compute_subscription,
		status: "past_due",
		payment_state: "past_due",
		recovery_action: "fix_payment",
		latest_failed_invoice_id: "in_card_open",
		latest_failed_invoice_hosted_url: null,
		next_payment_attempt_at: "2026-07-16T00:00:00Z",
	},
};

export const terminalFallbackDeployment = {
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
	},
};

export const cancelPendingBasicDeployment = {
	...paidBasicDeployment,
	id: "hdep_cancel_pending",
	name: "Cancel-pending Basic",
	compute_subscription: {
		...paidBasicDeployment.compute_subscription,
		cancel_at_period_end: true,
		actions: { cancel: null, resume: true, command_state: null },
		cancel_at: "2027-07-15T00:00:00Z",
	},
} satisfies DeploymentMutationFixture;

export const walletAnnualDeployment = {
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

export function walletSubscriptionQuote({
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

export function planChangeQuoteResponse({
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
	amountUsd,
}: {
	operationId: string;
	subscriptionId: number;
	fundingSource: "stripe" | "wallet";
	currentPlanSlug: "compute_basic" | "compute_performance";
	targetPlanSlug: "compute_basic" | "compute_performance";
	currentBillingTermMonths: 1 | 12;
	targetBillingTermMonths: 1 | 12;
	changeKind: PlanChangeKind;
	effectiveAt: string;
	amountCents: number;
	amountUsd: string | null;
}): PlanChangeQuote {
	return {
		operation_id: operationId,
		subscription_id: subscriptionId,
		funding_source: fundingSource,
		current_plan_slug: currentPlanSlug,
		target_plan_slug: targetPlanSlug,
		current_billing_term_months: currentBillingTermMonths,
		target_billing_term_months: targetBillingTermMonths,
		change_kind: changeKind,
		billing_effect: planChangeBillingEffect(changeKind),
		status: "quoted",
		effective_at: effectiveAt,
		proration_date: "2026-07-16T00:00:00Z",
		expires_at: "2026-07-16T00:15:00Z",
		amount_cents: amountCents,
		amount_usd: amountUsd,
		currency: "usd",
		stripe_invoice_preview_id: "in_preview_browser",
	};
}

export function planChangeResponse({
	operationId,
	subscriptionId,
	fundingSource,
	currentPlanSlug,
	targetPlanSlug,
	targetBillingTermMonths,
	changeKind,
	status,
	effectiveAt,
}: {
	operationId: string;
	subscriptionId: number;
	fundingSource: "stripe" | "wallet";
	currentPlanSlug: "compute_basic" | "compute_performance";
	targetPlanSlug: "compute_basic" | "compute_performance";
	targetBillingTermMonths: 1 | 12;
	changeKind?: PlanChangeKind;
	status: "awaiting_payment" | "awaiting_projection" | "scheduled" | "complete";
	effectiveAt: string;
}): PlanChangeOperation {
	const resolvedChangeKind =
		changeKind ?? (status === "scheduled" ? "scheduled_downgrade" : "immediate_upgrade");
	const deploymentId = `hdep_plan_${subscriptionId}`;
	return {
		name: `operations/${operationId}`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId,
			verb: "plan_change",
			targetGeneration: 1,
			manifestETag: `plan-change-${operationId}`,
			createTime: effectiveAt,
			updateTime: effectiveAt,
			planChange: {
				"@type": "type.googleapis.com/clawdi.v2.ComputePlanChangeProgress",
				operationId,
				subscriptionId,
				fundingSource,
				changeKind: resolvedChangeKind,
				billingEffect: planChangeBillingEffect(resolvedChangeKind),
				sourcePlanSlug: currentPlanSlug,
				targetPlanSlug,
				targetBillingTermMonths,
				state: status,
				effectiveAt,
				fundingInvoiceId: status === "scheduled" ? null : "in_plan_browser",
			},
		},
		done: status === "complete" || status === "scheduled",
		error: null,
		response:
			status === "complete" || status === "scheduled"
				? {
						"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
						deployment: mutationDeploymentReadFixture({
							...paidBasicDeployment,
							id: deploymentId,
							config_info: {
								...paidBasicDeployment.config_info,
								compute_plan_slug: targetPlanSlug,
								runtime: "hermes",
							},
						}).resource,
					}
				: null,
	};
}

export type StubResponse = { body: unknown; status: number; delayMs?: number };

function isStubResponse(value: unknown): value is StubResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"body" in value &&
		"status" in value &&
		typeof value.status === "number"
	);
}

export type HostedApiStubOptions = {
	autoReloadRequests?: string[];
	autoReloadResponses?: StubResponse[];
	canUsePlanCBilling?: boolean;
	planBillingCapability?: { enabled: boolean };
	productAccessRequests?: string[];
	cancelRequests?: string[];
	cancelResponse?: DeployComponents["schemas"]["V2ComputeSubscriptionActionResponse"];
	checkoutIdempotencyKeys?: string[];
	checkoutRequests?: string[];
	checkoutResponses?: StubResponse[];
	cloudAgentOverrides?: Record<string, unknown>;
	cloudAgents?: readonly unknown[];
	cloudAgentsResponse?: StubResponse;
	cloudAgentErrors?: Record<string, { detail: string; status: number }>;
	cloudAgentNotFoundIds?: readonly string[];
	cloudAgentResponses?: Record<string, StubResponse[]>;
	createRequests?: string[];
	deleteRequests?: string[];
	deployments?: readonly unknown[];
	deploymentsResponse?: StubResponse;
	accountNotifications?: readonly AccountNotification[];
	fixPaymentRequests?: string[];
	plans?: readonly unknown[];
	planCMutationRequests?: string[];
	planChangeRequests?: string[];
	planChangeResponses?: unknown[];
	planQuoteRequests?: string[];
	planQuoteResponses?: unknown[];
	restartRequests?: string[];
	runtimeUiRedemptionRequests?: string[];
	runtimeUiRedemptionResponses?: StubResponse[];
	resumeRequests?: string[];
	reusableSubscriptionRequests?: string[];
	reusableSubscriptionPages?: Record<string, ReusableSubscriptionsResponse>;
	scheduledPlanCancellationRequests?: string[];
	scheduledPlanCancellationResponses?: StubResponse[];
	subscriptionPages?: Record<string, SubscriptionListResponse>;
	subscriptionQuoteRequests?: string[];
	subscriptionQuoteResponses?: unknown[];
	startError?: { status: number; detail: string; code?: string };
	startRequests?: string[];
	topUpIdempotencyKeys?: string[];
	topUpRequests?: string[];
	topUpResponses?: StubResponse[];
	walletState?: WalletState;
	onTopUpSuccess?: () => void;
	onWalletCheckoutSuccess?: () => void;
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function stubHostedApi(page: Page, options: HostedApiStubOptions = {}) {
	const deployments = options.deployments ?? [];
	const plans = options.plans ?? [];
	let accountNotifications = [...(options.accountNotifications ?? [])];
	let currentWallet = options.walletState ?? walletState;
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
		if (p === "/v1/me/notifications" && method === "GET") {
			return fulfillJson(r, {
				items: accountNotifications,
				unread_count: accountNotifications.filter((item) => item.read_at == null).length,
				next_cursor: null,
			});
		}
		if (p === "/v1/me/notifications/read-all" && method === "POST") {
			const readAt = new Date().toISOString();
			const unreadCount = accountNotifications.filter((item) => item.read_at == null).length;
			accountNotifications = accountNotifications.map((item) => ({
				...item,
				read_at: item.read_at ?? readAt,
			}));
			return fulfillJson(r, { updated_count: unreadCount });
		}
		const notificationMatch = p.match(/^\/v1\/me\/notifications\/([^/]+)$/);
		if (notificationMatch && method === "PATCH") {
			const notificationId = decodeURIComponent(notificationMatch[1] ?? "");
			const body = JSON.parse(r.request().postData() ?? "{}") as { read?: boolean };
			const index = accountNotifications.findIndex((item) => item.id === notificationId);
			if (index === -1) return fulfillJson(r, { detail: "Notification not found" }, 404);
			const updated = {
				...accountNotifications[index],
				read_at: body.read ? new Date().toISOString() : null,
			};
			accountNotifications[index] = updated;
			return fulfillJson(r, updated);
		}
		if (notificationMatch && method === "DELETE") {
			const notificationId = decodeURIComponent(notificationMatch[1] ?? "");
			accountNotifications = accountNotifications.filter((item) => item.id !== notificationId);
			return r.fulfill({ status: 204, body: "" });
		}
		if (p === "/v2/subscription/plans") return fulfillJson(r, plans);
		if (p === "/v2/subscriptions" && r.request().method() === "GET") {
			const cursor = new URL(r.request().url()).searchParams.get("cursor") ?? "initial";
			return fulfillJson(
				r,
				options.subscriptionPages?.[cursor] ?? {
					items: [],
					has_more: false,
					next_cursor: null,
				},
			);
		}
		if (p === "/v2/subscriptions/reusable" && r.request().method() === "GET") {
			options.reusableSubscriptionRequests?.push(r.request().url());
			const cursor = new URL(r.request().url()).searchParams.get("cursor") ?? "initial";
			return fulfillJson(
				r,
				options.reusableSubscriptionPages?.[cursor] ?? {
					items: [],
					has_more: false,
					next_cursor: null,
				},
			);
		}
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
				if (response.status < 400) currentWallet = response.body as WalletState;
				return fulfillJson(r, response.body, response.status);
			}
			const request = JSON.parse(requestBody) as Partial<typeof walletState>;
			currentWallet = { ...currentWallet, ...request };
			return fulfillJson(r, currentWallet);
		}
		if (p === "/v2/wallet/transactions" && r.request().method() === "GET") {
			return fulfillJson(r, { items: [], has_more: false, next_cursor: null });
		}
		if (p === "/v2/deployments" && r.request().method() === "GET") {
			if (new URL(r.request().url()).searchParams.get("eventStreamHandoff") === "true") {
				return fulfillJson(r, {
					snapshot_isolation: "REPEATABLE READ",
					read_only: true,
					deployments: deployments.map((deployment) => readDeploymentFixture(deployment)),
					operations: [],
					event_stream_cursor: "e2e-cursor-0",
				});
			}
			if (options.deploymentsResponse) {
				return fulfillJson(r, options.deploymentsResponse.body, options.deploymentsResponse.status);
			}
			// Flat mutation fixtures must go out as DeploymentRead rows.
			return fulfillJson(
				r,
				deployments.map((d) => readDeploymentFixture(d)),
			);
		}
		if (p === "/v2/deployments" && r.request().method() === "POST") {
			options.createRequests?.push(r.request().postData() ?? "");
			return fulfillJson(r, {
				...includedBasicDeployment,
				id: "hdep_created",
				name: "Created Basic",
				status: "starting",
			});
		}
		if (p === "/v2/subscription/checkout" && r.request().method() === "POST") {
			const requestBody = r.request().postData() ?? "";
			options.checkoutIdempotencyKeys?.push(r.request().headers()["idempotency-key"] ?? "");
			options.checkoutRequests?.push(requestBody);
			const request = JSON.parse(requestBody) as { funding_source?: string };
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
								deploy_request_id: "wallet-compute-deploy-browser",
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
				billing_effect: "immediate_proration",
				status: "quoted",
				effective_at: "2026-07-16T00:00:00Z",
				proration_date: "2026-07-16T00:00:00Z",
				expires_at: "2026-07-16T00:15:00Z",
				amount_cents: 1_000,
				amount_usd: null,
				currency: "usd",
				stripe_invoice_preview_id: "in_preview_browser",
			};
			return isStubResponse(response)
				? fulfillJson(r, response.body, response.status)
				: fulfillJson(r, response);
		}
		if (p === "/v2/subscription/plan/change" && r.request().method() === "POST") {
			options.planChangeRequests?.push(r.request().postData() ?? "");
			const response =
				options.planChangeResponses?.shift() ??
				planChangeResponse({
					operationId: "op_plan_browser",
					subscriptionId: 42,
					fundingSource: "stripe",
					currentPlanSlug: "compute_basic",
					targetPlanSlug: "compute_performance",
					targetBillingTermMonths: 1,
					status: "complete",
					effectiveAt: "2026-07-16T00:00:00Z",
				});
			return isStubResponse(response)
				? fulfillJson(r, response.body, response.status)
				: fulfillJson(r, response);
		}
		if (p === "/v2/subscription/plan/cancel-scheduled-change" && r.request().method() === "POST") {
			options.scheduledPlanCancellationRequests?.push(r.request().postData() ?? "");
			const response = options.scheduledPlanCancellationResponses?.shift() ?? {
				status: 200,
				body: {
					status: "active",
					funding_source: "stripe",
					billing_term_months: 12,
					cancel_at_period_end: false,
					pending_plan_slug: null,
					action_state: "removed",
				},
			};
			if (response.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
			return fulfillJson(r, response.body, response.status);
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
		if (p === "/v2/subscription/cancel" && r.request().method() === "POST") {
			options.cancelRequests?.push(r.request().postData() ?? "");
			return fulfillJson(
				r,
				options.cancelResponse ?? {
					status: "active",
					billing_term_months: 12,
					cancel_at_period_end: true,
					current_period_end: "2026-08-15T00:00:00Z",
					cancel_at: "2026-08-15T00:00:00Z",
				},
			);
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
			return fulfillJson(r, { status: "starting" });
		}
		if (p.endsWith("/runtime-ui/redemption") && r.request().method() === "POST") {
			options.runtimeUiRedemptionRequests?.push(p);
			const response = options.runtimeUiRedemptionResponses?.shift() ?? {
				status: 200,
				body: { url: "https://runtime.example/ui?clawdi_code=browser" },
			};
			return fulfillJson(r, response.body, response.status);
		}
		if (p.endsWith("/start") && r.request().method() === "POST") {
			options.startRequests?.push(r.request().postData() ?? "");
			if (options.startError) {
				const { status, ...body } = options.startError;
				return fulfillJson(r, body, status);
			}
			return fulfillJson(r, { status: "starting" });
		}
		if (p.startsWith("/v2/deployments/") && r.request().method() === "DELETE") {
			options.deleteRequests?.push(p);
			return fulfillJson(r, { status: "deleted", cvm_deleted: true });
		}
		if (/^\/v2\/deployments\/[^/]+\/events$/.test(p) && method === "GET") {
			return r.fulfill({
				status: 200,
				contentType: "text/event-stream",
				headers: { "Cache-Control": "no-store" },
				body: ": heartbeat\n\n",
			});
		}
		const workspaceSkillsMatch = p.match(/^\/v2\/deployments\/([^/]+)\/workspace-skills$/);
		if (workspaceSkillsMatch && method === "GET") {
			return fulfillJson(r, {
				deployment_id: decodeURIComponent(workspaceSkillsMatch[1] ?? ""),
				deployment_resource_version: "rv-workspace-skills",
				manifest_generation: 1,
				items: [],
			});
		}
		if (p.startsWith("/v2/deployments/") && r.request().method() === "GET") {
			const id = decodeURIComponent(p.slice("/v2/deployments/".length));
			const deployment = deployments.find(
				(d): d is typeof d & { id: string } =>
					typeof d === "object" && d !== null && (d as { id?: unknown }).id === id,
			);
			return deployment
				? fulfillJson(r, readDeploymentFixture(deployment))
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
		if (/^\/v1\/agents\/[^/]+\/project-bindings$/.test(p) && r.request().method() === "GET") {
			return fulfillJson(r, []);
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
		if (p === "/v1/connectors") return fulfillJson(r, []);
		if (p === "/v1/me/invitations") return fulfillJson(r, []);
		if (p === "/v1/projects") return fulfillJson(r, []);
		if (p === "/v1/sessions") return fulfillJson(r, emptyPage);
		if (p === "/v1/auth/keys") return fulfillJson(r, []);
		return fulfillJson(r, {});
	});
}

export async function expectNoQuarterlyCopy(page: Page) {
	await expect(page.getByText("Quarterly", { exact: true })).toHaveCount(0);
	await expect(page.getByText(/\/qtr/)).toHaveCount(0);
}

export async function capturePricingScreenshot(page: Page, path: string) {
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

export function collectBrowserErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	page.on("pageerror", (e) => {
		errors.push(e.message);
	});
	return errors;
}

export async function expectNonZeroBox(locator: ReturnType<Page["locator"]>, label: string) {
	const box = await locator.boundingBox();
	expect(box, `${label} should render a layout box`).not.toBeNull();
	expect(box?.width, `${label} width`).toBeGreaterThan(0);
	expect(box?.height, `${label} height`).toBeGreaterThan(0);
}

export async function gotoHostedAgentSettings(
	page: Page,
	agentId: string,
	tier: "Basic" | "Performance",
	search = "",
) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await page.goto(`/agents/${agentId}/settings${search}`);
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

export async function gotoHostedSettingsDialog(page: Page, section: string) {
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
