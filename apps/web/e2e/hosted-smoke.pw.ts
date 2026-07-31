import type { DeploymentRead } from "@clawdi/shared/api";
import { expect, type Page, type Route, test } from "@playwright/test";
import type { ManagedModelCatalogItem } from "../src/hosted/billing/contracts";
import {
	presetCatalogToProviderModels,
	providerPresetById,
} from "../src/hosted/v2/ai-providers/provider-presets";
import type { AiProvider } from "../src/hosted/v2/ai-providers/types";

declare global {
	interface Window {
		__stripeCheckoutClientSecrets?: string[];
		__stripeCheckoutLoadCalls?: number;
		__stripeConfirmCalls?: number;
	}
}

// HOSTED (Clawdi Cloud) smoke against the vite dev server with dev-auth-bypass
// (NO Clerk key needed) + deploy-api enabled so /deploy renders. Exercises the
// deploy wizard's Base UI Select asserting ZERO browser console/page errors.
//
// IMPORTANT: stub by API HOST, never with broad "**/v2/**" globs — the app's
// own modules live under /src/hosted/v2/... and a path glob would intercept
// them and break module loading.

function hostedUser(canUseV2 = true, canUseV1 = false) {
	return {
		capabilities: {
			can_use_v1: canUseV1,
			can_use_v2: canUseV2,
		},
	};
}
const emptyPage = { items: [], total: 0, page: 1, page_size: 25 };

// Must match the API hosts configured in playwright.hosted.config.ts.
const CLOUD_API = "http://127.0.0.1:8000";
const DEPLOY_API = "http://127.0.0.1:8001";

const textModelCapabilities: ManagedModelCatalogItem["capabilities"] = {
	context_window: 272_000,
	max_context_window: null,
	max_input_tokens: 272_000,
	max_output_tokens: 128_000,
	input_modalities: ["text", "image"],
	supports_vision: true,
	supports_reasoning: true,
	supports_tools: true,
};

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

const managedModelCatalog: { models: ManagedModelCatalogItem[] } = {
	models: [
		{
			id: "gpt-5.6-luna",
			display_name: "GPT-5.6-Luna",
			provider_id: "openai-codex",
			is_default: true,
			is_featured: true,
			description: "Low cost for routine work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.6-sol",
			display_name: "GPT-5.6-Sol",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: false,
			description: "Higher cost for complex work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.6-terra",
			display_name: "GPT-5.6-Terra",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: false,
			description: "Balanced cost for everyday work.",
			capabilities: textModelCapabilities,
		},
	],
};

const dynamicManagedModelCatalog: { models: ManagedModelCatalogItem[] } = {
	models: [
		{
			id: "gpt-5.6-terra",
			display_name: "GPT-5.6-Terra",
			provider_id: "openai-codex",
			is_default: true,
			is_featured: true,
			description: "Balanced cost for everyday work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.6-luna",
			display_name: "GPT-5.6-Luna",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: true,
			description: "Low cost for routine work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.6-sol",
			display_name: "GPT-5.6-Sol",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: true,
			description: "Higher cost for complex work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "k3",
			display_name: "Kimi K3",
			provider_id: "kimi-coding",
			is_default: false,
			is_featured: true,
			description: "Variable cost for long, detailed work.",
			capabilities: {
				...textModelCapabilities,
				context_window: 262_144,
				max_context_window: 1_048_576,
				max_input_tokens: 262_144,
				max_output_tokens: null,
				supports_tools: null,
			},
		},
		{
			id: "gpt-5.5",
			display_name: "GPT-5.5",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: false,
			description: "Higher cost for demanding work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.4",
			display_name: "GPT-5.4",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: false,
			description: "Balanced cost for coding and tools.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.4-mini",
			display_name: "GPT-5.4-Mini",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: false,
			description: "Low cost for lighter coding work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.2",
			display_name: "GPT-5.2",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: false,
			description: "Variable cost for general work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "kimi-for-coding-highspeed",
			display_name: "K2.7 Code HighSpeed",
			provider_id: "kimi-coding",
			is_default: false,
			is_featured: false,
			description: "Variable cost for faster coding work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "kimi-for-coding",
			display_name: "Kimi K2.7 Code",
			provider_id: "kimi-coding",
			is_default: false,
			is_featured: false,
			description: "Variable cost for coding work.",
			capabilities: textModelCapabilities,
		},
	],
};

const deepSeekProvider = {
	id: "row-deepseek-team",
	provider_id: "deepseek-primary",
	scope: "account_global",
	type: "custom_openai_compatible",
	label: "Research DeepSeek",
	base_url: "https://api.deepseek.com/v1",
	models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
	api_mode: "openai_chat",
	auth: { type: "api_key", source: "managed" },
	usable: true,
	readiness: {
		credential_material: "available",
		runtime_compatibility: { openclaw: true, hermes: true, codex: true },
		deployable: true,
		endpoint_reachability: "not_tested",
		inference_verification: "not_tested",
	},
	managed_by: "user",
	runtime_env_name: "DEEPSEEK_API_KEY",
	capabilities: null,
	created_at: "2026-07-15T00:00:00Z",
	updated_at: "2026-07-15T00:00:00Z",
};

const deepSeekProxyProvider = {
	...deepSeekProvider,
	id: "row-deepseek-proxy",
	provider_id: "deepseek-team",
	label: "DeepSeek proxy",
	base_url: "https://proxy.example.com/v1",
};

function userProvider(providerId: string, label: string, models: AiProvider["models"]): AiProvider {
	return {
		id: `row-${providerId}`,
		provider_id: providerId,
		scope: "user",
		type: "custom_openai_compatible",
		label,
		base_url: `https://${providerId}.example.com/v1`,
		models,
		api_mode: "openai_chat",
		auth: { type: "api_key", source: "managed" },
		usable: true,
		readiness: {
			credential_material: "available",
			runtime_compatibility: { openclaw: true, hermes: true, codex: true },
			deployable: true,
			endpoint_reachability: "not_tested",
			inference_verification: "not_tested",
		},
		managed_by: "user",
		runtime_env_name: "CUSTOM_API_KEY",
		capabilities: null,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
	};
}

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

// Mirrors the user-facing GET /v2/subscription/plans response. clawdi-hosted resolves
// the owner-approved Stripe prices from scripts/stripe/create-compute-{basic,performance}.py.
const basicPlan = {
	slug: "compute_basic",
	name: "Compute Basic",
	price_cents: 1_000,
	signup_grant_usd: "5",
	vcpu: 2,
	ram_gb: 4,
	disk_size: 20,
	instance_type: null,
	offers: [
		{
			billing_term_months: 1,
			price_cents: 1_000,
			effective_monthly_price_cents: 1_000,
			discount_percent: 0,
		},
		{
			billing_term_months: 12,
			price_cents: 10_000,
			effective_monthly_price_cents: 833,
			discount_percent: 17,
		},
	],
};

const performancePlan = {
	slug: "compute_performance",
	name: "Compute Performance",
	price_cents: 2_000,
	signup_grant_usd: "5",
	vcpu: 4,
	ram_gb: 8,
	disk_size: 40,
	instance_type: "tdx.large",
	offers: [
		{
			billing_term_months: 1,
			price_cents: 2_000,
			effective_monthly_price_cents: 2_000,
			discount_percent: 0,
		},
		{
			billing_term_months: 12,
			price_cents: 20_000,
			effective_monthly_price_cents: 1_666,
			discount_percent: 17,
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

const paidBasicDeployment: DeploymentMutationFixture = {
	...includedBasicDeployment,
	id: "hdep_paid",
	name: "Paid Basic",
	compute_subscription: {
		subscription_id: 42,
		status: "active",
		funding_source: "stripe",
		payment_state: "ok",
		billing_term_months: 12,
		price_cents: 10_000,
		currency: "usd",
		cancel_at_period_end: false,
		current_period_end: "2027-07-15T00:00:00Z",
	},
};

const openClawIncludedDeployment: DeploymentMutationFixture = {
	...includedBasicDeployment,
	id: "hdep_openclaw_included",
	name: "OpenClaw included Basic",
	openclaw_control_ui_url: "https://runtime.example/openclaw/",
	config_info: {
		...includedBasicDeployment.config_info,
		runtime: "openclaw",
	},
};

const performanceDeployment = {
	...paidBasicDeployment,
	id: "hdep_performance",
	name: "Performance agent",
	compute_subscription: {
		...paidBasicDeployment.compute_subscription,
		price_cents: 20_000,
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

const stoppedProjectionEnvironmentId = "44444444-4444-4444-8444-444444444444";
const stoppedProjectionGoneDeployment: DeploymentMutationFixture = {
	...includedBasicDeployment,
	id: "hdep_stopped_projection_gone",
	name: "deployment-create-browser-generated",
	status: "stopped",
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: {},
	},
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
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: missingProjectionEnvironmentId },
	},
};

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

const railHostedEnvironmentId = "88888888-8888-4888-8888-888888888888";
const railConnectedEnvironmentId = "99999999-9999-4999-8999-999999999999";
const railHostedDeployment = {
	...includedBasicDeployment,
	id: "hdep_rail_cloud",
	name: "Rail Cloud",
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: railHostedEnvironmentId },
	},
};
const railConnectedCloudAgent = {
	...sharedLegacyCloudAgent,
	id: railConnectedEnvironmentId,
	name: "rail-connected",
	default_name: "Rail Connected",
	machine_name: "rail-connected.local",
	display_name: "Rail Connected",
	sort_order: 1,
};
const railHostedCloudAgent = {
	...sharedLegacyCloudAgent,
	id: railHostedEnvironmentId,
	name: "rail-cloud",
	default_name: "Rail Cloud",
	machine_name: "rail-cloud.local",
	display_name: "Rail Cloud projection",
	sort_order: 0,
};

const interruptedIdentitylessDeployment = {
	...includedBasicDeployment,
	id: "hdep_creation_interrupted",
	name: "Interrupted deployment",
	status: "failed",
	failure_reason: "creation_interrupted",
};

const walletState = {
	balance_usd: "25.00",
	x402_enabled: false,
	auto_reload_enabled: false,
	auto_reload_threshold_usd: "5.00",
	auto_reload_amount_cents: 2_500,
	auto_reload_monthly_cap_cents: 10_000,
	auto_reload_action: null,
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
		price_cents: 1_000,
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
	status: "creating",
	compute_subscription: {
		...walletActiveDeployment.compute_subscription,
		billing_term_months: 12,
		price_cents: 10_000,
		current_period_end: "2027-07-15T00:00:00Z",
	},
};

