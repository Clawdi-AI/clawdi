import { expect, type Page, type Route, test } from "@playwright/test";

// HOSTED (Clawdi Cloud) smoke against the vite dev server with dev-auth-bypass
// (NO Clerk key needed) + deploy-api enabled so /deploy renders. Exercises the
// deploy wizard's Base UI Select asserting ZERO browser console/page errors.
//
// IMPORTANT: stub by API HOST, never with broad "**/v2/**" globs — the app's
// own modules live under /src/hosted/v2/... and a path glob would intercept
// them and break module loading.

const me = { capabilities: { can_use_v1: false, can_use_v2: true } };
const emptyPage = { items: [], total: 0, page: 1, page_size: 25 };

// Must match the API hosts configured in playwright.hosted.config.ts.
const CLOUD_API = "http://127.0.0.1:8000";
const DEPLOY_API = "http://127.0.0.1:8001";

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

const includedBasicDeployment = {
	id: "hdep_included",
	user_id: "usr_browser",
	name: "Included Basic",
	app_id: "v2-browser",
	status: "running",
	created_at: "2026-07-15T00:00:00Z",
	upgrade_available: true,
	compute_subscription: null,
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
		status: "active",
		payment_state: "ok",
		billing_term_months: 12,
		price_cents: 8_640,
		currency: "usd",
		cancel_at_period_end: false,
	},
};

