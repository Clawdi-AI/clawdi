import type { DeployComponents, DeploymentRead } from "@clawdi/shared/api";
import { type BrowserContext, expect, type Locator, type Page, type Route } from "@playwright/test";
import type { ManagedModelCatalogItem, WalletState } from "../../src/hosted/billing/contracts";
import type { AiProvider } from "../../src/hosted/v2/ai-providers/types";
import {
	type DeploymentMutationFixture,
	fixtureAgentId,
	isDeploymentMutationFixture,
	isRecord,
	mutationDeploymentReadFixture,
	readDeploymentFixture,
} from "../hosted-stub-api";

type PlanChangeProgress = DeployComponents["schemas"]["ComputePlanChangeProgress"];

type PlanChangeKind = PlanChangeProgress["changeKind"];

type PlanChangeBillingEffect = PlanChangeProgress["billingEffect"];

type PlanChangeQuote = DeployComponents["schemas"]["V2ComputePlanChangeQuoteResponse"];

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

declare global {
	interface Window {
		__chatwootToggleCalls?: number;
		__stripeCheckoutClientSecrets?: string[];
		__stripeCheckoutLoadCalls?: number;
		__stripeConfirmCalls?: number;
		__stripeWalletAppearanceThemes?: string[];
		__stripeWalletClientSecrets?: string[];
		__stripeWalletConfirmCalls?: number;
		__stripeWalletReturnUrls?: string[];
	}
}

export async function expectLiveToolFillsDashboard(page: Page, surface: Locator) {
	const scrollContainer = page.locator("#dashboard-scroll-container");
	const header = scrollContainer.locator(":scope > header");
	const [surfaceBox, scrollBox, headerBox, scrollMetrics, pageMetrics] = await Promise.all([
		surface.evaluate((element) => element.getBoundingClientRect().toJSON()),
		scrollContainer.evaluate((element) => element.getBoundingClientRect().toJSON()),
		header.evaluate((element) => element.getBoundingClientRect().toJSON()),
		scrollContainer.evaluate((element) => ({
			clientHeight: element.clientHeight,
			overflowY: getComputedStyle(element).overflowY,
			scrollHeight: element.scrollHeight,
		})),
		page.evaluate(() => ({
			bodyClientHeight: document.body.clientHeight,
			bodyScrollHeight: document.body.scrollHeight,
			documentClientHeight: document.documentElement.clientHeight,
			documentScrollHeight: document.documentElement.scrollHeight,
		})),
	]);
	expect(Math.abs(surfaceBox.y - (headerBox.y + headerBox.height))).toBeLessThanOrEqual(1);
	expect(
		Math.abs(surfaceBox.y + surfaceBox.height - (scrollBox.y + scrollBox.height)),
	).toBeLessThanOrEqual(1);
	expect(scrollMetrics.overflowY).toBe("hidden");
	expect(scrollMetrics.scrollHeight).toBeLessThanOrEqual(scrollMetrics.clientHeight + 1);
	expect(pageMetrics.bodyScrollHeight).toBeLessThanOrEqual(pageMetrics.bodyClientHeight + 1);
	expect(pageMetrics.documentScrollHeight).toBeLessThanOrEqual(
		pageMetrics.documentClientHeight + 1,
	);
}

export async function expectTerminalFitsHost(terminal: Locator) {
	const geometry = await terminal.evaluate((host) => {
		const requiredElement = (selector: string) => {
			const element = host.querySelector<HTMLElement>(selector);
			if (!element) throw new Error(`Expected terminal element ${selector}`);
			return element;
		};
		const xterm = requiredElement(".xterm");
		const viewport = requiredElement(".xterm-viewport");
		const screen = requiredElement(".xterm-screen");
		const lastRow = requiredElement(".xterm-rows > div:last-child");
		return {
			host: {
				bottom: host.getBoundingClientRect().bottom,
				clientHeight: host.clientHeight,
				scrollHeight: host.scrollHeight,
			},
			xterm: {
				clientHeight: xterm.clientHeight,
				scrollHeight: xterm.scrollHeight,
			},
			viewport: viewport.getBoundingClientRect().toJSON(),
			screen: screen.getBoundingClientRect().toJSON(),
			lastRow: lastRow.getBoundingClientRect().toJSON(),
		};
	});
	expect(geometry.host.scrollHeight).toBeLessThanOrEqual(geometry.host.clientHeight + 1);
	expect(geometry.xterm.scrollHeight).toBeLessThanOrEqual(geometry.xterm.clientHeight + 1);
	expect(geometry.viewport.bottom).toBeLessThanOrEqual(geometry.host.bottom + 1);
	expect(geometry.screen.bottom).toBeLessThanOrEqual(geometry.viewport.bottom + 1);
	expect(geometry.lastRow.bottom).toBeLessThanOrEqual(geometry.viewport.bottom + 1);
}

export async function expectInlineSidebarStatus(sidebar: Locator, source: "hosted" | "connected") {
	const status = sidebar.getByTestId("app-sidebar-agent-status");
	await expect(status).toHaveAttribute("data-agent-status-source", source);
	await expect(status.locator("[aria-hidden]").first()).toBeVisible();
}

function hostedUser(canUseV2 = true, canUseV1 = false) {
	return {
		capabilities: {
			can_use_v1: canUseV1,
			can_use_v2: canUseV2,
		},
	};
}

const emptyPage = { items: [], total: 0, page: 1, page_size: 25 };

