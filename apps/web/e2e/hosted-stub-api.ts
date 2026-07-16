import { expect, type Page, type Route } from "@playwright/test";

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
const DEPLOY_API = process.env.E2E_HOSTED_DEPLOY_API_URL ?? "http://127.0.0.1:50001";

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
};

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
		current_period_end: "2027-07-15T00:00:00Z",
	},
};

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

export const walletState = {
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
		current_period_end: "2026-08-15T00:00:00Z",
	},
};

export const walletPastDueDeployment = {
	...walletActiveDeployment,
	compute_subscription: {
		...walletActiveDeployment.compute_subscription,
		status: "past_due",
		payment_state: "past_due",
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
		cancel_at: "2027-07-15T00:00:00Z",
	},
};

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

export function planChangeResponse({
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
	createRequests?: string[];
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
	runtimeUiRedemptionRequests?: string[];
	runtimeUiRedemptionResponses?: StubResponse[];
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

export async function stubHostedApi(page: Page, options: HostedApiStubOptions = {}) {
	const deployments = options.deployments ?? [];
	const plans = options.plans ?? [];
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
			return fulfillJson(r, deployments);
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
				return fulfillJson(r, { detail: options.startError.detail }, options.startError.status);
			}
			return fulfillJson(r, { status: "starting" });
		}
		if (p.startsWith("/v2/deployments/") && r.request().method() === "DELETE") {
			options.deleteRequests?.push(p);
			return fulfillJson(r, { status: "deleted", cvm_deleted: true });
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