const performanceDeployment = {
	...paidBasicDeployment,
	id: "hdep_performance",
	name: "Performance agent",
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

const walletBasicDeployment = {
	...paidBasicDeployment,
	id: "hdep_wallet",
	name: "Wallet Basic",
	compute_subscription: {
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
	...walletBasicDeployment,
	id: "hdep_wallet_due",
	name: "Wallet grace agent",
	compute_subscription: {
		...walletBasicDeployment.compute_subscription,
		subscription_id: 42,
		status: "past_due",
		payment_state: "past_due",
		next_collection_attempt_at: "2026-07-16T00:00:00Z",
		dunning_deadline_at: "2026-07-18T00:00:00Z",
		last_collection_failure_code: "insufficient_balance",
		recovery_action: "top_up",
	},
};

const walletUnpaidDeployment = {
	...walletBasicDeployment,
	id: "hdep_wallet_unpaid",
	name: "Wallet unpaid agent",
	compute_subscription: {
		...walletBasicDeployment.compute_subscription,
		subscription_id: 44,
		status: "unpaid",
		payment_state: "unpaid",
		pending_plan_slug: "compute_performance",
		last_collection_failure_code: "insufficient_balance",
		recovery_action: "top_up",
	},
};

const walletPlanDeployment = {
	...walletBasicDeployment,
	id: "hdep_wallet_plan",
	name: "Wallet plan agent",
	compute_subscription: {
		...walletBasicDeployment.compute_subscription,
		subscription_id: 73,
	},
};

const walletPendingDowngradeDeployment = {
	...performanceDeployment,
	id: "hdep_wallet_pending",
	name: "Wallet pending downgrade",
	compute_subscription: {
		...walletBasicDeployment.compute_subscription,
		subscription_id: 74,
		price_cents: 1_900,
		pending_plan_slug: "compute_basic",
	},
};

const walletFallbackDeployment = {
	...includedBasicDeployment,
	id: "hdep_wallet_fallback",
	name: "Wallet fallback agent",
	upgrade_available: true,
	last_funding_event: {
		type: "compute_subscription_fallback",
		funding_source: "wallet",
		reason: "payment_failure",
		occurred_at: "2026-07-18T00:00:00Z",
		prior_plan_slug: "compute_performance",
		subscription_id: 42,
	},
};

const stripeFallbackDeployment = {
	...includedBasicDeployment,
	id: "hdep_stripe_fallback",
	name: "Stripe fallback agent",
	upgrade_available: true,
	last_funding_event: {
		type: "compute_subscription_fallback",
		funding_source: "stripe",
		reason: "payment_failure",
		occurred_at: "2026-07-14T00:00:00Z",
		prior_plan_slug: "compute_performance",
		subscription_id: 84,
	},
};

type StubResponse = { body: unknown; status: number };

type HostedApiStubOptions = {
	billingHistoryRequests?: string[];
	billingHistoryResponses?: unknown[];
	cancelRequests?: string[];
	checkoutRequests?: string[];
	cloudAgentOverrides?: Record<string, unknown>;
	cloudAgentNotFoundIds?: readonly string[];
	createRequests?: string[];
	deleteRequests?: string[];
	deployRequestStatusRequests?: string[];
	deployRequestStatusResponses?: StubResponse[];
	deployments?: readonly unknown[];
	fixPaymentRequests?: string[];
	ledgerResponseForRequest?: (limit: number) => unknown;
	ledgerRequests?: string[];
	ledgerResponses?: unknown[];
	plans?: readonly unknown[];
	retryRequests?: string[];
	restartRequests?: string[];
	walletRetryResponses?: StubResponse[];
	startError?: { status: number; detail: string };
	startRequests?: string[];
	topUpIdempotencyKeys?: string[];
	topUpRequests?: string[];
	topUpResponses?: StubResponse[];
	walletActivateRequests?: string[];
	walletActivateResponses?: StubResponse[];
	walletQuoteRequests?: string[];
	walletQuoteResponses?: unknown[];
	walletPlanChangeRequests?: string[];
	walletPlanChangeResponses?: StubResponse[];
	walletPlanCancelRequests?: string[];
	walletPlanCancelResponses?: StubResponse[];
	walletPlanQuoteRequests?: string[];
	walletPlanQuoteResponses?: StubResponse[];
	onWalletActivateSuccess?: () => void;
	onWalletPlanChangeSuccess?: () => void;
	onWalletPlanCancelSuccess?: () => void;
	onWalletPlanCancelResponse?: (status: number) => void;
	onWalletRetrySuccess?: () => void;
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubHostedApi(page: Page, options: HostedApiStubOptions = {}) {
	const deployments = options.deployments ?? [];
	const plans = options.plans ?? [];
	// Deploy API (/me, /v2/*).
	await page.route(`${DEPLOY_API}/**`, (r) => {
		const p = new URL(r.request().url()).pathname;
		if (p === "/me" || p === "/v1/me") return fulfillJson(r, me);
		if (p === "/v2/subscription/plans") return fulfillJson(r, plans);
		if (p === "/v2/wallet" && r.request().method() === "GET") {
			return fulfillJson(r, walletState);
		}
		if (p === "/v2/wallet/ledger" && r.request().method() === "GET") {
			options.ledgerRequests?.push(r.request().url());
			const limit = Number(new URL(r.request().url()).searchParams.get("limit"));
			return fulfillJson(
				r,
				options.ledgerResponseForRequest?.(limit) ??
					options.ledgerResponses?.shift() ?? { items: [], has_more: false },
			);
		}
		if (p === "/v2/deployments" && r.request().method() === "GET") {
			return fulfillJson(r, deployments);
		}
		if (p.startsWith("/v2/deployments/by-request/") && r.request().method() === "GET") {
			const deployRequestId = decodeURIComponent(p.slice("/v2/deployments/by-request/".length));
			options.deployRequestStatusRequests?.push(deployRequestId);
			const response = options.deployRequestStatusResponses?.shift() ?? {
				status: 200,
				body: {
					deploy_request_id: deployRequestId,
					request_status: "succeeded",
					deployment_id: "hdep_wallet",
					deployment_status: "provisioning",
				},
			};
			return fulfillJson(r, response.body, response.status);
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
			options.checkoutRequests?.push(r.request().postData() ?? "");
			return fulfillJson(r, {
				flow_type: "checkout_session",
				action_url: null,
				checkout_url: "http://127.0.0.1:3100/deploy?mockCheckout=browser",
				client_secret: null,
			});
		}
		if (p === "/v2/subscription/wallet/quote" && r.request().method() === "POST") {
			options.walletQuoteRequests?.push(r.request().postData() ?? "");
			return fulfillJson(
				r,
				options.walletQuoteResponses?.shift() ?? {
					plan_slug: "compute_basic",
					billing_term_months: 1,
					monthly_price_cents: 900,
					monthly_price_credits: "9000",
					points_per_usd: 1000,
					first_charge_cents: 900,
					first_charge_credits: "9000",
					period_start: "2026-07-15T00:00:00Z",
					period_end: "2026-08-15T00:00:00Z",
					balance_credits: "25000",
					post_charge_balance_estimate_credits: "16000",
					warnings: [],
				},
			);
		}
		if (p === "/v2/subscription/wallet/activate" && r.request().method() === "POST") {
			options.walletActivateRequests?.push(r.request().postData() ?? "");
			const response = options.walletActivateResponses?.shift() ?? {
				status: 200,
				body: {
					subscription_id: 42,
					status: "active",
					funding_source: "wallet",
					deploy_request_id: "wallet-deploy-browser",
					deployment_id: "hdep_wallet",
					charge_ledger_id: "ledger_wallet_browser",
					charged_credits: "9000",
					post_charge_balance_credits: "16000",
					current_period_start: "2026-07-15T00:00:00Z",
					current_period_end: "2026-08-15T00:00:00Z",
					entitled_until: "2026-08-15T00:00:00Z",
				},
			};
			if (response.status < 400) options.onWalletActivateSuccess?.();
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v2/subscription/wallet/retry" && r.request().method() === "POST") {
			options.retryRequests?.push(r.request().postData() ?? "");
			const response = options.walletRetryResponses?.shift() ?? {
				status: 200,
				body: {
					subscription_id: 42,
					status: "active",
					current_period_end: "2026-08-15T00:00:00Z",
				},
			};
			if (response.status < 400) options.onWalletRetrySuccess?.();
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v2/subscription/wallet/plan/quote" && r.request().method() === "POST") {
			options.walletPlanQuoteRequests?.push(r.request().postData() ?? "");
			const response = options.walletPlanQuoteResponses?.shift() ?? {
				status: 200,
				body: {
					subscription_id: 73,
					current_plan_slug: "compute_basic",
					target_plan_slug: "compute_performance",
					status: "quoted",
					effective_at: "2026-08-15T00:00:00Z",
					amount_cents: 1900,
					amount_credits: "19000",
					points_per_usd: 1000,
					pending_plan_slug: null,
				},
			};
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v2/subscription/wallet/plan/change" && r.request().method() === "POST") {
			options.walletPlanChangeRequests?.push(r.request().postData() ?? "");
			const response = options.walletPlanChangeResponses?.shift() ?? {
				status: 200,
				body: {
					subscription_id: 73,
					current_plan_slug: "compute_basic",
					target_plan_slug: "compute_performance",
					status: "scheduled",
					effective_at: "2026-08-15T00:00:00Z",
					amount_cents: 1900,
					amount_credits: "19000",
					points_per_usd: 1000,
					pending_plan_slug: "compute_performance",
				},
			};
			if (response.status < 400) options.onWalletPlanChangeSuccess?.();
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v2/subscription/wallet/plan/cancel-pending" && r.request().method() === "POST") {
			options.walletPlanCancelRequests?.push(r.request().postData() ?? "");
			const response = options.walletPlanCancelResponses?.shift() ?? {
				status: 200,
				body: {
					subscription_id: 74,
					current_plan_slug: "compute_performance",
					canceled_plan_slug: "compute_basic",
					pending_plan_slug: null,
				},
			};
			if (response.status < 400) options.onWalletPlanCancelSuccess?.();
			options.onWalletPlanCancelResponse?.(response.status);
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
			return fulfillJson(r, response.body, response.status);
		}
		if (p === "/v2/subscription/fix-payment" && r.request().method() === "POST") {
			options.fixPaymentRequests?.push(r.request().postData() ?? "");
			return fulfillJson(r, { message: "Payment recovery started." });
		}
		if (p === "/v2/subscription/billing-history" && r.request().method() === "GET") {
			options.billingHistoryRequests?.push(r.request().url());
			return fulfillJson(
				r,
				options.billingHistoryResponses?.shift() ?? {
					data: [],
					has_more: false,
					next_cursor: null,
				},
			);
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
		if (p.endsWith("/restart") && r.request().method() === "POST") {
			options.restartRequests?.push(p);
			return fulfillJson(r, { status: "starting" });
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
		if (p === "/v1/me") return fulfillJson(r, me);
		if (p === "/v1/agents") return fulfillJson(r, []);
		if (p.startsWith("/v1/agents/") && r.request().method() === "GET") {
			const id = decodeURIComponent(p.slice("/v1/agents/".length));
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
	await expect(main.getByText("Jul 15, 2026", { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Retry startup", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Runtime UI", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Sessions", exact: true })).toHaveCount(0);

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

test("failed deployment with a retained projection renders recovery without live agent sections", async ({
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
	await expect(main.getByText("Jul 15, 2026", { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Retry startup", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Runtime UI", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Sessions", exact: true })).toHaveCount(0);

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

test("paid-funded Basic leaves the included slot available for direct compute_basic deploy", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const createRequests: string[] = [];
	await page.setViewportSize({ width: 1_440, height: 1_100 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await stubHostedApi(page, {
		createRequests,
		deployments: [paidBasicDeployment],
		plans: [{ ...basicPlan, offers: [] }, performancePlan],
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await expect(page.getByText("First slot free", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/First active agent free · paid additional agents unavailable/),
	).toBeVisible();
	await expectNoQuarterlyCopy(page);
	await capturePricingScreenshot(page, "/tmp/basic-paid-funded-slot-available-final.png");

	await page.getByRole("button", { name: "Deploy agent" }).click();
	await expect.poll(() => createRequests.length).toBe(1);
	expect(JSON.parse(createRequests[0] ?? "{}")).toMatchObject({
		compute_plan_slug: "compute_basic",
	});
	expect(errors, `direct Basic deploy: ${errors.join(" | ")}`).toEqual([]);
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

	await expect(page.getByText("$9/mo additional", { exact: true })).toBeVisible();
	await expect(page.getByText("Monthly", { exact: true })).toBeVisible();
	const annualTerm = page.getByRole("button", { name: /Annual.*%/ });
	await expect(annualTerm).toBeVisible();
	await expectNoQuarterlyCopy(page);
	await annualTerm.click();
	await expect(page.getByText("Wallet balance", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /Wallet balance/ })).toHaveCount(0);
	await expect(page.getByText(/Wallet-funded compute renews monthly/)).toBeVisible();
	await expect(
		page.getByText(
			/First active agent free · then \$7.2\/mo, billed \$86.4\/yr per additional agent/,
		),
	).toBeVisible();
	await expect(
		page.getByText(/additional Basic agent at \$7.2\/mo, billed \$86.4\/yr/),
	).toBeVisible();
	await capturePricingScreenshot(page, "/tmp/basic-free-funded-slot-occupied-final.png");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
		plan_slug: "compute_basic",
		billing_term_months: 12,
		deploy_config: { compute_plan_slug: "compute_basic" },
	});
	expect(errors, `paid Basic checkout: ${errors.join(" | ")}`).toEqual([]);
});

test("included Basic starts annual Performance checkout without direct tier switching", async ({
	page,
}) => {
	const checkoutRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic");
	const errors = collectBrowserErrors(page);

	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Change billing term" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);

	await page.getByRole("button", { name: /Annual/ }).click();
	await page.getByRole("button", { name: "Upgrade to Performance" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
		plan_slug: "compute_performance",
		billing_term_months: 12,
		upgrade_deployment_id: "hdep_included",
	});
	expect(errors, `included Basic upgrade: ${errors.join(" | ")}`).toEqual([]);
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

		await expect(page.getByRole("button", { name: "Change billing term" })).toBeVisible();
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

	await expect(page.getByRole("button", { name: "Change billing term" })).toBeVisible();
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
	const createRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		createRequests,
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/deploy?checkout=cancel");

	await expect(page.getByText("Checkout canceled", { exact: true })).toBeVisible();
	await expect(page.getByText("You were not charged. Your agent was not deployed.")).toBeVisible();
	await expect(page.getByText("$9/mo additional", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Continue to checkout" })).toBeVisible();
	await expect(page.getByText("First slot free", { exact: true })).toHaveCount(0);
	expect(checkoutRequests).toEqual([]);
	expect(createRequests).toEqual([]);
	expect(errors, `checkout abandonment: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet-funded Basic quotes, debits Wallet, and deploys without checkout", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [includedBasicDeployment];
	const checkoutRequests: string[] = [];
	const deployRequestStatusRequests: string[] = [];
	const walletQuoteRequests: string[] = [];
	const walletActivateRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployRequestStatusRequests,
		deployments,
		plans: [basicPlan, performancePlan],
		walletActivateRequests,
		walletQuoteRequests,
		onWalletActivateSuccess: () => deployments.push(walletBasicDeployment),
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await page.getByRole("button", { name: /Wallet balance/ }).click();
	await expect(page.getByText(/Wallet funds this additional Basic agent/)).toBeVisible();
	await expect(page.getByText(/Checkout opens here for an additional Basic agent/)).toHaveCount(0);
	await expect(page.getByText("Due now", { exact: true })).toBeVisible();
	await expect(page.getByText("Current balance", { exact: true })).toBeVisible();
	await expect(page.getByText("After this charge", { exact: true })).toBeVisible();
	await expect(page.getByText("Renews", { exact: true })).toBeVisible();
	const walletCta = page.getByRole("button", { name: "Pay $9.00 from wallet & deploy" });
	await expect(walletCta).toBeVisible();
	await page.screenshot({ path: "/tmp/wallet-deploy-quote.png", fullPage: true });

	await walletCta.click();
	await expect.poll(() => walletActivateRequests.length).toBe(1);
	const activation = JSON.parse(walletActivateRequests[0] ?? "{}");
	expect(activation).toMatchObject({
		plan_slug: "compute_basic",
		billing_term_months: 1,
		deploy_config: { compute_plan_slug: "compute_basic" },
	});
	expect(activation.deploy_config.deploy_request_id).toMatch(/^wallet-compute-deploy-/);
	expect(walletQuoteRequests).toHaveLength(1);
	expect(checkoutRequests).toEqual([]);
	expect(deployRequestStatusRequests).toEqual([]);
	await expect(page).toHaveURL(/\/agents\/hdep_wallet(?:\?|\/)/);
	expect(errors, `wallet deploy happy path: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet deploy rotates its request key after an explicit reuse conflict", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [includedBasicDeployment];
	const walletActivateRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		walletActivateRequests,
		walletActivateResponses: [
			{
				status: 409,
				body: {
					detail: {
						code: "idempotency_key_reused",
						message: "The deploy request key belongs to another payload.",
					},
				},
			},
		],
		onWalletActivateSuccess: () => deployments.push(walletBasicDeployment),
	});
	await page.goto("/deploy");
	await page.getByRole("button", { name: /Wallet balance/ }).click();
	const submit = page.getByRole("button", { name: "Pay $9.00 from wallet & deploy" });

	await submit.click();
	await expect.poll(() => walletActivateRequests.length).toBe(1);
	const freshAttemptToast = page.getByText("Start a fresh wallet attempt", { exact: true });
	await expect(freshAttemptToast).toBeVisible();
	await page.mouse.move(0, 0);
	await expect(freshAttemptToast).toHaveCount(0);
	await submit.click();
	await expect.poll(() => walletActivateRequests.length).toBe(2);

	const requestKeys = walletActivateRequests.map((body) => {
		const request = JSON.parse(body);
		return request.deploy_config.deploy_request_id as string;
	});
	expect(requestKeys[0]).toMatch(/^wallet-compute-deploy-/);
	expect(requestKeys[1]).toMatch(/^wallet-compute-deploy-/);
	expect(requestKeys[1]).not.toBe(requestKeys[0]);
	await expect(page).toHaveURL(/\/agents\/hdep_wallet(?:\?|\/)/);
	expect(
		errors.filter((error) => !error.includes("status of 409")),
		`wallet deploy key rotation: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("wallet deploy resolves an asynchronous autodeploy by stable request ID", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [includedBasicDeployment];
	const deployRequestStatusRequests: string[] = [];
	const walletActivateRequests: string[] = [];
	const asyncDeployment = {
		...walletBasicDeployment,
		id: "hdep_wallet_async",
		name: "Async Wallet Basic",
		deploy_request_id: "wallet-async-request",
	};
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		walletActivateRequests,
		walletActivateResponses: [
			{
				status: 200,
				body: {
					subscription_id: 43,
					status: "active",
					funding_source: "wallet",
					deploy_request_id: "wallet-async-request",
					deployment_id: null,
					charge_ledger_id: "ledger_wallet_async",
					charged_credits: "9000",
					post_charge_balance_credits: "16000",
					current_period_start: "2026-07-15T00:00:00Z",
					current_period_end: "2026-08-15T00:00:00Z",
					entitled_until: "2026-08-15T00:00:00Z",
				},
			},
		],
		deployRequestStatusRequests,
		deployRequestStatusResponses: [
			{
				status: 200,
				body: {
					deploy_request_id: "wallet-async-request",
					request_status: "succeeded",
					deployment_id: "hdep_wallet_async",
					deployment_status: "provisioning",
				},
			},
		],
		onWalletActivateSuccess: () => deployments.push(asyncDeployment),
	});
	await page.goto("/deploy");
	await page.getByRole("button", { name: /Wallet balance/ }).click();
	await page.getByRole("button", { name: "Pay $9.00 from wallet & deploy" }).click();

	await expect(page).toHaveURL(/\/agents\/hdep_wallet_async(?:\?|\/)/);
	expect(deployRequestStatusRequests).toEqual(["wallet-async-request"]);
	expect(walletActivateRequests).toHaveLength(1);
	expect(errors, `wallet deploy request resolution: ${errors.join(" | ")}`).toEqual([]);
});

test("insufficient wallet deploy keeps the wizard, opens top-up, and re-quotes", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const topUpRequests: string[] = [];
	const walletQuoteRequests: string[] = [];
	const walletActivateRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
		topUpRequests,
		walletActivateRequests,
		walletActivateResponses: [
			{
				status: 402,
				body: {
					detail: {
						code: "insufficient_wallet_balance",
						required_credits: "9000",
						available_credits: "5000",
						shortfall_credits: "4000",
					},
				},
			},
		],
		walletQuoteRequests,
		walletQuoteResponses: [
			{
				plan_slug: "compute_basic",
				billing_term_months: 1,
				monthly_price_cents: 900,
				monthly_price_credits: "9000",
				points_per_usd: 1000,
				first_charge_cents: 900,
				first_charge_credits: "9000",
				period_start: "2026-07-15T00:00:00Z",
				period_end: "2026-08-15T00:00:00Z",
				balance_credits: "5000",
				post_charge_balance_estimate_credits: "-4000",
				warnings: ["low_coverage"],
			},
			{
				plan_slug: "compute_basic",
				billing_term_months: 1,
				monthly_price_cents: 900,
				monthly_price_credits: "9000",
				points_per_usd: 1000,
				first_charge_cents: 900,
				first_charge_credits: "9000",
				period_start: "2026-07-15T00:00:00Z",
				period_end: "2026-08-15T00:00:00Z",
				balance_credits: "30000",
				post_charge_balance_estimate_credits: "21000",
				warnings: [],
			},
		],
	});
	await page.goto("/deploy");
	await page.getByRole("button", { name: /Wallet balance/ }).click();
	await page.getByRole("button", { name: "Pay $9.00 from wallet & deploy" }).click();

	await expect(
		page.getByRole("dialog").getByText("Top up AI Credits", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("Shortfall: $4.00.", { exact: false })).toBeVisible();
	await page.screenshot({ path: "/tmp/wallet-deploy-insufficient.png", fullPage: true });
	await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
	await expect.poll(() => topUpRequests.length).toBe(1);
	await expect.poll(() => walletQuoteRequests.length).toBe(2);
	await expect(page.getByText("$30.00", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Pay $9.00 from wallet & deploy" })).toBeVisible();
	const activation = JSON.parse(walletActivateRequests[0] ?? "{}");
	expect(activation.deploy_config.deploy_request_id).toMatch(/^wallet-compute-deploy-/);
	expect(
		errors.filter((error) => !error.includes("status of 402")),
		`wallet deploy insufficient: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("wallet deploy refund debt prefills debt plus the blocked compute charge", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
		walletActivateResponses: [
			{
				status: 409,
				body: {
					detail: {
						code: "open_refund_debt",
						outstanding_debt_credits: "2500.5",
					},
				},
			},
		],
	});
	await page.goto("/deploy");
	await page.getByRole("button", { name: /Wallet balance/ }).click();
	await page.getByRole("button", { name: "Pay $9.00 from wallet & deploy" }).click();

	const topUpDialog = page.getByRole("dialog");
	await expect(topUpDialog.getByText("Top up AI Credits", { exact: true })).toBeVisible();
	await expect(topUpDialog.getByText("Refund debt is repaid first", { exact: true })).toBeVisible();
	await expect(topUpDialog).toContainText(
		"The remaining funds cover the 9,000 credits blocked compute charge.",
	);
	await expect(page.getByLabel("Amount (USD)")).toHaveValue("12");
	expect(
		errors.filter((error) => !error.includes("status of 409")),
		`wallet deploy refund debt: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("wallet dunning shows grace recovery without Stripe portal actions", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [walletPastDueDeployment];
	const retryRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		retryRequests,
		onWalletRetrySuccess: () =>
			deployments.splice(0, 1, {
				...walletBasicDeployment,
				id: "hdep_wallet_due",
				name: "Wallet grace agent",
			}),
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_due", "Basic");

	await expect(page.getByText("Wallet payment failed", { exact: true })).toBeVisible();
	await expect(page.getByRole("alert").filter({ hasText: "Wallet payment failed" })).toContainText(
		"payment. The wallet balance was too low.",
	);
	await expect(page.getByText(/Grace deadline:/)).toBeVisible();
	await expect(page.getByRole("button", { name: "Top up" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry payment" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Fix payment" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Change billing term" })).toHaveCount(0);
	await page.screenshot({ path: "/tmp/wallet-dunning-banner.png", fullPage: true });
	await page.getByRole("button", { name: "Retry payment" }).click();
	await expect.poll(() => retryRequests.length).toBe(1);
	expect(JSON.parse(retryRequests[0] ?? "{}")).toEqual({ subscription_id: 42 });
	await expect(page.getByText("Wallet payment recovered", { exact: true })).toBeVisible();
	await expect(page.getByText("Wallet payment failed", { exact: true })).toHaveCount(0);
	expect(errors, `wallet dunning: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet retry opens top-up for balance shortfalls and refund debt", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const retryRequests: string[] = [];
	const topUpRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [walletPastDueDeployment],
		plans: [basicPlan, performancePlan],
		retryRequests,
		topUpRequests,
		walletRetryResponses: [
			{
				status: 402,
				body: {
					detail: {
						code: "insufficient_balance",
						required_credits: "19000",
						available_credits: "5000",
						shortfall_credits: "14000",
					},
				},
			},
			{
				status: 409,
				body: {
					detail: {
						code: "open_refund_debt",
						outstanding_debt_credits: "2500.5",
					},
				},
			},
		],
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_due", "Basic");

	await page.getByRole("button", { name: "Retry payment" }).click();
	await expect(
		page.getByRole("dialog").getByText("Top up AI Credits", { exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("Amount (USD)")).toHaveValue("14");
	await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
	await expect.poll(() => topUpRequests.length).toBe(1);
	expect(JSON.parse(topUpRequests[0] ?? "{}")).toEqual({ amount_cents: 1400 });
	await expect(
		page.getByRole("dialog").getByText("Top up AI Credits", { exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Retry payment" }).click();
	await expect(
		page.getByRole("dialog").getByText("Refund debt is repaid first", { exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("Amount (USD)")).toHaveValue("12");
	await expect(page.getByText("Top up to clear refund debt", { exact: true })).toBeVisible();
	expect(retryRequests).toHaveLength(2);
	expect(
		errors.filter((error) => !error.includes("status of 402") && !error.includes("status of 409")),
		`wallet retry errors: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("wallet unpaid subscription reactivates the plan due after terminal dunning", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [walletUnpaidDeployment];
	const walletActivateRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		walletActivateRequests,
		onWalletActivateSuccess: () =>
			deployments.splice(0, 1, {
				...performanceDeployment,
				id: "hdep_wallet_unpaid",
				name: "Wallet unpaid agent",
				compute_subscription: {
					...walletBasicDeployment.compute_subscription,
					subscription_id: 45,
					price_cents: 1_900,
				},
			}),
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_unpaid", "Basic");

	const alert = page.getByRole("alert").filter({ hasText: "Wallet compute funding ended" });
	await expect(alert).toContainText("Reactivate Performance compute to start a new subscription.");
	await expect(page.getByRole("button", { name: "Reactivate Performance" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry payment" })).toHaveCount(0);
	await page.getByRole("button", { name: "Reactivate Performance" }).click();
	await expect.poll(() => walletActivateRequests.length).toBe(1);
	expect(JSON.parse(walletActivateRequests[0] ?? "{}")).toEqual({
		plan_slug: "compute_performance",
		billing_term_months: 1,
		upgrade_deployment_id: "hdep_wallet_unpaid",
	});
	await expect(page.getByText("Wallet compute funding ended", { exact: true })).toHaveCount(0);
	expect(errors, `wallet unpaid recovery: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet fallback explains the failed Performance payment and offers re-activation", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [walletFallbackDeployment];
	const walletActivateRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		walletActivateRequests,
		onWalletActivateSuccess: () =>
			deployments.splice(0, 1, {
				...performanceDeployment,
				id: "hdep_wallet_fallback",
				name: "Wallet fallback agent",
				last_funding_event: walletFallbackDeployment.last_funding_event,
				compute_subscription: {
					...walletBasicDeployment.compute_subscription,
					subscription_id: 42,
					price_cents: 1_900,
				},
			}),
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_fallback", "Basic");

	const alert = page.getByRole("alert").filter({ hasText: "Wallet compute funding ended" });
	await expect(alert).toContainText(
		"This agent fell back from Performance compute because payment failed on Jul 18, 2026.",
	);
	await expect(alert).toContainText("This agent is now using included Basic.");
	await expect(page.getByRole("button", { name: "Reactivate Performance" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry payment" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toHaveCount(0);
	await expect(page.getByText("Wallet fallback", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Reactivate Performance" }).click();
	await expect.poll(() => walletActivateRequests.length).toBe(1);
	expect(JSON.parse(walletActivateRequests[0] ?? "{}")).toEqual({
		plan_slug: "compute_performance",
		billing_term_months: 1,
		upgrade_deployment_id: "hdep_wallet_fallback",
	});
	await expect(page.getByText("Wallet compute funding ended", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Performance compute", { exact: true })).toBeVisible();
	expect(errors, `wallet fallback: ${errors.join(" | ")}`).toEqual([]);
});

test("detached Stripe recovery omits the deployment id from fix-payment", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const fixPaymentRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [stripeFallbackDeployment],
		fixPaymentRequests,
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_stripe_fallback", "Basic");

	await expect(page.getByText("Compute funding ended", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Fix payment" }).click();
	await expect.poll(() => fixPaymentRequests.length).toBe(1);
	expect(JSON.parse(fixPaymentRequests[0] ?? "null")).toEqual({});
	expect(errors, `detached Stripe recovery: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet-funded plan upgrade renders and submits a scheduled renewal change", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const walletPlanQuoteRequests: string[] = [];
	const walletPlanChangeRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [walletPlanDeployment],
		plans: [basicPlan, performancePlan],
		walletPlanChangeRequests,
		walletPlanQuoteRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_plan", "Basic");

	await expect(page.getByText("Wallet", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Change billing term" })).toHaveCount(0);
	await page.getByRole("button", { name: "Schedule Performance upgrade" }).click();
	await expect.poll(() => walletPlanQuoteRequests.length).toBe(1);
	await expect(
		page.getByText("Changes at next renewal on Aug 15, 2026 · then $19.00/mo.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(page.getByText("Due now", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Schedule plan change" }).click();
	await expect.poll(() => walletPlanChangeRequests.length).toBe(1);
	expect(JSON.parse(walletPlanQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 73,
		target_plan_slug: "compute_performance",
	});
	expect(JSON.parse(walletPlanChangeRequests[0] ?? "{}")).toEqual({
		subscription_id: 73,
		target_plan_slug: "compute_performance",
	});
	await expect(page.getByText("Plan change scheduled", { exact: true })).toBeVisible();
	expect(errors, `wallet plan upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet plan quote refund debt opens an actionable prefilled top-up", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const walletPlanQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [walletPlanDeployment],
		plans: [basicPlan, performancePlan],
		walletPlanQuoteRequests,
		walletPlanQuoteResponses: [
			{
				status: 409,
				body: {
					detail: {
						code: "open_refund_debt",
						outstanding_debt_credits: "2500.5",
					},
				},
			},
		],
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_plan", "Basic");

	await page.getByRole("button", { name: "Schedule Performance upgrade" }).click();
	await expect(
		page.getByRole("dialog").getByText("Top up AI Credits", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("Refund debt is repaid first", { exact: true })).toBeVisible();
	await expect(page.getByLabel("Amount (USD)")).toHaveValue("10");
	expect(walletPlanQuoteRequests).toHaveLength(1);
	expect(
		errors.filter((error) => !error.includes("status of 409")),
		`wallet plan errors: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("wallet-funded pending downgrade can be canceled and refreshes the deployment", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [walletPendingDowngradeDeployment];
	const walletPlanCancelRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		walletPlanCancelRequests,
		onWalletPlanCancelSuccess: () =>
			deployments.splice(0, 1, {
				...walletPendingDowngradeDeployment,
				compute_subscription: {
					...walletPendingDowngradeDeployment.compute_subscription,
					pending_plan_slug: null,
				},
			}),
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_pending", "Performance");

	await expect(page.getByText(/Basic scheduled for/)).toBeVisible();
	await expect(page.getByRole("button", { name: "Schedule Basic downgrade" })).toBeDisabled();
	await page.getByRole("button", { name: "Cancel scheduled plan change" }).click();
	await expect(page.getByText("Cancel scheduled plan change?", { exact: true })).toBeVisible();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Cancel scheduled plan change" })
		.click();
	await expect.poll(() => walletPlanCancelRequests.length).toBe(1);
	expect(JSON.parse(walletPlanCancelRequests[0] ?? "{}")).toEqual({ subscription_id: 74 });
	await expect(page.getByText(/Basic scheduled for/)).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Schedule Basic downgrade" })).toBeEnabled();
	await expect(page.getByText("Scheduled plan change canceled", { exact: true })).toBeVisible();
	expect(errors, `wallet pending downgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet pending downgrade cancel reconciles an already-cleared conflict", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [walletPendingDowngradeDeployment];
	const walletPlanCancelRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		walletPlanCancelRequests,
		walletPlanCancelResponses: [
			{ status: 409, body: { detail: "Wallet compute subscription has no pending plan change." } },
		],
		onWalletPlanCancelResponse: () =>
			deployments.splice(0, 1, {
				...walletPendingDowngradeDeployment,
				compute_subscription: {
					...walletPendingDowngradeDeployment.compute_subscription,
					pending_plan_slug: null,
				},
			}),
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_pending", "Performance");

	await page.getByRole("button", { name: "Cancel scheduled plan change" }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Cancel scheduled plan change" })
		.click();
	await expect(page.getByText("Scheduled change already cleared", { exact: true })).toBeVisible();
	expect(walletPlanCancelRequests).toHaveLength(1);
	await expect(page.getByText(/Basic scheduled for/)).toHaveCount(0);
	expect(
		errors.filter((error) => !error.includes("status of 409")),
		`wallet pending conflict: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("mixed billing history paginates wallet charges and Stripe invoices", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const billingHistoryRequests: string[] = [];
	await stubHostedApi(page, {
		billingHistoryRequests,
		billingHistoryResponses: [
			{
				data: [
					{
						id: "wallet:1",
						funding_source: "wallet",
						compute_subscription_id: 42,
						plan_slug: "compute_basic",
						status: "applied",
						amount_cents: 900,
						currency: "usd",
						period_start: "2026-07-15T00:00:00Z",
						period_end: "2026-08-15T00:00:00Z",
						created: "2026-07-15T00:00:00Z",
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
						hosted_invoice_url: "https://invoice.stripe.test/in_1",
					},
				],
				has_more: true,
				next_cursor: "cursor_2",
			},
			{
				data: [
					{
						id: "wallet:2",
						funding_source: "wallet",
						compute_subscription_id: 42,
						plan_slug: "compute_basic",
						status: "refunded",
						amount_cents: 900,
						currency: "usd",
						created: "2026-06-15T00:00:00Z",
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
	await expect(billingTable.getByText("Applied", { exact: true })).toBeVisible();
	await expect(billingTable.locator('a[href="https://invoice.stripe.test/in_1"]')).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Load more" }).click();
	await expect.poll(() => billingHistoryRequests.length).toBe(2);
	expect(new URL(billingHistoryRequests[1] ?? "http://invalid").searchParams.get("cursor")).toBe(
		"cursor_2",
	);
	await expect(billingTable.getByText("Refunded", { exact: true })).toBeVisible();
	await settingsDialog.screenshot({ path: "/tmp/mixed-billing-history.png" });
	expect(errors, `mixed billing history: ${errors.join(" | ")}`).toEqual([]);
});

test("Wallet activity caps show-more requests at the ledger API limit", async ({ page }) => {
	const ledgerRequests: string[] = [];
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
		ledgerResponseForRequest: (limit) =>
			limit === 50
				? { items: [computeCharge], has_more: true }
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
					},
		plans: [basicPlan, performancePlan],
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	const errors = collectBrowserErrors(page);
	const ledgerTable = settingsDialog.getByRole("table");

	await expect(ledgerTable.getByText("Compute charge", { exact: true })).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Show more" }).click();
	await expect.poll(() => ledgerRequests.length).toBe(2);
	await expect(ledgerTable.getByText("Compute reversal", { exact: true })).toBeVisible();
	await expect(settingsDialog.getByRole("button", { name: "Show more" })).toHaveCount(0);
	await expect(settingsDialog).toContainText(
		"Showing your most recent activity. Older entries are archived.",
	);

	const limits = ledgerRequests.map((url) => Number(new URL(url).searchParams.get("limit")));
	expect([...new Set(limits)]).toEqual([50, 100]);
	expect(limits.every((limit) => limit <= 100)).toBe(true);
	expect(errors, `wallet ledger cap: ${errors.join(" | ")}`).toEqual([]);
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

test("Wallet summarizes compute commitment, coverage, renewal, and deployment link", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page, {
		deployments: [walletBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/channels?settings=billing-wallet");
	const settingsDialog = page.getByTestId("settings-dialog");
	await expect(settingsDialog.getByText("Compute coverage", { exact: true })).toBeVisible();
	await expect(settingsDialog.getByText("Monthly commitment", { exact: true })).toBeVisible();
	await expect(settingsDialog.getByText("$9.00", { exact: true })).toBeVisible();
	await expect(settingsDialog.getByText("Wallet Basic", { exact: true })).toBeVisible();
	await expect(settingsDialog.getByText(/\$9 on Aug 15, 2026/)).toBeVisible();
	const manage = settingsDialog.locator('a[href^="/agents/hdep_wallet/settings"]');
	await expect(manage).toBeVisible();
	await settingsDialog.screenshot({ path: "/tmp/wallet-compute-coverage.png" });
	expect(errors, `wallet compute coverage: ${errors.join(" | ")}`).toEqual([]);
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