export function hostedOverviewSessionsPage(
	itemCount: number,
	runtime: "hermes" | "openclaw" = "hermes",
) {
	const summaries = [
		"Prepare launch brief",
		"Research customer feedback before the product planning review",
		"Investigate a long-running customer issue across several projects and write a detailed plan for the next release review with every regional owner and support lead",
		"Review risks",
		"Fifth hosted session",
	];
	return {
		items: Array.from({ length: itemCount }, (_, index) => ({
			id: `hosted-overview-session-${index + 1}`,
			local_session_id: `hosted-local-${index + 1}`,
			project_path: "/hosted",
			agent_name: "e2e-2",
			agent_display_name: null,
			agent_default_name: "e2e-2",
			agent_type: runtime,
			machine_name: `${runtime}-3`,
			started_at: `2026-07-15T0${index}:00:00Z`,
			ended_at: null,
			updated_at: `2026-07-15T0${index}:30:00Z`,
			last_activity_at: `2026-07-15T0${index}:30:00Z`,
			duration_seconds: 1800,
			message_count: index + 3,
			input_tokens: (index + 1) * 200,
			output_tokens: (index + 1) * 100,
			cache_read_tokens: 0,
			model: "gpt-5",
			models_used: ["gpt-5"],
			summary: summaries[index],
			tags: [],
			status: "active",
			content_hash: `hosted-hash-${index}`,
		})),
		total: itemCount,
		page: 1,
		page_size: 3,
	};
}

const hostedMemories = {
	items: [
		{
			id: "memory-hosted-shared",
			content: "Hosted and connected agents share this memory",
			category: "context",
			tags: ["shared"],
			source: "web",
			source_session_id: null,
			source_machine_name: "another-agent.local",
			access_count: 2,
			created_at: "2026-07-15T00:00:00Z",
		},
	],
	total: 1,
	page: 1,
	page_size: 25,
};

export const CLOUD_API = "http://127.0.0.1:8000";

export const DEPLOY_API = process.env.E2E_HOSTED_DEPLOY_API_URL ?? "http://127.0.0.1:8001";

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