function walletSubscriptionQuote({
	planSlug,
	billingTermMonths,
	termPriceCents,
	debitAmountUsd,
	balanceBeforeUsd,
	balanceAfterUsd,
}: {
	planSlug: "compute_basic" | "compute_performance";
	billingTermMonths: 1 | 12;
	termPriceCents: number;
	debitAmountUsd: string;
	balanceBeforeUsd: string;
	balanceAfterUsd: string;
}) {
	return {
		plan_slug: planSlug,
		billing_term_months: billingTermMonths,
		funding_source: "wallet",
		currency: "usd",
		term_price_cents: termPriceCents,
		preview_invoice_id: `upcoming_${planSlug}_${billingTermMonths}`,
		expires_at: "2026-07-16T00:15:00Z",
		debit_amount_usd: debitAmountUsd,
		balance_before_usd: balanceBeforeUsd,
		balance_after_usd: balanceAfterUsd,
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
	amountUsd,
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
	amountUsd: string | null;
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
		amount_usd: amountUsd,
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
		status: 202,
		body: {
			name: `operations/${operationId}`,
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: `hdep_plan_${subscriptionId}`,
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
			response: null,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkoutDeployRequestId(requestBody: string): string | null {
	const request: unknown = JSON.parse(requestBody);
	if (!isRecord(request) || !isRecord(request.deploy_config)) return null;
	return typeof request.deploy_config.deploy_request_id === "string"
		? request.deploy_config.deploy_request_id
		: null;
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

function readSummaryState(
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
				runtime_configuration: config.runtime_configuration ?? { providers: [], features: [] },
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
		commercial_display: {
			compute_subscription: deployment.compute_subscription ?? null,
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

function completedDeploymentOperation(
	deployment: DeploymentMutationFixture,
	verb: "create" | "start" | "stop" | "restart" | "delete" | "update" | "reset_runtime_ui_access",
): NonNullable<DeploymentRead["accepted_operation"]> {
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

function failedDeletionReadFixture(
	deployment: DeploymentMutationFixture,
	retryable: boolean,
): DeploymentRead {
	const read = mutationDeploymentReadFixture({ ...deployment, status: "failed" });
	const status = read.resource.status;
	if (status === null) throw new Error("Failed deletion fixture requires deployment status");
	return {
		...read,
		accepted_operation: completedDeploymentOperation(deployment, "delete"),
		resource: {
			...read.resource,
			status: {
				...status,
				failure: {
					type: "https://api.clawdi.ai/problems/deployment-delete-failed",
					title: "Deployment deletion failed",
					status: 409,
					detail: "The deployment could not be deleted.",
					instance: deployment.id,
					code: "deployment_delete_failed",
					phase: "delete",
					retryable,
					conditionReason: "DeploymentDeleteFailed",
					conditionMessage: "The deployment could not be deleted.",
					observedGeneration: 2,
				},
			},
		},
	};
}

function acceptedDeletionReadFixture(deployment: DeploymentMutationFixture): DeploymentRead {
	const read = mutationDeploymentReadFixture({ ...deployment, status: "deleting" });
	const operation = completedDeploymentOperation(deployment, "delete");
	return {
		...read,
		accepted_operation: { ...operation, done: false, response: null },
		compute_slot_occupancy: {
			occupies_slot: false,
			backing_infra: "present",
			reason: "delete_accepted",
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
	aiProviders?: readonly unknown[];
	agentOrderRequests?: string[];
	autoReloadRequests?: string[];
	autoReloadResponses?: StubResponse[];
	billingHistoryRequests?: string[];
	billingHistoryResponses?: unknown[];
	canCreateCloudAgents?: boolean;
	canUseLegacyHostedDashboard?: boolean;
	productAccessRequests?: string[];
	cancelRequests?: string[];
	cancelResponses?: StubResponse[];
	checkoutRequests?: string[];
	checkoutResponses?: StubResponse[];
	channelAccount?: unknown;
	channelAccounts?: unknown[];
	channelAgentLinks?: readonly unknown[];
	channelBindings?: unknown[];
	channelBotPool?: unknown;
	channelHealthItems?: unknown[];
	linkAgentRequests?: Array<{ accountId: string; body: string }>;
	linkAgentResponses?: StubResponse[];
	unlinkAgentRequests?: string[];
	onLinkAgent?: (response: unknown) => void;
	createChannelRequests?: string[];
	createChannelResponse?: unknown;
	deleteBindingRequests?: string[];
	deleteBindingResponses?: StubResponse[];
	onCreateChannel?: (response: unknown) => void;
	pairCodeRequests?: string[];
	pairCodeResponses?: StubResponse[];
	cloudAgentOverrides?: Record<string, unknown>;
	cloudAgents?: readonly unknown[];
	cloudAgentsResponse?: StubResponse;
	cloudAgentErrors?: Record<string, { detail: string; status: number }>;
	cloudAgentNotFoundIds?: readonly string[];
	cloudAgentResponses?: Record<string, StubResponse[]>;
	createDeploymentResponse?: StubResponse;
	createDeploymentRequests?: Array<{ body: string; idempotencyKey: string | null }>;
	deleteRequestBodies?: string[];
	deleteRequests?: string[];
	completedDeleteIds?: Set<string>;
	failedDeleteRetryability?: Map<string, boolean>;
	deleteResponses?: StubResponse[];
	deploymentListRequests?: string[];
	deploymentListResponses?: unknown[][];
	deploymentListResponseGates?: Array<Promise<void> | undefined>;
	deploymentRequestReads?: string[];
	deployments?: readonly unknown[];
	deploymentsResponse?: StubResponse;
	fixPaymentRequests?: string[];
	ledgerResponseForRequest?: (limit: number) => unknown;
	ledgerRequests?: string[];
	ledgerResponses?: unknown[];
	legacyAgentEnvironmentIds?: readonly string[];
	managedModels?: typeof managedModelCatalog;
	planRequests?: string[];
	mutationOrder?: string[];
	plans?: readonly unknown[];
	portalRequests?: string[];
	planChangeOperationResponses?: StubResponse[];
	planChangeRequests?: string[];
	planChangeResponses?: unknown[];
	planQuoteRequests?: string[];
	planQuoteResponses?: unknown[];
	providerAcceptRequests?: string[];
	providerAcceptResponses?: StubResponse[];
	providerDraftTestRequests?: string[];
	providerDraftTestResponses?: StubResponse[];
	providerOAuthStartRequests?: string[];
	providerOAuthStartResponses?: StubResponse[];
	providerPatchRequests?: string[];
	providerPatchResponses?: StubResponse[];
	providerTestRequests?: string[];
	restartRequests?: string[];
	runtimeUiRedemptionRequests?: string[];
	runtimeUiRedemptionResponses?: StubResponse[];
	runtimeUiResetRequests?: Array<{ idempotencyKey: string | null; ifMatch: string | null }>;
	resumeRequests?: string[];
	subscriptionQuoteRequests?: string[];
	subscriptionQuoteResponses?: unknown[];
	startError?: { status: number; detail: string };
	startRequests?: string[];
	topUpIdempotencyKeys?: string[];
	topUpRequests?: string[];
	topUpResponses?: StubResponse[];
	unfinishedDeploymentRequests?: boolean;
	updateDeploymentRequests?: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}>;
	walletState?: typeof walletState;
	walletRequests?: string[];
	walletResponses?: StubResponse[];
	onTopUpSuccess?: () => void;
	onWalletCheckoutSuccess?: () => void;
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubCompletedStripeCheckout(page: Page) {
	await page.addInitScript(() => {
		const mockStripe = Object.assign(
			() => {
				const session = { canConfirm: true, status: { type: "open" } };
				const actions = {
					getSession: () => session,
					confirm: async () => ({
						type: "success",
						session: { status: { type: "complete" } },
					}),
				};
				return {
					elements: () => ({}),
					createToken: async () => ({}),
					createPaymentMethod: async () => ({}),
					confirmCardPayment: async () => ({}),
					_registerWrapper: () => undefined,
					initCheckoutElementsSdk: () => ({
						loadActions: async () => ({ type: "success", actions }),
						on: () => undefined,
						changeAppearance: () => undefined,
						loadFonts: () => undefined,
						createPaymentElement: () => ({
							mount: (node: HTMLElement) => {
								node.textContent = "Mock secure payment form";
							},
							on: () => undefined,
							off: () => undefined,
							update: () => undefined,
							destroy: () => undefined,
						}),
					}),
				};
			},
			{ version: "dahlia" },
		);
		Object.defineProperty(window, "Stripe", { configurable: true, value: mockStripe });
	});
}

async function stubRetriedStripeCheckoutLoad(page: Page) {
	await page.addInitScript(() => {
		const browserState = window;
		browserState.__stripeCheckoutClientSecrets = [];
		browserState.__stripeCheckoutLoadCalls = 0;
		browserState.__stripeConfirmCalls = 0;
		const mockStripe = Object.assign(
			() => ({
				elements: () => ({}),
				createToken: async () => ({}),
				createPaymentMethod: async () => ({}),
				confirmCardPayment: async () => {
					browserState.__stripeConfirmCalls = (browserState.__stripeConfirmCalls ?? 0) + 1;
					return {};
				},
				_registerWrapper: () => undefined,
				initCheckoutElementsSdk: (options: { clientSecret?: string }) => {
					browserState.__stripeCheckoutClientSecrets?.push(options.clientSecret ?? "");
					browserState.__stripeCheckoutLoadCalls =
						(browserState.__stripeCheckoutLoadCalls ?? 0) + 1;
					const failThisLoad = browserState.__stripeCheckoutLoadCalls === 1;
					const session = { canConfirm: true, status: { type: "open" } };
					const actions = {
						getSession: () => session,
						confirm: async () => {
							browserState.__stripeConfirmCalls = (browserState.__stripeConfirmCalls ?? 0) + 1;
							return {
								type: "success",
								session: { status: { type: "complete" } },
							};
						},
					};
					return {
						loadActions: async () =>
							failThisLoad
								? {
										type: "error",
										error: { message: "Mock Elements load failure" },
									}
								: { type: "success", actions },
						on: () => undefined,
						changeAppearance: () => undefined,
						loadFonts: () => undefined,
						createPaymentElement: () => ({
							mount: (node: HTMLElement) => {
								node.textContent = "Mock retried secure payment form";
							},
							on: () => undefined,
							off: () => undefined,
							update: () => undefined,
							destroy: () => undefined,
						}),
					};
				},
			}),
			{ version: "dahlia" },
		);
		Object.defineProperty(window, "Stripe", { configurable: true, value: mockStripe });
	});
}

async function stubHostedApi(page: Page, options: HostedApiStubOptions = {}) {
	const deployments = options.deployments ?? [];
	const acceptedDeleteIds = new Set<string>();
	const completedDeleteIds = options.completedDeleteIds ?? new Set<string>();
	const plans = options.plans ?? [];
	let currentWallet = options.walletState ?? walletState;
	const deploymentRequests = new Map<string, DeploymentMutationFixture>();
	// Deploy API (/me, /v2/*).
	await page.route(`${DEPLOY_API}/**`, async (r) => {
		const p = new URL(r.request().url()).pathname;
		if (p === "/me" || p === "/v1/me") {
			options.productAccessRequests?.push(`DEPLOY ${p}`);
			return fulfillJson(
				r,
				hostedUser(
					options.canCreateCloudAgents ?? true,
					options.canUseLegacyHostedDashboard ?? false,
				),
			);
		}
		if (p === "/v1/agent-environments") {
			return fulfillJson(r, {
				environment_ids: options.legacyAgentEnvironmentIds ?? [],
			});
		}
		if (p === "/v2/subscription/plans") {
			options.planRequests?.push(r.request().url());
			return fulfillJson(r, plans);
		}
		if (p === "/v2/ai-providers/managed/models") {
			return fulfillJson(r, options.managedModels ?? managedModelCatalog);
		}
		if (p === "/v2/wallet" && r.request().method() === "GET") {
			options.walletRequests?.push(r.request().url());
			const response = options.walletResponses?.shift();
			if (response) {
				if (response.status < 400) currentWallet = response.body as typeof walletState;
				return fulfillJson(r, response.body, response.status);
			}
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
			options.deploymentListRequests?.push(p);
			const deploymentListResponse = options.deploymentListResponses?.shift();
			const deploymentListResponseGate = options.deploymentListResponseGates?.shift();
			if (deploymentListResponse) {
				await deploymentListResponseGate;
				return fulfillJson(
					r,
					deploymentListResponse.map((deployment) =>
						isDeploymentMutationFixture(deployment)
							? readDeploymentFixture(deployment)
							: deployment,
					),
				);
			}
			if (options.deploymentsResponse) {
				if (options.deploymentsResponse.delayMs) {
					await new Promise((resolve) => setTimeout(resolve, options.deploymentsResponse?.delayMs));
				}
				return fulfillJson(r, options.deploymentsResponse.body, options.deploymentsResponse.status);
			}
			return fulfillJson(
				r,
				deployments
					.filter(
						(deployment) =>
							!isDeploymentMutationFixture(deployment) || !completedDeleteIds.has(deployment.id),
					)
					.map((deployment) =>
						isDeploymentMutationFixture(deployment) && acceptedDeleteIds.has(deployment.id)
							? options.failedDeleteRetryability?.has(deployment.id)
								? failedDeletionReadFixture(
										deployment,
										options.failedDeleteRetryability.get(deployment.id) ?? false,
									)
								: acceptedDeletionReadFixture(deployment)
							: readDeploymentFixture(deployment),
					),
			);
		}
		if (p === "/v2/deployments" && r.request().method() === "POST") {
			options.createDeploymentRequests?.push({
				body: r.request().postData() ?? "",
				idempotencyKey: r.request().headers()["idempotency-key"] ?? null,
			});
			const response = options.createDeploymentResponse;
			if (response) return fulfillJson(r, response.body, response.status);
			return fulfillJson(
				r,
				completedDeploymentOperation(
					{
						...includedBasicDeployment,
						id: "hdep_included_created",
						name: "Created included Basic",
						status: "running",
					},
					"create",
				),
				202,
			);
		}
		if (p.startsWith("/v2/deployments/by-request/") && r.request().method() === "GET") {
			const deployRequestId = decodeURIComponent(p.slice("/v2/deployments/by-request/".length));
			options.deploymentRequestReads?.push(deployRequestId);
			const deployment = deploymentRequests.get(deployRequestId);
			if (!deployment) {
				return fulfillJson(r, { detail: "Deployment request not found" }, 404);
			}
			const acceptedOperation = completedDeploymentOperation(deployment, "create");
			const unfinished = options.unfinishedDeploymentRequests ?? false;
			return fulfillJson(r, {
				deploy_request_id: deployRequestId,
				request_status: unfinished ? "processing" : "succeeded",
				lineage_tail: {
					deployment_id: deployment.id,
					lineage_version: 1,
					lineage_state: unfinished ? "processing" : "succeeded",
					operation: unfinished
						? { ...acceptedOperation, done: false, response: null }
						: acceptedOperation,
				},
			});
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
		if (p === "/v2/subscription/checkout" && r.request().method() === "POST") {
			const requestBody = r.request().postData() ?? "";
			options.checkoutRequests?.push(requestBody);
			const request = JSON.parse(requestBody) as {
				funding_source?: string;
				deploy_config?: { deploy_request_id?: string };
				quote?: {
					debit_amount_usd?: string | null;
					balance_after_usd?: string | null;
				};
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
								debited_usd: request.quote?.debit_amount_usd ?? null,
								balance_after_usd: request.quote?.balance_after_usd ?? null,
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
			if (response.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
			if (response.status < 400 && request.funding_source === "wallet") {
				options.onWalletCheckoutSuccess?.();
			}
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v2/subscription/quote" && r.request().method() === "POST") {
			const requestBody = r.request().postData() ?? "";
			options.subscriptionQuoteRequests?.push(requestBody);
			const request = JSON.parse(requestBody) as {
				plan_slug?: "compute_basic" | "compute_performance";
				billing_term_months?: 1 | 12;
			};
			const planSlug =
				request.plan_slug === "compute_performance" ? "compute_performance" : "compute_basic";
			const billingTermMonths = request.billing_term_months === 12 ? 12 : 1;
			const plan = planSlug === "compute_performance" ? performancePlan : basicPlan;
			const offer = plan.offers.find(
				(candidate) => candidate.billing_term_months === billingTermMonths,
			);
			if (!offer) throw new Error("Missing hosted smoke billing offer fixture");
			const balanceBeforeUsd = currentWallet.balance_usd;
			const debitAmountUsd = (offer.price_cents / 100).toFixed(2);
			const balanceAfterUsd = (Number(balanceBeforeUsd) - offer.price_cents / 100).toFixed(2);
			const response =
				options.subscriptionQuoteResponses?.shift() ??
				walletSubscriptionQuote({
					planSlug,
					billingTermMonths,
					termPriceCents: offer.price_cents,
					debitAmountUsd,
					balanceBeforeUsd,
					balanceAfterUsd,
				});
			if (isStubResponse(response) && response.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
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
		if (p.startsWith("/v2/operations/") && r.request().method() === "GET") {
			const response = options.planChangeOperationResponses?.shift();
			if (response?.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
			return response
				? fulfillJson(r, response.body, response.status)
				: fulfillJson(r, { detail: "Operation not found" }, 404);
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
					amount_usd: "25.00",
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
		if (p === "/v2/subscription/portal" && r.request().method() === "POST") {
			options.portalRequests?.push(r.request().postData() ?? "");
			return fulfillJson(r, { portal_url: "/channels?portal=opened" });
		}
		if (p === "/v2/subscription/cancel" && r.request().method() === "POST") {
			options.cancelRequests?.push(r.request().postData() ?? "");
			options.mutationOrder?.push("cancel");
			const response = options.cancelResponses?.shift();
			if (response) return fulfillJson(r, response.body, response.status);
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
		if (
			p.startsWith("/v2/deployments/") &&
			!p.slice("/v2/deployments/".length).includes("/") &&
			r.request().method() === "PATCH"
		) {
			const deploymentId = decodeURIComponent(p.slice("/v2/deployments/".length));
			options.updateDeploymentRequests?.push({
				body: r.request().postData() ?? "",
				idempotencyKey: r.request().headers()["idempotency-key"] ?? null,
				ifMatch: r.request().headers()["if-match"] ?? null,
			});
			const deployment = deployments.find(
				(candidate): candidate is DeploymentMutationFixture =>
					isDeploymentMutationFixture(candidate) && candidate.id === deploymentId,
			);
			return deployment
				? fulfillJson(r, completedDeploymentOperation(deployment, "update"), 202)
				: fulfillJson(r, { detail: "Deployment not found" }, 404);
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
		if (p.endsWith("/runtime-ui/credentials") && r.request().method() === "POST") {
			options.runtimeUiRedemptionRequests?.push(p);
			const deploymentId = p.split("/")[3] ?? "";
			const response = options.runtimeUiRedemptionResponses?.shift() ?? {
				status: 200,
				body: {
					runtime: "hermes",
					url: "https://runtime.example/hermes",
					deployment_resource_version: `rv_${deploymentId}`,
					auth_mode: "password",
					username: "admin",
					password: "test-password",
				},
			};
			return fulfillJson(r, response.body, response.status);
		}
		if (p.endsWith("/runtime-ui/access/reset") && r.request().method() === "POST") {
			options.runtimeUiResetRequests?.push({
				idempotencyKey: r.request().headers()["idempotency-key"] ?? null,
				ifMatch: r.request().headers()["if-match"] ?? null,
			});
			const deploymentId = p.split("/")[3] ?? "";
			const deployment = deployments.find(
				(candidate): candidate is DeploymentMutationFixture =>
					isDeploymentMutationFixture(candidate) && candidate.id === deploymentId,
			);
			return deployment
				? fulfillJson(r, completedDeploymentOperation(deployment, "reset_runtime_ui_access"), 202)
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
			options.deleteRequestBodies?.push(r.request().postData() ?? "");
			options.deleteRequests?.push(p);
			options.mutationOrder?.push("delete");
			const response = options.deleteResponses?.shift();
			if (response) return fulfillJson(r, response.body, response.status);
			const deploymentId = p.slice("/v2/deployments/".length);
			const deployment = deployments.find(
				(candidate): candidate is DeploymentMutationFixture =>
					isDeploymentMutationFixture(candidate) && candidate.id === deploymentId,
			);
			if (!deployment) return fulfillJson(r, { detail: "Deployment not found" }, 404);
			acceptedDeleteIds.add(deployment.id);
			const operation = completedDeploymentOperation(deployment, "delete");
			return fulfillJson(r, { ...operation, done: false, response: null }, 202);
		}
		return fulfillJson(r, {});
	});
	// Cloud API (/v1/*).
	await page.route(`${CLOUD_API}/**`, async (r) => {
		const p = new URL(r.request().url()).pathname;
		if (p === "/v1/me") {
			options.productAccessRequests?.push(`CLOUD ${p}`);
			return fulfillJson(
				r,
				hostedUser(
					options.canCreateCloudAgents ?? true,
					options.canUseLegacyHostedDashboard ?? false,
				),
			);
		}
		if (p === "/v1/agents") {
			return options.cloudAgentsResponse
				? fulfillJson(r, options.cloudAgentsResponse.body, options.cloudAgentsResponse.status)
				: fulfillJson(r, options.cloudAgents ?? []);
		}
		if (p === "/v1/agents/order" && r.request().method() === "PATCH") {
			const postData = r.request().postData() ?? "";
			options.agentOrderRequests?.push(postData);
			const body: unknown = JSON.parse(postData || "{}");
			const agentIds =
				isRecord(body) && Array.isArray(body.agent_ids)
					? body.agent_ids.filter((id): id is string => typeof id === "string")
					: [];
			const agentsById = new Map(
				(options.cloudAgents ?? [])
					.filter(isRecord)
					.flatMap((agent) => (typeof agent.id === "string" ? [[agent.id, agent] as const] : [])),
			);
			return fulfillJson(
				r,
				agentIds.flatMap((id, sortOrder) => {
					const agent = agentsById.get(id);
					return agent ? [{ ...agent, sort_order: sortOrder }] : [];
				}),
			);
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
		if (p === "/v1/ai-providers") {
			return fulfillJson(r, { providers: options.aiProviders ?? [] });
		}
		if (p === "/v1/ai-providers/accept" && r.request().method() === "POST") {
			options.providerAcceptRequests?.push(r.request().postData() ?? "");
			const response = options.providerAcceptResponses?.shift() ?? {
				status: 500,
				body: { detail: "No provider accept response configured" },
			};
			return fulfillJson(r, response.body, response.status);
		}
		if (p.match(/^\/v1\/ai-providers\/[^/]+$/) && r.request().method() === "PATCH") {
			options.providerPatchRequests?.push(r.request().postData() ?? "");
			const response = options.providerPatchResponses?.shift() ?? {
				status: 200,
				body: deepSeekProvider,
			};
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v1/ai-providers/test" && r.request().method() === "POST") {
			options.providerDraftTestRequests?.push(r.request().postData() ?? "");
			const response = options.providerDraftTestResponses?.shift() ?? {
				status: 200,
				body: { ok: true, readiness: deepSeekProvider.readiness, error: null },
			};
			if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			return fulfillJson(r, response.body, response.status);
		}
		if (
			p.match(/^\/v1\/ai-providers\/[^/]+\/auth\/oauth\/device\/start$/) &&
			r.request().method() === "POST"
		) {
			options.providerOAuthStartRequests?.push(r.request().postData() ?? "");
			const response = options.providerOAuthStartResponses?.shift() ?? {
				status: 500,
				body: { detail: "No provider OAuth response configured" },
			};
			return fulfillJson(r, response.body, response.status);
		}
		if (p.match(/^\/v1\/ai-providers\/[^/]+\/test$/) && r.request().method() === "POST") {
			options.providerTestRequests?.push(r.request().url());
			return fulfillJson(r, {
				ok: true,
				readiness: {
					...deepSeekProvider.readiness,
					endpoint_reachability: "reachable",
					inference_verification: "verified",
				},
				error: null,
			});
		}
		if (p === "/v1/channels" && r.request().method() === "GET") {
			return fulfillJson(
				r,
				options.channelAccounts ?? (options.channelAccount ? [options.channelAccount] : []),
			);
		}
		if (p === "/v1/channels" && r.request().method() === "POST") {
			options.createChannelRequests?.push(r.request().postData() ?? "");
			const response = options.createChannelResponse ?? {};
			options.onCreateChannel?.(response);
			return fulfillJson(r, response, 201);
		}
		if (p === "/v1/channels/bot-pool") {
			return fulfillJson(r, options.channelBotPool ?? { providers: {} });
		}
		if (p === "/v1/channels/health") {
			return fulfillJson(r, { items: options.channelHealthItems ?? [] });
		}
		if (p === "/v1/channels/agent-links" && r.request().method() === "GET") {
			const requestedAgentId = new URL(r.request().url()).searchParams.get("agent_id");
			const links = options.channelAgentLinks ?? [];
			return fulfillJson(
				r,
				requestedAgentId
					? links.filter((link) => isRecord(link) && link.agent_id === requestedAgentId)
					: links,
			);
		}
		if (p.match(/^\/v1\/channels\/[^/]+$/) && r.request().method() === "GET") {
			return fulfillJson(r, options.channelAccount ?? { detail: "Channel not found" }, 200);
		}
		if (p.endsWith("/agent-links") && r.request().method() === "GET") {
			const match = p.match(/^\/v1\/channels\/([^/]+)\/agent-links$/);
			const accountId = match?.[1] ? decodeURIComponent(match[1]) : null;
			return fulfillJson(
				r,
				accountId
					? (options.channelAgentLinks ?? []).filter(
							(link) => isRecord(link) && link.account_id === accountId,
						)
					: [],
			);
		}
		if (p.endsWith("/agent-links") && r.request().method() === "POST") {
			const match = p.match(/^\/v1\/channels\/([^/]+)\/agent-links$/);
			const accountId = match?.[1] ? decodeURIComponent(match[1]) : "";
			options.linkAgentRequests?.push({
				accountId,
				body: r.request().postData() ?? "",
			});
			const response = options.linkAgentResponses?.shift() ?? { body: {}, status: 201 };
			if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			if (response.status < 400) options.onLinkAgent?.(response.body);
			return fulfillJson(r, response.body, response.status);
		}
		if (p.match(/\/agent-links\/[^/]+$/) && r.request().method() === "DELETE") {
			options.unlinkAgentRequests?.push(p);
			return fulfillJson(r, { unlinked: true });
		}
		if (p.endsWith("/pair-codes") && r.request().method() === "POST") {
			options.pairCodeRequests?.push(r.request().postData() ?? "");
			const response = options.pairCodeResponses?.shift() ?? { body: {}, status: 201 };
			return fulfillJson(r, response.body, response.status);
		}
		if (p.match(/\/bindings\/[^/]+$/) && r.request().method() === "DELETE") {
			options.deleteBindingRequests?.push(p);
			const response = options.deleteBindingResponses?.shift() ?? {
				body: {
					binding_id: p.slice(p.lastIndexOf("/") + 1),
					unpaired: true,
					notification_status: "sent",
					provider_cleanup_status: "succeeded",
					warning: null,
				},
				status: 200,
			};
			if (response.status < 400) {
				const bindingId = p.slice(p.lastIndexOf("/") + 1);
				const index = options.channelBindings?.findIndex(
					(binding) => isRecord(binding) && binding.id === bindingId,
				);
				if (index !== undefined && index >= 0) options.channelBindings?.splice(index, 1);
			}
			return fulfillJson(r, response.body, response.status);
		}
		if (p.endsWith("/bindings") && r.request().method() === "GET") {
			const match = p.match(/^\/v1\/channels\/([^/]+)\/bindings$/);
			const accountId = match?.[1] ? decodeURIComponent(match[1]) : null;
			return fulfillJson(
				r,
				accountId
					? (options.channelBindings ?? []).filter(
							(binding) => isRecord(binding) && binding.account_id === accountId,
						)
					: [],
			);
		}
		if (p.endsWith("/activity") && r.request().method() === "GET") {
			return fulfillJson(r, { items: [] });
		}
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

async function captureModelScreenshot(page: Page, path: string) {
	const modelPicker = page.locator("#deploy-catalog-model");
	await modelPicker.evaluate((element) => {
		element.scrollIntoView({ block: "center", inline: "nearest" });
	});
	await page.waitForTimeout(100);
	await modelPicker.locator("xpath=ancestor::section[1]").screenshot({ path });
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

async function expectNonZeroBox(locator: ReturnType<Page["locator"]>, label: string) {
	const box = await locator.boundingBox();
	expect(box, `${label} should render a layout box`).not.toBeNull();
	expect(box?.width, `${label} width`).toBeGreaterThan(0);
	expect(box?.height, `${label} height`).toBeGreaterThan(0);
}

async function expectPointerCursor(locator: ReturnType<Page["locator"]>, label: string) {
	const cursor = await locator.evaluate((element) => getComputedStyle(element).cursor);
	expect(cursor, `${label} cursor`).toBe("pointer");
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

test("empty account opens the shared Add agent dialog with peer setup tabs", async ({
	page,
	context,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Playwright baseURL is required for the onboarding test.");
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await stubHostedApi(page, { deployments: [], cloudAgents: [] });
	await page.goto("/");

	const firstAgent = page.locator("main").getByText("Get your first agent running", {
		exact: true,
	});
	await expect(firstAgent).toBeVisible();
	await expect(page.getByRole("button", { name: "Deploy on Clawdi", exact: true })).toHaveAttribute(
		"href",
		"/deploy",
	);
	await expect(page.getByText("Node.js 22.5+ is required.", { exact: true })).toHaveCount(0);

	await page.getByRole("button", { name: "Connect an agent on your machine", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Add agent" });
	await expect(dialog).toBeVisible();
	const commandTab = dialog.getByRole("tab", { name: "Run commands", exact: true });
	const promptTab = dialog.getByRole("tab", { name: "Ask your agent", exact: true });
	await expect(commandTab).toHaveAttribute("aria-selected", "true");
	await expect(promptTab).toHaveAttribute("aria-selected", "false");
	await expect(dialog.getByText("Node.js 22.5+ is required.", { exact: true })).toBeVisible();
	await expect(
		dialog.getByText("npm install -g clawdi@latest && clawdi auth login && clawdi setup", {
			exact: true,
		}),
	).toHaveCount(0);

	const commands = [
		{ label: "Copy Install the CLI command", value: "npm install -g clawdi@latest" },
		{ label: "Copy Log in command", value: "clawdi auth login" },
		{ label: "Copy Connect and enable sync command", value: "clawdi setup" },
	];
	for (const command of commands) {
		await expect(dialog.getByText(command.value, { exact: true })).toBeVisible();
		await dialog.getByRole("button", { name: command.label, exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe(command.value);
	}

	await promptTab.click();
	await expect(promptTab).toHaveAttribute("aria-selected", "true");
	const prompt = `Set up Clawdi on this machine. Fetch ${new URL(baseURL).origin}/skill.md, and follow the skills to set it up. Finally, confirm the installation with \`clawdi doctor\`.`;
	await expect(dialog.getByText(prompt, { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: "Copy prompt", exact: true }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
});

test("returning users can deploy on Clawdi or connect another machine", async ({ page }) => {
	await stubHostedApi(page, { deployments: [includedBasicDeployment], cloudAgents: [] });
	await page.goto("/");

	await expect(page.getByText("Included Basic", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("Add another agent", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Deploy on Clawdi", exact: true })).toHaveAttribute(
		"href",
		"/deploy",
	);
	await expect(
		page.getByRole("button", { name: "Connect an agent on your machine", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Connect an agent on your machine", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Add agent" })).toBeVisible();
});

test("empty accounts without deploy access only get the connected-agent path", async ({ page }) => {
	await stubHostedApi(page, {
		canCreateCloudAgents: false,
		deployments: [],
		cloudAgents: [],
	});
	await page.goto("/");

	await expect(page.getByText("Let's connect your first agent", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Deploy on Clawdi", exact: true })).toHaveCount(0);
	await expect(page.getByText("Node.js 22.5+ is required.", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Connect an agent on your machine", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Add agent" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "Run commands", exact: true })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

test("returning accounts keep hosted management but hide new deploys when denied", async ({
	page,
}) => {
	await stubHostedApi(page, {
		canCreateCloudAgents: false,
		deployments: [includedBasicDeployment],
		cloudAgents: [],
	});
	await page.goto("/");

	await expect(page.getByText("Included Basic", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("Add another agent", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Deploy on Clawdi", exact: true })).toHaveCount(0);
	await expect(
		page.getByText("Connect another agent on your machine and manage it from this dashboard.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(page.getByText("Node.js 22.5+ is required.", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Connect an agent on your machine", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Add agent" })).toBeVisible();
});

test("hosted mixed agent rail uses whole semantic buttons for context switching", async ({
	page,
	browser,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Playwright baseURL is required for the hosted rail test.");
	const agentOrderRequests: string[] = [];
	await stubHostedApi(page, {
		agentOrderRequests,
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent, railConnectedCloudAgent],
	});

	await page.goto("/agents");
	const rail = page.getByTestId("app-sidebar-agent-rail");
	const consoleLink = rail.getByRole("link", { name: "Console", exact: true });
	const cloudButton = rail.getByRole("button", { name: "Rail Cloud", exact: true });
	const connectedButton = rail.getByRole("button", { name: /Rail Connected/ });

	await expect(consoleLink).toHaveAttribute("href", "/");
	await expect(cloudButton).toHaveAttribute("type", "button");
	await expect(connectedButton).toHaveAttribute("type", "button");
	await expectPointerCursor(cloudButton, "Cloud tile");
	await expectPointerCursor(connectedButton, "connected tile");
	await expect(rail.getByRole("button", { name: /^Reorder / })).toHaveCount(0);
	await expect(rail.getByTitle(/^Reorder /)).toHaveCount(0);

	const connectedTileBox = await rail
		.getByTestId("app-sidebar-agent-tile")
		.filter({ hasText: "Rail Connected" })
		.boundingBox();
	const connectedButtonBox = await connectedButton.boundingBox();
	if (!connectedTileBox || !connectedButtonBox) {
		throw new Error("Hosted rail agent tile should be a whole interactive button.");
	}
	expect(connectedTileBox.height).toBeCloseTo(72, 0);
	expect(connectedButtonBox.x).toBeCloseTo(connectedTileBox.x, 0);
	expect(connectedButtonBox.y).toBeCloseTo(connectedTileBox.y, 0);
	expect(connectedButtonBox.height).toBeCloseTo(connectedTileBox.height, 0);
	expect(connectedButtonBox.width).toBeCloseTo(connectedTileBox.width, 0);

	await consoleLink.click();
	await expect(page).toHaveURL("/");
	await cloudButton.click();
	await expect(page).toHaveURL(
		`/agents/${railHostedEnvironmentId}?source=on-clawdi&d=hdep_rail_cloud`,
	);
	await connectedButton.click();
	await expect(page).toHaveURL(`/agents/${railConnectedEnvironmentId}`);
	await consoleLink.click();
	await expect(page).toHaveURL("/");

	await page.goto("/");
	await connectedButton.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(`/agents/${railConnectedEnvironmentId}`);

	const touchContext = await browser.newContext({
		baseURL,
		hasTouch: true,
		viewport: { width: 1280, height: 720 },
	});
	const touchPage = await touchContext.newPage();
	const touchOrderRequests: string[] = [];
	try {
		await stubHostedApi(touchPage, {
			agentOrderRequests: touchOrderRequests,
			deployments: [railHostedDeployment],
			cloudAgents: [railHostedCloudAgent, railConnectedCloudAgent],
		});
		await touchPage.goto("/");
		const touchConnectedButton = touchPage
			.getByTestId("app-sidebar-agent-rail")
			.getByRole("button", { name: /Rail Connected/ });
		await touchConnectedButton.tap();
		await expect(touchPage).toHaveURL(`/agents/${railConnectedEnvironmentId}`);
	} finally {
		await touchContext.close();
	}
	expect(agentOrderRequests).toEqual([]);
	expect(touchOrderRequests).toEqual([]);
});

test("hosted Skills hide private platform resources", async ({ page }) => {
	await stubHostedApi(page, {
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
	});
	await page.route(`${CLOUD_API}/v1/skills**`, (route) =>
		fulfillJson(route, {
			items: [
				{
					id: "skill-filesystem-docs",
					skill_key: "filesystem-docs",
					name: "Filesystem docs",
					description: "Projected from the Agent filesystem",
					version: 3,
					source: "agent_sync",
					authority: "agent_sync",
					source_repo: null,
					agent_types: ["hermes"],
					file_count: 2,
					content_hash: "a".repeat(64),
					is_active: true,
					created_at: "2026-07-15T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
					project_id: "project-hosted",
					project_name: "Rail Cloud Agent Project",
					project_kind: "environment",
					machine_name: "rail-cloud.local",
					environment_id: railHostedEnvironmentId,
				},
			],
			total: 1,
			page: 1,
			page_size: 200,
		}),
	);
	await page.route(`${CLOUD_API}/v1/agents/${railHostedEnvironmentId}/runtime-observed`, (route) =>
		fulfillJson(route, {
			environment: { ...railHostedCloudAgent, hosted_managed: true },
			desired: {
				deployment_id: railHostedDeployment.id,
				instance_id: "instance-rail-cloud",
				desired_config_generation: 1,
				desired_source_revision: "b".repeat(64),
				enabled_runtimes: ["hermes"],
				has_mcp: true,
				has_tools: false,
				managed_skills: [{ id: "clawdi", enabled: true, version: 1 }],
			},
			observed: null,
			health: { status: "ok", reasons: [] },
			provider_health: [],
		}),
	);
	const detailQuery = `?source=on-clawdi&d=${railHostedDeployment.id}`;
	await page.goto(`/agents/${railHostedEnvironmentId}/skills${detailQuery}`);
	const main = page.locator("main");
	await expect(main.getByText("Clawdi", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Manifest", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Filesystem docs", { exact: true })).toBeVisible();
	await expect(main.getByText("Agent synced · Read-only", { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: /Send Filesystem docs/ })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "MCP", exact: true })).toHaveCount(0);
});

test("transient inventory withholds connected tiles until membership resolves", async ({
	page,
}) => {
	await stubHostedApi(page, {
		cloudAgents: [railHostedCloudAgent, railConnectedCloudAgent],
		deploymentsResponse: {
			status: 200,
			delayMs: 1_000,
			body: [mutationDeploymentReadFixture(railHostedDeployment)],
		},
	});

	await page.goto("/");
	const rail = page.getByTestId("app-sidebar-agent-rail");
	await expect(rail.getByRole("button", { name: /Rail Connected/ })).toHaveCount(0);
	await expect(rail.getByRole("button", { name: "Rail Cloud", exact: true })).toBeVisible();
	await expect(rail.getByRole("button", { name: /Rail Connected/ })).toBeVisible();
});

test("whole agent tile drag does not navigate and the next click does", async ({ page }) => {
	const agentOrderRequests: string[] = [];
	await stubHostedApi(page, {
		agentOrderRequests,
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent, railConnectedCloudAgent],
	});
	await page.goto("/");

	const rail = page.getByTestId("app-sidebar-agent-rail");
	const connectedButton = rail.getByRole("button", { name: /Rail Connected/ });
	const cloudButton = rail.getByRole("button", { name: "Rail Cloud", exact: true });
	const sourceBox = await connectedButton.boundingBox();
	const targetBox = await cloudButton.boundingBox();
	if (!sourceBox || !targetBox) throw new Error("Agent tile buttons should render.");

	await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
		steps: 10,
	});
	await expect(connectedButton).toHaveAttribute("aria-pressed", "true");
	await page.mouse.up();

	await expect(page).toHaveURL(/\/$/);
	await expect.poll(() => agentOrderRequests.length).toBe(1);
	expect(JSON.parse(agentOrderRequests[0] ?? "{}")).toEqual({
		agent_ids: [railConnectedEnvironmentId, railHostedEnvironmentId],
	});

	await connectedButton.click();
	await expect(page).toHaveURL(`/agents/${railConnectedEnvironmentId}`);
});

test("existing Cloud customers keep billing settings when new deploys are disabled", async ({
	page,
}) => {
	await stubHostedApi(page, {
		canCreateCloudAgents: false,
		deployments: [includedBasicDeployment],
	});
	await page.goto("/channels");
	await page.waitForLoadState("networkidle");

	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: /^Wallet/ })).toBeVisible();
	await expect(dialog.getByRole("button", { name: /^Compute/ })).toBeVisible();
	await expect(dialog.getByRole("button", { name: /^Usage/ })).toBeVisible();
});

test("deploy wizard Select opens without browser errors", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page, { plans: [basicPlan], deployments: [] });
	await page.goto("/deploy");

	const nameInput = page.getByRole("textbox", { name: "Name in Clawdi" });
	await expect(nameInput).toHaveValue("Hermes");
	const maxLengthName = "a".repeat(64);
	await nameInput.fill(maxLengthName);
	await expect(
		page.getByText("64 / 64 characters — limit reached.", { exact: true }),
	).toBeVisible();
	await expect(page.locator('[role="status"][aria-live="polite"]')).toHaveText(
		"Name limit reached. You can enter up to 64 characters.",
	);
	await nameInput.press("End");
	await nameInput.type("b");
	await expect(nameInput).toHaveValue(maxLengthName);

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

test("deploy keeps AI providers expanded and provider selection exclusive", async ({ page }) => {
	await stubHostedApi(page, { plans: [basicPlan], deployments: [] });
	await page.goto("/deploy");

	await expect(page.getByRole("button", { name: /^Hermes/ })).toContainText("Recommended");
	await expect(
		page.getByText("Agent software can’t be changed later", { exact: true }),
	).toHaveCount(0);
	const addProvider = page.getByRole("button", { name: /^Add a provider/ });
	await expect(addProvider).toBeVisible();
	const managed = page.getByRole("button", { name: /^Clawdi AI/ });
	const unmanaged = page.getByRole("button", { name: /^Configure inside agent/ });
	await expect(managed).toHaveAttribute("aria-pressed", "true");
	await expect(unmanaged).toHaveAttribute("aria-pressed", "false");

	await unmanaged.click();
	await expect(unmanaged).toHaveAttribute("aria-pressed", "true");
	await expect(managed).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("managed-model-choices")).toHaveCount(0);
	await managed.click();
	await expect(managed).toHaveAttribute("aria-pressed", "true");
	await expect(unmanaged).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("managed-model-choices")).toBeVisible();
	await expect(page.getByRole("button", { name: "Change", exact: true })).toHaveCount(0);
});

test("AI Providers preserves provider identity and keeps technical details progressive", async ({
	context,
	page,
}, testInfo) => {
	const providerAcceptRequests: string[] = [];
	const providerTestRequests: string[] = [];
	const providerDraftTestRequests: string[] = [];
	const providerPatchRequests: string[] = [];
	await page.setViewportSize({ width: 390, height: 844 });
	await stubHostedApi(page, {
		aiProviders: [deepSeekProvider, deepSeekProxyProvider],
		deployments: [],
		providerAcceptRequests,
		providerAcceptResponses: [
			{
				status: 503,
				body: { detail: "upstream tenant=internal replacement_key=must-not-render" },
			},
			{
				status: 200,
				body: { status: "ready", provider: deepSeekProvider },
			},
		],
		providerDraftTestRequests,
		providerDraftTestResponses: [
			{
				status: 200,
				delayMs: 1_000,
				body: {
					ok: false,
					readiness: deepSeekProvider.readiness,
					error: {
						category: "authentication",
						code: "invalid_api_key",
						message: "upstream tenant=internal api_key=must-not-render",
						retryable: false,
					},
				},
			},
			{
				status: 200,
				body: { ok: true, readiness: deepSeekProvider.readiness, error: null },
			},
		],
		providerPatchRequests,
		providerTestRequests,
	});
	await page.goto("/ai-providers");
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);

	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "AI Providers", level: 1 })).toBeVisible();
	await expect(main.getByText("Clawdi", { exact: true })).toBeVisible();
	await expect(main.getByText("Included", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Research DeepSeek", { exact: true })).toBeVisible();
	await expect(main.getByText("DeepSeek · DeepSeek V4 Flash", { exact: true })).toBeVisible();
	await expect(main.getByText("DeepSeek proxy", { exact: true })).toBeVisible();
	await expect(
		main.getByText("Custom (OpenAI-compatible) · DeepSeek V4 Flash", { exact: true }),
	).toBeVisible();
	await expect(main.getByText("https://api.deepseek.com/v1", { exact: true })).toHaveCount(0);
	await expect(main.getByText("DEEPSEEK_API_KEY", { exact: true })).toHaveCount(0);
	await expect(main.getByText("OpenAI Chat Completions", { exact: true })).toHaveCount(0);

	await main.getByRole("button", { name: "Remove Research DeepSeek" }).click();
	const removeDialog = page.getByRole("alertdialog", { name: "Remove Research DeepSeek?" });
	await expect(
		removeDialog.getByText(
			"This provider will be removed from your account and cannot be restored.",
			{ exact: true },
		),
	).toBeVisible();
	await expect(
		removeDialog.getByText("No hosted agents currently use this provider.", { exact: true }),
	).toBeVisible();
	await removeDialog.getByRole("button", { name: "Cancel" }).click();

	await main.getByRole("button", { name: "Test connection for Research DeepSeek" }).click();
	const testDialog = page.getByRole("dialog", { name: "Test connection" });
	await expect(testDialog.getByText(/may incur a small provider charge/)).toBeVisible();
	expect(providerTestRequests).toHaveLength(0);
	await testDialog.getByRole("button", { name: "Run test" }).click();
	await expect.poll(() => providerTestRequests.length).toBe(1);
	await expect(testDialog.getByText("Connection verified", { exact: true })).toBeVisible();
	await expect(
		testDialog.getByText("The saved credentials and first configured model are working.", {
			exact: true,
		}),
	).toBeVisible();
	await testDialog.getByRole("button", { name: "Close" }).first().click();

	await main.getByRole("button", { name: "Edit Research DeepSeek" }).click();
	const editDialog = page.getByRole("dialog", { name: "Edit provider" });
	const savedApiKey = editDialog.getByRole("textbox", { name: "API key", exact: true });
	await expect(savedApiKey).toHaveAttribute("type", "password");
	await expect(savedApiKey).toHaveValue("");
	await expect(savedApiKey).toHaveAttribute("placeholder", "Leave blank to keep current key");
	await expect(
		editDialog.getByText("Leave blank to keep the current key.", { exact: true }),
	).toBeVisible();
	await editDialog.getByRole("button", { name: "Show API key" }).click();
	await expect(savedApiKey).toHaveAttribute("type", "text");
	await editDialog.getByRole("button", { name: "Hide API key" }).click();
	await expect(savedApiKey).toHaveAttribute("type", "password");
	const advanced = editDialog.locator("details");
	await expect(advanced).not.toHaveAttribute("open", "");
	await expect(editDialog.getByLabel("Base URL")).not.toBeVisible();
	await advanced.locator("summary").click();
	await expect(editDialog.getByLabel("Name")).toHaveValue("Research DeepSeek");
	await expect(editDialog.getByLabel("Base URL")).toHaveValue("https://api.deepseek.com/v1");
	await expect(editDialog.getByText("deepseek-primary", { exact: true })).toBeVisible();
	await editDialog.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect.poll(() => providerPatchRequests.length).toBe(1);
	const preservedCredentialPatch = JSON.parse(providerPatchRequests[0] ?? "{}");
	expect(preservedCredentialPatch).not.toHaveProperty("credential");
	expect(preservedCredentialPatch).not.toHaveProperty("api_key");
	await expect(editDialog).toHaveCount(0);

	await main.getByRole("button", { name: "Edit Research DeepSeek" }).click();
	const replacementDialog = page.getByRole("dialog", { name: "Edit provider" });
	const replacementApiKey = replacementDialog.getByRole("textbox", {
		name: "API key",
		exact: true,
	});
	await replacementApiKey.fill("  replacement-key  ");
	await replacementDialog.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect.poll(() => providerAcceptRequests.length).toBe(1);
	const failedReplacement = page.locator("[data-sonner-toast]").filter({
		hasText: "Couldn't save provider",
	});
	await expect(failedReplacement).toContainText("The service is having trouble right now.");
	await expect(failedReplacement).not.toContainText("tenant=internal");
	await expect(replacementDialog).toBeVisible();
	await replacementDialog.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect.poll(() => providerAcceptRequests.length).toBe(2);
	for (const request of providerAcceptRequests) {
		expect(JSON.parse(request)).toMatchObject({
			credential: { type: "api_key", value: "replacement-key" },
			replace: true,
		});
	}
	await expect(replacementDialog).toHaveCount(0);
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 7_000 });

	await main.getByRole("button", { name: "Edit DeepSeek proxy" }).click();
	const proxyEditDialog = page.getByRole("dialog", { name: "Edit provider" });
	await expect(proxyEditDialog.locator("details")).toHaveAttribute("open", "");
	await expect(proxyEditDialog.getByLabel("Base URL")).toHaveValue("https://proxy.example.com/v1");
	await expect(proxyEditDialog.getByText("deepseek-team", { exact: true })).toBeVisible();
	await proxyEditDialog.getByRole("button", { name: "Cancel" }).click();

	await main.getByRole("button", { name: "Add provider", exact: true }).click();
	const chooserDialog = page.getByRole("dialog", { name: "Add a provider" });
	await expect(chooserDialog.getByText("Providers", { exact: true })).toBeVisible();
	await expect(chooserDialog.getByText("Popular", { exact: true })).toHaveCount(0);
	await expect(chooserDialog.getByText("More providers", { exact: true })).toHaveCount(0);
	await expect(chooserDialog.locator("details")).toHaveCount(0);
	await expect(chooserDialog.locator('[data-slot="dialog-footer"]')).toHaveCount(0);
	await expect(chooserDialog.getByRole("button", { name: "Close" })).toBeVisible();
	const choiceGrid = chooserDialog.getByTestId("provider-choice-grid");
	const choiceButtons = choiceGrid.locator(":scope > button");
	await expect(choiceButtons).toHaveCount(17);
	await expect(choiceButtons.locator("button, a, input, select, textarea")).toHaveCount(0);
	await expect(
		chooserDialog.getByRole("button", {
			name: "OpenAI API key or ChatGPT sign-in",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		chooserDialog.getByRole("button", {
			name: "Anthropic Claude model access",
			exact: true,
		}),
	).toBeVisible();
	await expect(chooserDialog.getByRole("button", { name: /^Custom endpoint/ })).toBeVisible();
	const providerSearch = chooserDialog.getByRole("textbox", { name: "Search providers" });
	const mobileOpenAiBox = await chooserDialog
		.getByRole("button", { name: /^OpenAI/ })
		.boundingBox();
	const mobileAnthropicBox = await chooserDialog
		.getByRole("button", { name: /^Anthropic/ })
		.boundingBox();
	expect(Math.abs((mobileOpenAiBox?.x ?? 0) - (mobileAnthropicBox?.x ?? 0))).toBeLessThanOrEqual(1);
	expect(mobileAnthropicBox?.y ?? 0).toBeGreaterThan(mobileOpenAiBox?.y ?? 0);
	const mobileScroll = await chooserDialog
		.getByTestId("provider-dialog-body")
		.evaluate((element) => ({
			clientHeight: element.clientHeight,
			scrollHeight: element.scrollHeight,
		}));
	expect(mobileScroll.scrollHeight).toBeGreaterThan(mobileScroll.clientHeight);
	await chooserDialog.screenshot({
		path:
			process.env.PROVIDER_CHOOSER_MOBILE_SCREENSHOT_PATH ??
			testInfo.outputPath("provider-chooser-mobile.png"),
	});

	await page.setViewportSize({ width: 1000, height: 800 });
	const desktopOpenAiBox = await chooserDialog
		.getByRole("button", { name: /^OpenAI/ })
		.boundingBox();
	const desktopAnthropicBox = await chooserDialog
		.getByRole("button", { name: /^Anthropic/ })
		.boundingBox();
	expect(Math.abs((desktopOpenAiBox?.y ?? 0) - (desktopAnthropicBox?.y ?? 0))).toBeLessThanOrEqual(
		1,
	);
	expect(desktopAnthropicBox?.x ?? 0).toBeGreaterThan(desktopOpenAiBox?.x ?? 0);
	await chooserDialog.screenshot({
		path:
			process.env.PROVIDER_CHOOSER_DESKTOP_SCREENSHOT_PATH ??
			testInfo.outputPath("provider-chooser-desktop.png"),
	});
	await page.setViewportSize({ width: 390, height: 844 });

	await providerSearch.focus();
	await page.keyboard.press("Tab");
	await expect(chooserDialog.getByRole("button", { name: /^OpenAI/ })).toBeFocused();
	await providerSearch.focus();
	await providerSearch.fill("Moonshot");
	await expect(chooserDialog.getByRole("button", { name: /^Kimi API/ })).toBeVisible();
	await chooserDialog.getByRole("button", { name: "Clear search" }).click();
	await expect(choiceGrid.locator(":scope > button")).toHaveCount(17);
	await providerSearch.fill("not-a-listed-provider");
	const noMatchGrid = chooserDialog.getByTestId("provider-choice-grid");
	await expect(noMatchGrid.locator(":scope > button")).toHaveCount(1);
	await expect(noMatchGrid.getByRole("button", { name: /^Use a custom endpoint/ })).toBeVisible();
	await chooserDialog.getByRole("button", { name: "Clear search" }).click();
	await chooserDialog.getByRole("button", { name: /^DeepSeek/ }).click();
	const presetDialog = page.getByRole("dialog");
	await expect(presetDialog).toHaveAccessibleName("Set up DeepSeek");
	await expect(presetDialog.getByRole("link", { name: /Get API key/ })).toHaveAttribute(
		"href",
		"https://platform.deepseek.com/api_keys",
	);
	const presetAdvanced = presetDialog.locator("details");
	await expect(presetAdvanced).not.toHaveAttribute("open", "");
	await expect(presetDialog.getByLabel("Name")).not.toBeVisible();
	await presetAdvanced.locator("summary").click();
	await presetDialog.getByLabel("Name").fill("Research DeepSeek East");
	await expect(presetDialog).toHaveAccessibleName("Set up Research DeepSeek East");
	await expect(presetDialog.getByText("deepseek", { exact: true })).toBeVisible();
	const presetApiKey = presetDialog.getByRole("textbox", { name: "API key", exact: true });
	await expect(presetApiKey).toHaveAttribute("type", "password");
	await page.evaluate(() => navigator.clipboard.writeText("  pasted-key-with-whitespace  "));
	await presetApiKey.focus();
	await page.keyboard.press("Control+V");
	await presetDialog.getByRole("button", { name: "Show API key" }).click();
	await expect(presetApiKey).toHaveAttribute("type", "text");
	await expect(presetApiKey).toHaveValue("  pasted-key-with-whitespace  ");
	await presetDialog.getByRole("button", { name: "Hide API key" }).click();
	await expect(presetApiKey).toHaveAttribute("type", "password");
	await expect(presetDialog).not.toContainText("pasted-key-with-whitespace");
	await expect(
		presetDialog.getByRole("button", { name: "Add provider", exact: true }),
	).toBeEnabled();
	const draftTestButton = presetDialog.getByRole("button", {
		name: "Test connection",
		exact: true,
	});
	await draftTestButton.click();
	await expect.poll(() => providerDraftTestRequests.length).toBe(1);
	expect(JSON.parse(providerDraftTestRequests[0] ?? "{}")).toMatchObject({
		credential: { type: "api_key", value: "pasted-key-with-whitespace" },
	});
	await expect(
		presetDialog.getByText("The provider rejected the API key. Check it and try again.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(presetDialog).not.toContainText("tenant=internal");
	await draftTestButton.click();
	await expect.poll(() => providerDraftTestRequests.length).toBe(2);
	await expect(
		presetDialog.getByText("Connection verified. The provider accepted the test request.", {
			exact: true,
		}),
	).toBeVisible();
	await presetDialog.getByRole("button", { name: "Back" }).click();
	await expect(chooserDialog).toBeVisible();
	await chooserDialog.getByRole("button", { name: /^Custom endpoint/ }).click();
	const customDialog = page.getByRole("dialog");
	await expect(customDialog).toHaveAccessibleName("Set up Custom endpoint");
	await expect(
		customDialog.getByText(
			"Enter the credential and connection details for this custom endpoint.",
			{ exact: true },
		),
	).toBeVisible();
	await expect(customDialog.locator("details")).toHaveAttribute("open", "");
	const customName = customDialog.getByLabel("Name");
	await expect(customName).toHaveAttribute("required", "");
	await customDialog.getByRole("textbox", { name: "API key", exact: true }).fill("test-api-key");
	await customDialog.getByLabel("Base URL").fill("https://proxy.example.com/v1");
	await expect(
		customDialog.getByRole("button", { name: "Add provider", exact: true }),
	).toBeDisabled();
	await customName.fill("Team proxy");
	await expect(customDialog).toHaveAccessibleName("Set up Team proxy");
	await expect(
		customDialog.getByRole("button", { name: "Add provider", exact: true }),
	).toBeEnabled();

	const documentWidth = await page.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	expect(documentWidth.scrollWidth).toBe(documentWidth.clientWidth);
});

test("AI Provider OAuth and destructive confirmations keep dialog semantics on mobile and desktop", async ({
	page,
}, testInfo) => {
	const oauthProvider = {
		...deepSeekProvider,
		id: "row-openai-codex",
		provider_id: "openai-codex",
		type: "openai",
		label: "ChatGPT (Codex)",
		base_url: "https://api.openai.com/v1",
		models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
		api_mode: "openai_responses",
		auth: { type: "agent_profile", tool: "codex", profile: "default" },
		runtime_env_name: null,
	};
	const providerAcceptRequests: string[] = [];
	const providerOAuthStartRequests: string[] = [];
	await page.setViewportSize({ width: 390, height: 844 });
	await stubHostedApi(page, {
		aiProviders: [oauthProvider],
		deploymentsResponse: {
			status: 403,
			body: { detail: "internal deployment tenant=must-not-render" },
		},
		providerAcceptRequests,
		providerAcceptResponses: [
			{
				status: 200,
				body: {
					status: "pending",
					provider: oauthProvider,
					authorization: {
						flow: "device_code",
						state: "expired-state",
						verification_url: "https://auth.openai.com/codex/device",
						user_code: "OLD-CODE",
						expires_at: "2000-01-01T00:00:00Z",
						poll_interval_seconds: 60,
					},
				},
			},
			{
				status: 200,
				body: {
					status: "pending",
					provider: oauthProvider,
					authorization: {
						flow: "device_code",
						state: "replacement-state",
						verification_url: "https://auth.openai.com/codex/device",
						user_code: "NEW-CODE",
						expires_at: "2099-01-01T00:00:00Z",
						poll_interval_seconds: 60,
					},
				},
			},
		],
		providerOAuthStartRequests,
		providerOAuthStartResponses: [
			{
				status: 200,
				body: {
					state: "reconnect-state",
					verification_url: "https://auth.openai.com/codex/device",
					user_code: "RECONNECT",
					expires_at: "2099-01-01T00:00:00Z",
					poll_interval_seconds: 60,
				},
			},
		],
	});
	await page.goto("/ai-providers");

	const main = page.locator("main");
	await main.getByRole("button", { name: "Edit ChatGPT (Codex)", exact: true }).click();
	const editDialog = page.getByRole("dialog", { name: "Edit provider" });
	await expect(editDialog.getByText("ChatGPT sign-in", { exact: true })).toBeVisible();
	await expect(editDialog.locator('[data-slot="dialog-footer"]')).toBeVisible();
	await editDialog.getByRole("button", { name: "Reconnect", exact: true }).click();
	await expect.poll(() => providerOAuthStartRequests.length).toBe(1);
	const reconnectDialog = page.getByRole("dialog", { name: "Sign in with ChatGPT" });
	await expect(reconnectDialog.getByText("RECONNECT", { exact: true })).toBeVisible();
	await expect(
		reconnectDialog.getByRole("link", { name: /Open ChatGPT and enter code/ }),
	).toHaveAttribute("href", "https://auth.openai.com/codex/device");
	await expect(
		reconnectDialog.getByText("Waiting for ChatGPT authorization…", { exact: true }),
	).toBeVisible();
	await reconnectDialog.screenshot({
		path:
			process.env.PROVIDER_OAUTH_MOBILE_SCREENSHOT_PATH ??
			testInfo.outputPath("provider-oauth-mobile.png"),
	});
	await reconnectDialog.getByRole("button", { name: "Cancel", exact: true }).click();

	await main.getByRole("button", { name: "Add provider", exact: true }).click();
	const chooserDialog = page.getByRole("dialog", { name: "Add a provider" });
	await chooserDialog.getByRole("button", { name: /^OpenAI/ }).click();
	const configureDialog = page.getByRole("dialog");
	await expect(configureDialog).toHaveAccessibleName("Set up OpenAI");
	const apiKeyAuth = configureDialog.getByRole("button", {
		name: "Sign in with an API key For usage-based access",
		exact: true,
	});
	const chatGptAuth = configureDialog.getByRole("button", {
		name: "Sign in with ChatGPT For subscription access",
		exact: true,
	});
	await expect(apiKeyAuth).toHaveAttribute("aria-pressed", "true");
	await expect(chatGptAuth).toHaveAttribute("aria-pressed", "false");
	const openAiApiKey = configureDialog.getByRole("textbox", { name: "API key", exact: true });
	await configureDialog.getByRole("button", { name: "Show API key" }).click();
	await expect(openAiApiKey).toHaveAttribute("type", "text");
	await chatGptAuth.click();
	await expect(chatGptAuth).toHaveAttribute("aria-pressed", "true");
	await expect(apiKeyAuth).toHaveAttribute("aria-pressed", "false");
	await apiKeyAuth.click();
	await expect(openAiApiKey).toHaveAttribute("type", "password");
	await chatGptAuth.click();
	await configureDialog.getByRole("button", { name: "Continue to ChatGPT", exact: true }).click();
	await expect.poll(() => providerAcceptRequests.length).toBe(1);
	expect(JSON.parse(providerAcceptRequests[0] ?? "{}")).toMatchObject({
		credential: { type: "oauth", provider: "codex", flow: "device_code" },
		replace: false,
	});

	const oauthDialog = page.getByRole("dialog", { name: "Sign in with ChatGPT" });
	await expect(
		oauthDialog.getByText("This code expired. Start again for a new code.", { exact: true }),
	).toBeVisible();
	await oauthDialog.getByRole("button", { name: "Get a new code", exact: true }).click();
	await expect.poll(() => providerAcceptRequests.length).toBe(2);
	await expect(oauthDialog.getByText("NEW-CODE", { exact: true })).toBeVisible();
	await expect(
		oauthDialog.getByText("Waiting for ChatGPT authorization…", { exact: true }),
	).toBeVisible();
	await page.setViewportSize({ width: 1000, height: 800 });
	await oauthDialog.screenshot({
		path:
			process.env.PROVIDER_OAUTH_DESKTOP_SCREENSHOT_PATH ??
			testInfo.outputPath("provider-oauth-desktop.png"),
	});
	await page.keyboard.press("Escape");
	await expect(oauthDialog).toHaveCount(0);

	await page.setViewportSize({ width: 390, height: 844 });
	await main.getByRole("button", { name: "Remove ChatGPT (Codex)", exact: true }).click();
	const removeDialog = page.getByRole("alertdialog", { name: "Remove ChatGPT (Codex)?" });
	await expect(removeDialog).not.toContainText("tenant=must-not-render");
	await expect(
		removeDialog.getByText(/couldn't check whether any agents use this provider/i),
	).toBeVisible();
	const acknowledgement = removeDialog.getByRole("checkbox", {
		name: /affected agents will lose model access/i,
	});
	const removeProvider = removeDialog.getByRole("button", {
		name: "Remove provider",
		exact: true,
	});
	await expect(removeProvider).toBeDisabled();
	await acknowledgement.check();
	await expect(removeProvider).toBeEnabled();
	await removeDialog.getByRole("button", { name: "Cancel", exact: true }).click();

	const documentWidth = await page.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	expect(documentWidth.scrollWidth).toBe(documentWidth.clientWidth);
});

test("AI provider chooser and auth dialogs preserve hierarchy in dark mode", async ({
	page,
}, testInfo) => {
	const providerAcceptRequests: string[] = [];
	const pendingOpenAiProvider = {
		...deepSeekProvider,
		id: "row-dark-openai",
		provider_id: "openai-dark",
		type: "openai",
		label: "OpenAI",
		base_url: "https://api.openai.com/v1",
		models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
		api_mode: "openai_responses",
		auth: { type: "agent_profile", tool: "codex", profile: "default" },
		runtime_env_name: null,
	};
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => window.localStorage.setItem("clawdi-theme", "dark"));
	await stubHostedApi(page, {
		aiProviders: [],
		deployments: [],
		providerAcceptRequests,
		providerAcceptResponses: [
			{
				status: 200,
				body: {
					status: "pending",
					provider: pendingOpenAiProvider,
					authorization: {
						flow: "device_code",
						state: "dark-mode-state",
						verification_url: "https://auth.openai.com/codex/device",
						user_code: "DARK-CODE",
						expires_at: "2099-01-01T00:00:00Z",
						poll_interval_seconds: 60,
					},
				},
			},
		],
	});
	await page.goto("/ai-providers");
	await expect(page.locator("html")).toHaveClass(/dark/);

	const main = page.locator("main");
	await main.getByRole("button", { name: "Add provider", exact: true }).first().click();
	const chooserDialog = page.getByRole("dialog", { name: "Add a provider" });
	const providerSearch = chooserDialog.getByRole("textbox", { name: "Search providers" });
	await expect(providerSearch).toBeFocused();
	const openAiChoice = chooserDialog.getByRole("button", {
		name: "OpenAI API key or ChatGPT sign-in",
		exact: true,
	});
	const anthropicChoice = chooserDialog.getByRole("button", {
		name: "Anthropic Claude model access",
		exact: true,
	});
	await expect(openAiChoice).toBeVisible();
	await expect(anthropicChoice).toBeVisible();
	await expect(openAiChoice.locator(':scope > [aria-hidden="true"]')).toHaveCount(1);
	const anthropicIcon = anthropicChoice.locator(':scope > [aria-hidden="true"]');
	await expect(anthropicIcon).toHaveCount(1);
	await expect(anthropicIcon.locator("img")).toHaveAttribute("alt", "Anthropic");
	const chooserBody = chooserDialog.getByTestId("provider-dialog-body");
	const mobileScroll = await chooserBody.evaluate((element) => ({
		clientHeight: element.clientHeight,
		scrollHeight: element.scrollHeight,
	}));
	expect(mobileScroll.scrollHeight).toBeGreaterThan(mobileScroll.clientHeight);
	await chooserDialog.screenshot({ path: testInfo.outputPath("provider-dark-chooser-mobile.png") });

	await page.setViewportSize({ width: 1000, height: 800 });
	const openAiBox = await openAiChoice.boundingBox();
	const anthropicBox = await anthropicChoice.boundingBox();
	expect(Math.abs((openAiBox?.y ?? 0) - (anthropicBox?.y ?? 0))).toBeLessThanOrEqual(1);
	expect(anthropicBox?.x ?? 0).toBeGreaterThan(openAiBox?.x ?? 0);
	await chooserDialog.screenshot({
		path: testInfo.outputPath("provider-dark-chooser-desktop.png"),
	});

	await openAiChoice.click();
	const configureDialog = page.getByRole("dialog", { name: "Set up OpenAI" });
	const apiKeyAuth = configureDialog.getByRole("button", {
		name: "Sign in with an API key For usage-based access",
		exact: true,
	});
	const chatGptAuth = configureDialog.getByRole("button", {
		name: "Sign in with ChatGPT For subscription access",
		exact: true,
	});
	await expect(apiKeyAuth).toHaveAttribute("aria-pressed", "true");
	await expect(chatGptAuth).toHaveAttribute("aria-pressed", "false");
	await expect(configureDialog.locator('[data-slot="dialog-footer"]')).toBeVisible();
	await configureDialog.screenshot({
		path: testInfo.outputPath("provider-dark-api-key-desktop.png"),
	});

	await page.setViewportSize({ width: 390, height: 844 });
	await configureDialog.screenshot({
		path: testInfo.outputPath("provider-dark-api-key-mobile.png"),
	});
	await chatGptAuth.click();
	const oauthConfigureDialog = page.getByRole("dialog", { name: "Set up ChatGPT (Codex)" });
	await oauthConfigureDialog
		.getByRole("button", { name: "Continue to ChatGPT", exact: true })
		.click();
	await expect.poll(() => providerAcceptRequests.length).toBe(1);
	const oauthDialog = page.getByRole("dialog", { name: "Sign in with ChatGPT" });
	await expect(oauthDialog.getByText("DARK-CODE", { exact: true })).toBeVisible();
	await oauthDialog.screenshot({ path: testInfo.outputPath("provider-dark-oauth-mobile.png") });

	await page.setViewportSize({ width: 1000, height: 800 });
	await oauthDialog.screenshot({ path: testInfo.outputPath("provider-dark-oauth-desktop.png") });
	const documentWidth = await page.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	expect(documentWidth.scrollWidth).toBe(documentWidth.clientWidth);
});

test("deploy cards and CTA-adjacent amount distinguish free, monthly, and annual prices", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await stubHostedApi(page, { plans: [basicPlan, performancePlan], deployments: [] });
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	const actionBar = page.getByTestId("deploy-action-bar");
	const amount = actionBar.getByTestId("deploy-amount");
	await expect(amount).toHaveText("Free");
	await expect(actionBar.getByRole("button", { name: "Deploy" })).toBeVisible();

	const performanceChoice = page.getByRole("button", { name: /^Performance/ });
	await performanceChoice.click();
	const computePrice = page.getByTestId("performance-compute-price");
	await expect(computePrice).toContainText("$20.00/mo");
	await expect(computePrice).toContainText("Billed monthly");
	await expect(performanceChoice).toContainText("4 vCPU · 8 GB RAM");
	await expect(amount).toContainText("$20.00/mo");
	await expect(amount).toContainText("Billed monthly");
	await expect(actionBar.getByRole("button", { name: "Continue to checkout" })).toBeVisible();

	await page.getByRole("button", { name: /Annual.*%/ }).click();
	await expect(computePrice).toContainText("$16.66/mo");
	await expect(computePrice).toContainText("Billed $200.00/yr · save $40.00");
	await expect(amount).toContainText("$200.00/yr");
	await expect(amount).toContainText("$16.66/mo, billed annually");

	const amountMetrics = await amount.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(amountMetrics.scrollWidth).toBeLessThanOrEqual(amountMetrics.clientWidth);
	const pageMetrics = await page.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	expect(pageMetrics.scrollWidth).toBe(pageMetrics.clientWidth);
});

test("deploy CTA-adjacent Wallet amount handles loading, retry, and insufficient balance", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const delayedQuote = walletSubscriptionQuote({
		planSlug: "compute_basic",
		billingTermMonths: 1,
		termPriceCents: 1_000,
		debitAmountUsd: "10.00",
		balanceBeforeUsd: "25.00",
		balanceAfterUsd: "15.00",
	});
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan],
		subscriptionQuoteResponses: [{ status: 200, body: delayedQuote, delayMs: 700 }],
	});
	await page.goto("/deploy");
	await page.getByRole("button", { name: /Wallet balance/ }).click();

	const amount = page.getByTestId("deploy-amount");
	await expect(amount).toContainText("Debit today: —");
	await expect(amount).toContainText("Getting quote…");
	await expect(page.getByRole("button", { name: "Pay & deploy" })).toBeDisabled();
	await expect(amount).toContainText("Debit today: $10.00");
	await expect(amount).toContainText("From Wallet · renews monthly");
	await expect(page.getByRole("button", { name: "Pay & deploy" })).toBeEnabled();

	await page.unrouteAll({ behavior: "wait" });
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan],
		subscriptionQuoteResponses: [
			{ status: 400, body: { detail: "quote unavailable" } },
			delayedQuote,
		],
	});
	await page.goto("/deploy");
	await page.getByRole("button", { name: /Wallet balance/ }).click();
	await expect(amount).toContainText("Quote unavailable");
	await expect(page.getByRole("button", { name: "Pay & deploy" })).toBeDisabled();
	await amount.getByRole("button", { name: "Retry" }).click();
	await expect(amount).toContainText("Debit today: $10.00");

	await page.unrouteAll({ behavior: "wait" });
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan],
		walletState: { ...walletState, balance_usd: "5.00" },
	});
	await page.goto("/deploy");
	await page.getByRole("button", { name: /Wallet balance/ }).click();
	await expect(amount).toContainText("Debit today: $10.00");
	await expect(amount).toContainText("Available $5.00 · short $5.00");
	const topUp = page.getByRole("button", { name: "Top up Wallet", exact: true });
	await expect(topUp).toHaveCount(1);
	await expect(topUp).toBeEnabled();
	await page.screenshot({ path: "/tmp/deploy-wallet-insufficient-390.png" });
	await topUp.click();
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up Wallet" });
	await expect(topUpDialog).toBeVisible();
	await expect(topUpDialog.getByRole("spinbutton", { name: "Amount (USD)" })).toHaveValue("10");
	await expect(topUpDialog.getByRole("button", { name: "Continue with $10.00" })).toBeVisible();
});

test("deploy form stays readable without stretching compact controls", async ({ page }) => {
	await stubHostedApi(page, {
		plans: [basicPlan, performancePlan],
		deployments: [],
		managedModels: dynamicManagedModelCatalog,
	});
	await page.goto("/deploy");
	await page.getByRole("button", { name: /^Performance/ }).click();
	await page.getByRole("button", { name: /Annual.*%/ }).click();

	for (const viewport of [
		{ columns: 2, name: "desktop", width: 1280, height: 900 },
		{ columns: 2, name: "tablet without sidebar", width: 700, height: 900 },
		{ columns: 1, name: "tablet with sidebar", width: 800, height: 900 },
		{ columns: 1, name: "mobile", width: 390, height: 844 },
	]) {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await page.evaluate(() => {
			window.scrollTo(0, 0);
			document.querySelector("#dashboard-scroll-container")?.scrollTo(0, 0);
		});
		await page.waitForTimeout(100);
		const metrics = await page.evaluate(() => {
			const sectionFor = (title: string) =>
				Array.from(document.querySelectorAll("section")).find(
					(section) =>
						section.querySelector(":scope > div:nth-child(2) > div")?.textContent?.trim() === title,
				);
			const rect = (element: Element | null | undefined) => {
				const box = element?.getBoundingClientRect();
				return box
					? { bottom: box.bottom, left: box.left, right: box.right, top: box.top, width: box.width }
					: null;
			};
			const gridMetrics = (element: Element | null | undefined) =>
				element
					? {
							columns: getComputedStyle(element).gridTemplateColumns,
							rect: rect(element),
						}
					: null;
			const inlineTextMetrics = (element: Element | null | undefined) =>
				element
					? (() => {
							const textRange = document.createRange();
							textRange.selectNodeContents(element);
							const lineTops = new Set(
								Array.from(textRange.getClientRects()).map((box) => Math.round(box.top * 10)),
							);
							return {
								lineCount: lineTops.size,
								text: element.textContent?.trim() ?? "",
								whiteSpace: getComputedStyle(element).whiteSpace,
							};
						})()
					: null;
			const labelMetrics = (controlId: string) => {
				const label = document.querySelector(`[data-slot="label"][for="${controlId}"]`);
				if (!label) return null;
				const style = getComputedStyle(label);
				return {
					fontSize: style.fontSize,
					fontWeight: style.fontWeight,
					lineHeight: style.lineHeight,
				};
			};
			const sectionGrid = (title: string) => {
				const section = sectionFor(title);
				return gridMetrics(section?.querySelector(":scope > div:nth-child(3) .grid"));
			};
			const paymentButton = Array.from(document.querySelectorAll("button")).find((button) =>
				button.textContent?.includes("Card subscription"),
			);
			const coreTitleLabels = [
				"Hermes",
				"OpenClaw",
				"Clawdi AI",
				"Configure inside agent",
				"Basic",
				"Performance",
				"Card subscription",
				"Wallet balance",
			];
			const titleWidths = Array.from(
				document.querySelectorAll<HTMLSpanElement>("button span.font-medium"),
			)
				.filter((title) => coreTitleLabels.includes(title.textContent?.trim() ?? ""))
				.map((title) => ({
					clientWidth: title.clientWidth,
					label: title.textContent?.trim() ?? "",
					scrollWidth: title.scrollWidth,
				}));
			const computePlans = ["Basic", "Performance"].map((label) => {
				const testIdPrefix = label === "Basic" ? "basic" : "performance";
				const title = Array.from(
					document.querySelectorAll<HTMLSpanElement>("button span.font-medium"),
				).find((candidate) => candidate.textContent?.trim() === label);
				const card = title?.closest("button");
				const resources = card?.querySelector("p");
				const price = card?.querySelector(`[data-testid="${testIdPrefix}-compute-price"]`);
				const primaryPrice = price?.querySelector("span.font-semibold");
				return {
					card: rect(card),
					label,
					price: rect(price),
					primaryPrice: rect(primaryPrice),
					ramUnit: inlineTextMetrics(
						card?.querySelector(`[data-testid="${testIdPrefix}-ram-resource"]`),
					),
					resources: rect(resources),
					savings: inlineTextMetrics(
						price?.querySelector(`[data-testid="${testIdPrefix}-compute-price-savings"]`),
					),
					secondaryWhiteSpace: price
						? getComputedStyle(price.querySelector(":scope > div:last-child") ?? price).whiteSpace
						: null,
					title: rect(title),
				};
			});
			const catalogModel = document.querySelector("#deploy-catalog-model");
			const modelPickerFrame = catalogModel?.closest('div[data-hosted="true"][data-v2="true"]');
			const modelPickerFrameStyle = modelPickerFrame ? getComputedStyle(modelPickerFrame) : null;
			const managedModelChoices = document.querySelector('[data-testid="managed-model-choices"]');
			const managedModelControls = document.querySelector('[data-testid="managed-model-controls"]');
			const managedModelOverflow = document.querySelector('[data-testid="managed-model-overflow"]');
			const modelLabel = document.querySelector("#deploy-catalog-model-label");
			const firstModelChoice = managedModelChoices?.querySelector("label");
			return {
				document: {
					clientWidth: document.documentElement.clientWidth,
					scrollWidth: document.documentElement.scrollWidth,
				},
				main: rect(document.querySelector("main")),
				agentSoftware: sectionGrid("Agent software"),
				aiProviders: sectionGrid("AI providers"),
				compute: sectionGrid("Compute"),
				payment: gridMetrics(paymentButton?.parentElement),
				catalogModel: rect(catalogModel),
				firstModelChoice: rect(firstModelChoice),
				managedModelChoices: managedModelChoices
					? {
							cards: Array.from(managedModelChoices.querySelectorAll(":scope > label")).map(
								(card) => rect(card),
							),
							clientWidth: managedModelChoices.clientWidth,
							columns: getComputedStyle(managedModelChoices).gridTemplateColumns,
							descriptions: Array.from(
								managedModelChoices.querySelectorAll('[id$="-description"]'),
							).map((description) => ({
								...inlineTextMetrics(description),
								clientWidth: description.clientWidth,
								scrollWidth: description.scrollWidth,
							})),
							labels: Array.from(managedModelChoices.querySelectorAll('[id$="-title"]')).map(
								(title) => title.textContent?.trim() ?? "",
							),
							rect: rect(managedModelChoices),
							scrollWidth: managedModelChoices.scrollWidth,
						}
					: null,
				managedModelControls: managedModelControls
					? {
							clientWidth: managedModelControls.clientWidth,
							rect: rect(managedModelControls),
							scrollWidth: managedModelControls.scrollWidth,
						}
					: null,
				managedModelOverflow: rect(managedModelOverflow),
				modelLabel: rect(modelLabel),
				modelPickerFrameRect: rect(modelPickerFrame),
				modelPickerFrame: modelPickerFrameStyle
					? {
							borderTopWidth: Number.parseFloat(modelPickerFrameStyle.borderTopWidth),
							paddingTop: Number.parseFloat(modelPickerFrameStyle.paddingTop),
						}
					: null,
				name: rect(document.querySelector("#agent-name")),
				nameLabel: labelMetrics("agent-name"),
				language: rect(document.querySelector("#agent-language")),
				languageLabel: labelMetrics("agent-language"),
				timezone: rect(document.querySelector("#agent-timezone")),
				timezoneLabel: labelMetrics("agent-timezone"),
				billingTerm: rect(document.querySelector('[aria-label="Billing term"]')),
				action: rect(document.querySelector('button[type="submit"]')),
				amount: (() => {
					const element = document.querySelector('[data-testid="deploy-amount"]');
					const primary = element?.querySelector("span.font-semibold");
					return element
						? {
								rect: rect(element),
								primaryClientWidth: primary?.clientWidth ?? 0,
								primaryScrollWidth: primary?.scrollWidth ?? 0,
								primaryText: primary?.textContent,
								text: element.textContent,
							}
						: null;
				})(),
				computePlans,
				titleWidths,
			};
		});

		expect(metrics.document.scrollWidth, `${viewport.name} should not horizontally overflow`).toBe(
			metrics.document.clientWidth,
		);
		expect(metrics.main, `${viewport.name} main bounds`).not.toBeNull();
		expect(metrics.main?.right, `${viewport.name} main right edge`).toBeLessThanOrEqual(
			viewport.width,
		);

		for (const [label, grid] of [
			["Agent software", metrics.agentSoftware],
			["AI providers", metrics.aiProviders],
			["Compute", metrics.compute],
			["Payment method", metrics.payment],
		] as const) {
			expect(grid, `${viewport.name} ${label} grid`).not.toBeNull();
			if (!grid) continue;
			const columnWidths = grid.columns.split(/\s+/).map(Number.parseFloat);
			expect(columnWidths, `${viewport.name} ${label} column count`).toHaveLength(viewport.columns);
			expect(
				Math.min(...columnWidths),
				`${viewport.name} ${label} cards should remain readable`,
			).toBeGreaterThanOrEqual(300);
			expect(grid.rect?.right, `${viewport.name} ${label} right edge`).toBeLessThanOrEqual(
				viewport.width,
			);
		}

		expect(metrics.titleWidths, `${viewport.name} core card titles`).toHaveLength(8);
		for (const title of metrics.titleWidths) {
			expect(title.scrollWidth, `${viewport.name} ${title.label} title`).toBeLessThanOrEqual(
				title.clientWidth,
			);
		}
		for (const plan of metrics.computePlans) {
			expect(plan.card, `${viewport.name} ${plan.label} card`).not.toBeNull();
			const cardHeight = plan.card ? plan.card.bottom - plan.card.top : Number.POSITIVE_INFINITY;
			expect(cardHeight, `${viewport.name} ${plan.label} height`).toBeLessThanOrEqual(96);
			expect(plan.primaryPrice?.top, `${viewport.name} ${plan.label} price top`).toBeCloseTo(
				plan.title?.top ?? 0,
				0,
			);
			expect(
				plan.price?.top,
				`${viewport.name} ${plan.label} price should stay with title and resources`,
			).toBeLessThanOrEqual(plan.resources?.bottom ?? 0);
			expect(plan.ramUnit?.text, `${viewport.name} ${plan.label} RAM unit`).toMatch(/^\d+ GB RAM$/);
			expect(plan.ramUnit?.whiteSpace, `${viewport.name} ${plan.label} RAM unit`).toBe("nowrap");
			expect(plan.ramUnit?.lineCount, `${viewport.name} ${plan.label} RAM unit`).toBe(1);
			expect(
				plan.secondaryWhiteSpace,
				`${viewport.name} ${plan.label} billing copy may wrap naturally`,
			).toBe("normal");
		}
		const performancePlanMetrics = metrics.computePlans.find(
			(plan) => plan.label === "Performance",
		);
		expect(performancePlanMetrics?.savings?.text, `${viewport.name} annual savings copy`).toBe(
			"· save $40.00",
		);
		expect(
			performancePlanMetrics?.savings?.whiteSpace,
			`${viewport.name} annual savings copy`,
		).toBe("nowrap");
		expect(performancePlanMetrics?.savings?.lineCount, `${viewport.name} annual savings copy`).toBe(
			1,
		);

		for (const [label, control, maxWidth] of [
			["Main model", metrics.catalogModel, 448],
			["Name", metrics.name, 448],
			["Language", metrics.language, 160],
			["Timezone", metrics.timezone, 384],
			["Billing term", metrics.billingTerm, 320],
		] as const) {
			expect(control, `${viewport.name} ${label} bounds`).not.toBeNull();
			expect(control?.width, `${viewport.name} ${label} width`).toBeLessThanOrEqual(maxWidth);
			expect(control?.right, `${viewport.name} ${label} right edge`).toBeLessThanOrEqual(
				viewport.width,
			);
		}
		expect(metrics.language?.width, `${viewport.name} compact Language select`).toBeLessThan(
			metrics.name?.width ?? 0,
		);
		expect(metrics.languageLabel, `${viewport.name} Language label`).toEqual(metrics.nameLabel);
		expect(metrics.timezoneLabel, `${viewport.name} Timezone label`).toEqual(metrics.nameLabel);
		expect(metrics.modelPickerFrame, `${viewport.name} unframed deploy model picker`).toEqual({
			borderTopWidth: 0,
			paddingTop: 0,
		});
		expect(metrics.managedModelChoices, `${viewport.name} managed model choices`).not.toBeNull();
		expect(metrics.managedModelChoices?.labels, `${viewport.name} featured model order`).toEqual([
			"GPT-5.6-Sol",
			"Kimi K3",
		]);
		expect(
			metrics.managedModelChoices?.columns.split(/\s+/),
			`${viewport.name} featured models use two deterministic columns`,
		).toHaveLength(2);
		const featuredCards = metrics.managedModelChoices?.cards ?? [];
		expect(featuredCards, `${viewport.name} featured card count`).toHaveLength(2);
		expect(featuredCards[0]?.top, `${viewport.name} featured cards stay on one row`).toBeCloseTo(
			featuredCards[1]?.top ?? Number.POSITIVE_INFINITY,
			0,
		);
		expect(featuredCards[0]?.width, `${viewport.name} featured cards stay equal width`).toBeCloseTo(
			featuredCards[1]?.width ?? Number.POSITIVE_INFINITY,
			0,
		);
		for (const description of metrics.managedModelChoices?.descriptions ?? []) {
			expect(
				description.scrollWidth,
				`${viewport.name} featured description should not overflow`,
			).toBeLessThanOrEqual(description.clientWidth);
			if (viewport.width === 390) {
				expect(
					description.lineCount,
					`${viewport.name} long featured description should wrap`,
				).toBeGreaterThan(1);
			}
		}
		expect(
			metrics.managedModelControls?.scrollWidth,
			`${viewport.name} managed model controls should not overflow`,
		).toBeLessThanOrEqual(metrics.managedModelControls?.clientWidth ?? 0);
		expect(
			metrics.managedModelControls?.rect?.right,
			`${viewport.name} managed model controls right edge`,
		).toBeLessThanOrEqual(viewport.width);
		expect(metrics.managedModelOverflow, `${viewport.name} overflow model select`).not.toBeNull();
		expect(
			metrics.managedModelOverflow?.width,
			`${viewport.name} overflow model select stays content-sized`,
		).toBeLessThan(metrics.modelPickerFrameRect?.width ?? Number.POSITIVE_INFINITY);
		expect(
			metrics.firstModelChoice?.top,
			`${viewport.name} Main model choices follow the section title`,
		).toBeGreaterThanOrEqual(metrics.modelLabel?.bottom ?? Number.POSITIVE_INFINITY);

		expect(metrics.action, `${viewport.name} sticky action`).not.toBeNull();
		expect(metrics.action?.top, `${viewport.name} sticky action top`).toBeGreaterThanOrEqual(0);
		expect(metrics.action?.bottom, `${viewport.name} sticky action bottom`).toBeLessThanOrEqual(
			viewport.height,
		);
		expect(metrics.amount?.primaryText, `${viewport.name} sticky annual amount`).toBe("$200.00/yr");
		expect(metrics.amount?.text, `${viewport.name} sticky annual caption`).toContain(
			"$16.66/mo, billed annually",
		);
		expect(
			metrics.amount?.primaryScrollWidth,
			`${viewport.name} sticky amount should not truncate`,
		).toBeLessThanOrEqual(metrics.amount?.primaryClientWidth ?? 0);
		expect(metrics.amount?.rect?.right, `${viewport.name} amount right edge`).toBeLessThanOrEqual(
			viewport.width,
		);
		if (viewport.columns === 1) {
			expect(metrics.action?.width, `${viewport.name} full-width action`).toBeCloseTo(
				metrics.compute?.rect?.width ?? 0,
				0,
			);
			expect(metrics.amount?.rect?.bottom, `${viewport.name} amount above CTA`).toBeLessThanOrEqual(
				metrics.action?.top ?? 0,
			);
		} else {
			expect(metrics.amount?.rect?.right, `${viewport.name} amount beside CTA`).toBeLessThanOrEqual(
				metrics.action?.left ?? 0,
			);
		}
		await capturePricingScreenshot(page, `/tmp/deploy-compute-card-${viewport.width}.png`);
		await captureModelScreenshot(page, `/tmp/deploy-ai-provider-${viewport.width}.png`);
	}
});

test("free Basic Deploy submits the declarative create contract", async ({ page }) => {
	const createDeploymentRequests: Array<{ body: string; idempotencyKey: string | null }> = [];
	const convergencePollRequests: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.startsWith("/v2/operations/") || path.startsWith("/v2/deployments/by-request/")) {
			convergencePollRequests.push(path);
		}
	});
	const acceptedCreate = completedDeploymentOperation(
		{
			...includedBasicDeployment,
			id: "hdep_included_created",
			name: "Created included Basic",
			status: "running",
		},
		"create",
	);
	const startingDeployment = {
		...includedBasicDeployment,
		id: "hdep_included_created",
		name: "Created included Basic",
		status: "creating",
	};
	const deploymentListRequests: string[] = [];
	const acceptedInventoryGate = deferred();
	await stubHostedApi(page, {
		plans: [basicPlan],
		deployments: [startingDeployment],
		deploymentListResponses: [[], [startingDeployment]],
		deploymentListResponseGates: [undefined, acceptedInventoryGate.promise],
		deploymentListRequests,
		createDeploymentResponse: {
			status: 202,
			body: { ...acceptedCreate, done: false, response: null },
		},
		createDeploymentRequests,
	});
	await page.goto("/deploy");

	await page.getByRole("button", { name: "Deploy", exact: true }).click();
	await expect(page).toHaveURL(/\/agents\/hdep_included_created/);
	await expect.poll(() => deploymentListRequests.length).toBeGreaterThanOrEqual(2);
	expect(new URL(page.url()).searchParams.has("setup")).toBe(false);
	try {
		await expect(page.getByText("Agent not found", { exact: true })).toHaveCount(0);
		await expect(page.getByText("Clawdi Cloud agent not found", { exact: true })).toHaveCount(0);
		await expect(page.getByLabel("Agent ownership loading")).toBeVisible();
		await expect(page.locator('[data-hosted="true"] [data-slot="skeleton"]').first()).toBeVisible();
	} finally {
		acceptedInventoryGate.resolve();
	}
	await expect(page.getByText("Starting your agent…", { exact: true })).toBeVisible();
	await expect(page.getByText("Agent actions", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
	await expect(page.getByText("Agent unavailable", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Clawdi Cloud agent not found", { exact: true })).toHaveCount(0);
	await expect(page.locator("body")).not.toContainText("hdep_included_created");
	expect(convergencePollRequests).toEqual([]);
	await expect(page.getByText("Couldn’t deploy", { exact: true })).toHaveCount(0);
	expect(createDeploymentRequests).toHaveLength(1);
	expect(createDeploymentRequests[0]?.idempotencyKey).toMatch(/^deployment-create-/);
	expect(JSON.parse(createDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		compute_plan_slug: "compute_basic",
		runtime: "hermes",
		primary_model: {
			provider_id: "clawdi",
			model: "gpt-5.6-luna",
		},
	});
});

test("paid checkout navigates on deployment acceptance without LRO convergence", async ({
	page,
}) => {
	const checkoutRequests: string[] = [];
	const deploymentRequestReads: string[] = [];
	const operationPollRequests: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.startsWith("/v2/operations/")) operationPollRequests.push(path);
	});
	await stubCompletedStripeCheckout(page);
	const startingDeployment: DeploymentMutationFixture = {
		...paidBasicDeployment,
		id: "hdep_created",
		name: "Created Basic",
		status: "creating",
	};
	await stubHostedApi(page, {
		checkoutRequests,
		checkoutResponses: [
			{
				status: 200,
				body: {
					flow_type: "checkout_session",
					funding_source: "stripe",
					action_url: null,
					checkout_url: "https://checkout.stripe.test/session",
					client_secret: "cs_test_paid_checkout",
				},
			},
		],
		deploymentRequestReads,
		deployments: [includedBasicDeployment, startingDeployment],
		plans: [basicPlan],
		unfinishedDeploymentRequests: true,
	});
	await page.goto("/deploy");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({ ui_mode: "custom" });
	const checkoutDialog = page.getByRole("dialog", { name: /Complete .* checkout/ });
	await expect(checkoutDialog.getByText("Mock secure payment form", { exact: true })).toBeVisible();
	await checkoutDialog.getByRole("button", { name: "Subscribe", exact: true }).click();

	await expect(page).toHaveURL(/\/agents\/hdep_created/);
	await expect(page.getByText("Starting your agent…", { exact: true })).toBeVisible();
	await expect(
		page.getByText("This step should finish within five minutes.", { exact: false }),
	).toBeVisible();
	expect(deploymentRequestReads).toHaveLength(1);
	expect(operationPollRequests).toEqual([]);
	await expect(page.getByText("Couldn’t deploy", { exact: true })).toHaveCount(0);
});

test("failed checkout start stays contextual and retries without duplicate or internal errors", async ({
	page,
}) => {
	const checkoutRequests: string[] = [];
	await page.setViewportSize({ width: 390, height: 844 });
	await stubCompletedStripeCheckout(page);
	await stubHostedApi(page, {
		checkoutRequests,
		checkoutResponses: [
			{
				status: 503,
				body: { detail: "stripe_proxy_internal tenant=usr_secret upstream=acct_live" },
			},
			{
				status: 200,
				body: {
					flow_type: "checkout_session",
					funding_source: "stripe",
					action_url: null,
					checkout_url: "https://checkout.stripe.test/retry",
					client_secret: "cs_test_checkout_retry",
				},
			},
		],
		deployments: [includedBasicDeployment],
		plans: [basicPlan],
	});
	await page.goto("/deploy");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	const error = page.locator("[data-sonner-toast]").filter({ hasText: "Checkout didn’t open" });
	await expect(error.getByText("Checkout didn’t open", { exact: true })).toBeVisible();
	await expect(error).toContainText("Secure checkout is temporarily unavailable.");
	await expect(error).toContainText("No payment was submitted.");
	await expect(error).not.toContainText("stripe_proxy_internal");
	await expect(error).not.toContainText("usr_secret");
	await expect(error).toBeInViewport();
	const errorBounds = await error.boundingBox();
	if (!errorBounds) throw new Error("Expected the checkout error toast to have layout bounds");
	expect(errorBounds.x).toBeGreaterThanOrEqual(0);
	expect(errorBounds.x + errorBounds.width).toBeLessThanOrEqual(390);
	await expect(
		page.getByText("The billing service is having trouble", { exact: false }),
	).toHaveCount(0);
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
	await expect(checkoutRequests).toHaveLength(1);

	await error.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(checkoutRequests).toHaveLength(2);
	await expect(page.getByRole("dialog", { name: /Complete .* checkout/ })).toBeVisible();
	const initialDeployRequestId = checkoutDeployRequestId(checkoutRequests[0] ?? "{}");
	const retryDeployRequestId = checkoutDeployRequestId(checkoutRequests[1] ?? "{}");
	expect(initialDeployRequestId).not.toBeNull();
	expect(retryDeployRequestId).toBe(initialDeployRequestId);
});

test("missing publishable key starts hosted Checkout", async ({ page, baseURL }) => {
	test.skip(
		(process.env.E2E_STRIPE_PUBLISHABLE_KEY ?? "pk_test_browser").length > 0,
		"Run with E2E_STRIPE_PUBLISHABLE_KEY='' to exercise hosted Checkout selection.",
	);
	if (!baseURL) throw new Error("Playwright baseURL is required for hosted Checkout.");
	const checkoutRequests: string[] = [];
	const hostedUrl = new URL("/deploy?hosted_checkout=1", baseURL).toString();
	await stubHostedApi(page, {
		checkoutRequests,
		checkoutResponses: [
			{
				status: 200,
				body: {
					flow_type: "checkout_session",
					funding_source: "stripe",
					action_url: hostedUrl,
					checkout_url: hostedUrl,
					client_secret: null,
				},
			},
		],
		deployments: [includedBasicDeployment],
		plans: [basicPlan],
	});
	await page.goto("/deploy");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({ ui_mode: "hosted" });
	await expect(page).toHaveURL(hostedUrl);
	await expect(page.getByRole("dialog", { name: /Complete .* checkout/ })).toHaveCount(0);
});

test("Elements load failure retries the same Checkout Session", async ({ page }) => {
	const checkoutRequests: string[] = [];
	const clientSecret = "cs_test_elements_failed_secret";
	await stubRetriedStripeCheckoutLoad(page);
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
					client_secret: clientSecret,
				},
			},
		],
		deployments: [includedBasicDeployment],
		plans: [basicPlan],
	});
	await page.goto("/deploy");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	const dialog = page.getByRole("dialog", { name: /Complete .* checkout/ });
	await expect(
		dialog.getByText("We couldn’t load the secure payment form.", { exact: false }),
	).toBeVisible();
	await expect(dialog).not.toContainText("Mock Elements load failure");
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(
		await page.evaluate(() => {
			return {
				clientSecrets: window.__stripeCheckoutClientSecrets,
				confirmCalls: window.__stripeConfirmCalls,
			};
		}),
	).toEqual({ clientSecrets: [clientSecret], confirmCalls: 0 });

	await dialog.getByRole("button", { name: "Retry payment form", exact: true }).click();
	await expect(dialog.getByText("Mock retried secure payment form", { exact: true })).toBeVisible();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(
		await page.evaluate(() => {
			return {
				clientSecrets: window.__stripeCheckoutClientSecrets,
				confirmCalls: window.__stripeConfirmCalls,
			};
		}),
	).toEqual({ clientSecrets: [clientSecret, clientSecret], confirmCalls: 0 });
});

test("accepted detail delete dismisses immediately while teardown finishes in the background", async ({
	page,
}) => {
	const deleteRequests: string[] = [];
	const deploymentListRequests: string[] = [];
	const completedDeleteIds = new Set<string>();
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
		completedDeleteIds,
		deleteRequests,
		deploymentListRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic");
	const historyLengthBeforeDelete = await page.evaluate(() => window.history.length);

	await page.locator("main").getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete agent", exact: true })
		.click();

	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_included"]);
	await expect.poll(() => new URL(page.url()).pathname).toBe("/");
	await expect
		.poll(() => page.evaluate(() => window.history.length))
		.toBe(historyLengthBeforeDelete);
	await expect(page.getByText("Agent removed", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Cleanup continues in the background.", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "Open Basic", exact: true })).toHaveCount(0);
	await expect(page.getByTestId("app-sidebar-agent-tiles").getByLabel("Basic")).toHaveCount(0);
	// The deployment is still in the stubbed inventory as `deleting`; dismissal
	// therefore precedes teardown rather than waiting for a completed list read.
	expect(completedDeleteIds.has("hdep_included")).toBe(false);
	await page.goto("/deploy");
	await expect(page.getByRole("button", { name: "Deploy", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Continue to checkout" })).toHaveCount(0);
	expect(completedDeleteIds.has("hdep_included")).toBe(false);

	const readsBeforeCompletion = deploymentListRequests.length;
	completedDeleteIds.add("hdep_included");
	await page.reload();
	await expect.poll(() => deploymentListRequests.length).toBeGreaterThan(readsBeforeCompletion);
	await expect(page.getByRole("link", { name: "Open Basic", exact: true })).toHaveCount(0);
});

test("rejected detail delete stays on the current agent without accepted cleanup feedback", async ({
	page,
}) => {
	const deleteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
		deleteRequests,
		deleteResponses: [
			{ status: 422, body: { detail: "internal delete coordinator rejected tenant usr_secret" } },
		],
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic");

	await page.locator("main").getByRole("button", { name: "Delete", exact: true }).click();
	const dialog = page.getByRole("alertdialog");
	await dialog.getByRole("button", { name: "Delete agent", exact: true }).click();

	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_included"]);
	await expect(page).toHaveURL(/\/agents\/hdep_included\/settings/);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Delete agent", exact: true })).toBeEnabled();
	await expect(page.getByText("Agent removed", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Cleanup continues in the background.", { exact: true })).toHaveCount(
		0,
	);
	await expect(page.getByText("internal delete coordinator", { exact: false })).toHaveCount(0);
});

test("deploy managed model picker preserves featured and overflow order and submits overflow", async ({
	page,
}) => {
	const createDeploymentRequests: Array<{ body: string; idempotencyKey: string | null }> = [];
	await stubHostedApi(page, {
		plans: [basicPlan],
		deployments: [],
		createDeploymentRequests,
		managedModels: dynamicManagedModelCatalog,
	});
	await page.goto("/deploy");

	const managedModels = page.getByTestId("managed-model-choices");
	await expect(managedModels).toHaveAccessibleName("Main model");
	const featuredModels = managedModels.getByRole("radio");
	const featuredCards = managedModels.locator(":scope > label");
	await expect(featuredModels).toHaveCount(4);
	await expect(featuredCards).toHaveCount(4);
	await expect(featuredModels.nth(0)).toHaveAccessibleName("GPT-5.6-Terra");
	await expect(featuredModels.nth(1)).toHaveAccessibleName("GPT-5.6-Luna");
	await expect(featuredModels.nth(2)).toHaveAccessibleName("GPT-5.6-Sol");
	await expect(featuredModels.nth(3)).toHaveAccessibleName("Kimi K3");
	await expect(featuredCards.nth(0).getByText("O", { exact: true })).toBeVisible();
	await expect(featuredCards.nth(0).getByText("S", { exact: true })).toHaveCount(0);
	await expect(featuredCards.nth(3).getByRole("img", { name: /kimi-coding/i })).toBeVisible();
	for (const radio of await featuredModels.all()) {
		const visualControl = await radio.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				height: element.getBoundingClientRect().height,
				position: style.position,
				width: element.getBoundingClientRect().width,
			};
		});
		expect(visualControl.position).toBe("absolute");
		expect(visualControl.height).toBeLessThanOrEqual(1);
		expect(visualControl.width).toBeLessThanOrEqual(1);
	}
	const overflowModels = page.getByTestId("managed-model-overflow");
	await expect(overflowModels).toHaveAccessibleName("More managed models");
	await expect(overflowModels).toContainText("More models");
	await expect(featuredModels.nth(0)).toBeChecked();
	await expect(featuredModels.nth(1)).not.toBeChecked();
	await expect(featuredModels.nth(2)).not.toBeChecked();
	await expect(featuredModels.nth(3)).not.toBeChecked();
	await expect(page.locator("#deploy-primary-model")).toHaveCount(0);
	await expect(managedModels).toContainText("Higher cost for complex work.");
	await expect(managedModels).toContainText("Variable cost for long, detailed work.");
	await expect(managedModels).not.toContainText(/272K|256K|1M|Codex|context|eligible plans/i);
	await expect(page.getByTestId("managed-model-details")).toHaveCount(0);
	const cardBoxesBefore = await featuredCards.evaluateAll((cards) =>
		cards.map((card) => {
			const box = card.getBoundingClientRect();
			return { height: box.height, width: box.width };
		}),
	);
	await featuredCards.nth(2).click({ position: { x: 3, y: 3 } });
	await expect(featuredModels.nth(2)).toBeChecked();
	await expect(featuredModels.nth(0)).not.toBeChecked();
	await expect(featuredCards.nth(0).locator("svg.lucide-check")).toHaveCSS("opacity", "0");
	await expect(featuredCards.nth(2).locator("svg.lucide-check")).toHaveCSS("opacity", "1");
	await featuredCards.nth(3).click({ position: { x: 3, y: 3 } });
	await expect(featuredModels.nth(3)).toBeChecked();
	await expect(featuredModels.nth(2)).not.toBeChecked();
	expect(
		await featuredCards.evaluateAll((cards) =>
			cards.map((card) => {
				const box = card.getBoundingClientRect();
				return { height: box.height, width: box.width };
			}),
		),
	).toEqual(cardBoxesBefore);

	const screenshotStyle = await page.addStyleTag({
		content: ".sticky.bottom-0 { display: none !important; }",
	});
	for (const viewport of [
		{ width: 1280, height: 800 },
		{ width: 800, height: 800 },
		{ width: 700, height: 800 },
		{ width: 390, height: 800 },
	]) {
		await page.setViewportSize(viewport);
		const documentWidth = await page.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
		}));
		expect(documentWidth.scrollWidth, `model picker at ${viewport.width}px`).toBe(
			documentWidth.clientWidth,
		);
		await expect(managedModels).toBeVisible();
		await expect(overflowModels).toBeVisible();
		const modelPicker = managedModels.locator("../..");
		await modelPicker.screenshot({
			path: `/tmp/managed-model-guidance-${viewport.width}.png`,
		});
		const pickerBox = await modelPicker.boundingBox();
		expect(
			pickerBox?.x ?? viewport.width,
			`model picker at ${viewport.width}px`,
		).toBeGreaterThanOrEqual(0);
		expect(
			(pickerBox?.x ?? 0) + (pickerBox?.width ?? viewport.width),
			`model picker right edge at ${viewport.width}px`,
		).toBeLessThanOrEqual(viewport.width);
	}
	await screenshotStyle.evaluate((element) => element.parentNode?.removeChild(element));

	await expect(overflowModels).toContainText("More models");
	await overflowModels.click();
	await expect(page.getByRole("option")).toHaveCount(6);
	await expect(page.getByRole("option").nth(0)).toContainText("GPT-5.5");
	await expect(page.getByRole("option").nth(0).getByText("O", { exact: true })).toBeVisible();
	await expect(page.getByRole("option").nth(1)).toContainText("GPT-5.4");
	await expect(page.getByRole("option").nth(1).getByText("O", { exact: true })).toBeVisible();
	await expect(page.getByRole("option").nth(1)).toContainText(
		"Balanced cost for coding and tools.",
	);
	await expect(page.getByRole("option").nth(2)).toContainText("GPT-5.4-Mini");
	await expect(page.getByRole("option").nth(2)).toContainText("Low cost for lighter coding work.");
	await page.getByRole("option").nth(1).click();
	await expect(overflowModels.locator('[data-slot="select-value"]')).toHaveText("GPT-5.4");
	await expect(featuredModels.nth(0)).not.toBeChecked();
	await page.getByRole("button", { name: "Deploy", exact: true }).click();
	await expect(page).toHaveURL(/\/agents\/hdep_included_created/);

	expect(JSON.parse(createDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		primary_model: {
			model: "gpt-5.4",
		},
	});
});

test("deploy keeps every saved provider model editable and uses only catalog defaults", async ({
	page,
}) => {
	const preset = providerPresetById("deepseek");
	if (!preset) throw new Error("Expected the DeepSeek preset fixture.");
	const savedPresetProvider = {
		...userProvider(preset.id, preset.label, presetCatalogToProviderModels(preset)),
		base_url: preset.base_url,
	};
	const catalogA = userProvider("owner-catalog-a", "Owner Catalog A", [
		{ id: "owner-a-default", label: "Owner A default" },
		{ id: "owner-a-alternate", label: "Owner A alternate" },
	]);
	const catalogB = userProvider("owner-catalog-b", "Owner Catalog B", [
		{ id: "owner-b-default", label: "Owner B default" },
	]);
	const withoutCatalog = userProvider("owner-empty", "Owner Empty", null);
	await stubHostedApi(page, {
		plans: [basicPlan],
		deployments: [],
		aiProviders: [savedPresetProvider, catalogA, catalogB, withoutCatalog],
	});
	await page.goto("/deploy");

	await page.getByRole("button", { name: /^DeepSeek/ }).click();
	const modelInput = page.getByLabel("Main model");
	await expect(modelInput).toHaveValue(preset.catalog[0].id);
	await expect(modelInput).toHaveAttribute("list", "deploy-model-options");

	await page.getByRole("button", { name: /^Owner Catalog A/ }).click();
	await expect(modelInput).toHaveAttribute("id", "deploy-primary-model");
	await expect(modelInput).toHaveAttribute("list", "deploy-model-options");
	await expect(modelInput).toHaveValue("owner-a-default");
	await expect(page.locator("#deploy-model-options option")).toHaveCount(2);

	await page.getByRole("button", { name: /^Owner Catalog B/ }).click();
	await expect(modelInput).toHaveValue("owner-b-default");
	await page.getByRole("button", { name: /^Owner Catalog A/ }).click();
	await expect(modelInput).toHaveValue("owner-a-default");

	await modelInput.fill("owner/custom-model");
	await page.getByRole("button", { name: /^Owner Catalog B/ }).click();
	await expect(modelInput).toHaveValue("owner/custom-model");

	await modelInput.fill("owner-b-default");
	await page.getByRole("button", { name: /^Owner Empty/ }).click();
	await expect(modelInput).toHaveValue("");
	await expect(modelInput).not.toHaveAttribute("list");
	await page.getByRole("button", { name: /^Owner Catalog A/ }).click();
	await expect(modelInput).toHaveValue("owner-a-default");
	await expect(page.getByTestId("managed-model-choices")).toHaveCount(0);
});

test("Basic paid checkout stays hidden until deployment inventory succeeds", async ({ page }) => {
	await stubHostedApi(page, {
		plans: [basicPlan],
		deploymentsResponse: { status: 200, body: [], delayMs: 1_000 },
	});
	await page.goto("/deploy");

	await expect(page.getByText("Checking your free Basic slot…", { exact: true })).toBeVisible();
	await expect(page.getByText("$10.00/mo", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Continue to checkout" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Deploy", exact: true })).toBeDisabled();

	await expect(page.getByTestId("basic-compute-price")).toContainText("Free");
	await expect(page.getByTestId("basic-compute-price")).toContainText("First Basic agent");
	await expect(page.getByRole("button", { name: "Deploy", exact: true })).toBeEnabled();
});

test("empty plans and wallet failures expose working retries", async ({ page }) => {
	const planRequests: string[] = [];
	await stubHostedApi(page, { plans: [], planRequests });
	await page.goto("/deploy");

	const plansError = page.getByRole("alert").filter({ hasText: "Couldn't load compute plans" });
	await expect(plansError).toBeVisible();
	await plansError.getByRole("button", { name: "Retry" }).click();
	await expect.poll(() => planRequests.length).toBeGreaterThanOrEqual(2);

	const walletRequests: string[] = [];
	await page.unrouteAll({ behavior: "wait" });
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan],
		walletRequests,
		walletResponses: [
			{ status: 403, body: { detail: "wallet unavailable" } },
			{ status: 200, body: walletState },
		],
	});
	await page.goto("/deploy");
	await page.getByRole("button", { name: /Wallet balance/ }).click();

	const amount = page.getByTestId("deploy-amount");
	await expect(amount).toContainText("Quote unavailable");
	await amount.getByRole("button", { name: "Retry" }).click();
	await expect(amount).toContainText("Debit today: $10.00");
	await expect(page.getByRole("button", { name: "Pay & deploy" })).toBeEnabled();
	await expect.poll(() => walletRequests.length).toBe(2);
});

test("hosted locale settings submit canonical deployment PATCH", async ({ page }) => {
	const updateDeploymentRequests: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}> = [];
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan],
		updateDeploymentRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic");

	await page.locator("#hosted-agent-language").click();
	await page.getByRole("option", { name: "Español" }).click();
	await page.locator("main").getByRole("button", { name: "Save changes" }).click();
	await expect.poll(() => updateDeploymentRequests.length).toBe(1);

	expect(updateDeploymentRequests[0]?.idempotencyKey).toMatch(/^deployment-update-/);
	expect(updateDeploymentRequests[0]?.ifMatch).toBe('"rv_hdep_included"');
	expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		language: "es",
	});
});

test("hosted AI provider Apply submits canonical deployment PATCH", async ({ page }) => {
	const updateDeploymentRequests: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}> = [];
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		updateDeploymentRequests,
	});
	await page.goto("/agents/hdep_included/model-provider?source=on-clawdi");

	await page.getByRole("button", { name: /Configure inside agent/ }).click();
	await page.locator("main").getByRole("button", { name: "Save changes" }).click();
	await expect.poll(() => updateDeploymentRequests.length).toBe(1);
	expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		ai_provider_auth_kind: "unmanaged",
		ai_provider_id: null,
		provider_ids: [],
		primary_model: null,
	});
});

test("hosted AI provider Apply accepts the managed Luna default", async ({ page }) => {
	const updateDeploymentRequests: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}> = [];
	const unmanagedDeployment: DeploymentMutationFixture = {
		...includedBasicDeployment,
		id: "hdep_unmanaged_model",
		config_info: {
			...includedBasicDeployment.config_info,
			ai_provider_auth_kind: "unmanaged",
		},
	};
	await stubHostedApi(page, {
		deployments: [unmanagedDeployment],
		updateDeploymentRequests,
	});
	await page.goto("/agents/hdep_unmanaged_model/model-provider?source=on-clawdi");

	await page.getByRole("button", { name: /Clawdi AI/ }).click();
	const agentModels = page.getByTestId("managed-model-choices");
	await expect(agentModels).toHaveAccessibleName("Main model");
	const agentModelChoice = agentModels.getByRole("radio", { name: "GPT-5.6-Luna" });
	await expect(agentModelChoice).toBeChecked();
	await expect(agentModels).toContainText("Low cost for routine work.");
	await expect(page.locator("#agent-primary-model")).toHaveCount(0);
	const agentModelFrame = await agentModels.evaluate((element) => {
		const frame = element.closest('div[data-hosted="true"][data-v2="true"]');
		const style = frame ? getComputedStyle(frame) : null;
		return style
			? {
					borderTopWidth: Number.parseFloat(style.borderTopWidth),
					paddingTop: Number.parseFloat(style.paddingTop),
				}
			: null;
	});
	expect(agentModelFrame).toEqual({ borderTopWidth: 1, paddingTop: 12 });
	for (const viewport of [
		{ height: 900, width: 1280 },
		{ height: 900, width: 800 },
		{ height: 900, width: 700 },
		{ height: 844, width: 390 },
	]) {
		await page.setViewportSize(viewport);
		await expect(agentModels).toHaveAccessibleName("Main model");
		const documentWidth = await page.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
		}));
		expect(documentWidth.scrollWidth, `agent settings at ${viewport.width}px`).toBe(
			documentWidth.clientWidth,
		);
	}
	await page.locator("main").getByRole("button", { name: "Save changes" }).click();
	await expect.poll(() => updateDeploymentRequests.length).toBe(1);
	expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		ai_provider_auth_kind: "managed",
		provider_ids: ["clawdi"],
		primary_model: {
			provider_id: "clawdi",
			model: "gpt-5.6-luna",
		},
	});
});