const managedModelCatalog: { models: ManagedModelCatalogItem[] } = {
	models: [
		{
			id: "gpt-5.6-luna",
			display_name: "GPT-5.6 Luna",
			provider_id: "openai-codex",
			is_default: true,
			is_featured: true,
			description: "Low cost for routine work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.6-sol",
			display_name: "GPT-5.6 Sol",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: false,
			description: "Higher cost for complex work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.6-terra",
			display_name: "GPT-5.6 Terra",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: false,
			description: "Balanced cost for everyday work.",
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

export function userProvider(
	providerId: string,
	label: string,
	models: AiProvider["models"],
): AiProvider {
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

export const basicPlan = {
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

export const performancePlan = {
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

export const includedBasicDeployment: DeploymentMutationFixture = {
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

export const paidBasicDeployment: DeploymentMutationFixture = {
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

export const missingProjectionEnvironmentId = "55555555-5555-4555-8555-555555555555";

export const missingProjectionFailureReason =
	"startup_probe_failing; restart_count=2; container failed readiness probe after the runtime bridge exhausted every startup attempt";

export const failedMissingProjectionDeployment = {
	...includedBasicDeployment,
	id: "hdep_failed_projection",
	agent_id: missingProjectionEnvironmentId,
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
	agent_id: missingProjectionEnvironmentId,
	name: "Running projection agent",
	hermes_control_ui_url: "https://runtime.example/hermes",
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: missingProjectionEnvironmentId },
	},
};

export const sharedLegacyEnvironmentId = "77777777-7777-4777-8777-777777777777";

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

export const railHostedEnvironmentId = "88888888-8888-4888-8888-888888888888";

export const railConnectedEnvironmentId = "99999999-9999-4999-8999-999999999999";

export const railHostedDeployment = {
	...includedBasicDeployment,
	id: "hdep_rail_cloud",
	agent_id: railHostedEnvironmentId,
	name: "e2e-2",
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: railHostedEnvironmentId },
	},
};

export const railConnectedCloudAgent = {
	...sharedLegacyCloudAgent,
	id: railConnectedEnvironmentId,
	name: "rail-connected",
	default_name: "Rail Connected",
	machine_name: "rail-connected.local",
	display_name: "Rail Connected",
	sort_order: 1,
};

export const railHostedCloudAgent = {
	...sharedLegacyCloudAgent,
	id: railHostedEnvironmentId,
	name: "e2e-2",
	default_name: "e2e-2",
	machine_name: "hermes-3.local",
	display_name: null,
	sort_order: 0,
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

export const terminalFallbackDeployment: DeploymentMutationFixture = {
	...includedBasicDeployment,
	id: "hdep_terminal_fallback",
	name: "Fallback Basic",
	upgrade_available: false,
	last_funding_event: {
		funding_source: "stripe",
		reason: "payment_failure",
		prior_plan_slug: "compute_performance",
		occurred_at: "2026-07-16T00:00:00Z",
		subscription_id: 42,
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
}): { body: NonNullable<DeploymentRead["accepted_operation"]>; status: number } {
	const resolvedChangeKind =
		changeKind ?? (status === "scheduled" ? "scheduled_downgrade" : "immediate_upgrade");
	const deploymentId = `hdep_plan_${subscriptionId}`;
	return {
		status: 202,
		body: {
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
								},
							}).resource,
						}
					: null,
		},
	};
}

export function completedDeploymentOperation(
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

function failedDeploymentOperation(
	deployment: DeploymentMutationFixture,
	verb: "create" | "start" | "stop" | "restart" | "delete" | "update",
): NonNullable<DeploymentRead["accepted_operation"]> {
	return {
		...completedDeploymentOperation(deployment, verb),
		error: {
			code: 13,
			message: "operation failed",
			details: [
				{
					"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
					type: "https://api.clawdi.ai/problems/runtime-bootstrap-failed",
					title: "Runtime bootstrap failed",
					status: 502,
					detail: "Internal operation detail",
					code: "runtime_bootstrap_failed",
					retryable: true,
					conditionReason: "RuntimeBootstrapFailed",
					conditionMessage: "Runtime bootstrap failed",
					observedGeneration: 2,
				},
			],
		},
		response: null,
	};
}

function failedDeletionReadFixture(
	deployment: DeploymentMutationFixture,
	retryable: boolean,
): DeploymentRead {
	const read = mutationDeploymentReadFixture({ ...deployment, status: "failed" });
	const status = read.resource.status;
	if (status === null) throw new Error("Failed deletion fixture requires deployment status");
	const failureTitle = retryable
		? "Deployment resource teardown failed"
		: "Deployment resource teardown failed permanently";
	const failureReason = retryable ? "ResourceTeardownFailed" : "ResourceTeardownTerminalFailure";
	return {
		...read,
		accepted_operation: failedDeploymentOperation(deployment, "delete"),
		resource: {
			...read.resource,
			status: {
				...status,
				failure: {
					type: retryable
						? "https://api.clawdi.ai/problems/resource-teardown-failed"
						: "https://api.clawdi.ai/problems/resource-teardown-terminal-failure",
					title: failureTitle,
					status: 502,
					detail: "The deployment could not be deleted.",
					instance: deployment.id,
					code: retryable ? "resource_teardown_failed" : "resource_teardown_terminal_failure",
					phase: "delete",
					retryable,
					conditionReason: failureReason,
					conditionMessage: failureTitle,
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
	sessionsPage?: unknown;
	sessionsResponse?: StubResponse;
	sessionRequests?: string[];
	legacySkillDetailRequests?: string[];
	skillDetailRequests?: string[];
	skillDetailResponses?: Readonly<Record<string, StubResponse>>;
	connectorConnections?: readonly unknown[];
	connectorCatalog?: readonly {
		name: string;
		display_name: string;
		logo: string;
		description: string;
		auth_type: string;
		connect_disabled: boolean;
		connect_disabled_reason: null;
	}[];
	aiProviders?: readonly unknown[];
	aiProviderRequests?: string[];
	agentProjectBindings?: readonly unknown[];
	agentProjectBindingRequests?: string[];
	agentProjects?: readonly unknown[];
	agentProjectRequests?: string[];
	agentProjectsResponse?: StubResponse;
	agentResourceFixtures?: boolean;
	agentOrderRequests?: string[];
	autoReloadRequests?: string[];
	autoReloadResponses?: StubResponse[];
	canCreateCloudAgents?: boolean;
	canUseLegacyHostedDashboard?: boolean;
	productAccessRequests?: string[];
	productAccessResponseGate?: Promise<void>;
	cancelRequests?: string[];
	cancelResponses?: StubResponse[];
	checkoutRequests?: string[];
	checkoutResponses?: StubResponse[];
	channelAccount?: unknown;
	channelAccounts?: unknown[];
	channelAccountsResponses?: StubResponse[];
	channelAgentLinks?: readonly unknown[];
	channelAgentLinksResponse?: StubResponse;
	channelBindings?: unknown[];
	channelBindingResponses?: Record<string, StubResponse[]>;
	channelBotPool?: unknown;
	channelBotPoolResponses?: StubResponse[];
	channelHealthItems?: unknown[];
	linkAgentRequests?: Array<{ accountId: string; body: string }>;
	linkAgentResponses?: StubResponse[];
	linkAgentResponseGates?: Array<Promise<void> | undefined>;
	unlinkAgentRequests?: string[];
	unlinkAgentResponses?: StubResponse[];
	onUnlinkAgent?: (path: string) => void;
	onLinkAgent?: (response: unknown) => void;
	createChannelRequests?: string[];
	createChannelResponse?: unknown;
	createChannelResponses?: StubResponse[];
	deleteChannelRequests?: string[];
	deleteChannelResponses?: StubResponse[];
	onDeleteChannel?: (accountId: string) => void;
	deleteBindingRequests?: string[];
	deleteBindingResponses?: StubResponse[];
	onCreateChannel?: (response: unknown) => void;
	pairCodeRequests?: string[];
	pairCodeResponses?: StubResponse[];
	pairCodeResponseGates?: Array<Promise<void> | undefined>;
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
	deploymentDetailRequests?: string[];
	deploymentDetailResponses?: StubResponse[];
	deploymentDetailResponseGates?: Array<Promise<void> | undefined>;
	deploymentListRequests?: string[];
	deploymentListResponses?: Array<unknown[] | StubResponse>;
	deploymentListResponseGates?: Array<Promise<void> | undefined>;
	deploymentRequestReads?: string[];
	deployments?: readonly unknown[];
	deploymentsResponse?: StubResponse;
	fixPaymentRequests?: string[];
	legacyAgentEnvironmentIds?: readonly string[];
	managedModels?: typeof managedModelCatalog;
	managedModelRequests?: string[];
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
	providerOAuthPollResponses?: StubResponse[];
	providerPatchRequests?: string[];
	providerPatchResponses?: StubResponse[];
	providerTestRequests?: string[];
	restartRequests?: string[];
	runtimeUiRedemptionRequests?: string[];
	runtimeUiRedemptionResponses?: StubResponse[];
	runtimeUiResetRequests?: Array<{ idempotencyKey: string | null; ifMatch: string | null }>;
	skillRequests?: string[];
	vaultRequests?: string[];
	skillsByProjectId?: Readonly<Record<string, readonly unknown[]>>;
	resumeRequests?: string[];
	subscriptionQuoteRequests?: string[];
	subscriptionQuoteResponses?: unknown[];
	startError?: { status: number; detail: string };
	startRequests?: string[];
	topUpIdempotencyKeys?: string[];
	topUpRequests?: string[];
	topUpResponses?: StubResponse[];
	walletSetupCreates?: Array<{ body: string; idempotencyKey: string | null }>;
	walletSetupFinalizeFailures?: number;
	walletSetupFinalizes?: string[];
	unfinishedDeploymentRequests?: boolean;
	usageResponse?: unknown;
	updateDeploymentRequests?: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}>;
	workspaceSkillRequests?: string[];
	workspaceSkillsByDeploymentId?: Readonly<Record<string, readonly unknown[]>>;
	walletState?: typeof walletState;
	walletRequests?: string[];
	walletResponses?: StubResponse[];
	walletResponseGates?: Array<Promise<void> | undefined>;
	onTopUpSuccess?: () => void;
	onWalletCheckoutSuccess?: () => void;
};

export async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function stubCompletedStripeCheckout(page: Page) {
	await page.addInitScript(() => {
		const mockStripe = Object.assign(
			() => {
				const session = { canConfirm: true, status: { type: "open" } };
				const actions = {
					getSession: () => session,
					confirm: async () => ({
						type: "success",
						session: { status: { type: "complete", paymentStatus: "paid" } },
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
						createExpressCheckoutElement: () => ({
							mount: () => undefined,
							on: () => undefined,
							off: () => undefined,
							update: () => undefined,
							destroy: () => undefined,
						}),
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

export async function stubWalletStripeSetup(page: Page) {
	await page.addInitScript(() => {
		const browserState = window;
		browserState.__stripeWalletAppearanceThemes = [];
		browserState.__stripeWalletClientSecrets = [];
		browserState.__stripeWalletConfirmCalls = 0;
		browserState.__stripeWalletReturnUrls = [];
		let latestClientSecret = "";
		const recordTheme = (appearance?: { theme?: string }) => {
			if (appearance?.theme) browserState.__stripeWalletAppearanceThemes?.push(appearance.theme);
		};
		const mockStripe = Object.assign(
			() => ({
				confirmCardPayment: async () => ({}),
				elements: (options: { appearance?: { theme?: string }; clientSecret?: string }) => {
					latestClientSecret = options.clientSecret ?? "";
					browserState.__stripeWalletClientSecrets?.push(latestClientSecret);
					recordTheme(options.appearance);
					return {
						create: () => ({
							destroy: () => undefined,
							mount: (node: HTMLElement) => {
								node.textContent = "Mock Wallet card form";
							},
							off: () => undefined,
							on: (event: string, callback: () => void) => {
								if (event === "ready") window.setTimeout(callback, 0);
							},
							update: () => undefined,
						}),
						getElement: () => null,
						submit: async () => ({}),
						update: (next: { appearance?: { theme?: string } }) => recordTheme(next.appearance),
					};
				},
				createPaymentMethod: async () => ({}),
				createToken: async () => ({}),
				confirmSetup: async (options: { confirmParams?: { return_url?: string } }) => {
					browserState.__stripeWalletConfirmCalls =
						(browserState.__stripeWalletConfirmCalls ?? 0) + 1;
					browserState.__stripeWalletReturnUrls?.push(options.confirmParams?.return_url ?? "");
					return {
						setupIntent: {
							id: latestClientSecret.split("_secret_", 1)[0] ?? "",
							status: "succeeded",
						},
					};
				},
				retrievePaymentIntent: async () => ({
					paymentIntent: { id: "pi_auto_reload_return", status: "succeeded" },
				}),
				_registerWrapper: () => undefined,
			}),
			{ version: "dahlia" },
		);
		Object.defineProperty(window, "Stripe", { configurable: true, value: mockStripe });
	});
}

export async function stubHostedApi(page: Page, options: HostedApiStubOptions = {}) {
	const deployments = options.deployments ?? [];
	const aiProviders = [...(options.aiProviders ?? [])];
	const acceptedDeleteIds = new Set<string>();
	const completedDeleteIds = options.completedDeleteIds ?? new Set<string>();
	const plans = options.plans ?? [];
	let currentWallet: WalletState = options.walletState ?? walletState;
	let walletSetupFinalizeFailures = options.walletSetupFinalizeFailures ?? 0;
	const walletSetupSettings = new Map<
		string,
		{
			auto_reload_amount_cents: number;
			auto_reload_monthly_cap_cents: number;
			auto_reload_threshold_usd: number | string;
			consent_version: "wallet_auto_reload_off_session_v2";
		}
	>();
	const deploymentRequests = new Map<string, DeploymentMutationFixture>();
	const acceptedDeployments = new Map<string, DeploymentMutationFixture>();
	// Deploy API (/me, /v2/*).
	await page.route(`${DEPLOY_API}/**`, async (r) => {
		const p = new URL(r.request().url()).pathname;
		if (p === "/v1/me/notifications") {
			return fulfillJson(r, { items: [], next_cursor: null });
		}
		if (p === "/me" || p === "/v1/me") {
			options.productAccessRequests?.push(`DEPLOY ${p}`);
			await options.productAccessResponseGate;
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
			options.managedModelRequests?.push(r.request().url());
			return fulfillJson(r, options.managedModels ?? managedModelCatalog);
		}
		if (p === "/v2/usage" && r.request().method() === "GET" && options.usageResponse) {
			return fulfillJson(r, options.usageResponse);
		}
		if (p === "/v2/wallet" && r.request().method() === "GET") {
			options.walletRequests?.push(r.request().url());
			const response = options.walletResponses?.shift();
			await options.walletResponseGates?.shift();
			if (response) {
				if (response.status < 400) currentWallet = response.body as WalletState;
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
				if (response.status < 400) currentWallet = response.body as WalletState;
				return fulfillJson(r, response.body, response.status);
			}
			const request = JSON.parse(requestBody) as Partial<typeof walletState>;
			currentWallet =
				request.auto_reload_enabled === false
					? {
							...currentWallet,
							...request,
							auto_reload_card: null,
							auto_reload_consented_at: null,
							auto_reload_consent_version: null,
							auto_reload_has_payment_method: false,
							auto_reload_status: "off",
						}
					: { ...currentWallet, ...request };
			return fulfillJson(r, currentWallet);
		}
		if (p === "/v2/wallet/auto-reload/setup-intent" && r.request().method() === "POST") {
			const body = r.request().postData() ?? "";
			options.walletSetupCreates?.push({
				body,
				idempotencyKey: r.request().headers()["idempotency-key"] ?? null,
			});
			const request = JSON.parse(body) as {
				auto_reload_amount_cents: number;
				auto_reload_monthly_cap_cents: number;
				auto_reload_threshold_usd: number | string;
				consent_version: "wallet_auto_reload_off_session_v2";
			};
			const attempt = options.walletSetupCreates?.length ?? walletSetupSettings.size + 1;
			const setupIdentity = `wsetup_${(attempt === 1 ? "a" : "b").repeat(64)}`;
			const setupIntentId = `seti_wallet_${attempt}`;
			walletSetupSettings.set(setupIdentity, request);
			return fulfillJson(r, {
				...request,
				amount_policy: "wallet_reload_configured_plus_negative_balance_v1",
				client_secret: `${setupIntentId}_secret_mock_${attempt}`,
				currency: "usd",
				setup_identity: setupIdentity,
				setup_intent_id: setupIntentId,
				status: "requires_payment_method",
			});
		}
		if (p === "/v2/wallet/auto-reload/setup-intent/finalize" && r.request().method() === "POST") {
			const body = r.request().postData() ?? "";
			options.walletSetupFinalizes?.push(body);
			if (walletSetupFinalizeFailures > 0) {
				walletSetupFinalizeFailures -= 1;
				return fulfillJson(r, { detail: "temporarily_unavailable" }, 503);
			}
			const request = JSON.parse(body) as { setup_identity: string; setup_intent_id: string };
			const settings = walletSetupSettings.get(request.setup_identity);
			if (!settings) return fulfillJson(r, { detail: "setup_not_found" }, 404);
			const replacement = request.setup_intent_id === "seti_wallet_2";
			currentWallet = {
				...currentWallet,
				auto_reload_amount_cents: settings.auto_reload_amount_cents,
				auto_reload_card: {
					brand: replacement ? "mastercard" : "visa",
					exp_month: replacement ? 8 : 12,
					exp_year: 2032,
					last4: replacement ? "4444" : "4242",
				},
				auto_reload_consented_at: "2026-08-13T12:00:00Z",
				auto_reload_consent_version: settings.consent_version,
				auto_reload_enabled: true,
				auto_reload_has_payment_method: true,
				auto_reload_monthly_cap_cents: settings.auto_reload_monthly_cap_cents,
				auto_reload_status: "active",
				auto_reload_threshold_usd: String(settings.auto_reload_threshold_usd),
			};
			return fulfillJson(r, currentWallet);
		}
		if (p === "/v2/wallet/transactions" && r.request().method() === "GET") {
			return fulfillJson(r, { items: [], has_more: false, next_cursor: null });
		}
		if (p === "/v2/deployments" && r.request().method() === "GET") {
			options.deploymentListRequests?.push(p);
			const deploymentListResponse = options.deploymentListResponses?.shift();
			const deploymentListResponseGate = options.deploymentListResponseGates?.shift();
			if (deploymentListResponse) {
				await deploymentListResponseGate;
				if (isStubResponse(deploymentListResponse)) {
					return fulfillJson(r, deploymentListResponse.body, deploymentListResponse.status);
				}
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
			const createdDeployment: DeploymentMutationFixture = {
				...includedBasicDeployment,
				id: "hdep_included_created",
				name: "Created included Basic",
				status: "creating",
			};
			acceptedDeployments.set(createdDeployment.id, createdDeployment);
			return fulfillJson(r, completedDeploymentOperation(createdDeployment, "create"), 202);
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
					agent_id: fixtureAgentId(deployment),
					deployment_id: deployment.id,
					lineage_version: 1,
					lineage_state: unfinished ? "processing" : "succeeded",
					operation: unfinished
						? { ...acceptedOperation, done: false, response: null }
						: acceptedOperation,
				},
			});
		}
		const workspaceSkillsMatch = p.match(/^\/v2\/deployments\/([^/]+)\/workspace-skills$/);
		if (workspaceSkillsMatch && r.request().method() === "GET") {
			const deploymentId = decodeURIComponent(workspaceSkillsMatch[1] ?? "");
			options.workspaceSkillRequests?.push(r.request().url());
			return fulfillJson(r, {
				deployment_id: deploymentId,
				deployment_resource_version: "rv-workspace-skills",
				manifest_generation: 1,
				items: options.workspaceSkillsByDeploymentId?.[deploymentId] ?? [],
			});
		}
		if (p.startsWith("/v2/deployments/") && r.request().method() === "GET") {
			const deploymentId = decodeURIComponent(p.slice("/v2/deployments/".length));
			options.deploymentDetailRequests?.push(deploymentId);
			const response = options.deploymentDetailResponses?.shift();
			const responseGate = options.deploymentDetailResponseGates?.shift();
			await responseGate;
			if (response) {
				if (response.delayMs) {
					await new Promise((resolve) => setTimeout(resolve, response.delayMs));
				}
				return fulfillJson(r, readDeploymentFixture(response.body), response.status);
			}
			const deployment =
				deployments.find(
					(candidate): candidate is DeploymentMutationFixture =>
						isDeploymentMutationFixture(candidate) && candidate.id === deploymentId,
				) ?? acceptedDeployments.get(deploymentId);
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
		if (p === "/v2/wallet/payment-methods") {
			return fulfillJson(r, { items: [], has_more: false });
		}
		if (p === "/v2/wallet/topup" && r.request().method() === "POST") {
			options.topUpRequests?.push(r.request().postData() ?? "");
			options.topUpIdempotencyKeys?.push(r.request().headers()["idempotency-key"] ?? "");
			const response = options.topUpResponses?.shift() ?? {
				status: 200,
				body: {
					status: "succeeded",
					flow_type: "checkout_session",
					checkout_session_id: "cs_topup_fixture",
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
			const response = options.runtimeUiRedemptionResponses?.shift() ?? {
				status: 200,
				body: { detail: "Hermes uses browser OIDC login" },
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
		const url = new URL(r.request().url());
		const p = url.pathname;
		if (p === "/v1/me") {
			options.productAccessRequests?.push(`CLOUD ${p}`);
			await options.productAccessResponseGate;
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
		if (p.match(/^\/v1\/agents\/[^/]+\/project-bindings$/) && r.request().method() === "GET") {
			const agentId = decodeURIComponent(p.split("/")[3] ?? "");
			options.agentProjectBindingRequests?.push(r.request().url());
			if (options.agentProjectBindings) return fulfillJson(r, options.agentProjectBindings);
			if (!options.agentResourceFixtures) return fulfillJson(r, []);
			return fulfillJson(r, [
				{
					id: `binding-${agentId}`,
					agent_id: agentId,
					project_id: "project-hosted",
					binding_type: "primary",
					priority: 0,
					default_write_enabled: true,
					created_at: "2026-07-15T00:00:00Z",
				},
			]);
		}
		if (/^\/v1\/agents\/[^/]+\/skills$/.test(p) && r.request().method() === "GET") {
			return fulfillJson(r, {
				agent_id: decodeURIComponent(p.split("/")[3] ?? ""),
				skills: [],
				removal_failures: [],
			});
		}
		if (p.startsWith("/v1/agents/") && r.request().method() === "GET") {
			const id = decodeURIComponent(p.slice("/v1/agents/".length));
			const response = options.cloudAgentResponses?.[id]?.shift();
			if (response) {
				if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
				return fulfillJson(r, response.body, response.status);
			}
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
			options.aiProviderRequests?.push(r.request().url());
			return fulfillJson(r, { providers: aiProviders });
		}
		if (p === "/v1/ai-providers/accept" && r.request().method() === "POST") {
			options.providerAcceptRequests?.push(r.request().postData() ?? "");
			const response = options.providerAcceptResponses?.shift() ?? {
				status: 500,
				body: { detail: "No provider accept response configured" },
			};
			if (
				response.status < 400 &&
				isRecord(response.body) &&
				response.body.status === "ready" &&
				isRecord(response.body.provider)
			) {
				aiProviders.push(response.body.provider);
			}
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
		if (
			p.match(/^\/v1\/ai-providers\/[^/]+\/auth\/oauth\/device\/poll$/) &&
			r.request().method() === "POST"
		) {
			const response = options.providerOAuthPollResponses?.shift() ?? {
				status: 200,
				body: { status: "pending", retry_after_seconds: 60 },
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
			const response = options.channelAccountsResponses?.shift();
			if (response?.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
			if (response) return fulfillJson(r, response.body, response.status);
			return fulfillJson(
				r,
				options.channelAccounts ?? (options.channelAccount ? [options.channelAccount] : []),
			);
		}
		if (p === "/v1/channels" && r.request().method() === "POST") {
			options.createChannelRequests?.push(r.request().postData() ?? "");
			const configured =
				options.createChannelResponses?.shift() ?? options.createChannelResponse ?? {};
			const response = isStubResponse(configured) ? configured : { body: configured, status: 201 };
			if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			if (response.status < 400) options.onCreateChannel?.(response.body);
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v1/channels/bot-pool") {
			const response = options.channelBotPoolResponses?.shift();
			if (response?.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
			if (response) return fulfillJson(r, response.body, response.status);
			return fulfillJson(r, options.channelBotPool ?? { providers: {} });
		}
		if (p === "/v1/channels/health") {
			return fulfillJson(r, { items: options.channelHealthItems ?? [] });
		}
		if (p === "/v1/channels/agent-links" && r.request().method() === "GET") {
			const response = options.channelAgentLinksResponse;
			if (response?.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
			if (response) return fulfillJson(r, response.body, response.status);
			const requestedAgentId = new URL(r.request().url()).searchParams.get("agent_id");
			const links = options.channelAgentLinks ?? [];
			return fulfillJson(
				r,
				requestedAgentId
					? links.filter((link) => isRecord(link) && link.agent_id === requestedAgentId)
					: links,
			);
		}
		if (p.match(/^\/v1\/channels\/[^/]+$/) && r.request().method() === "DELETE") {
			const accountId = decodeURIComponent(p.slice(p.lastIndexOf("/") + 1));
			options.deleteChannelRequests?.push(accountId);
			const response = options.deleteChannelResponses?.shift() ?? { body: null, status: 204 };
			if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			if (response.status < 400) options.onDeleteChannel?.(accountId);
			if (response.status === 204) return r.fulfill({ status: 204, body: "" });
			return fulfillJson(r, response.body, response.status);
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
			const responseGate = options.linkAgentResponseGates?.shift();
			await responseGate;
			if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			if (response.status < 400) options.onLinkAgent?.(response.body);
			return fulfillJson(r, response.body, response.status);
		}
		if (p.match(/\/agent-links\/[^/]+$/) && r.request().method() === "DELETE") {
			options.unlinkAgentRequests?.push(p);
			const response = options.unlinkAgentResponses?.shift() ?? {
				body: { unlinked: true },
				status: 200,
			};
			if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			if (response.status < 400) options.onUnlinkAgent?.(p);
			return fulfillJson(r, response.body, response.status);
		}
		if (p.endsWith("/pair-codes") && r.request().method() === "POST") {
			options.pairCodeRequests?.push(r.request().postData() ?? "");
			const response = options.pairCodeResponses?.shift() ?? { body: {}, status: 201 };
			const responseGate = options.pairCodeResponseGates?.shift();
			await responseGate;
			if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
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
			if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
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
			const response = accountId
				? options.channelBindingResponses?.[accountId]?.shift()
				: undefined;
			if (response?.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, response.delayMs));
			}
			if (response) return fulfillJson(r, response.body, response.status);
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
		if (p === "/v1/projects") {
			options.agentProjectRequests?.push(r.request().url());
			if (options.agentProjectsResponse) {
				if (options.agentProjectsResponse.delayMs) {
					await new Promise((resolve) =>
						setTimeout(resolve, options.agentProjectsResponse?.delayMs),
					);
				}
				return fulfillJson(
					r,
					options.agentProjectsResponse.body,
					options.agentProjectsResponse.status,
				);
			}
			if (options.agentProjects) return fulfillJson(r, options.agentProjects);
			if (!options.agentResourceFixtures) return fulfillJson(r, []);
			return fulfillJson(r, [
				{
					id: "project-hosted",
					name: "Hosted Agent Project",
					slug: "hosted-agent-project",
					kind: "environment",
					origin_environment_id: railHostedEnvironmentId,
					archived_at: null,
					created_at: "2026-07-15T00:00:00Z",
					is_owner: true,
					owner_display: "Hosted User",
					owner_handle: "hosted-user",
				},
			]);
		}
		const projectDetailMatch = p.match(/^\/v1\/projects\/([^/]+)$/);
		if (projectDetailMatch && r.request().method() === "GET") {
			options.agentProjectRequests?.push(r.request().url());
			const projectId = decodeURIComponent(projectDetailMatch[1] ?? "");
			const project = (options.agentProjects ?? []).find(
				(candidate) =>
					isRecord(candidate) && typeof candidate.id === "string" && candidate.id === projectId,
			);
			return fulfillJson(r, project ?? { detail: "Project not found" }, project ? 200 : 404);
		}
		if (p === "/v1/skills") {
			options.skillRequests?.push(r.request().url());
			const projectId = url.searchParams.get("project_id") ?? "";
			const page = Number(url.searchParams.get("page") ?? "1");
			const pageSize = Number(url.searchParams.get("page_size") ?? "25");
			const projectSkills = options.skillsByProjectId?.[projectId] ?? [];
			const start = (page - 1) * pageSize;
			return fulfillJson(r, {
				items: projectSkills.slice(start, start + pageSize),
				total: projectSkills.length,
				page,
				page_size: pageSize,
			});
		}
		const projectSkillDetailMatch = p.match(/^\/v1\/projects\/([^/]+)\/skills\/(.+)$/);
		if (projectSkillDetailMatch && r.request().method() === "GET") {
			options.skillDetailRequests?.push(r.request().url());
			const projectId = decodeURIComponent(projectSkillDetailMatch[1] ?? "");
			const skillKey = decodeURIComponent(projectSkillDetailMatch[2] ?? "");
			const response = options.skillDetailResponses?.[`${projectId}/${skillKey}`];
			return fulfillJson(
				r,
				response?.body ?? { detail: "Skill not found" },
				response?.status ?? 404,
			);
		}
		if (/^\/v1\/skills\/.+/.test(p) && r.request().method() === "GET") {
			options.legacySkillDetailRequests?.push(r.request().url());
			return fulfillJson(r, { detail: "Skill not found" }, 404);
		}
		if (p === "/v1/vault" && r.request().method() === "POST") {
			return fulfillJson(r, {});
		}
		if (p === "/v1/vault") {
			options.vaultRequests?.push(r.request().url());
			if (!options.agentResourceFixtures) {
				return fulfillJson(r, { items: [], total: 0, page: 1, page_size: 200 });
			}
			const projectId = url.searchParams.get("project_id");
			const items = [
				{
					id: "vault-hosted",
					slug: "hosted-vault",
					name: "Hosted Scoped Vault",
					project_ids: ["project-hosted"],
					is_owner: true,
					item_count: 1,
					created_at: "2026-07-15T00:00:00Z",
				},
				{
					id: "vault-other",
					slug: "other-vault",
					name: "Other Account Vault",
					project_ids: ["project-other"],
					is_owner: true,
					item_count: 1,
					created_at: "2026-07-15T00:00:00Z",
				},
			].filter((vault) => !projectId || vault.project_ids.includes(projectId));
			return fulfillJson(r, {
				items,
				total: items.length,
				page: Number(url.searchParams.get("page") ?? "1"),
				page_size: Number(url.searchParams.get("page_size") ?? "25"),
			});
		}
		if (p === "/v1/vault/detail") {
			const vaultId = url.searchParams.get("vault_id");
			if (vaultId !== "vault-hosted") {
				return fulfillJson(r, { detail: "Vault not found" }, 404);
			}
			return fulfillJson(r, {
				id: "vault-hosted",
				slug: "hosted-vault",
				name: "Hosted Scoped Vault",
				project_ids: ["project-hosted"],
				is_owner: true,
				item_count: 1,
				created_at: "2026-07-15T00:00:00Z",
			});
		}
		if (/^\/v1\/vault\/[^/]+\/items$/.test(p)) {
			return fulfillJson(r, { "(default)": ["HOSTED_API_KEY"] });
		}
		if (p === "/v1/connectors") return fulfillJson(r, options.connectorConnections ?? []);
		const connectorAppMatch = p.match(/^\/v1\/connectors\/available\/([^/]+)$/);
		if (connectorAppMatch) {
			const app = (
				options.connectorCatalog ?? [
					{
						name: "github",
						display_name: "GitHub",
						logo: "",
						description: "Source control connector",
						auth_type: "oauth",
						connect_disabled: false,
						connect_disabled_reason: null,
					},
				]
			).find((item) => item.name === decodeURIComponent(connectorAppMatch[1] ?? ""));
			return fulfillJson(r, app ?? { detail: "App not found" }, app ? 200 : 404);
		}
		if (/^\/v1\/connectors\/[^/]+\/tools$/.test(p)) return fulfillJson(r, []);
		if (p === "/v1/connectors/available") {
			if (!options.agentResourceFixtures) {
				return fulfillJson(r, { items: [], total: 0, page: 1, page_size: 24 });
			}
			return fulfillJson(r, {
				items: options.connectorCatalog ?? [
					{
						name: "github",
						display_name: "GitHub",
						logo: "",
						description: "Source control connector",
						auth_type: "oauth",
						connect_disabled: false,
						connect_disabled_reason: null,
					},
				],
				total: 1,
				page: 1,
				page_size: 24,
			});
		}
		if (p === "/v1/sessions") {
			options.sessionRequests?.push(r.request().url());
			if (options.sessionsResponse) {
				if (options.sessionsResponse.delayMs) {
					await new Promise((resolve) => setTimeout(resolve, options.sessionsResponse?.delayMs));
				}
				return fulfillJson(r, options.sessionsResponse.body, options.sessionsResponse.status);
			}
			return fulfillJson(r, options.sessionsPage ?? emptyPage);
		}
		const memoryDetailMatch = p.match(/^\/v1\/memories\/([^/]+)$/);
		if (memoryDetailMatch) {
			const memory = hostedMemories.items.find(
				(item) => item.id === decodeURIComponent(memoryDetailMatch[1] ?? ""),
			);
			return fulfillJson(r, memory ?? { detail: "Memory not found" }, memory ? 200 : 404);
		}
		if (p === "/v1/memories") return fulfillJson(r, hostedMemories);
		if (p === "/v1/settings") {
			return fulfillJson(r, { memory_provider: "builtin", mem0_api_key: null });
		}
		if (p === "/v1/auth/keys") return fulfillJson(r, []);
		return fulfillJson(r, {});
	});
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

export async function expectNoHorizontalOverflow(locator: Locator, label: string) {
	const metrics = await locator.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(metrics.scrollWidth, `${label} horizontal overflow`).toBeLessThanOrEqual(
		metrics.clientWidth + 1,
	);
}

export async function expectContainedInOwnerAndViewport(
	page: Page,
	control: Locator,
	owner: Locator,
	label: string,
) {
	await expect(control, `${label} should be visible`).toBeVisible();
	await control.scrollIntoViewIfNeeded();
	const [controlBox, ownerBox] = await Promise.all([control.boundingBox(), owner.boundingBox()]);
	expect(controlBox, `${label} control box`).not.toBeNull();
	expect(ownerBox, `${label} owner box`).not.toBeNull();
	if (!controlBox || !ownerBox) return;
	const tolerance = 1;
	const controlRight = controlBox.x + controlBox.width;
	const controlBottom = controlBox.y + controlBox.height;
	const ownerRight = ownerBox.x + ownerBox.width;
	const ownerBottom = ownerBox.y + ownerBox.height;
	expect(controlBox.x, `${label} left edge in owner`).toBeGreaterThanOrEqual(
		ownerBox.x - tolerance,
	);
	expect(controlBox.y, `${label} top edge in owner`).toBeGreaterThanOrEqual(ownerBox.y - tolerance);
	expect(controlRight, `${label} right edge in owner`).toBeLessThanOrEqual(ownerRight + tolerance);
	expect(controlBottom, `${label} bottom edge in owner`).toBeLessThanOrEqual(
		ownerBottom + tolerance,
	);
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("Playwright viewport is required for containment checks");
	expect(controlBox.x, `${label} left edge in viewport`).toBeGreaterThanOrEqual(-tolerance);
	expect(controlBox.y, `${label} top edge in viewport`).toBeGreaterThanOrEqual(-tolerance);
	expect(controlRight, `${label} right edge in viewport`).toBeLessThanOrEqual(
		viewport.width + tolerance,
	);
	expect(controlBottom, `${label} bottom edge in viewport`).toBeLessThanOrEqual(
		viewport.height + tolerance,
	);

	if (await control.evaluate((element) => element.matches("button, [role=button]"))) {
		const content = await control.evaluate((element) => ({
			clientHeight: element.clientHeight,
			clientWidth: element.clientWidth,
			scrollHeight: element.scrollHeight,
			scrollWidth: element.scrollWidth,
		}));
		expect(content.scrollWidth, `${label} button content width`).toBeLessThanOrEqual(
			content.clientWidth + tolerance,
		);
		expect(content.scrollHeight, `${label} button content height`).toBeLessThanOrEqual(
			content.clientHeight + tolerance,
		);
	}
}

export async function _expectControlsDoNotOverlap(controls: Locator[], label: string) {
	const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
	for (let first = 0; first < boxes.length; first += 1) {
		const firstBox = boxes[first];
		if (!firstBox) continue;
		for (let second = first + 1; second < boxes.length; second += 1) {
			const secondBox = boxes[second];
			if (!secondBox) continue;
			const horizontalOverlap =
				Math.min(firstBox.x + firstBox.width, secondBox.x + secondBox.width) -
				Math.max(firstBox.x, secondBox.x);
			const verticalOverlap =
				Math.min(firstBox.y + firstBox.height, secondBox.y + secondBox.height) -
				Math.max(firstBox.y, secondBox.y);
			expect(
				horizontalOverlap > 0 && verticalOverlap > 0,
				`${label}: controls ${first + 1} and ${second + 1} overlap`,
			).toBe(false);
		}
	}
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
			await expect(page.getByText(`${tier} plan`, { exact: true })).toBeVisible();
			// Do not open a modal while React is still hydrating the sidebar; Base UI's
			// focus isolation mutates aria-hidden and can create a false mismatch.
			await page.waitForLoadState("networkidle");
			return;
		} catch (error) {
			if (attempt === 1) throw error;
		}
	}
}

export const openClawRuntimeEndpoint = "https://runtime.example/openclaw/";

export const openClawRuntimeToken = "test-deployment-token";

export async function stubOpenClawRuntime(page: Page, context: BrowserContext, handoffUrl: string) {
	type FrameGate = { signalStarted: () => void; released: Promise<void> };
	let nextFrameGate: FrameGate | null = null;
	let documentLoads = 0;
	const pauseNextIframe = () => {
		if (nextFrameGate) throw new Error("An OpenClaw iframe gate is already pending.");
		let started = false;
		let release: () => void = () => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		nextFrameGate = {
			signalStarted: () => {
				started = true;
			},
			released,
		};
		return { isStarted: () => started, release };
	};

	// A popup's initial navigation belongs to context routing, not this page.
	await page.route("https://runtime.example/**", async (route) => {
		if (route.request().isNavigationRequest()) {
			documentLoads += 1;
			const gate = nextFrameGate;
			nextFrameGate = null;
			if (gate) {
				gate.signalStarted();
				await gate.released;
			}
		}
		await route.fallback();
	});
	await context.route("https://runtime.example/**", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html><title>Mock OpenClaw</title><main>Mock OpenClaw</main>",
		});
	});

	const credentialRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [openClawIncludedDeployment],
		runtimeUiRedemptionRequests: credentialRequests,
		runtimeUiRedemptionResponses: Array.from({ length: 2 }, () => ({
			status: 200,
			body: {
				runtime: "openclaw",
				auth_mode: "openclaw_token",
				url: openClawRuntimeEndpoint,
				deployment_resource_version: `rv_${openClawIncludedDeployment.id}`,
				token: openClawRuntimeToken,
				handoff_url: handoffUrl,
			},
		})),
	});

	return {
		agentId: fixtureAgentId(openClawIncludedDeployment),
		credentialRequests,
		pauseNextIframe,
		documentLoads: () => documentLoads,
	};
}

export async function expectOpenClawWindow(
	context: BrowserContext,
	openButton: Locator,
	expectedUrl: string,
) {
	const popupPromise = context.waitForEvent("page");
	await openButton.click();
	const popup = await popupPromise;
	await expect(popup).toHaveURL(expectedUrl);
	await popup.close();
}

export async function _gotoHostedSettingsDialog(page: Page, section: string) {
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