test("agent settings preserves a persisted custom primary model outside the provider catalog", async ({
	page,
}) => {
	const persistedProvider = userProvider("persisted-catalog", "Persisted Catalog", [
		{ id: "persisted-default", label: "Persisted default" },
		{ id: "persisted-alternate", label: "Persisted alternate" },
	]);
	const switchProvider = userProvider("switch-catalog", "Switch Catalog", [
		{ id: "switch-default", label: "Switch default" },
	]);
	const persistedCustomModel = "owner/persisted-custom-model";
	expect(persistedProvider.models?.some((model) => model.id === persistedCustomModel)).toBe(false);
	const deployment: DeploymentMutationFixture = {
		...includedBasicDeployment,
		id: "hdep_persisted_custom_model",
		config_info: {
			...includedBasicDeployment.config_info,
			ai_provider_auth_kind: "api_key",
			runtime_configuration: {
				providers: [
					{
						provider_id: persistedProvider.provider_id,
						auth_kind: "secret_reference",
						base_url: persistedProvider.base_url,
						models: persistedProvider.models?.map((model) => model.id) ?? [],
					},
				],
				primary_model: {
					provider_id: persistedProvider.provider_id,
					model: persistedCustomModel,
				},
				features: [],
			},
		},
	};
	await stubHostedApi(page, {
		deployments: [deployment],
		aiProviders: [persistedProvider, switchProvider],
	});
	await page.goto("/agents/hdep_persisted_custom_model/model-provider?source=on-clawdi");

	const modelInput = page.getByLabel("Main model");
	await expect(modelInput).toHaveAttribute("id", "agent-primary-model");
	await expect(modelInput).toHaveValue(persistedCustomModel);

	await modelInput.fill("owner/edited-custom-model");
	await expect(modelInput).toHaveValue("owner/edited-custom-model");
	await page.getByRole("button", { name: /^Switch Catalog/ }).click();
	await page.locator("#agent-primary-provider").click();
	await page.getByRole("option", { name: "Switch Catalog" }).click();
	await expect(modelInput).toHaveValue("owner/edited-custom-model");
	await expect(modelInput).toHaveAttribute("list", "agent-model-options");
	await expect(page.locator("#agent-model-options option")).toHaveAttribute(
		"value",
		"switch-default",
	);
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
	await expect.poll(() => new URL(page.url()).searchParams.get("d")).toBe("hdep_failed_projection");
	await expect(main.getByText("Some agent details are not ready", { exact: true })).toBeVisible();
	await expect(main.getByText(missingProjectionFailureReason, { exact: true })).toHaveCount(0);
	await expect(
		main.getByText("The Clawdi service could not complete this request.", { exact: true }),
	).toBeVisible();
	await expect(main.getByText("Failed", { exact: true })).toBeVisible();
	await expect(main.getByText("Basic", { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Retry startup", exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Agent Interface", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Check again", exact: true })).toBeVisible();

	expect(restartRequests).toEqual([]);

	await main.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete agent", exact: true })
		.click();
	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_failed_projection"]);
});

test("stopped deployment tiles expose Start and friendly Delete actions", async ({ page }) => {
	const startRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [stoppedProjectionGoneDeployment],
		startRequests,
	});

	for (const path of ["/", "/agents"]) {
		await page.goto(path);
		const main = page.locator("main");
		await expect(main.getByRole("button", { name: "Start Hermes", exact: true })).toBeVisible();
		await expect(main.getByRole("button", { name: "Delete Hermes", exact: true })).toBeVisible();
		await expect(
			main.getByText("deployment-create-browser-generated", { exact: true }),
		).toHaveCount(0);
	}

	await page.locator("main").getByRole("button", { name: "Start Hermes", exact: true }).click();
	await expect.poll(() => startRequests.length).toBe(1);
});

test("stopped detail stays recoverable without querying its removed projection", async ({
	page,
}) => {
	const cloudRequests: string[] = [];
	const deployRequests: string[] = [];
	const startRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		const path = `${url.pathname}${url.search}`;
		if (url.origin === CLOUD_API) cloudRequests.push(path);
		if (url.origin === DEPLOY_API) deployRequests.push(path);
	});
	await stubHostedApi(page, {
		deployments: [stoppedProjectionGoneDeployment],
		cloudAgentNotFoundIds: [stoppedProjectionEnvironmentId],
		startRequests,
	});

	const detailPath = `/agents/${stoppedProjectionEnvironmentId}`;
	const detailQuery = `?source=on-clawdi&d=${stoppedProjectionGoneDeployment.id}`;
	for (const section of ["", "/sessions", "/channel-links", "/console"]) {
		await page.goto(`${detailPath}${section}${detailQuery}`);
		const main = page.locator("main");
		await expect(
			main.locator('[data-slot="empty-title"]').getByText("Stopped", { exact: true }),
		).toBeVisible();
		await expect(main.getByRole("button", { name: "Start", exact: true })).toBeVisible();
		await expect(main.getByText("Clawdi Cloud agent not found", { exact: true })).toHaveCount(0);
		await expect(main.getByText("Some agent details are not ready", { exact: true })).toHaveCount(
			0,
		);
	}

	const removedProjectionRequests = cloudRequests.filter((path) => {
		if (path === `/v1/agents/${stoppedProjectionEnvironmentId}`) return true;
		if (path.startsWith("/v1/sessions")) return true;
		return (
			path.startsWith("/v1/channels/agent-links") &&
			path.includes(encodeURIComponent(stoppedProjectionEnvironmentId))
		);
	});
	expect(removedProjectionRequests).toEqual([]);
	expect(deployRequests.filter((path) => path.endsWith("/runtime-ui/credentials"))).toEqual([]);

	await page.goto(`${detailPath}${detailQuery}`);
	await page.locator("main").getByRole("button", { name: "Start", exact: true }).click();
	await expect.poll(() => startRequests.length).toBe(1);
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
	await expect(main.getByText(retainedProjectionFailureReason, { exact: true })).toHaveCount(0);
	await expect(
		main.getByText("The Clawdi service could not complete this request.", { exact: true }),
	).toBeVisible();
	await expect(main.getByText("Failed", { exact: true })).toBeVisible();
	await expect(main.getByText("Basic", { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Retry startup", exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Agent Interface", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();

	expect(restartRequests).toEqual([]);

	await main.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete agent", exact: true })
		.click();
	await expect
		.poll(() => deleteRequests)
		.toEqual(["/v2/deployments/hdep_failed_retained_projection"]);
});

test("terminal provider failure replaces Starting with provider recovery", async ({ page }) => {
	const starting = {
		...includedBasicDeployment,
		id: "hdep_provider_failed",
		name: "Provider recovery",
		status: "starting",
	};
	const deployment = mutationDeploymentReadFixture(starting);
	deployment.accepted_operation = {
		...completedDeploymentOperation(starting, "create"),
		done: true,
		response: null,
		error: {
			code: 5,
			message: "provider unavailable",
			details: [
				{
					"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
					type: "https://api.clawdi.ai/problems/provider-not-found",
					title: "Provider not found",
					status: 404,
					detail: "Provider unavailable",
					code: "provider_not_found",
					retryable: false,
					conditionReason: "ProviderNotFound",
					conditionMessage: "Provider unavailable",
					observedGeneration: 1,
				},
			],
		},
	};
	await stubHostedApi(page, { deployments: [deployment] });

	await page.goto(`/agents/${starting.id}?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.getByText("Provider configuration failed", { exact: true })).toBeVisible();
	await expect(
		main.getByText("The selected provider is no longer available in your Clawdi account.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(main.getByText("Starting your agent…", { exact: true })).toHaveCount(0);
	await main.getByRole("button", { name: "Fix provider", exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/agents/${starting.id}/model-provider`));
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
	await expect(main.getByText("Some agent details are not ready", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Agent Interface", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	await main.getByRole("button", { name: "Check again", exact: true }).click();
	await expect(main.getByText("Some agent details are not ready", { exact: true })).toHaveCount(0);
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
	await expect(main.getByText("Couldn’t load all agent details", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Agent Interface", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	const renderErrors = errors.filter(
		(error) => error.includes("Maximum update depth") || error.includes("Too many re-renders"),
	);
	expect(renderErrors, `projection failure render: ${errors.join(" | ")}`).toEqual([]);
});

test("deployment detail stays put, becomes running, and keeps manual Runtime UI access", async ({
	page,
}) => {
	const pendingRuntimeUiDeployment = {
		...runningMissingProjectionDeployment,
		id: "hdep_runtime_ui_settling",
		name: "Runtime UI settling agent",
		status: "creating",
		hermes_control_ui_url: null,
	};
	const readyRuntimeUiDeployment = {
		...pendingRuntimeUiDeployment,
		status: "running",
		hermes_control_ui_url: "https://runtime.example/hermes",
	};
	const deployments: unknown[] = [pendingRuntimeUiDeployment];
	const deploymentListRequests: string[] = [];
	const runtimeUiRedemptionRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		deploymentListRequests,
		runtimeUiRedemptionRequests,
	});

	await page.goto(`/agents/${pendingRuntimeUiDeployment.id}?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.getByText("Starting your agent…", { exact: true })).toBeVisible();
	await expect(page).toHaveURL(
		(url) => url.pathname === `/agents/${pendingRuntimeUiDeployment.id}`,
	);

	deployments.splice(0, 1, readyRuntimeUiDeployment);

	await expect
		.poll(() => deploymentListRequests.length, { timeout: 15_000 })
		.toBeGreaterThanOrEqual(2);
	await expect(main.getByText("Your agent is running", { exact: true })).toBeVisible();
	await expect(page).toHaveURL(
		(url) => url.pathname === `/agents/${pendingRuntimeUiDeployment.id}`,
	);
	expect(runtimeUiRedemptionRequests).toEqual([]);
	await expect(main.locator('iframe[title="Hermes Dashboard"]')).toHaveCount(0);

	await page.getByRole("link", { name: "Agent Interface", exact: true }).click();
	await expect(page).toHaveURL(
		(url) =>
			url.pathname === `/agents/${pendingRuntimeUiDeployment.id}/console` &&
			url.searchParams.get("source") === "on-clawdi" &&
			url.searchParams.get("d") === pendingRuntimeUiDeployment.id,
	);
	await expect(main.locator('iframe[title="Hermes Dashboard"]')).toHaveAttribute(
		"src",
		"https://runtime.example/hermes",
	);
	await expect(main.getByRole("button", { name: "Access Hermes Dashboard" })).toBeVisible();
	await expect(
		main.getByRole("button", { name: "Open Hermes Dashboard in new window" }),
	).toBeVisible();
});

test("Runtime UI Access shows Hermes username, masks password, and submits one declarative reset", async ({
	context,
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const runtimeUiRedemptionRequests: string[] = [];
	const runtimeUiResetRequests: Array<{ idempotencyKey: string | null; ifMatch: string | null }> =
		[];
	await stubHostedApi(page, {
		deployments: [runningMissingProjectionDeployment],
		runtimeUiRedemptionRequests,
		runtimeUiResetRequests,
	});

	await page.goto(`/agents/${missingProjectionEnvironmentId}/console?source=on-clawdi`);
	const main = page.locator("main");
	const iframe = main.locator('iframe[title="Hermes Dashboard"]');
	await expect(iframe).toHaveAttribute("src", "https://runtime.example/hermes");
	await expect(page.getByText("Sign in to Hermes", { exact: true })).toBeVisible();
	await main.getByRole("button", { name: "Access Hermes Dashboard" }).click();
	const dialog = page.getByRole("dialog", { name: "Runtime UI access" });
	await expect(dialog).toBeVisible();
	await expect(page.getByText("Sign in to Hermes", { exact: true })).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(
				(deploymentId) =>
					localStorage.getItem(`clawdi.hermes-access-hint.dismissed.${deploymentId}`),
				runningMissingProjectionDeployment.id,
			),
		)
		.toBe("1");
	await expect.poll(() => runtimeUiRedemptionRequests.length).toBe(1);
	await expect(dialog.locator("code")).toHaveText(["admin", "••••••••••••"]);
	await expect(dialog.getByText("admin", { exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Show Username" })).toHaveCount(0);
	await dialog.getByRole("button", { name: "Copy Username" }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("admin");
	await dialog.getByRole("button", { name: "Copy Password" }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("test-password");

	await dialog.getByRole("button", { name: "Reset access", exact: true }).click();
	const confirmation = page.getByRole("alertdialog", { name: "Reset Runtime UI access?" });
	await confirmation.getByRole("button", { name: "Reset access", exact: true }).click();
	await expect.poll(() => runtimeUiResetRequests.length).toBe(1);
	expect(runtimeUiResetRequests[0]).toMatchObject({ ifMatch: '"rv_hdep_running_projection"' });
	expect(runtimeUiResetRequests[0]?.idempotencyKey).toBeTruthy();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByText("test-password", { exact: true })).toHaveCount(0);
});

test("Runtime UI credential failure renders a retryable error instead of a permanent spinner", async ({
	page,
}) => {
	const runtimeUiRedemptionRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [runningMissingProjectionDeployment],
		runtimeUiRedemptionRequests,
		runtimeUiRedemptionResponses: [
			{ status: 500, body: { detail: "credentials temporarily unavailable" } },
			{
				status: 200,
				body: {
					runtime: "hermes",
					url: "https://runtime.example/hermes",
					deployment_resource_version: "rv_hdep_running_projection",
					auth_mode: "password",
					username: "admin",
					password: "recovered-password",
				},
			},
		],
	});

	await page.goto(`/agents/${missingProjectionEnvironmentId}/console?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.locator('iframe[title="Hermes Dashboard"]')).toHaveAttribute(
		"src",
		"https://runtime.example/hermes",
	);
	await main.getByRole("button", { name: "Access Hermes Dashboard", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Runtime UI access" });
	await expect.poll(() => runtimeUiRedemptionRequests.length).toBe(1);
	await expect(
		dialog.getByText("Couldn't load Hermes Dashboard access", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("credentials temporarily unavailable", { exact: true })).toHaveCount(
		0,
	);
	await dialog.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		dialog.getByText("Couldn't load Hermes Dashboard access", { exact: true }),
	).toHaveCount(0);
	await expect(dialog.locator("code")).toHaveText(["admin", "••••••••••••"]);
	await dialog.getByRole("button", { name: "Show Password", exact: true }).click();
	await expect(dialog.getByText("recovered-password", { exact: true })).toBeVisible();
	await expect.poll(() => runtimeUiRedemptionRequests.length).toBe(2);
});

test("OpenClaw Console opens through the direct gateway token handoff", async ({ page }) => {
	const runtimeUiRedemptionRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [openClawIncludedDeployment],
		runtimeUiRedemptionRequests,
		runtimeUiRedemptionResponses: [
			{
				status: 200,
				body: {
					runtime: "openclaw",
					url: "https://runtime.example/openclaw/",
					deployment_resource_version: "rv_hdep_openclaw_included",
					auth_mode: "openclaw_token",
					token: "gateway-token",
					handoff_url: "https://runtime.example/openclaw/#token=gateway-token",
				},
			},
		],
	});

	await page.goto("/agents/hdep_openclaw_included/console?source=on-clawdi");
	const main = page.locator("main");
	const iframe = main.locator('iframe[title="OpenClaw Control UI"]');
	await expect.poll(() => runtimeUiRedemptionRequests.length).toBe(1);
	await expect(iframe).toHaveAttribute(
		"src",
		"https://runtime.example/openclaw/#token=gateway-token",
	);
	await expect(main.getByText("gateway-token", { exact: false })).toHaveCount(0);
	await expect(
		main.getByRole("button", { name: "Open OpenClaw Control UI in new window" }),
	).toBeVisible();
	const toolbarPopupPromise = page.waitForEvent("popup");
	await main.getByRole("button", { name: "Open OpenClaw Control UI in new window" }).click();
	const toolbarPopup = await toolbarPopupPromise;
	expect(toolbarPopup).toBeDefined();
	await toolbarPopup.close();
	await main.getByRole("button", { name: "Access OpenClaw Control UI" }).click();
	const dialog = page.getByRole("dialog", { name: "Runtime UI access" });
	expect(runtimeUiRedemptionRequests).toHaveLength(1);
	await expect(main.getByText("gateway-token", { exact: false })).toHaveCount(0);
	await expect(iframe).toHaveAttribute(
		"src",
		"https://runtime.example/openclaw/#token=gateway-token",
	);
	await expect(dialog.locator("code")).toHaveText("••••••••••••");
	await dialog.getByRole("button", { name: "Copy Token" }).click();
	await dialog.getByRole("button", { name: "Show Token" }).click();
	await expect(dialog.getByText("gateway-token", { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: "Hide Token" }).click();
	await expect(dialog.getByText("gateway-token", { exact: true })).toHaveCount(0);
	const popupPromise = page.waitForEvent("popup");
	await dialog.getByRole("button", { name: "Open in new window", exact: true }).click();
	const popup = await popupPromise;
	expect(popup).toBeDefined();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(iframe).toHaveAttribute(
		"src",
		"https://runtime.example/openclaw/#token=gateway-token",
	);
	await expect(main.getByText("gateway-token", { exact: false })).toHaveCount(0);
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
	const newerTile = agents.getByRole("link", { name: "Open Newer twin", exact: true });
	const olderTile = agents.getByRole("link", { name: "Open Older twin", exact: true });
	await expect(newerTile).toBeVisible();
	await expect(olderTile).toBeVisible();
	await expect(newerTile.locator("..").getByText("Running", { exact: true })).toHaveCount(0);
	await expect(olderTile.locator("..").getByText("Stopped", { exact: true })).toHaveCount(0);
	const rail = page.getByTestId("app-sidebar-agent-tiles");
	const newerRailTile = rail.getByLabel("Newer twin", { exact: true });
	const olderRailTile = rail.getByLabel("Older twin", { exact: true });
	await expect(newerRailTile).toBeVisible();
	await expect(olderRailTile).toBeVisible();
	await newerRailTile.click();
	await expect(page).toHaveURL(
		new RegExp(`/agents/${sharedLegacyEnvironmentId}(?:\\?|/).*d=hdep_shared_newer`),
	);
	await page.goto("/agents");
	await olderRailTile.click();
	await expect(page).toHaveURL(
		new RegExp(`/agents/${sharedLegacyEnvironmentId}(?:\\?|/).*d=hdep_shared_older`),
	);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(page).toHaveURL(
		new RegExp(`/agents/${sharedLegacyEnvironmentId}/settings\\?.*d=hdep_shared_older`),
	);

	const main = page.locator("main");
	await main.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete agent", exact: true })
		.click();

	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_shared_older"]);
});

test("shared legacy environment direct route asks the user to choose an agent", async ({
	page,
}) => {
	await stubHostedApi(page, {
		deployments: [newerSharedEnvironmentDeployment, olderSharedEnvironmentDeployment],
	});

	await page.goto(`/agents/${sharedLegacyEnvironmentId}?source=on-clawdi`);
	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Choose an agent" })).toBeVisible();
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
	const failedDeleteRetryability = new Map<string, boolean>();
	await stubHostedApi(page, {
		deployments: [interruptedIdentitylessDeployment],
		deleteRequests,
		failedDeleteRetryability,
	});

	await page.goto("/agents");
	const historyLengthBeforeDelete = await page.evaluate(() => window.history.length);
	const deleteAction = page.getByRole("button", { name: "Delete Interrupted deployment" });
	await expect(deleteAction).toBeVisible();
	await deleteAction.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete agent", exact: true })
		.click();
	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_creation_interrupted"]);
	await expect.poll(() => new URL(page.url()).pathname).toBe("/");
	await expect
		.poll(() => page.evaluate(() => window.history.length))
		.toBe(historyLengthBeforeDelete);
	await expect(deleteAction).toHaveCount(0);

	failedDeleteRetryability.set("hdep_creation_interrupted", false);
	await expect(
		page.getByText("Cleanup for Interrupted deployment needs attention", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Contact support", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry cleanup", exact: true })).toHaveCount(0);
	await expect(deleteAction).toHaveCount(0);
});

test("Basic create always follows the wizard-selected funding path", async ({ page }) => {
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

	await expect(page.getByTestId("basic-compute-price")).toContainText("$10.00/mo");
	await expect(page.getByRole("button", { name: /^Basic/ })).toContainText("2 vCPU · 4 GB RAM");
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

test("entitled card subscription activation opens the accepted deployment without checkout", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		checkoutResponses: [
			{
				status: 200,
				body: {
					flow_type: "subscription_activation",
					funding_source: "stripe",
					checkout_url: "",
					deploy_request_id: "reuse-active-subscription",
					deployment_id: "hdep_included",
					current_period_end: "2027-07-15T00:00:00Z",
					entitled_until: "2027-07-15T00:00:00Z",
				},
			},
		],
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	await expect(page).toHaveURL(/\/agents\/hdep_included(?:\?|\/)/);
	await expect(page.getByText("Agent deployment started", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: /Complete .* checkout/ })).toHaveCount(0);
	await expect(page.getByText("Mock secure payment form", { exact: true })).toHaveCount(0);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
		funding_source: "stripe",
		deploy_config: { compute_plan_slug: "compute_basic" },
	});
	expect(errors, `subscription reuse activation: ${errors.join(" | ")}`).toEqual([]);
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

	await expect(page.getByTestId("basic-compute-price")).toContainText("$10.00/mo");
	await expect(page.getByText("Monthly", { exact: true })).toBeVisible();
	const annualTerm = page.getByRole("button", { name: /Annual.*%/ });
	await expect(annualTerm).toBeVisible();
	await expectNoQuarterlyCopy(page);
	await annualTerm.click();
	await expect(page.getByText("Wallet balance", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /Wallet balance/ })).toBeVisible();
	const basicPrice = page.getByTestId("basic-compute-price");
	await expect(basicPrice).toContainText("$8.33/mo");
	await expect(basicPrice).toContainText("Billed $100.00/yr · save $20.00");
	await expect(page.getByTestId("deploy-amount")).toContainText("$100.00/yr");
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
		checkoutResponses: [
			{
				status: 202,
				delayMs: 500,
				body: {
					flow_type: "subscription_activation",
					funding_source: "wallet",
					checkout_url: "",
					deployment_id: "hdep_wallet_created",
					deploy_request_id: "wallet-annual-delayed",
					debited_usd: "100.00",
					balance_after_usd: "0.00",
				},
			},
		],
		deployments,
		plans: [basicPlan, performancePlan],
		subscriptionQuoteRequests,
		subscriptionQuoteResponses: [
			walletSubscriptionQuote({
				planSlug: "compute_basic",
				billingTermMonths: 12,
				termPriceCents: 10_000,
				debitAmountUsd: "100.00",
				balanceBeforeUsd: "100.00",
				balanceAfterUsd: "0.00",
			}),
		],
		walletState: { ...walletState, balance_usd: "100.00" },
		onWalletCheckoutSuccess: () => deployments.push(walletAnnualDeployment),
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await expect(page.getByTestId("basic-compute-price")).toContainText("$10.00/mo");
	await page.getByRole("button", { name: /Annual.*%/ }).click();
	await expect(page.getByTestId("basic-compute-price")).toContainText("$8.33/mo");
	await page.getByRole("button", { name: /Wallet balance/ }).click();
	await expect.poll(() => subscriptionQuoteRequests.length).toBe(1);
	const walletAmount = page.getByTestId("deploy-amount");
	await expect(walletAmount).toContainText("Debit today: $100.00");
	await expect(walletAmount).toContainText("From Wallet · renews yearly");

	await page.getByRole("button", { name: "Pay & deploy" }).click();
	const accepting = page.getByRole("button", { name: "Confirming payment & creating agent…" });
	await expect(accepting).toBeDisabled();
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await page.waitForTimeout(100);
	expect(subscriptionQuoteRequests).toHaveLength(1);
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
			term_price_cents: 10_000,
			debit_amount_usd: "100.00",
			balance_before_usd: "100.00",
			balance_after_usd: "0.00",
		},
	});
	await expect(page).toHaveURL(/\/agents\/hdep_wallet_created(?:\?|\/)/);
	await expect(page.getByText("Wallet payment confirmed", { exact: true })).toBeVisible();
	await expect(page.getByText("$100.00 was paid from Wallet.", { exact: true })).toBeVisible();
	await page.waitForTimeout(8_500);
	await expect(page.getByText("Wallet payment confirmed", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Agent deployed", { exact: true })).toHaveCount(0);
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
				status: "awaiting_projection",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planChangeOperationResponses: [
			{
				...planChangeResponse({
					operationId: "op_free_card",
					subscriptionId: 7,
					fundingSource: "stripe",
					currentPlanSlug: "compute_basic",
					targetPlanSlug: "compute_performance",
					targetBillingTermMonths: 12,
					status: "complete",
					effectiveAt: "2026-07-16T00:00:00Z",
				}),
				status: 200,
			},
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
				amountUsd: null,
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
	await expect(page.getByText("Plan changed", { exact: true })).toBeVisible();
	expect(errors, `included Basic card upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("included Basic explains an unknown upgrade state and offers a re-check", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const deployment = {
		...includedBasicDeployment,
		id: "hdep_upgrade_state_unknown",
		name: "Upgrade state unknown",
		upgrade_available: false,
		upgrade_eligibility: {
			eligible: false,
			reason: "deployment_state_unknown",
		},
	} satisfies DeploymentMutationFixture;
	await stubHostedApi(page, {
		deployments: [deployment],
		plans: [basicPlan, performancePlan],
	});

	await gotoHostedAgentSettings(page, deployment.id, "Basic");
	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toBeDisabled();
	await expect(
		page.getByText(
			"Clawdi couldn’t read this agent’s current state. Check again before trying to upgrade.",
			{ exact: true },
		),
	).toBeVisible();
	expect(errors, `unknown upgrade state: ${errors.join(" | ")}`).toEqual([]);
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
		planChangeOperationResponses: [
			{
				...planChangeResponse({
					operationId: "op_free_wallet",
					subscriptionId: 7,
					fundingSource: "wallet",
					currentPlanSlug: "compute_basic",
					targetPlanSlug: "compute_performance",
					targetBillingTermMonths: 1,
					status: "complete",
					effectiveAt: "2026-07-16T00:00:00Z",
				}),
				status: 200,
			},
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
				amountUsd: "19.00",
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
	await expect(equation).toContainText("$25.00");
	await expect(equation).toContainText("$19.00");
	await expect(equation).toContainText("$6.00");
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_free_wallet",
	});
	expect(checkoutRequests).toEqual([]);
	expect(subscriptionQuoteRequests).toEqual([]);
	await expect(page.getByText("Plan changed", { exact: true })).toBeVisible();
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
				status: "awaiting_projection",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planChangeOperationResponses: [
			{
				...planChangeResponse({
					operationId: "op_paid_card",
					subscriptionId: 42,
					fundingSource: "stripe",
					currentPlanSlug: "compute_basic",
					targetPlanSlug: "compute_performance",
					targetBillingTermMonths: 12,
					status: "complete",
					effectiveAt: "2026-07-16T00:00:00Z",
				}),
				status: 200,
				delayMs: 1_500,
			},
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
				amountUsd: null,
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
	await expect(
		changeDialog.getByText("Still waiting for confirmation", { exact: true }),
	).toBeVisible();
	await changeDialog.getByRole("button", { name: "Close", exact: true }).last().click();
	await expect(changeDialog).not.toBeVisible();
	await expect(page.getByRole("button", { name: "Check plan change status" })).toBeVisible();
	await expect(page.getByText("Plan changed", { exact: true })).toBeVisible();
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
		planChangeOperationResponses: [
			{
				...planChangeResponse({
					operationId: "op_paid_wallet",
					subscriptionId: 42,
					fundingSource: "wallet",
					currentPlanSlug: "compute_basic",
					targetPlanSlug: "compute_performance",
					targetBillingTermMonths: 1,
					status: "complete",
					effectiveAt: "2026-07-16T00:00:00Z",
				}),
				status: 200,
			},
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
				amountUsd: "10.00",
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
	await expect(equation).toContainText("$25.00");
	await expect(equation).toContainText("$10.00");
	await expect(equation).toContainText("$15.00");
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
				amountUsd: null,
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

	await expect(
		page.locator("main").getByText("Compute subscription ended", { exact: true }),
	).toBeVisible();
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

test("paid agent deletion sends one delete carrying the cancel choice", async ({ page }) => {
	const cancelRequests: string[] = [];
	const deleteRequestBodies: string[] = [];
	const deleteRequests: string[] = [];
	const mutationOrder: string[] = [];
	await stubHostedApi(page, {
		cancelRequests,
		deleteRequestBodies,
		deleteRequests,
		deployments: [paidBasicDeployment],
		mutationOrder,
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_paid", "Basic");

	await page.locator("main").getByRole("button", { name: "Delete", exact: true }).click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("Keep subscription — redeploy reuses it, no re-charge.");
	await expect(dialog).toContainText("Delete agent and cancel subscription");
	const choices = dialog.getByRole("radio");
	await expect(choices).toHaveCount(2);
	await expect(choices.nth(1)).toBeChecked();
	await dialog
		.getByRole("button", { name: "Delete agent and cancel subscription", exact: true })
		.click();

	await expect.poll(() => mutationOrder).toEqual(["delete"]);
	expect(cancelRequests).toEqual([]);
	expect(deleteRequests).toEqual(["/v2/deployments/hdep_paid"]);
	expect(deleteRequestBodies).toHaveLength(1);
	expect(JSON.parse(deleteRequestBodies[0] ?? "{}")).toEqual({
		subscription_choice: "cancel_subscription",
	});
});

test("paid agent deletion sends one delete carrying the reusable subscription choice", async ({
	page,
}) => {
	const cancelRequests: string[] = [];
	const deleteRequestBodies: string[] = [];
	const deleteRequests: string[] = [];
	const mutationOrder: string[] = [];
	await stubHostedApi(page, {
		cancelRequests,
		deleteRequestBodies,
		deleteRequests,
		deployments: [paidBasicDeployment],
		mutationOrder,
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_paid", "Basic");

	await page.locator("main").getByRole("button", { name: "Delete", exact: true }).click();
	const dialog = page.getByRole("alertdialog");
	await dialog.getByRole("radio").first().check();
	await dialog
		.getByRole("button", { name: "Delete agent (keep subscription)", exact: true })
		.click();

	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_paid"]);
	expect(cancelRequests).toEqual([]);
	expect(mutationOrder).toEqual(["delete"]);
	expect(deleteRequestBodies).toHaveLength(1);
	expect(JSON.parse(deleteRequestBodies[0] ?? "{}")).toEqual({
		subscription_choice: "keep_subscription",
	});
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

test("occupied included Basic start explains the slot entitlement recovery", async ({ page }) => {
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
		page.getByText(
			"Your free Basic compute slot is already in use. Stop that agent or choose paid compute, then try again.",
			{
				exact: true,
			},
		),
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
	await expect(page.getByTestId("basic-compute-price")).toContainText("$10.00/mo");
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
	await expect(billingTable.getByText("Paid from Wallet", { exact: true })).toBeVisible();
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
	await expect(billingTable.getByText("Paid from Wallet", { exact: true })).toBeVisible();
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
		operation: "compute_charge",
		description: "Compute Basic renewal",
		amount_usd: "-9.00",
		status: "applied",
		receipt_url: null,
		created_at: "2026-07-15T00:00:00Z",
		applied_at: "2026-07-15T00:00:00Z",
	};
	const topUp = {
		operation: "topup",
		description: "Card top-up",
		amount_usd: "25.00",
		status: "applied",
		receipt_url: "https://billing.stripe.test/receipt/topup",
		created_at: "2026-07-15T00:00:02Z",
		applied_at: "2026-07-15T00:00:02Z",
	};
	await stubHostedApi(page, {
		ledgerRequests,
		ledgerResponseForRequest: (limit) => {
			if (limit === 50) return { items: [topUp, computeCharge], has_more: true };
			expandedAttempts += 1;
			return expandedAttempts === 1
				? { status: 400, body: { detail: "ledger_backend_unavailable" } }
				: {
						items: [
							computeCharge,
							{
								...computeCharge,
								operation: "compute_credit",
								description: "Compute Basic reversal",
								amount_usd: "9.00",
								created_at: "2026-07-15T00:00:01Z",
								applied_at: "2026-07-15T00:00:01Z",
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
	await expect(ledgerTable.getByText("Card top-up", { exact: true })).toBeVisible();
	await expect(
		ledgerTable.locator('a[href="https://billing.stripe.test/receipt/topup"]'),
	).toHaveText("Receipt");
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

test("pending welcome balance stops polling and offers a bounded refresh", async ({ page }) => {
	await page.clock.install({ time: new Date("2026-07-25T12:00:00Z") });
	const ledgerRequests: string[] = [];
	const pendingGrant = {
		operation: "grant_signup",
		description: "Welcome balance",
		amount_usd: "5.00",
		status: "pending",
		receipt_url: null,
		created_at: "2026-07-25T12:00:00Z",
		applied_at: null,
	};
	await stubHostedApi(page, {
		deployments: [],
		ledgerRequests,
		ledgerResponseForRequest: () => ({ items: [pendingGrant], has_more: false }),
		plans: [basicPlan],
	});

	await page.goto("/agents");
	await expect(page.getByText("Adding your welcome balance…", { exact: true })).toBeVisible();
	await page.clock.fastForward(60_001);
	await expect(
		page.getByText("Your welcome balance is taking longer than expected", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Refresh balance", exact: true })).toBeVisible();

	const requestsAtTimeout = ledgerRequests.length;
	await page.clock.fastForward(120_000);
	expect(ledgerRequests).toHaveLength(requestsAtTimeout);

	await page.getByRole("button", { name: "Refresh balance", exact: true }).click();
	await expect.poll(() => ledgerRequests.length).toBeGreaterThan(requestsAtTimeout);
	await expect(page.getByText("Adding your welcome balance…", { exact: true })).toBeVisible();
});

test("Wallet formats its balance and opens billing from the balance actions", async ({ page }) => {
	const portalRequests: string[] = [];
	await stubHostedApi(page, {
		portalRequests,
		walletState: { ...walletState, balance_usd: "29.4825458" },
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	const balanceCard = settingsDialog
		.locator('[data-slot="card"]')
		.filter({ hasText: "Wallet balance" });
	await expect(balanceCard.getByText("$29.48", { exact: true })).toBeVisible();
	await expect(balanceCard.getByRole("button", { name: "Top up", exact: true })).toBeVisible();

	await balanceCard.getByRole("button", { name: "Manage payment methods" }).click();

	await expect.poll(() => portalRequests.length).toBe(1);
	await expect(page).toHaveURL(/\?portal=opened$/);
	expect(JSON.parse(portalRequests[0] ?? "null")).toEqual({});
});

test("auto-reload batches toggle and fields into one explicit save", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const autoReloadRequests: string[] = [];
	const savedWallet = {
		...walletState,
		auto_reload_enabled: true,
		auto_reload_threshold_usd: "7.50",
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
	await expect(threshold).toHaveValue("7.50");

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
			auto_reload_threshold_usd: 7.5,
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
					amount_usd: "40.00",
				},
			},
		],
		plans: [basicPlan, performancePlan],
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	await settingsDialog.getByRole("button", { name: "Top up" }).click();
	const topUpPanel = settingsDialog.getByRole("region", { name: "Top up Wallet" });
	await expect(page.getByRole("dialog")).toHaveCount(1);
	const amount = topUpPanel.getByLabel("Amount (USD)");

	await amount.fill("25.50");
	await amount.blur();
	await expect(
		topUpPanel.getByText("Enter a whole-dollar amount from $10.00–$2,000.00.", {
			exact: true,
		}),
	).toBeVisible();
	await amount.fill("40");
	const submit = topUpPanel.getByRole("button", { name: "Continue with $40.00" });
	await submit.evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
	});
	await expect(topUpPanel.getByRole("button", { name: "Starting…" })).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(topUpPanel).toBeVisible();
	await expect.poll(() => topUpRequests.length).toBe(1);
	await expect(topUpPanel).toHaveCount(0);
	await expect(
		page.getByText("Wallet credit can’t be confirmed automatically", { exact: true }),
	).toBeVisible();
	expect(JSON.parse(topUpRequests[0] ?? "{}")).toEqual({ amount_cents: 4_000 });
	expect(errors, `top-up interaction: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet confirms a card top-up only from its exact payment reference", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const ledgerRequests: string[] = [];
	const walletRequests: string[] = [];
	let topUpAccepted = false;
	let postTopUpLedgerReads = 0;
	const previousTopUp = {
		operation: "topup",
		description: "Previous card top-up",
		amount_usd: "25.00",
		status: "applied",
		payment_reference: "pi_previous_25",
		receipt_url: null,
		created_at: "2026-07-27T12:00:00Z",
		applied_at: "2026-07-27T12:00:01Z",
	};
	const currentTopUp = {
		...previousTopUp,
		description: "Current card top-up",
		payment_reference: "pi_current_25",
		created_at: "2026-07-27T12:00:02Z",
		applied_at: "2026-07-27T12:00:03Z",
	};
	await stubHostedApi(page, {
		ledgerRequests,
		ledgerResponseForRequest: () => {
			if (!topUpAccepted) return { items: [], has_more: false };
			postTopUpLedgerReads += 1;
			return postTopUpLedgerReads === 1
				? { items: [previousTopUp], has_more: false }
				: { items: [currentTopUp, previousTopUp], has_more: false };
		},
		onTopUpSuccess: () => {
			topUpAccepted = true;
		},
		plans: [basicPlan, performancePlan],
		topUpResponses: [
			{
				status: 200,
				body: {
					status: "succeeded",
					flow_type: "mock",
					payment_intent_id: "pi_current_25",
					client_secret: null,
					amount_usd: "25.00",
				},
			},
		],
		walletRequests,
		walletResponses: [
			{ status: 200, body: { ...walletState, balance_usd: "0.00" } },
			{ status: 200, body: { ...walletState, balance_usd: "25.00" } },
		],
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	await expect(settingsDialog.getByText("$0.00", { exact: true })).toBeVisible();
	await expect(settingsDialog.getByText("No activity yet", { exact: true })).toBeVisible();

	await settingsDialog.getByRole("button", { name: "Top up" }).last().click();
	await settingsDialog
		.getByRole("region", { name: "Top up Wallet" })
		.getByRole("button", { name: "Continue with $25.00" })
		.click();

	await expect(page.getByText("Wallet credited", { exact: true })).toBeVisible();
	await expect(settingsDialog.getByText("$25.00", { exact: true })).toBeVisible();
	await expect(
		settingsDialog.getByRole("table").getByText("Current card top-up", { exact: true }),
	).toBeVisible();
	expect(postTopUpLedgerReads).toBeGreaterThanOrEqual(2);
	expect(walletRequests.length).toBeGreaterThanOrEqual(2);
	expect(errors, `exact payment-reference wallet confirmation: ${errors.join(" | ")}`).toEqual([]);
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
	const topUpPanel = settingsDialog.getByRole("region", { name: "Top up Wallet" });
	const submit = topUpPanel.getByRole("button", { name: "Continue" });

	await submit.click();
	await expect.poll(() => topUpIdempotencyKeys.length).toBe(1);
	await expect(page.getByText("Start a fresh top-up", { exact: true })).toBeVisible();
	await expect(topUpPanel).toBeVisible();
	await submit.click();
	await expect.poll(() => topUpIdempotencyKeys.length).toBe(2);

	expect(topUpIdempotencyKeys[0]).toMatch(/^topup-/);
	expect(topUpIdempotencyKeys[1]).toMatch(/^topup-/);
	expect(topUpIdempotencyKeys[1]).not.toBe(topUpIdempotencyKeys[0]);
	await expect(topUpPanel).toHaveCount(0);
	expect(
		errors.filter((error) => !error.includes("status of 409")),
		`top-up key rotation: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("wallet top-up acceptance refreshes an automatically paid open invoice without claiming credit", async ({
	page,
}) => {
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
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up Wallet" });
	await expect(topUpDialog).toBeVisible();
	await topUpDialog.getByRole("button", { name: "Continue with $25.00" }).click();

	await expect.poll(() => topUpRequests.length).toBe(1);
	await expect(page.getByText("Payment accepted", { exact: true })).toBeVisible();
	await expect(
		page.getByText("We're confirming your Wallet credit now.", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("Top-up complete", { exact: true })).toHaveCount(0);
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
		settingsDialog.getByText("$5.00 welcome balance on signup", { exact: true }),
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

test("app 404 offers a working exit to the dashboard", async ({ page }) => {
	await stubHostedApi(page);
	const response = await page.goto("/this-clawdi-page-does-not-exist");
	expect(response?.status()).toBe(404);

	const dashboardExit = page.getByRole("link", { name: "Back to dashboard", exact: true });
	await expect(dashboardExit).toHaveAttribute("href", "/");
	const errors = collectBrowserErrors(page);
	await dashboardExit.click();

	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByTestId("app-sidebar")).toBeVisible();
	expect(errors, `app 404: ${errors.join(" | ")}`).toEqual([]);
});

test("Channels inventories only owned bots without ready-pool operations", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 1100 });
	const errors = collectBrowserErrors(page);
	const accountId = "10111111-1111-4111-8111-111111111111";
	const cloudHermesId = "10222222-2222-4222-8222-222222222222";
	const cloudOpenClawId = "10333333-3333-4333-8333-333333333333";
	const localCodexId = "10444444-4444-4444-8444-444444444444";
	const localOpenClawId = "10555555-5555-4555-8555-555555555555";
	const legacyId = "10666666-6666-4666-8666-666666666666";
	const unresolvedId = "10777777-7777-4777-8777-777777777777";
	const existingLinkId = "10888888-8888-4888-8888-888888888888";
	const newLinkId = "10999999-9999-4999-8999-999999999999";
	const discordBotId = "10aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const personalTelegramId = "10bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const personalDiscordId = "10cccccc-cccc-4ccc-8ccc-cccccccccccc";
	const globalCreatedBotId = "10dddddd-dddd-4ddd-8ddd-dddddddddddd";
	const createChannelRequests: string[] = [];
	const cloudHermesDeployment = {
		...runningMissingProjectionDeployment,
		id: "hdep_channels_cloud_hermes",
		name: "Cloud Hermes",
		config_info: {
			...runningMissingProjectionDeployment.config_info,
			clawdi_cloud_environments: { hermes: cloudHermesId },
		},
	};
	const cloudOpenClawDeployment = {
		...openClawIncludedDeployment,
		id: "hdep_channels_cloud_openclaw",
		name: "Cloud OpenClaw",
		config_info: {
			...openClawIncludedDeployment.config_info,
			clawdi_cloud_environments: { openclaw: cloudOpenClawId },
		},
	};
	const agent = (id: string, name: string, agentType: string, sortOrder: number) => ({
		...sharedLegacyCloudAgent,
		id,
		name: name.toLowerCase().replaceAll(" ", "-"),
		default_name: name,
		machine_name: `${name.toLowerCase().replaceAll(" ", "-")}.local`,
		display_name: name,
		agent_type: agentType,
		sort_order: sortOrder,
	});
	const bot = {
		id: accountId,
		provider: "telegram",
		name: "Clawdi Support Bot",
		status: "active",
		visibility: "public",
		has_provider_token: true,
		webhook_url: "https://cloud.example.test/channels/support",
		created_at: "2026-07-27T12:25:00Z",
		access: "public",
		capabilities: {
			link_agent: true,
			pair_chat: true,
			send_message: true,
			manage_account: false,
			sync_commands: true,
		},
		link_count: 57,
		max_links: null,
		available: true,
	};
	const discordBot = {
		...bot,
		id: discordBotId,
		provider: "discord",
		name: "Clawdi Community Bot",
		webhook_url: "https://cloud.example.test/channels/community",
		link_count: 91,
	};
	const personalTelegram = {
		id: personalTelegramId,
		provider: "telegram",
		name: "Personal Telegram",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud.example.test/channels/personal-telegram",
		created_at: "2026-07-27T12:26:00Z",
	};
	const personalDiscord = {
		...personalTelegram,
		id: personalDiscordId,
		provider: "discord",
		name: "Personal Discord",
		webhook_url: "https://cloud.example.test/channels/personal-discord",
		created_at: "2026-07-27T12:27:00Z",
	};
	const links: unknown[] = [
		{
			id: existingLinkId,
			account_id: accountId,
			agent_id: cloudHermesId,
			status: "active",
			created_at: "2026-07-27T12:30:00Z",
		},
	];
	const linkAgentRequests: Array<{ accountId: string; body: string }> = [];
	const validExpiry = new Date(Date.now() + 15 * 60_000).toISOString();
	const newLink = {
		id: newLinkId,
		account_id: accountId,
		agent_id: cloudOpenClawId,
		status: "active",
		created_at: "2026-07-31T00:00:00Z",
	};
	await stubHostedApi(page, {
		deployments: [cloudHermesDeployment, cloudOpenClawDeployment],
		legacyAgentEnvironmentIds: [legacyId],
		cloudAgents: [
			agent(cloudHermesId, "Cloud Hermes", "hermes", 0),
			agent(cloudOpenClawId, "Cloud OpenClaw", "openclaw", 1),
			agent(localCodexId, "Local Codex", "codex", 2),
			agent(localOpenClawId, "Local OpenClaw", "openclaw", 3),
			agent(legacyId, "Legacy OpenClaw", "openclaw", 4),
			agent(unresolvedId, "Unknown OpenClaw", "openclaw", 5),
		],
		channelAccounts: [personalDiscord, personalTelegram],
		createChannelRequests,
		createChannelResponse: {
			...personalTelegram,
			id: globalCreatedBotId,
			name: "Inventory Telegram",
			webhook_secret: "one-time-webhook-secret",
			agent_link_id: null,
			agent_id: null,
			agent_token: null,
		},
		channelAgentLinks: links,
		channelBotPool: { providers: { discord: [discordBot], telegram: [bot] } },
		linkAgentRequests,
		linkAgentResponses: [
			{
				status: 409,
				body: { detail: "Only Cloud Agents can be linked or paired with channels." },
				delayMs: 100,
			},
			{ status: 201, body: newLink },
		],
		onLinkAgent: (response) => links.push(response),
		pairCodeResponses: [
			{
				status: 201,
				body: {
					id: "channel-home-pair-code",
					agent_link_id: newLinkId,
					agent_id: cloudOpenClawId,
					code: "CHANNELHOME123",
					expires_at: validExpiry,
					pairing_command: "/bot_pair CHANNELHOME123",
					bot_username: "Clawdi_Support_Bot",
					deep_link: "https://t.me/Clawdi_Support_Bot?start=CHANNELHOME123",
					qr_payload: "https://t.me/Clawdi_Support_Bot?start=CHANNELHOME123",
				},
			},
		],
	});

	await page.goto("/channels");
	const ownedSection = page.locator("[data-owned-bots-section]");
	await expect(ownedSection).toContainText(/Bots\s*2/);
	expect(
		await ownedSection
			.locator("[data-channel-account-id]")
			.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-channel-account-id"))),
	).toEqual([personalTelegramId, personalDiscordId]);
	await expect(page.getByRole("button", { name: /All\s+2/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /Telegram\s+1/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /Discord\s+1/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /WhatsApp/ })).toHaveCount(0);
	await expect(page.locator("[data-ready-bots-section]")).toHaveCount(0);
	await expect(page.locator("[data-pool-account-id]")).toHaveCount(0);
	await expect(page.getByText("Ready-to-go bots", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Clawdi Support Bot", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Clawdi Community Bot", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Link an agent", exact: true })).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "Link an agent" })).toHaveCount(0);
	await page.screenshot({
		path:
			process.env.CHANNELS_HOME_SCREENSHOT_PATH ??
			testInfo.outputPath("channels-owned-bot-inventory.png"),
		fullPage: true,
	});

	await page.setViewportSize({ width: 320, height: 844 });
	await expect(ownedSection.getByText("Personal Telegram", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /WhatsApp/ })).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
	await page.screenshot({
		path:
			process.env.CHANNELS_HOME_MOBILE_SCREENSHOT_PATH ??
			testInfo.outputPath("channels-owned-bot-inventory-320.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Connect bot", exact: true }).click();
	const connectDialog = page.getByRole("dialog", { name: "Connect a channel" });
	await connectDialog.getByLabel("Name").fill("Inventory Telegram");
	await connectDialog.getByLabel("Bot token").fill("123456:inventory-browser-token");
	await connectDialog.getByRole("button", { name: "Connect", exact: true }).click();
	await expect.poll(() => createChannelRequests.length).toBe(1);
	expect(JSON.parse(createChannelRequests[0] ?? "{}")).toEqual({
		provider: "telegram",
		name: "Inventory Telegram",
		provider_token: "123456:inventory-browser-token",
		agent_id: null,
	});
	await expect(page.getByRole("dialog", { name: "Channel connected" })).toBeVisible();
	expect(errors, `Channels inventory browser errors: ${errors.join(" | ")}`).toEqual([]);
});

test("channel connect updates its auto-linked agent page without reload", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const channelId = "11111111-1111-4111-8111-111111111111";
	const linkId = "22222222-2222-4222-8222-222222222222";
	const channelAccounts: unknown[] = [];
	const channelAgentLinks: unknown[] = [];
	const createChannelRequests: string[] = [];
	const pairCodeRequests: string[] = [];
	const validExpiry = new Date(Date.now() + 15 * 60_000).toISOString();
	const channelAccount = {
		id: channelId,
		provider: "telegram",
		name: "Browser Telegram",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud.example.test/channels/browser",
		created_at: "2026-07-27T12:00:00Z",
	};
	const channelLink = {
		id: linkId,
		account_id: channelId,
		agent_id: missingProjectionEnvironmentId,
		status: "active",
		created_at: "2026-07-27T12:00:00Z",
		account: channelAccount,
	};
	await stubHostedApi(page, {
		deployments: [runningMissingProjectionDeployment],
		channelAccounts,
		channelAgentLinks,
		createChannelRequests,
		createChannelResponse: {
			...channelAccount,
			webhook_secret: "one-time-webhook-secret",
			agent_link_id: linkId,
			agent_id: missingProjectionEnvironmentId,
			agent_token: "one-time-agent-token",
		},
		onCreateChannel: () => {
			channelAccounts.push(channelAccount);
			channelAgentLinks.push(channelLink);
		},
		pairCodeRequests,
		pairCodeResponses: [
			{
				status: 201,
				body: {
					id: "connected-bot-pair-code",
					agent_link_id: linkId,
					agent_id: missingProjectionEnvironmentId,
					code: "CONNECTED123",
					expires_at: validExpiry,
					pairing_command: "/bot_pair CONNECTED123",
					bot_username: "Browser_Telegram_Bot",
					deep_link: "https://t.me/Browser_Telegram_Bot?start=CONNECTED123",
					qr_payload: "https://t.me/Browser_Telegram_Bot?start=CONNECTED123",
				},
			},
		],
	});
	await page.goto("/channels");
	const globalConnect = page.getByRole("button", { name: "Connect bot", exact: true }).first();
	await expect(globalConnect).toBeVisible();
	await expect(page.locator('[data-slot="tabs-list"]')).toHaveCount(0);
	await expect(page.getByText("Ready-to-go bots", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Bots", { exact: true })).toBeVisible();
	await expectNonZeroBox(page.locator('[data-sidebar="separator"]').first(), "sidebar separator");
	await globalConnect.click();
	const globalDialog = page.getByRole("dialog");
	await expect(globalDialog).toBeVisible();
	await globalDialog.getByRole("button", { name: "Cancel", exact: true }).click();

	await page.goto(
		`/agents/${missingProjectionEnvironmentId}/channel-links?source=on-clawdi&d=${runningMissingProjectionDeployment.id}`,
	);

	await expect(page.getByText("No connected channels", { exact: true })).toBeVisible();
	await page.getByText("Use your own bot", { exact: true }).click();
	const connect = page.getByRole("button", { name: "Connect a bot", exact: true }).first();
	await expect(connect).toBeVisible();
	await connect.click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Browser Telegram");
	await dialog.getByLabel("Bot token").fill("123456:browser-test-token");
	await dialog.getByRole("button", { name: "Connect", exact: true }).click();

	await expect.poll(() => createChannelRequests.length).toBe(1);
	await expect.poll(() => pairCodeRequests.length).toBe(1);
	const pairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
	await expect(pairDialog.getByRole("img", { name: "Telegram pairing QR code" })).toBeVisible();
	await expect(page.locator("body")).not.toContainText("one-time-agent-token");
	await pairDialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByText("No connected channels", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Browser Telegram", { exact: true }).first()).toBeVisible();
	expect(JSON.parse(createChannelRequests[0] ?? "{}")).toEqual({
		provider: "telegram",
		name: "Browser Telegram",
		provider_token: "123456:browser-test-token",
		agent_id: missingProjectionEnvironmentId,
	});
	expect(JSON.parse(pairCodeRequests[0] ?? "{}")).toEqual({
		ttl_seconds: 900,
		agent_link_id: linkId,
	});
	expect(errors, `channel connect convergence: ${errors.join(" | ")}`).toEqual([]);
});

test("Agent Channels uses compact task-ordered rows and the shared Telegram pair dialog", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 1100 });
	const errors = collectBrowserErrors(page);
	const agentId = missingProjectionEnvironmentId;
	const otherAgentId = "70000000-0000-4000-8000-000000000000";
	const telegramId = "71111111-1111-4111-8111-111111111111";
	const telegramLinkId = "72222222-2222-4222-8222-222222222222";
	const otherTelegramLinkId = "72222222-2222-4222-8222-333333333333";
	const discordId = "73333333-3333-4333-8333-333333333333";
	const discordLinkId = "74444444-4444-4444-8444-444444444444";
	const ownedId = "75555555-5555-4555-8555-555555555555";
	const readyId = "76666666-6666-4666-8666-666666666666";
	const currentBindingId = "77777777-7777-4777-8777-777777777777";
	const otherAgentBindingId = "78888888-8888-4888-8888-888888888888";
	const polledBindingId = "79999999-9999-4999-8999-999999999999";
	const validExpiry = new Date(Date.now() + 15 * 60_000).toISOString();
	const successfulPairResponse = (id: string, code: string): StubResponse => ({
		status: 201,
		body: {
			id,
			agent_link_id: telegramLinkId,
			agent_id: agentId,
			agent_token: "agent-channel-token-must-not-render",
			code,
			expires_at: validExpiry,
			pairing_command: `/bot_pair ${code}`,
			bot_username: "Clawdi_Ready_Bot",
			deep_link: `https://t.me/Clawdi_Ready_Bot?start=${code}`,
			qr_payload: `https://t.me/Clawdi_Ready_Bot?start=${code}`,
		},
	});
	const agentChannelsDeployment = {
		...runningMissingProjectionDeployment,
		openclaw_control_ui_url: "https://runtime.example/openclaw",
		config_info: {
			...runningMissingProjectionDeployment.config_info,
			runtime: "openclaw",
			clawdi_cloud_environments: { openclaw: agentId },
		},
	};
	const telegramAccount = {
		id: telegramId,
		provider: "telegram",
		name: "Support Telegram",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud.example.test/channels/support-telegram",
		created_at: "2026-07-27T12:00:00Z",
	};
	const discordAccount = {
		id: discordId,
		provider: "discord",
		name: "Community Discord",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud.example.test/channels/community-discord",
		created_at: "2026-07-27T12:05:00Z",
	};
	const ownedAccount = {
		id: ownedId,
		provider: "telegram",
		name: "My Telegram bot",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud.example.test/channels/my-telegram",
		created_at: "2026-07-27T12:10:00Z",
	};
	const pairCodeRequests: string[] = [];
	const deleteBindingRequests: string[] = [];
	const unlinkAgentRequests: string[] = [];
	const channelBindings: unknown[] = [
		{
			id: currentBindingId,
			account_id: telegramId,
			agent_link_id: telegramLinkId,
			external_chat_id: "101",
			external_chat_type: "private",
			external_chat_name: "Current Agent DM",
			status: "active",
			created_at: "2026-07-30T10:00:00Z",
		},
		{
			id: otherAgentBindingId,
			account_id: telegramId,
			agent_link_id: otherTelegramLinkId,
			external_chat_id: "202",
			external_chat_type: "private",
			external_chat_name: "Other Agent DM",
			status: "active",
			created_at: "2026-07-30T10:05:00Z",
		},
	];
	await stubHostedApi(page, {
		deployments: [agentChannelsDeployment],
		cloudAgents: [
			{
				...sharedLegacyCloudAgent,
				id: agentId,
				name: "support-agent",
				default_name: "Support Agent",
				machine_name: "support.local",
				display_name: "Support Agent",
				agent_type: "openclaw",
			},
		],
		channelAccounts: [telegramAccount, discordAccount, ownedAccount],
		channelBindings,
		channelAgentLinks: [
			{
				id: telegramLinkId,
				account_id: telegramId,
				agent_id: agentId,
				status: "active",
				created_at: "2026-07-27T12:15:00Z",
				account: telegramAccount,
			},
			{
				id: otherTelegramLinkId,
				account_id: telegramId,
				agent_id: otherAgentId,
				status: "active",
				created_at: "2026-07-27T12:17:00Z",
				account: telegramAccount,
			},
			{
				id: discordLinkId,
				account_id: discordId,
				agent_id: agentId,
				status: "active",
				created_at: "2026-07-27T12:20:00Z",
				account: discordAccount,
			},
		],
		channelBotPool: {
			providers: {
				discord: [
					{
						id: readyId,
						provider: "discord",
						name: "Clawdi Ready Bot",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://cloud.example.test/channels/ready-telegram",
						created_at: "2026-07-27T12:25:00Z",
						access: "public",
						capabilities: {
							link_agent: true,
							pair_chat: true,
							send_message: true,
							manage_account: false,
							sync_commands: true,
						},
						link_count: 0,
						max_links: null,
						available: true,
					},
				],
			},
		},
		channelHealthItems: [
			{
				account_id: telegramId,
				provider: "telegram",
				name: "Support Telegram",
				visibility: "private",
				channel_status: "active",
				health_status: "ok",
				pending_inbox: 0,
				pending_deliveries: 0,
				in_progress_deliveries: 0,
				failed_deliveries: 0,
				last_message_at: "2026-07-30T10:00:00Z",
			},
			{
				account_id: discordId,
				provider: "discord",
				name: "Community Discord",
				visibility: "private",
				channel_status: "active",
				health_status: "ok",
				pending_inbox: 0,
				pending_deliveries: 0,
				in_progress_deliveries: 0,
				failed_deliveries: 0,
				last_message_at: "2026-07-30T09:55:00Z",
			},
		],
		deleteBindingRequests,
		unlinkAgentRequests,
		deleteBindingResponses: [
			{ status: 502, body: { detail: "temporary Telegram cleanup error" } },
			{
				status: 200,
				body: {
					binding_id: currentBindingId,
					unpaired: true,
					notification_status: "sent",
					provider_cleanup_status: "succeeded",
					warning: null,
				},
			},
		],
		pairCodeRequests,
		pairCodeResponses: [
			successfulPairResponse("agent-channel-pair-code", "AGENTPAIR123"),
			{ status: 503, body: { detail: "temporary Telegram pair error" } },
			successfulPairResponse("agent-channel-pair-retry", "AGENTRETRY123"),
			{
				status: 201,
				body: {
					id: "agent-channel-pair-missing-link",
					agent_link_id: telegramLinkId,
					agent_id: agentId,
					agent_token: "agent-channel-token-must-not-render",
					code: "AGENTMANUAL123",
					expires_at: validExpiry,
					pairing_command: "/bot_pair AGENTMANUAL123",
					bot_username: "Clawdi_Ready_Bot",
					deep_link: null,
					qr_payload: null,
				},
			},
			{
				status: 201,
				body: {
					id: "agent-channel-pair-expired",
					agent_link_id: telegramLinkId,
					agent_id: agentId,
					agent_token: "agent-channel-token-must-not-render",
					code: "AGENTEXPIRED123",
					expires_at: "2000-01-01T00:00:00Z",
					pairing_command: "/bot_pair AGENTEXPIRED123",
					bot_username: "Clawdi_Ready_Bot",
					deep_link: "https://t.me/Clawdi_Ready_Bot?start=AGENTEXPIRED123",
					qr_payload: "https://t.me/Clawdi_Ready_Bot?start=AGENTEXPIRED123",
				},
			},
		],
	});

	await page.goto(
		`/agents/${agentId}/channel-links?source=on-clawdi&d=${agentChannelsDeployment.id}`,
	);
	const connectedSection = page.locator("[data-agent-connected-channels]");
	const addSection = page.locator("[data-agent-add-channel]");
	await expect(connectedSection.getByText("Connected channels", { exact: true })).toBeVisible();
	await expect(page.locator("[data-agent-paired-chats]")).toHaveCount(0);
	await expect(page.getByText("Paired chats", { exact: true })).toHaveCount(0);
	await expect(addSection.getByText("Add a channel", { exact: true })).toBeVisible();
	const telegramGroup = page.locator(`[data-agent-channel-group-id="${telegramLinkId}"]`);
	const discordGroup = page.locator(`[data-agent-channel-group-id="${discordLinkId}"]`);
	const telegramRow = page.locator(`[data-agent-channel-link-id="${telegramLinkId}"]`);
	const discordRow = page.locator(`[data-agent-channel-link-id="${discordLinkId}"]`);
	await expect(telegramRow).toContainText("Support Telegram");
	await expect(telegramRow).toContainText("Last activity");
	await expect(discordRow).toContainText("Community Discord");
	const pairButton = telegramRow.getByRole("button", { name: "Pair Telegram", exact: true });
	await expect(pairButton).toBeVisible();
	await expect(discordRow.getByRole("button", { name: "Pair chat", exact: true })).toBeVisible();
	await expect(telegramRow.getByRole("button", { name: "Unlink", exact: true })).toBeVisible();
	await expect(addSection.locator(`[data-add-channel-id="${readyId}"]`)).toContainText(
		"Clawdi Ready Bot",
	);
	await expect(addSection.getByText("Use your own bot", { exact: true })).toBeVisible();
	await expect(addSection.locator("details")).not.toHaveAttribute("open", "");
	await expect(page.getByRole("button", { name: /^Access .* Dashboard$/ })).toHaveCount(0);
	const currentBindingRow = page.locator(`[data-channel-binding-id="${currentBindingId}"]`);
	await expect(currentBindingRow).toContainText("Current Agent DM");
	await expect(
		telegramGroup.locator(`[data-channel-binding-id="${currentBindingId}"]`),
	).toBeVisible();
	await expect(discordGroup.locator("[data-channel-binding-id]")).toHaveCount(0);
	await expect(discordGroup.locator("[data-agent-channel-chats-for]")).toHaveCount(0);
	await expect(currentBindingRow).not.toContainText("Support Telegram");
	await expect(page.locator(`[data-channel-binding-id="${otherAgentBindingId}"]`)).toHaveCount(0);
	await expect(page.getByText("Other Agent DM", { exact: true })).toHaveCount(0);
	await expect(currentBindingRow).not.toContainText("101");
	await expect(telegramRow).not.toContainText("Active");
	await expect(telegramRow).not.toContainText("Healthy");
	await expect(page.getByText("Waiting for channel activity", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Finish pairing", { exact: false })).toHaveCount(0);
	const telegramBox = await telegramRow.boundingBox();
	const discordBox = await discordRow.boundingBox();
	expect(Math.abs((telegramBox?.height ?? 0) - (discordBox?.height ?? 0))).toBeLessThanOrEqual(1);
	await page.screenshot({
		path:
			process.env.AGENT_CHANNELS_PAGE_SCREENSHOT_PATH ??
			testInfo.outputPath("agent-channels-compact-page.png"),
		fullPage: true,
	});

	await pairButton.click();
	await expect.poll(() => pairCodeRequests.length).toBe(1);
	expect(JSON.parse(pairCodeRequests[0] ?? "{}")).toEqual({
		ttl_seconds: 900,
		agent_link_id: telegramLinkId,
	});
	const pairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
	await expect(pairDialog.getByRole("img", { name: "Telegram pairing QR code" })).toBeVisible();
	await expect(pairDialog.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
	await expect(pairDialog.getByRole("button", { name: "Open @Clawdi_Ready_Bot" })).toHaveAttribute(
		"href",
		"https://t.me/Clawdi_Ready_Bot?start=AGENTPAIR123",
	);
	await expect(page.locator("body")).not.toContainText("agent-channel-token-must-not-render");
	await page.screenshot({
		path:
			process.env.AGENT_CHANNELS_DIALOG_SCREENSHOT_PATH ??
			testInfo.outputPath("agent-channels-pair-dialog.png"),
		fullPage: true,
	});

	channelBindings.push({
		id: polledBindingId,
		account_id: telegramId,
		agent_link_id: telegramLinkId,
		external_chat_id: "303",
		external_chat_type: "private",
		external_chat_name: "Newly Paired DM",
		status: "active",
		created_at: "2026-07-30T10:10:00Z",
	});
	await pairDialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.locator(`[data-channel-binding-id="${polledBindingId}"]`)).toContainText(
		"Newly Paired DM",
		{ timeout: 5_000 },
	);
	await expect(
		telegramGroup.locator(`[data-channel-binding-id="${polledBindingId}"]`),
	).toBeVisible();
	await expect(discordGroup.locator(`[data-channel-binding-id="${polledBindingId}"]`)).toHaveCount(
		0,
	);

	await pairButton.click();
	await expect.poll(() => pairCodeRequests.length).toBe(2);
	await expect(
		page.getByRole("dialog", { name: "Pair Telegram" }).getByText("Couldn't create Telegram link"),
	).toBeVisible();
	await page
		.getByRole("dialog", { name: "Pair Telegram" })
		.getByRole("button", { name: "Retry", exact: true })
		.click();
	await expect.poll(() => pairCodeRequests.length).toBe(3);
	await expect(
		page
			.getByRole("dialog", { name: "Pair Telegram" })
			.getByRole("img", { name: "Telegram pairing QR code" }),
	).toBeVisible();
	await page
		.getByRole("dialog", { name: "Pair Telegram" })
		.getByRole("button", { name: "Close", exact: true })
		.click();

	await pairButton.click();
	await expect.poll(() => pairCodeRequests.length).toBe(4);
	let recoveryDialog = page.getByRole("dialog", { name: "Pair Telegram" });
	await expect(
		recoveryDialog.getByText("Telegram link unavailable", { exact: true }),
	).toBeVisible();
	await recoveryDialog.getByText("Pair a group manually", { exact: true }).click();
	await expect(recoveryDialog.getByText("/bot_pair AGENTMANUAL123", { exact: true })).toBeVisible();
	await recoveryDialog.getByRole("button", { name: "Close", exact: true }).click();

	await pairButton.click();
	await expect.poll(() => pairCodeRequests.length).toBe(5);
	recoveryDialog = page.getByRole("dialog", { name: "Pair Telegram" });
	await expect(
		recoveryDialog.getByText("This Telegram link has expired", { exact: true }),
	).toBeVisible();
	await expect(recoveryDialog.getByRole("img", { name: "Telegram pairing QR code" })).toHaveCount(
		0,
	);
	await recoveryDialog.getByRole("button", { name: "Close", exact: true }).click();

	await currentBindingRow.getByRole("button", { name: "Unpair", exact: true }).click();
	const unpairConfirmation = page.getByRole("alertdialog", { name: "Unpair Current Agent DM?" });
	await unpairConfirmation.getByRole("button", { name: "Unpair chat", exact: true }).click();
	await expect.poll(() => deleteBindingRequests.length).toBe(1);
	await expect(page.getByText("Couldn't unpair chat", { exact: true })).toBeVisible();
	await expect(currentBindingRow).toContainText("Couldn't unpair · Try again");
	await expect(unpairConfirmation).toBeVisible();
	await unpairConfirmation.getByRole("button", { name: "Unpair chat", exact: true }).click();
	await expect.poll(() => deleteBindingRequests.length).toBe(2);
	expect(deleteBindingRequests).toEqual([
		`/v1/channels/${telegramId}/bindings/${currentBindingId}`,
		`/v1/channels/${telegramId}/bindings/${currentBindingId}`,
	]);
	await expect(currentBindingRow).toHaveCount(0);
	await expect(page.locator(`[data-channel-binding-id="${polledBindingId}"]`)).toBeVisible();
	await expect(page.locator(`[data-channel-binding-id="${otherAgentBindingId}"]`)).toHaveCount(0);
	expect(
		channelBindings.some((binding) => isRecord(binding) && binding.id === otherAgentBindingId),
	).toBe(true);

	await page.setViewportSize({ width: 320, height: 844 });
	const mobileChatRow = page.locator(`[data-channel-binding-id="${polledBindingId}"]`);
	const mobileChatTitle = mobileChatRow.getByText("Newly Paired DM", { exact: true });
	const mobileUnpair = mobileChatRow.getByRole("button", { name: "Unpair", exact: true });
	await expect(mobileChatTitle).toBeVisible();
	await expect(mobileUnpair).toBeVisible();
	const mobileTitleBox = await mobileChatTitle.boundingBox();
	const mobileActionBox = await mobileUnpair.boundingBox();
	expect(mobileTitleBox?.width ?? 0).toBeGreaterThan(100);
	expect(mobileActionBox?.y ?? 0).toBeGreaterThan(mobileTitleBox?.y ?? 0);
	const mobileChannelTitle = telegramRow.getByText("Support Telegram", { exact: true });
	const mobilePairAction = telegramRow.getByRole("button", { name: "Pair Telegram", exact: true });
	const mobileChannelTitleBox = await mobileChannelTitle.boundingBox();
	const mobilePairActionBox = await mobilePairAction.boundingBox();
	expect(mobileChannelTitleBox?.width ?? 0).toBeGreaterThan(100);
	expect(mobilePairActionBox?.y ?? 0).toBeGreaterThan(mobileChannelTitleBox?.y ?? 0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 7_000 });
	await page.screenshot({
		path:
			process.env.AGENT_CHANNELS_MOBILE_SCREENSHOT_PATH ??
			testInfo.outputPath("agent-channels-320.png"),
		fullPage: true,
	});

	await discordRow.getByRole("button", { name: "Unlink", exact: true }).click();
	const unlinkConfirmation = page.getByRole("alertdialog", { name: "Unlink this channel?" });
	await unlinkConfirmation.getByRole("button", { name: "Unlink", exact: true }).click();
	await expect.poll(() => unlinkAgentRequests.length).toBe(1);
	expect(unlinkAgentRequests).toEqual([`/v1/channels/${discordId}/agent-links/${discordLinkId}`]);
	const unexpectedErrors = errors.filter(
		(error) =>
			!error.includes("temporary Telegram pair error") &&
			!error.includes("temporary Telegram cleanup error") &&
			!error.includes("503") &&
			!error.includes("502"),
	);
	expect(
		unexpectedErrors,
		`Agent Channels browser errors: ${unexpectedErrors.join(" | ")}`,
	).toEqual([]);
});

test("Bot detail keeps Agent relationships read-only and routes to Agent Channels", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 1100 });
	const errors = collectBrowserErrors(page);
	const channelId = "11111111-1111-4111-8111-111111111111";
	const linkId = "22222222-2222-4222-8222-222222222222";
	const agentId = "33333333-3333-4333-8333-333333333333";
	const bindingId = "44444444-4444-4444-8444-444444444444";
	const pairCodeRequests: string[] = [];
	const deleteBindingRequests: string[] = [];
	const linkAgentRequests: Array<{ accountId: string; body: string }> = [];
	const channelAccount = {
		id: channelId,
		provider: "telegram",
		name: "Browser Telegram",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud.example.test/channels/browser",
		created_at: "2026-07-25T12:00:00Z",
	};
	const channelLink = {
		id: linkId,
		account_id: channelId,
		agent_id: agentId,
		status: "active",
		created_at: "2026-07-25T12:00:00Z",
	};
	const deployment = {
		...openClawIncludedDeployment,
		id: "hdep_channel_detail_cloud",
		config_info: {
			...openClawIncludedDeployment.config_info,
			clawdi_cloud_environments: { openclaw: agentId },
		},
	};
	await stubHostedApi(page, {
		deployments: [deployment],
		channelAccount,
		channelAccounts: [channelAccount],
		channelAgentLinks: [channelLink],
		channelBindings: [
			{
				id: bindingId,
				account_id: channelId,
				agent_link_id: linkId,
				external_chat_id: "101",
				external_chat_type: "private",
				external_chat_name: "Must stay on Agent Channels",
				status: "active",
				created_at: "2026-07-30T10:00:00Z",
			},
		],
		cloudAgents: [
			{
				...sharedLegacyCloudAgent,
				id: agentId,
				name: "support-agent",
				default_name: "Support Agent",
				machine_name: "support.local",
				display_name: "Support Agent",
				agent_type: "openclaw",
			},
		],
		pairCodeRequests,
		deleteBindingRequests,
		linkAgentRequests,
	});

	await page.goto(`/channels/${channelId}`);
	const linkedSection = page.locator("[data-channel-linked-agents]");
	await expect(linkedSection.getByText("Linked Agents", { exact: true })).toBeVisible();
	const agentRow = page.locator(`[data-channel-agent-link-id="${linkId}"]`);
	await expect(agentRow).toContainText("Support Agent");
	await expect(agentRow).toContainText("Channels");
	await expect(agentRow).toHaveAttribute("href", `/agents/${agentId}/channel-links`);
	await expect(page.getByText("Must stay on Agent Channels", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Paired chats", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Linked devices", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Link an agent", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Pair Telegram", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Unpair", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Unlink", exact: true })).toHaveCount(0);
	const activityTab = page.getByRole("tab", { name: "Activity", exact: true });
	await expect(activityTab).toBeVisible();
	await expect(page.getByRole("tab", { name: "Health", exact: true })).toBeVisible();
	await page.getByRole("tab", { name: "Commands", exact: true }).click();
	await expect(page.getByText("Pairing commands", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Publish Clawdi’s pairing commands to Telegram.", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("Publish this agent's slash commands", { exact: false })).toHaveCount(
		0,
	);
	await activityTab.click();
	await page.screenshot({
		path:
			process.env.CHANNEL_DETAIL_SCREENSHOT_PATH ??
			testInfo.outputPath("bot-detail-read-only-agents.png"),
		fullPage: true,
	});

	await page.setViewportSize({ width: 320, height: 844 });
	await expect(agentRow).toBeVisible();
	await expect(agentRow.getByText("Channels", { exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
	await page.screenshot({
		path:
			process.env.CHANNEL_DETAIL_MOBILE_SCREENSHOT_PATH ??
			testInfo.outputPath("bot-detail-read-only-agents-320.png"),
		fullPage: true,
	});

	await agentRow.click();
	await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/channel-links(?:\\?|$)`));
	await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
	expect(pairCodeRequests).toEqual([]);
	expect(deleteBindingRequests).toEqual([]);
	expect(linkAgentRequests).toEqual([]);
	expect(errors, `Bot detail browser errors: ${errors.join(" | ")}`).toEqual([]);
});
