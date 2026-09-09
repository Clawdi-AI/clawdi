import type { DeployComponents, DeploymentRead } from "@clawdi/shared/api";
import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	type Route,
	test,
} from "@playwright/test";
import type { ManagedModelCatalogItem, WalletState } from "../src/hosted/billing/contracts";
import type { AiProvider } from "../src/hosted/v2/ai-providers/types";
import {
	type DeploymentMutationFixture,
	fixtureAgentId,
	isDeploymentMutationFixture,
	isRecord,
	mutationDeploymentReadFixture,
	readDeploymentFixture,
} from "./hosted-stub-api";
import { measureNavigation } from "./navigation-measurement";

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
		__mavaLiveChatToggleCalls?: number;
		__stripeCheckoutClientSecrets?: string[];
		__stripeCheckoutLoadCalls?: number;
		__stripeConfirmCalls?: number;
		__stripeWalletAppearanceThemes?: string[];
		__stripeWalletClientSecrets?: string[];
		__stripeWalletConfirmCalls?: number;
		__stripeWalletReturnUrls?: string[];
	}
}

async function expectLiveToolFillsDashboard(page: Page, surface: Locator) {
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

async function expectTerminalFitsHost(terminal: Locator) {
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

async function expectInlineSidebarStatus(sidebar: Locator, source: "hosted" | "connected") {
	const status = sidebar.getByTestId("app-sidebar-agent-status");
	await expect(status).toHaveAttribute("data-agent-status-source", source);
	await expect(status.locator("[aria-hidden]").first()).toBeVisible();
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

function hostedOverviewSessionsPage(itemCount: number, runtime: "hermes" | "openclaw" = "hermes") {
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

// Must match the API hosts configured in playwright.hosted.config.ts.
const CLOUD_API = "http://127.0.0.1:8000";
const DEPLOY_API = process.env.E2E_HOSTED_DEPLOY_API_URL ?? "http://127.0.0.1:8001";

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

const missingProjectionEnvironmentId = "55555555-5555-4555-8555-555555555555";
const missingProjectionFailureReason =
	"startup_probe_failing; restart_count=2; container failed readiness probe after the runtime bridge exhausted every startup attempt";
const failedMissingProjectionDeployment = {
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

const runningMissingProjectionDeployment = {
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

const sharedLegacyEnvironmentId = "77777777-7777-4777-8777-777777777777";
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
	agent_id: railHostedEnvironmentId,
	name: "e2e-2",
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
	name: "e2e-2",
	default_name: "e2e-2",
	machine_name: "hermes-3.local",
	display_name: null,
	sort_order: 0,
};

test("navigation timing preserves the outgoing iframe geometry", async ({
	page,
	context,
}, testInfo) => {
	await stubHostedApi(page, {
		deployments: [
			{
				...mutationDeploymentReadFixture({
					...railHostedDeployment,
					hermes_control_ui_url: "https://runtime.example/",
				}),
				files_endpoint: { url: "https://files.example.test/" },
			},
		],
		cloudAgents: [railHostedCloudAgent],
		plans: [basicPlan, performancePlan],
		agentResourceFixtures: true,
		sessionsPage: hostedOverviewSessionsPage(3),
	});
	let runtimeDocuments = 0;
	await context.route("https://runtime.example/**", (route) => {
		if (route.request().resourceType() === "document") runtimeDocuments += 1;
		return route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><style>body{margin:0;background:#fafafa;color:#222;font:16px system-ui}header{background:#eceef0;padding:20px}main{padding:24px}textarea{width:80%;height:100px}</style><header>Runtime dashboard</header><main><h1>Chat</h1><textarea aria-label="Message">Retained conversation</textarea></main>',
		});
	});
	await context.route("https://files.example.test/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			headers: {
				"access-control-allow-origin": "http://127.0.0.1:3100",
				"access-control-allow-credentials": "true",
				"access-control-allow-headers": "authorization",
			},
			body: "<!doctype html><style>body{background:#fff;color:#222;font:16px system-ui}</style><h1>Workspace files</h1><p>notes.txt</p>",
		}),
	);
	let slow = false;
	let apiDelay = 300;
	await page.route("**/*", async (route) => {
		const request = route.request();
		if (slow && ["script", "fetch", "xhr"].includes(request.resourceType())) {
			await new Promise((resolve) =>
				setTimeout(resolve, request.resourceType() === "script" ? 400 : apiDelay),
			);
		}
		await route.fallback();
	});
	const results = [];
	for (const [section, destination] of [
		["", '[data-overview-section="tools"]'],
		["sessions", '[data-slot="page-header"] h1'],
		["channel-links", '[data-slot="page-header"] h1'],
		["model-provider", '[data-slot="page-header"] h1'],
		["settings", '[data-slot="page-header"] h1'],
	] as const) {
		for (const temperature of ["cold", "warm"] as const) {
			slow = false;
			if (temperature === "cold") await page.goto(`/agents/${railHostedEnvironmentId}/console`);
			else
				await page
					.getByTestId("app-sidebar")
					.getByRole("link", { name: "Hermes Dashboard", exact: true })
					.click();
			await expect(page.locator("main iframe")).toBeVisible();
			await page.evaluate(() => document.fonts.ready);
			slow = true;
			results.push(
				await measureNavigation(page, testInfo, {
					name: `${section || "overview"}-${temperature}`,
					href: `/agents/${railHostedEnvironmentId}${section ? `/${section}` : ""}`,
					destination,
				}),
			);
		}
	}
	for (const [section, title] of [
		["files", "Files"],
		["console", "Hermes Dashboard"],
	] as const) {
		if (section === "files") {
			slow = false;
			await page
				.getByTestId("app-sidebar")
				.getByRole("link", { name: "Hermes Dashboard", exact: true })
				.click();
			await expect(page.locator("main iframe")).toBeVisible();
		}
		slow = true;
		results.push(
			await measureNavigation(page, testInfo, {
				name: `iframe-to-${section}`,
				href: `/agents/${railHostedEnvironmentId}/${section}`,
				destination: `main iframe[title="${title}"]`,
			}),
		);
	}
	const runtimeFrame = page.frameLocator('iframe[title="Hermes Dashboard"]');
	await runtimeFrame.getByRole("textbox", { name: "Message" }).fill("Unsaved runtime draft");
	await runtimeFrame.locator("body").evaluate(() => history.pushState(null, "", "#retained"));
	const documentsBeforeSettings = runtimeDocuments;
	await page.getByRole("button", { name: /^Wallet balance/ }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(runtimeFrame.getByRole("textbox", { name: "Message" })).toHaveValue(
		"Unsaved runtime draft",
	);
	expect(await runtimeFrame.locator("body").evaluate(() => location.hash)).toBe("#retained");
	expect(runtimeDocuments).toBe(documentsBeforeSettings);
	apiDelay = 1500;
	results.push(
		await measureNavigation(page, testInfo, {
			name: "overview-pending",
			href: `/agents/${railHostedEnvironmentId}`,
			destination: '[data-overview-section="tools"]',
		}),
	);
	await testInfo.attach("navigation-summary", {
		body: JSON.stringify(results, null, 2),
		contentType: "application/json",
	});
});

test("agent navigation retains keyboard focus as inventory resolves", async ({ page }) => {
	await stubHostedApi(page, {
		deployments: [mutationDeploymentReadFixture(railHostedDeployment)],
		cloudAgents: [railHostedCloudAgent],
	});
	let release = () => {};
	const inventory = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`${CLOUD_API}/v1/agents`, async (route) => {
		await inventory;
		await route.fallback();
	});
	try {
		await page.goto(`/agents/${railHostedEnvironmentId}`);
		const sidebar = page.getByTestId("app-sidebar");
		const overview = sidebar.getByRole("link", { name: "Overview", exact: true });
		await expect(sidebar.getByRole("group", { name: "Navigation loading" })).toBeVisible();
		await overview.focus();
		release();
		await expect(sidebar.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();
		await expect(overview).toBeFocused();
	} finally {
		release();
	}
});

test("agent layout does not mount the runtime before its provider is loaded", async ({
	page,
	context,
}) => {
	let release = () => {};
	let requested = false;
	let documents = 0;
	const provider = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(/hosted-agent-event-stream-layout/, async (route) => {
		requested = true;
		await provider;
		await route.fallback();
	});
	await stubHostedApi(page, {
		deployments: [{ ...railHostedDeployment, hermes_control_ui_url: "https://runtime.example/" }],
		cloudAgents: [railHostedCloudAgent],
	});
	await context.route("https://runtime.example/**", (route) => {
		if (route.request().isNavigationRequest()) documents += 1;
		return route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><p>Runtime document</p>",
		});
	});
	try {
		await page.goto(`/agents/${railHostedEnvironmentId}/console`, {
			waitUntil: "domcontentloaded",
		});
		await expect.poll(() => requested).toBe(true);
		expect(documents).toBe(0);
		release();
		await expect(
			page.frameLocator('iframe[title="Hermes Dashboard"]').getByText("Runtime document"),
		).toBeVisible();
		expect(documents).toBe(1);
	} finally {
		release();
	}
});

test("dismissed hosted agents never reappear as connected during projection cleanup", async ({
	page,
}) => {
	for (const status of ["deleting", "deleted"]) {
		await page.unrouteAll({ behavior: "wait" });
		await stubHostedApi(page, {
			deployments: [{ ...railHostedDeployment, status }],
			cloudAgents: [railHostedCloudAgent],
		});
		await page.goto(`/agents/${railHostedEnvironmentId}`);
		await expect(page).toHaveURL("/");
		await expect(page.locator("[data-overview-status]")).toHaveCount(0);
	}
});

test("overview loads resources and retains memory data after a failed refetch", async ({
	page,
}) => {
	const paidSubscription = paidBasicDeployment.compute_subscription;
	if (!paidSubscription) throw new Error("Missing paid subscription fixture");
	const deployment = mutationDeploymentReadFixture({
		...railHostedDeployment,
		hermes_control_ui_url: "https://runtime.example/",
		config_info: { ...railHostedDeployment.config_info, compute_plan_slug: "compute_performance" },
		compute_subscription: {
			...paidSubscription,
			current_period_end: "2026-09-11T00:00:00Z",
		},
	});
	const sessionsPage = hostedOverviewSessionsPage(3);
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [railHostedCloudAgent],
		plans: [basicPlan, performancePlan],
		agentResourceFixtures: true,
		sessionsPage,
	});
	let inventoryGate = Promise.resolve();
	let resourceGate = Promise.resolve();
	await page.route(`${DEPLOY_API}/v2/deployments**`, async (route) => {
		if (new URL(route.request().url()).pathname === "/v2/deployments") await inventoryGate;
		await route.fallback();
	});
	await page.route(`${CLOUD_API}/**`, async (route) => {
		if (/\/(agent-plugins|memories|vault|connectors)(\?|$)/.test(route.request().url()))
			await resourceGate;
		await route.fallback();
	});
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 390, height: 844 },
		{ width: 320, height: 800 },
	]) {
		await page.setViewportSize(viewport);
		let releaseInventory = () => {};
		let releaseResources = () => {};
		inventoryGate = new Promise<void>((resolve) => {
			releaseInventory = resolve;
		});
		resourceGate = new Promise<void>((resolve) => {
			releaseResources = resolve;
		});
		try {
			await page.goto(`/agents/${railHostedEnvironmentId}`);
			await expect(page.getByTestId("overview-status-card-skeleton")).toBeVisible();
			releaseInventory();
			await expect(page.locator("[data-overview-compute-plan]")).toHaveText("Performance plan");
			await expect(
				page.locator('[data-overview-module="plugins"] [data-slot="skeleton"]'),
			).toBeVisible();

			releaseResources();
			await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
		} finally {
			releaseInventory();
			releaseResources();
		}
	}
	let memoryFailures = 0;
	await page.route(`${CLOUD_API}/v1/memories?*`, async (route) => {
		memoryFailures += 1;
		await fulfillJson(route, { detail: "Temporary fixture error" }, 503);
	});
	const currentTime = await page.evaluate(() => Date.now());
	await page.clock.setFixedTime(currentTime + 60_000);
	await page.locator('main a[href$="/sessions"]').click();
	await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
	await page.goBack();
	await expect.poll(() => memoryFailures).toBe(3);
	await page.evaluate(() => new Promise(requestAnimationFrame));
	const memories = page.locator('[data-overview-module="memories"]');
	await expect(memories).toContainText("1 memory");
	await expect(memories.locator('[data-slot="skeleton"]')).toHaveCount(0);
});

test("runtime readiness keeps launch closed across generation and credential races", async ({
	page,
	context,
}, testInfo) => {
	const deployment = mutationDeploymentReadFixture({
		...railHostedDeployment,
		openclaw_control_ui_url: "https://runtime.example/",
		config_info: { ...railHostedDeployment.config_info, runtime: "openclaw" },
	});
	const readyStatus = deployment.resource.status;
	const endpoint = deployment.runtime_ui_endpoint;
	if (!readyStatus || !endpoint) throw new Error("Missing runtime readiness fixture");
	const handoffUrl = `${endpoint.url}#bootstrapToken=fixture-token&bootstrapProfile=owner`;
	const credentialRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [],
		agentResourceFixtures: true,
		runtimeUiRedemptionRequests: credentialRequests,
	});
	await context.route("https://runtime.example/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><title>Runtime fixture</title><h1>Mock authentication target</h1>",
		}),
	);
	let credentialGate = Promise.resolve();
	let credentialFailures = 1;
	await page.route(`${DEPLOY_API}/v2/deployments/*/runtime-ui/credentials`, async (route) => {
		credentialRequests.push(route.request().url());
		const version = deployment.resource.metadata.resourceVersion;
		await credentialGate;
		if (credentialFailures-- > 0)
			return route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({ detail: "Runtime UI credential is unavailable" }),
			});
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				runtime: "openclaw",
				url: endpoint.url,
				deployment_resource_version: version,
				auth_mode: "openclaw_token",
				token: "fixture-token",
				handoff_url: handoffUrl,
			}),
		});
	});
	for (const state of ["starting", "no-endpoint", "old-ack", "old-generation", "ready"] as const) {
		deployment.resource.status = {
			...readyStatus,
			summary_state: state === "starting" ? "starting" : "running",
			driver_acknowledged_generation: state === "old-ack" ? 0 : 1,
		};
		deployment.resource.metadata.generation = state === "old-generation" ? 2 : 1;
		deployment.runtime_ui_endpoint = state === "no-endpoint" ? null : endpoint;
		await page.goto(`/agents/${railHostedEnvironmentId}`);
		const launch = page.locator('[data-overview-module="dashboard"]');
		if (state === "ready") {
			await expect(launch.getByRole("link", { name: "Chat on the web" })).toBeVisible();
		} else {
			await expect(launch.getByRole("button", { name: "Chat on the web" })).toBeDisabled();
		}

		expect(credentialRequests).toHaveLength(0);
		if (state === "no-endpoint") {
			const publishedAt = await page.evaluate(() => performance.now());
			deployment.runtime_ui_endpoint = endpoint;
			await expect(launch.getByRole("link", { name: "Chat on the web" })).toBeVisible({
				timeout: 15_000,
			});
			const observedAt = await page.evaluate(() => performance.now());
			await testInfo.attach("endpoint-publication-refresh", {
				body: JSON.stringify({ milliseconds: observedAt - publishedAt }),
				contentType: "application/json",
			});
		}
	}
	let releaseCredentials = () => {};
	credentialGate = new Promise<void>((resolve) => {
		releaseCredentials = resolve;
	});
	try {
		await page.getByRole("link", { name: "Chat on the web" }).click();
		await expect.poll(() => credentialRequests.length).toBe(1);
		await expect(page.locator("main iframe")).toHaveCount(0);

		releaseCredentials();
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(page.locator("main iframe")).toHaveAttribute("src", handoffUrl);
		await page
			.getByTestId("app-sidebar")
			.getByRole("link", { name: "Overview", exact: true })
			.click();
		await page.getByRole("link", { name: "Chat on the web" }).click();
		await expect(page.locator("main iframe")).toHaveAttribute("src", endpoint.url);
		expect(credentialRequests).toHaveLength(2);
		deployment.resource.metadata.generation = 2;
		deployment.resource.metadata.resourceVersion = "rv_generation_2";
		deployment.resource.status = {
			...readyStatus,
			observedGeneration: 2,
			driver_acknowledged_generation: 2,
			driver_applied_generation: 2,
			conditions: readyStatus.conditions.map((condition) => ({
				...condition,
				observedGeneration: 2,
			})),
		};
		await page.reload();
		await expect.poll(() => credentialRequests.length).toBe(3);
		await expect(page.locator("main iframe")).toHaveAttribute("src", handoffUrl);
	} finally {
		releaseCredentials();
	}
});

const walletState: WalletState = {
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

const terminalFallbackDeployment: DeploymentMutationFixture = {
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

function planChangeResponse({
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

async function stubWalletStripeSetup(page: Page) {
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

async function stubHostedApi(page: Page, options: HostedApiStubOptions = {}) {
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

async function expectNoHorizontalOverflow(locator: Locator, label: string) {
	const metrics = await locator.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(metrics.scrollWidth, `${label} horizontal overflow`).toBeLessThanOrEqual(
		metrics.clientWidth + 1,
	);
}

async function expectContainedInOwnerAndViewport(
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

async function _expectControlsDoNotOverlap(controls: Locator[], label: string) {
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

async function gotoHostedAgentSettings(
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

const openClawRuntimeEndpoint = "https://runtime.example/openclaw/";
const openClawRuntimeToken = "test-deployment-token";

async function stubOpenClawRuntime(page: Page, context: BrowserContext, handoffUrl: string) {
	type FrameGate = { signalStarted: () => void; released: Promise<void> };
	let nextFrameGate: FrameGate | null = null;
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
		runtimeUiRedemptionResponses: [
			{
				status: 200,
				body: {
					runtime: "openclaw",
					auth_mode: "openclaw_token",
					url: openClawRuntimeEndpoint,
					deployment_resource_version: `rv_${openClawIncludedDeployment.id}`,
					token: openClawRuntimeToken,
					handoff_url: handoffUrl,
				},
			},
		],
	});

	return {
		agentId: fixtureAgentId(openClawIncludedDeployment),
		credentialRequests,
		pauseNextIframe,
	};
}

async function expectOpenClawWindow(
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

async function _gotoHostedSettingsDialog(page: Page, section: string) {
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

test("Help opens the hosted Mava live chat", async ({ page }) => {
	await page.addInitScript(() => {
		window.__mavaLiveChatToggleCalls = 0;
		window.MavaWebChatToggle = () => {
			window.__mavaLiveChatToggleCalls = (window.__mavaLiveChatToggleCalls ?? 0) + 1;
		};
	});
	await stubHostedApi(page);
	await page.goto("/agents");
	await page.waitForLoadState("networkidle");

	await page.getByTestId("app-sidebar-help-menu-button").click();
	await expect(page.getByRole("menuitem", { name: "Docs" })).toBeVisible();
	const liveChat = page.getByRole("menuitem", { name: "Live chat" });
	await expect(liveChat).toBeVisible();
	await liveChat.click();
	await expect.poll(() => page.evaluate(() => window.__mavaLiveChatToggleCalls)).toBe(1);
});

test("deploy hides the Mava launcher while other dashboard pages reserve clearance", async ({
	page,
}) => {
	await stubHostedApi(page, { plans: [basicPlan, performancePlan] });
	await page.goto("/deploy");
	await expect(page.getByTestId("deploy-action-bar")).toBeVisible();
	await page.evaluate(() => {
		const launcher = document.createElement("button");
		launcher.id = "mava-webchat-launcher";
		launcher.textContent = "Support";
		document.body.appendChild(launcher);
	});

	const launcher = page.locator("#mava-webchat-launcher");
	await expect(launcher).toBeHidden();

	await page.locator('a[href="/agents"]').first().click();
	await expect(page).toHaveURL("/agents");
	await expect(launcher).toBeVisible();
});

test("hosted agent overview uses the modular hierarchy", async ({ page }) => {
	const sessionRequests: string[] = [];
	const aiProviderRequests: string[] = [];
	const managedModelRequests: string[] = [];
	const overviewConnectorRequests: string[] = [];
	const agentProjectRequests: string[] = [];
	const skillRequests: string[] = [];
	const vaultRequests: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.startsWith("/v1/connectors/available")) overviewConnectorRequests.push(path);
	});
	const telegramAccount = {
		id: "channel-overview-telegram",
		provider: "telegram",
		name: "Research Telegram",
		status: "active",
		created_at: "2026-07-15T00:00:00Z",
	};
	await stubHostedApi(page, {
		sessionRequests,
		aiProviderRequests,
		managedModelRequests,
		agentProjectRequests,
		skillRequests,
		vaultRequests,
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
		agentResourceFixtures: true,
		sessionsPage: hostedOverviewSessionsPage(5),
		connectorConnections: [
			{ id: "hosted-conn-github", app_name: "github", status: "ACTIVE" },
			{ id: "hosted-conn-slack", app_name: "slack", status: "ACTIVE" },
		],
		connectorCatalog: ["github", "slack", "gmail", "notion", "linear", "dropbox", "calendar"].map(
			(name) => ({
				name,
				display_name: name[0]?.toUpperCase() + name.slice(1),
				logo: "",
				description: `${name} connector`,
				auth_type: "oauth",
				connect_disabled: false,
				connect_disabled_reason: null,
			}),
		),
		skillsByProjectId: {
			"project-hosted": [
				{
					id: "skill-hosted-briefing",
					skill_key: "briefing",
					name: "Daily briefing",
					description: "Prepare daily briefings",
					version: 1,
					source: "cloud",
					authority: "cloud",
					source_repo: null,
					agent_types: ["hermes"],
					file_count: 1,
					content_hash: "b".repeat(64),
					is_active: true,
					created_at: "2026-07-15T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
					project_id: "project-hosted",
					project_name: "Hosted Agent Project",
					project_kind: "environment",
				},
			],
		},
		channelAgentLinks: [
			{
				id: "link-overview-telegram",
				account_id: telegramAccount.id,
				agent_id: railHostedEnvironmentId,
				status: "active",
				created_at: "2026-07-15T00:00:00Z",
				account: telegramAccount,
			},
		],
	});
	await page.goto(`/agents/${railHostedEnvironmentId}`);
	await expect.poll(() => sessionRequests.length).toBe(1);
	expect(new URL(sessionRequests[0] ?? "http://invalid").searchParams.get("page_size")).toBe("3");

	const overview = page.locator("main");
	const overviewTitleRow = page.locator('[data-slot="page-header"]');
	await expect(overviewTitleRow.getByText("Cloud", { exact: true })).toHaveCount(1);
	await expect(overviewTitleRow.getByText("Legacy", { exact: true })).toHaveCount(0);
	await expect(overview.getByRole("heading", { name: "Workspace", exact: true })).toBeVisible({
		timeout: 12_000,
	});
	await expect(overview.getByRole("heading", { name: "Shared", exact: true })).toBeVisible();
	await expect(overview.locator("[data-overview-access-scope]")).toHaveCount(0);
	await expect(overview.locator("[data-overview-module-error]")).toHaveCount(0);
	await expect(
		overview.locator(
			"[data-overview-module] a a, [data-overview-module] a button, [data-overview-module] button a",
		),
	).toHaveCount(0);
	await expect(overview.getByRole("heading", { name: "Connections", exact: true })).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="channels"]')).toContainText(
		"Telegram, Discord, or WhatsApp",
	);
	await expect(overview.locator('[data-overview-module="sessions"]')).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="projects"]')).not.toContainText(
		"Hosted Agent Project",
	);
	await expect(overview.getByText("Default Project", { exact: true })).toHaveCount(0);
	await expect(overview.getByTestId("agent-project-grid")).toHaveCount(0);
	expect(agentProjectRequests).toHaveLength(1);
	expect(skillRequests).toHaveLength(1);
	expect(new URL(skillRequests[0] ?? "http://invalid").searchParams.get("project_id")).toBe(
		"project-hosted",
	);
	expect(vaultRequests).toHaveLength(1);
	expect(new URL(vaultRequests[0] ?? "http://invalid").searchParams.get("project_id")).toBe(
		"project-hosted",
	);
	const viewAllSessions = page
		.locator("#hosted-recent-sessions")
		.locator("..")
		.getByRole("button", { name: "View all", exact: true });
	const viewAllHref = await viewAllSessions.getAttribute("href");
	const viewAllUrl = new URL(viewAllHref ?? "", page.url());
	expect(viewAllUrl.pathname).toBe(`/agents/${railHostedEnvironmentId}/sessions`);
	expect(viewAllUrl.search).toBe("");
	const recentSessions = page.getByRole("region", { name: "Recent sessions" });
	await expect(recentSessions.locator("article")).toHaveCount(3);
	await expect(recentSessions).not.toContainText("Review risks");
	await expect(page.locator('[data-overview-module="dashboard"]')).toBeVisible();
	await expect(page.getByRole("button", { name: "Chat on the web", exact: true })).toBeDisabled();
	const compute = page.locator('[data-overview-status="compute"]');
	await expect(compute).toContainText("Running");
	await expect(compute).toContainText("Basic plan");
	await expect(compute.getByRole("link", { name: "Compute", exact: true })).toHaveAttribute(
		"href",
		/\/settings/,
	);
	await expect(compute.getByRole("button")).toHaveCount(0);
	await expect(compute.locator("a a, a button, button a")).toHaveCount(0);
	await expect(compute.getByLabel("Compute resources", { exact: true })).toBeVisible();
	await expect(overview.locator('[data-overview-module="model-provider"]')).toContainText(
		"AI Providers",
	);
	expect(aiProviderRequests).toEqual([]);
	await expect.poll(() => managedModelRequests.length).toBe(1);
	for (const configuration of ["2 vCPU", "4 GiB RAM", "20 GiB storage"])
		await expect(compute.getByText(configuration, { exact: true })).toBeVisible();
	await expect(overview.locator('[data-overview-module="skills"]')).toContainText(
		"No skills installed",
	);
	await expect(overview.locator('[data-overview-module="vaults"]')).toContainText("1 vault");
	await expect(
		overview.locator('[data-overview-module="skills"]').getByRole("link", { name: "Skills" }),
	).toHaveAttribute(
		"href",
		`/agents/${railHostedEnvironmentId}/project-access/project-hosted/skills`,
	);
	await expect(
		overview.locator('[data-overview-module="vaults"]').getByRole("link", { name: "Vaults" }),
	).toHaveAttribute("href", `/agents/${railHostedEnvironmentId}/vaults`);
	await expect(overview.locator('[data-overview-module="memories"]')).toContainText("1 memory");
	await expect(overview.locator('[data-overview-module="connectors"]')).toContainText("2 apps");
	expect(overviewConnectorRequests).toEqual([]);
	const sidebar = page.getByTestId("app-sidebar");
	await expect(sidebar.getByText("Running", { exact: true })).toBeVisible();
	await expectInlineSidebarStatus(sidebar, "hosted");
	await expect(sidebar.getByText("Paused", { exact: true })).toHaveCount(0);
	await expect(sidebar.getByText(/last seen/i)).toHaveCount(0);
	for (const section of ["Projects", "Memories", "Connectors", "Skills", "Vaults"]) {
		await expect(sidebar.getByRole("link", { name: section, exact: true })).toBeVisible();
	}
	const projectGroup = sidebar.getByRole("group", {
		name: "Workspace",
		exact: true,
	});
	const skillsLink = projectGroup.getByRole("link", { name: "Skills", exact: true });
	const vaultsLink = projectGroup.getByRole("link", { name: "Vaults", exact: true });
	const expectedProjectHub = `/agents/${railHostedEnvironmentId}/project-access/project-hosted`;
	await expect(skillsLink).toHaveAttribute("href", `${expectedProjectHub}/skills`);
	await expect(vaultsLink).toHaveAttribute("href", `/agents/${railHostedEnvironmentId}/vaults`);
	await vaultsLink.focus();
	await expect(vaultsLink).toBeFocused();
	await vaultsLink.click();
	await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}/vaults`);
	await expect(vaultsLink).toHaveAttribute("data-active", "");
	await expect(skillsLink).not.toHaveAttribute("data-active", "");
	await page.goto(`/agents/${railHostedEnvironmentId}`);
	await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 1200 });
	await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
	const mobileSidebar = page.getByRole("dialog");
	await expectInlineSidebarStatus(mobileSidebar, "hosted");

	await page.keyboard.press("Escape");
	await page.goto(`/agents/${railHostedEnvironmentId}/sessions`);
	const sessionsHeading = page.getByRole("heading", { name: "Sessions", exact: true });
	await expect(sessionsHeading).toBeVisible();
	await expect(sessionsHeading.locator("..").getByText("Cloud", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Chat on the web", exact: true })).toHaveCount(0);
});

for (const projectionFailure of [
	{ name: "missing", response: { status: 404, body: { detail: "Agent not found" } } },
	{ name: "error", response: { status: 500, body: { detail: "projection gateway failed" } } },
] as const) {
	test(`hosted overview renders from deployment authority when the agent projection is ${projectionFailure.name}`, async ({
		page,
	}) => {
		// The overview renders from deployment status alone: a missing or
		// erroring projection never blanks the page and never leaks internals.
		await stubHostedApi(page, {
			deployments: [runningMissingProjectionDeployment],
			cloudAgentResponses:
				projectionFailure.name === "missing"
					? { [missingProjectionEnvironmentId]: [projectionFailure.response] }
					: undefined,
			cloudAgentErrors:
				projectionFailure.name === "error"
					? {
							[missingProjectionEnvironmentId]: {
								status: 500,
								detail: "projection gateway failed",
							},
						}
					: undefined,
		});
		await page.goto(`/agents/${missingProjectionEnvironmentId}`);
		const main = page.locator("main");
		await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
		await expect(main.getByText("Unavailable right now", { exact: true }).first()).toBeVisible();
		await expect(main).not.toContainText("projection gateway failed");
	});
}

test("Custom model ownership is preserved in agent settings", async ({ page }) => {
	const id = "existing-provider";
	const provider = {
		...userProvider(id, "Existing provider", [{ id: "legacy-first" }, { id: "legacy-second" }]),
		configuration_mode: "custom" as const,
	};
	const deployment: DeploymentMutationFixture = {
		...railHostedDeployment,
		config_info: {
			...railHostedDeployment.config_info,
			ai_provider_auth_kind: "api_key",
			runtime_configuration: {
				providers: [
					{
						provider_id: id,
						auth_kind: "secret_reference",
						models: ["legacy-first", "legacy-second"],
					},
				],
				primary_model: { provider_id: id, model: "legacy-first" },
				features: [],
			},
		},
	};
	const updates: Array<{ body: string; idempotencyKey: string | null; ifMatch: string | null }> =
		[];
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [railHostedCloudAgent],
		aiProviders: [provider],
		updateDeploymentRequests: updates,
	});
	await page.goto(`/agents/${railHostedEnvironmentId}`);
	await expect(page.locator('[data-overview-module="model-provider"]')).toContainText(
		"Managed in agent",
	);
	await page.goto(`/agents/${railHostedEnvironmentId}/model-provider`);
	await expect(page.getByTestId("managed-model-controls")).toHaveCount(0);
	await expect(page.locator("main").getByRole("button", { name: "Save changes" })).toBeDisabled();
	expect(updates).toEqual([]);
});

test("Clawdi AI model selection saves the chosen managed model", async ({ page }, testInfo) => {
	const updateDeploymentRequests: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}> = [];
	await stubHostedApi(page, {
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
		updateDeploymentRequests,
	});
	await page.goto(`/agents/${railHostedEnvironmentId}/model-provider`);
	await page
		.getByTestId("provider-choice-grid")
		.getByRole("button", { name: /^Clawdi AI/ })
		.click();
	const models = page.getByTestId("managed-model-controls");
	await expect(models.getByRole("button", { name: /^GPT-5.6 Luna/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await models.getByRole("combobox", { name: "More managed models" }).click();
	await page.getByRole("option", { name: /GPT-5.6 Sol/ }).click();
	await expect(models.getByRole("combobox")).toContainText("GPT-5.6 Sol");
	await expect(page.getByText("Add, validate, or remove providers on")).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath("managed-model-picker.png") });
	await page.locator("main").getByRole("button", { name: "Save changes" }).click();
	await expect.poll(() => updateDeploymentRequests.length).toBe(1);
	expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		ai_provider_auth_kind: "managed",
		primary_model: { provider_id: "clawdi", model: "gpt-5.6-sol" },
	});
});

for (const kind of ["native", "custom"] as const) {
	test(`${kind} provider creation stays in context and binds without choosing a model`, async ({
		page,
	}) => {
		const providerAcceptRequests: string[] = [];
		const updateDeploymentRequests: Array<{
			body: string;
			idempotencyKey: string | null;
			ifMatch: string | null;
		}> = [];
		const providerId = kind === "native" ? "openai" : "custom-gateway";
		const providerName = kind === "native" ? "OpenAI" : "Custom gateway";
		const createdProvider: AiProvider = {
			...userProvider(providerId, providerName, []),
			configuration_mode: kind,
			native_provider: kind === "native" ? "openai" : null,
			models: null,
			api_mode: kind === "native" ? "openai_responses" : "openai_chat",
			type: kind === "native" ? "openai" : "custom_openai_compatible",
			base_url: kind === "native" ? "https://api.openai.com/v1" : "https://custom.example/v1",
			runtime_env_name: "OPENAI_API_KEY",
		};
		await stubHostedApi(page, {
			deployments: [railHostedDeployment],
			cloudAgents: [railHostedCloudAgent],
			providerAcceptRequests,
			providerAcceptResponses: [
				{ status: 200, body: { status: "ready", provider: createdProvider } },
			],
			updateDeploymentRequests,
		});
		const agentPath = `/agents/${railHostedEnvironmentId}/model-provider`;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await page.goto(agentPath);
			try {
				await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
				break;
			} catch (error) {
				if (attempt === 1) throw error;
			}
		}
		const agentPageUrl = page.url();

		await page.getByRole("button", { name: /Add a provider/ }).click();
		expect(page.url()).toBe(agentPageUrl);
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveAccessibleName("Add a provider");
		await dialog
			.getByRole("button", { name: kind === "native" ? /^OpenAI/ : /^Custom endpoint/ })
			.click();
		if (kind === "custom") {
			await dialog.getByLabel("Name", { exact: true }).fill(providerName);
			await dialog.getByLabel("Endpoint").fill("https://custom.example/v1");
		}
		await dialog.getByRole("textbox", { name: "API key" }).fill("sk-e2e-agent-provider");
		await dialog.getByRole("button", { name: "Add provider", exact: true }).click();

		await expect(dialog).toBeHidden();
		await expect.poll(() => providerAcceptRequests.length).toBe(1);
		const saved = JSON.parse(providerAcceptRequests[0] ?? "{}").provider;
		expect(saved).toMatchObject({ configuration_mode: kind, label: providerName });
		expect(saved).not.toHaveProperty("models");
		expect(page.url()).toBe(agentPageUrl);
		const providerCard = page
			.getByTestId("provider-choice-grid")
			.getByRole("button", { pressed: true })
			.filter({ hasText: providerName });
		await expect(providerCard).toHaveAttribute("aria-pressed", "true");
		const mainModel = page.getByRole("combobox", { name: "Main model" });
		await expect(mainModel).toHaveCount(0);
		await expect(page.getByText("Add, validate, or remove providers on")).toHaveCount(0);
		await expect(page.getByTestId("managed-model-controls")).toHaveCount(0);
		expect(updateDeploymentRequests).toEqual([]);
		await page.locator("main").getByRole("button", { name: "Save changes" }).click();
		await expect.poll(() => updateDeploymentRequests.length).toBe(1);
		expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
			ai_provider_auth_kind: "api_key",
			ai_provider_id: providerId,
			provider_ids: [providerId],
			primary_model: null,
		});
	});
}

test("hosted live-tool routes keep scrolling inside their viewport", async ({ page }) => {
	let releaseDeploymentList: (() => void) | undefined;
	const deploymentListGate = new Promise<void>((resolve) => {
		releaseDeploymentList = resolve;
	});
	const liveToolDeployment = {
		...mutationDeploymentReadFixture(railHostedDeployment),
		files_endpoint: { url: "https://files.example.test/" },
	};
	await stubHostedApi(page, {
		cloudAgents: [railHostedCloudAgent],
		deployments: [liveToolDeployment],
		deploymentListResponses: [[liveToolDeployment]],
		deploymentListResponseGates: [deploymentListGate],
	});

	try {
		await page.goto(`/agents/${railHostedEnvironmentId}/console`);
		const loadingShell = page.getByTestId("agent-live-tool-loading-shell");
		await expect(loadingShell).toBeVisible();
		await expect(page.getByTestId("overview-status-card-skeleton")).toHaveCount(0);
		const dashboardContent = page.getByTestId("dashboard-page-content");
		await expect(dashboardContent).toHaveAttribute("data-mava-launcher", "hidden");
		await page.evaluate(() => {
			const launcher = document.createElement("button");
			launcher.id = "mava-webchat-launcher";
			launcher.textContent = "Support";
			document.body.appendChild(launcher);
		});
		await expect(page.locator("#mava-webchat-launcher")).toBeHidden();
		await expectLiveToolFillsDashboard(page, loadingShell);
		const loadingBox = await loadingShell.boundingBox();
		if (!loadingBox) throw new Error("Live-tool loading shell should have stable geometry.");

		releaseDeploymentList?.();
		const liveSurface = page.getByTestId("hosted-agent-live-surface");
		await expect(liveSurface).toBeVisible();
		const liveBox = await liveSurface.boundingBox();
		if (!liveBox) throw new Error("Hosted live-tool surface should have stable geometry.");
		expect(Math.abs(liveBox.x - loadingBox.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(liveBox.width - loadingBox.width)).toBeLessThanOrEqual(1);
		expect(Math.abs(liveBox.height - loadingBox.height)).toBeLessThanOrEqual(1);
		await expectLiveToolFillsDashboard(page, liveSurface);

		await page.setViewportSize({ width: 390, height: 844 });
		await expectLiveToolFillsDashboard(page, liveSurface);

		for (const section of ["files", "terminal"] as const) {
			await page.goto(`/agents/${railHostedEnvironmentId}/${section}`);
			const routeSurface = page.getByTestId("hosted-agent-live-surface");
			await expect(routeSurface).toBeVisible();
			await expectLiveToolFillsDashboard(page, routeSurface);
		}
	} finally {
		releaseDeploymentList?.();
	}
});

test("hosted terminal opens a standalone fitted window", async ({ page, context }) => {
	const liveToolDeployment = mutationDeploymentReadFixture(railHostedDeployment);
	await stubHostedApi(page, {
		cloudAgents: [railHostedCloudAgent],
		deployments: [liveToolDeployment],
		deploymentListResponses: [[liveToolDeployment]],
	});
	const terminalPath = `/agents/${railHostedEnvironmentId}/terminal`;
	const terminalWindowPath = `/terminal/${railHostedEnvironmentId}`;

	await page.goto(terminalPath);
	const openButton = page.getByRole("button", { name: "Open Terminal in new window" });
	await expect(openButton).toContainText("Open in new window");
	const popupPromise = context.waitForEvent("page");
	await openButton.click();
	const popup = await popupPromise;
	await expect(popup).toHaveURL(terminalWindowPath);
	await popup.close();

	for (const viewportSize of [
		{ width: 1440, height: 900 },
		{ width: 390, height: 844 },
	] as const) {
		await page.setViewportSize(viewportSize);
		await page.goto(terminalPath);
		const terminal = page.locator(".hosted-terminal");
		await expect(terminal.locator(".xterm-screen")).toBeVisible();
		await expect(page.getByRole("button", { name: "Retry terminal" })).toBeEnabled();
		await expectTerminalFitsHost(terminal);

		await page.goto(terminalWindowPath);
		const standaloneSurface = page.getByTestId("hosted-agent-live-surface");
		const standaloneTerminal = standaloneSurface.locator(".hosted-terminal");
		await expect(standaloneTerminal.locator(".xterm-screen")).toBeVisible();
		await expect(page.getByRole("button", { name: "Open Terminal in new window" })).toHaveCount(0);
		await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
		await expect(page.getByTestId("dashboard-page-content")).toHaveCount(0);
		await expect(page.locator('main[data-mava-launcher="hidden"]')).toBeVisible();
		const standaloneGeometry = await standaloneSurface.evaluate((surface) => ({
			surface: surface.getBoundingClientRect().toJSON(),
			viewport: { width: window.innerWidth, height: window.innerHeight },
			body: { clientHeight: document.body.clientHeight, scrollHeight: document.body.scrollHeight },
			document: {
				clientHeight: document.documentElement.clientHeight,
				scrollHeight: document.documentElement.scrollHeight,
			},
		}));
		expect(Math.abs(standaloneGeometry.surface.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(standaloneGeometry.surface.y)).toBeLessThanOrEqual(1);
		expect(
			Math.abs(standaloneGeometry.surface.width - standaloneGeometry.viewport.width),
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(standaloneGeometry.surface.height - standaloneGeometry.viewport.height),
		).toBeLessThanOrEqual(1);
		expect(standaloneGeometry.body.scrollHeight).toBeLessThanOrEqual(
			standaloneGeometry.body.clientHeight + 1,
		);
		expect(standaloneGeometry.document.scrollHeight).toBeLessThanOrEqual(
			standaloneGeometry.document.clientHeight + 1,
		);
		await expectTerminalFitsHost(standaloneTerminal);
	}
});

test("overview billing facts and shortcuts follow subscription authority", async ({ page }) => {
	await page.clock.setFixedTime(new Date("2026-09-07T12:00:00Z"));
	const included = includedBasicDeployment.compute_subscription;
	const paid = paidBasicDeployment.compute_subscription;
	if (!included || !paid) throw new Error("Missing subscription fixtures");
	const deployment = mutationDeploymentReadFixture({
		...railHostedDeployment,
		hermes_control_ui_url: "https://runtime.example/",
	});
	const commercial = deployment.commercial_display;
	const runtimeStatus = deployment.resource.status;
	if (!commercial || !runtimeStatus) throw new Error("Missing deployment projection");
	const future = "2027-07-15T00:00:00Z";
	const ended = "2026-08-15T00:00:00Z";
	const billingMutations: string[] = [];
	page.on("request", (request) => {
		if (
			["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
			new URL(request.url()).host === "127.0.0.1:8001"
		)
			billingMutations.push(request.url());
	});
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [railHostedCloudAgent],
		plans: [basicPlan, performancePlan],
		agentResourceFixtures: true,
		sessionsPage: hostedOverviewSessionsPage(3),
	});
	for (const scenario of [
		{
			name: "included",
			subscription: included,
			value: "Included with your plan",
			date: null,
			action: "Upgrade",
		},
		{
			name: "stopped",
			subscription: included,
			value: "Included with your plan",
			date: null,
			action: "Upgrade",
		},
		{
			name: "paid",
			subscription: paid,
			value: "Active",
			date: ["Next renewal", "Jul 15, 2027"],
			action: null,
		},
		{
			name: "canceling",
			subscription: { ...paid, cancel_at_period_end: true, cancel_at: future },
			value: "Canceling",
			date: ["Ends on", "Jul 15, 2027"],
			action: null,
		},
		{
			name: "trial",
			subscription: {
				...paid,
				status: "trialing",
				actions: { cancel: "end_trial", resume: false, command_state: null },
			},
			value: "Trial",
			date: ["Trial ends", "Jul 15, 2027"],
			action: null,
		},
		{
			name: "payment-retry",
			subscription: {
				...paid,
				payment_state: "past_due",
				recovery_action: "fix_payment",
				next_payment_attempt_at: "2026-09-08T12:00:00Z",
			},
			value: "Past due",
			date: ["Next payment attempt", "Sep 8, 2026"],
			action: "Fix payment",
		},
		{
			name: "missing-retry",
			subscription: {
				...paid,
				payment_state: "past_due",
				recovery_action: "fix_payment",
				next_payment_attempt_at: null,
			},
			value: "Past due",
			date: null,
			action: "Fix payment",
		},
		{
			name: "wallet-recovery",
			subscription: {
				...paid,
				funding_source: "wallet",
				payment_state: "past_due",
				recovery_action: "top_up",
			},
			value: "Past due",
			date: null,
			action: "Top up",
		},
		{
			name: "ended",
			subscription: {
				...paid,
				status: "canceled",
				canceled_at: ended,
				recovery_action: "start_new",
			},
			value: "Ended",
			date: ["Ended on", "Aug 15, 2026"],
			action: "Manage",
		},
		{
			name: "pending",
			subscription: { ...paid, recovery_blocked_reason: "authority_pending" },
			value: "Updating subscription",
			date: null,
			action: null,
		},
		{
			name: "missing-date",
			subscription: { ...paid, current_period_end: null },
			value: "Active",
			date: null,
			action: null,
		},
		{
			name: "unknown-subscription",
			subscription: { ...paid, status: "unrecognized" },
			value: "Status unavailable",
			date: null,
			action: null,
		},
		{
			name: "unknown-runtime",
			subscription: { ...paid, current_period_end: null },
			value: "Active",
			date: null,
			action: null,
		},
		{ name: "missing-subscription", subscription: null, value: null, date: null, action: null },
	] as const) {
		commercial.compute_subscription = scenario.subscription;
		deployment.resource.status =
			scenario.name === "unknown-runtime"
				? null
				: { ...runtimeStatus, summary_state: scenario.name === "stopped" ? "stopped" : "running" };
		deployment.upgrade_available = scenario.name === "included" || scenario.name === "stopped";
		for (const width of scenario.name === "payment-retry" || scenario.name === "included"
			? [1440, 390, 320]
			: scenario.name === "paid"
				? [1440, 390]
				: [1440]) {
			await page.setViewportSize({
				width,
				height: width === 1440 ? 900 : width === 320 ? 800 : 844,
			});
			await page.goto(`/agents/${railHostedEnvironmentId}`);
			const compute = page.locator('[data-overview-status="compute"]');
			const body = compute.locator('[data-slot="card-content"]');
			await expect(body).toContainText("Basic plan");
			const row = body.locator("[data-overview-subscription-row]");
			if (scenario.value) await expect(row).toContainText(scenario.value);
			else await expect(row).toHaveCount(0);
			if (scenario.value === "Included with your plan") {
				await expect(row.getByText("Subscription:", { exact: true })).toHaveCount(0);
				await expect(row.getByText("Active", { exact: true })).toHaveCount(0);
			}
			const date = row.locator("xpath=following-sibling::div[1]");
			await expect(date).toHaveCount(scenario.date ? 1 : 0);
			if (scenario.date) for (const text of scenario.date) await expect(date).toContainText(text);
			const actions = body.getByRole("button");
			await expect(actions).toHaveCount(scenario.action ? 1 : 0);
			await expect(body.locator("dl [data-slot=button]")).toHaveCount(0);
			if (scenario.action) {
				await expect(actions).toHaveText(scenario.action);
				await expect(
					page.locator('main [data-slot="alert"]').getByRole("button", {
						name: /^(Fix payment|Top up|Start a new subscription)$/,
					}),
				).toHaveCount(0);
			}
			await expect(compute.locator("a a, a button, button a, [data-slot=badge]")).toHaveCount(0);
			if (scenario.action) {
				const target =
					scenario.action === "Top up"
						? `/agents/${railHostedEnvironmentId}?settings=billing-wallet`
						: `/agents/${railHostedEnvironmentId}/settings#compute-plan-controls`;
				await expect(actions).toHaveAttribute("href", target);
				await actions.click();
				await expect(page).toHaveURL(target);
				if (scenario.action === "Top up") await expect(page.getByRole("dialog")).toBeVisible();
				else await expect(page.locator("#compute-plan-controls")).toBeVisible();
			}
		}
	}
	expect(billingMutations).toEqual([]);
});

for (const runtime of ["hermes", "openclaw"] as const) {
	test(`${runtime} overview entries preserve navigation and layout`, async ({ page, context }) => {
		const label = runtime === "hermes" ? "Hermes Dashboard" : "OpenClaw Control UI";
		const endpoint = "https://runtime.example/";
		const deployment = {
			...railHostedDeployment,
			hermes_control_ui_url: endpoint,
			openclaw_control_ui_url: endpoint,
			config_info: { ...railHostedDeployment.config_info, runtime },
		};
		const credentialRequests: string[] = [];
		const sessionsPage = hostedOverviewSessionsPage(3, runtime);
		await stubHostedApi(page, {
			deployments: [deployment],
			cloudAgents: [{ ...railHostedCloudAgent, agent_type: runtime }],
			plans: [basicPlan, performancePlan],
			agentResourceFixtures: true,
			sessionsPage,
			runtimeUiRedemptionRequests: credentialRequests,
			runtimeUiRedemptionResponses: [
				{
					status: 200,
					body: {
						runtime,
						url: endpoint,
						deployment_resource_version: `rv_${deployment.id}`,
						...(runtime === "hermes"
							? { auth_mode: "password", username: "admin", password: "test-password" }
							: {
									auth_mode: "openclaw_token",
									token: "test-token",
									handoff_url: `${endpoint}#token=test-token`,
								}),
					},
				},
			],
		});
		await context.route("https://runtime.example/**", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><title>Runtime</title><main>Runtime dashboard</main>",
			}),
		);
		for (const { sessionCount, ...viewport } of [
			{ width: 1440, height: 900, sessionCount: 0 },
			{ width: 1440, height: 900, sessionCount: 1 },
			{ width: 1440, height: 900, sessionCount: 3 },
			{ width: 390, height: 844, sessionCount: 3 },
			{ width: 320, height: 800, sessionCount: 3 },
		]) {
			Object.assign(sessionsPage, hostedOverviewSessionsPage(sessionCount, runtime));
			await page.setViewportSize(viewport);
			await page.goto(`/agents/${railHostedEnvironmentId}`);
			const module = page.locator('[data-overview-module="dashboard"]');
			const open = page.getByRole("link", { name: "Chat on the web", exact: true });
			await expect(open).toHaveCount(1);
			await expect(open).toBeEnabled();
			await expect(open.getByText(label, { exact: true })).toBeVisible();
			await expect(module.getByRole("link")).toHaveCount(1);
			await expect(module.locator('[role="status"], #agent-dashboard-status')).toHaveCount(0);
			await expectContainedInOwnerAndViewport(page, open, module, "Dashboard action");
			await expectNoHorizontalOverflow(module, "Dashboard module");
			await expectNoHorizontalOverflow(
				open.locator('[data-slot="card-description"]'),
				"Dashboard subtitle",
			);
			const entry = page.locator('[data-overview-section="entry"]');
			const channels = page.locator('[data-overview-module="channels"]');
			await expect(channels).toContainText("Telegram, Discord, or WhatsApp");
			await expect(entry.locator('[data-overview-status="compute"]')).toBeVisible();
			const compute = entry.locator('[data-overview-status="compute"]');
			await expect(compute.getByRole("button", { name: "Upgrade", exact: true })).toBeVisible();
			await expect(compute.locator('[data-slot="card-content"]')).toContainText("Basic plan");
			await expect(compute.locator("a a, a button, button a")).toHaveCount(0);
			const sessionGrid = page.getByTestId("overview-session-grid");
			await expect(sessionGrid.getByRole("article")).toHaveCount(sessionCount);
			if (sessionCount === 0) {
				await expect(sessionGrid.getByRole("status")).toHaveText(
					"No sessions from this agent yet.",
				);
			}
			await expectNoHorizontalOverflow(page.locator("main"), "Overview");
		}
		await page
			.locator('[data-overview-module="channels"]')
			.getByRole("link", { name: "Chat via channels", exact: true })
			.click();
		await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}/channel-links`);
		await page.goto(`/agents/${railHostedEnvironmentId}`);
		await page.getByRole("link", { name: "Chat on the web", exact: true }).click();
		await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}/console`);
		await expect(page.locator('[data-slot="breadcrumb-page"]').last()).toHaveText(label);
		const target = runtime === "hermes" ? `${endpoint}chat` : `${endpoint}#token=test-token`;
		await expect(page.locator(`iframe[title="${label}"]`)).toHaveAttribute("src", target);
		if (runtime === "hermes") {
			await page.getByRole("button", { name: "Access Hermes Dashboard", exact: true }).click();
			await expect(page.getByRole("dialog").getByText("admin", { exact: true })).toBeVisible();
		}
		expect(credentialRequests).toHaveLength(1);
		const popupPromise = context.waitForEvent("page");
		await page
			.getByRole("button", { name: `Open ${label} in new window`, exact: true })
			.last()
			.click();
		const popup = await popupPromise;
		await expect(popup).toHaveURL(target);
		await popup.close();
	});
}

test("native OpenClaw windows wait for the handoff iframe load and reuse the clean endpoint", async ({
	page,
	context,
}) => {
	const nativeHandoff = `${openClawRuntimeEndpoint}#bootstrapToken=one-time-token&bootstrapProfile=owner`;
	const runtime = await stubOpenClawRuntime(page, context, nativeHandoff);
	const initialFrame = runtime.pauseNextIframe();

	await page.goto(`/agents/${runtime.agentId}/console`, { waitUntil: "domcontentloaded" });
	await expect.poll(() => runtime.credentialRequests.length).toBe(1);
	await expect.poll(initialFrame.isStarted).toBe(true);
	const openButton = page.getByRole("button", {
		name: "Open OpenClaw Control UI in new window",
	});
	const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
	await expect(openButton).toBeDisabled();
	await expect(openButton).toContainText("Open in new window");
	await expect(page.getByRole("button", { name: "Reconnect" })).toBeEnabled();
	await expect(iframe).toHaveAttribute("src", nativeHandoff);
	expect(runtime.credentialRequests).toHaveLength(1);

	initialFrame.release();
	await expect(openButton).toBeEnabled();
	await expectOpenClawWindow(context, openButton, openClawRuntimeEndpoint);
	expect(runtime.credentialRequests).toHaveLength(1);

	const remountedFrame = runtime.pauseNextIframe();
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect.poll(remountedFrame.isStarted).toBe(true);
	await expect(openButton).toBeDisabled();
	await expect(iframe).toHaveAttribute("src", openClawRuntimeEndpoint);
	expect(runtime.credentialRequests).toHaveLength(1);

	remountedFrame.release();
	await expect(openButton).toBeEnabled();
	await expectOpenClawWindow(context, openButton, openClawRuntimeEndpoint);
	expect(runtime.credentialRequests).toHaveLength(1);
});

test("legacy OpenClaw windows reuse the exact token handoff", async ({ page, context }) => {
	const legacyHandoff = `${openClawRuntimeEndpoint}#token=${openClawRuntimeToken}`;
	const runtime = await stubOpenClawRuntime(page, context, legacyHandoff);
	const frame = runtime.pauseNextIframe();

	await page.goto(`/agents/${runtime.agentId}/console`, { waitUntil: "domcontentloaded" });
	await expect.poll(() => runtime.credentialRequests.length).toBe(1);
	const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
	await expect(iframe).toHaveAttribute("src", legacyHandoff);
	await expect.poll(frame.isStarted).toBe(true);
	const openButton = page.getByRole("button", {
		name: "Open OpenClaw Control UI in new window",
	});
	await expect(openButton).toBeDisabled();
	await expect(openButton).toContainText("Open in new window");
	expect(runtime.credentialRequests).toHaveLength(1);

	frame.release();
	await expect(openButton).toBeEnabled();
	await expectOpenClawWindow(context, openButton, legacyHandoff);
	expect(runtime.credentialRequests).toHaveLength(1);
});

test("agent rail keeps New agent after agents and retains cache after list failure", async ({
	page,
}) => {
	let releaseColdList: (() => void) | undefined;
	let releaseFailedRefetch: (() => void) | undefined;
	const coldListGate = new Promise<void>((resolve) => {
		releaseColdList = resolve;
	});
	const failedRefetchGate = new Promise<void>((resolve) => {
		releaseFailedRefetch = resolve;
	});
	const deploymentListRequests: string[] = [];
	const failedList = { body: { detail: "projection failed" }, status: 500 };
	await stubHostedApi(page, {
		cloudAgents: [railHostedCloudAgent],
		deploymentListRequests,
		deploymentListResponses: [[railHostedDeployment], failedList, failedList, failedList],
		deploymentListResponseGates: [coldListGate, failedRefetchGate],
	});

	try {
		await page.goto("/agents");
		const rail = page.getByTestId("app-sidebar-agent-rail");
		const newAgent = rail.getByRole("button", { name: "New agent" });
		await expect(rail.getByTestId("app-sidebar-agent-tile")).toHaveCount(0);
		await expect(rail.getByRole("button", { name: "e2e-2", exact: true })).toHaveCount(0);

		releaseColdList?.();
		const agentTile = rail.getByTestId("app-sidebar-agent-tile");
		await expect(agentTile).toHaveCount(1);
		await expect(rail.getByTestId("app-sidebar-agent-loading-slot")).toHaveCount(0);
		const agentTileBox = await agentTile.boundingBox();
		const loadedNewAgentBox = await newAgent.boundingBox();
		if (!agentTileBox || !loadedNewAgentBox) {
			throw new Error("Loaded agent rail controls should be visible.");
		}
		expect(loadedNewAgentBox.y).toBeGreaterThan(agentTileBox.y);

		await rail.getByRole("button", { name: "e2e-2", exact: true }).click();
		await expect(page.locator('[data-agent-overview="hosted"]')).toBeVisible();
		const currentTime = await page.evaluate(() => Date.now());
		await page.clock.setFixedTime(currentTime + 31_000);
		await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
		await expect.poll(() => deploymentListRequests.length).toBeGreaterThanOrEqual(2);
		await expect(rail.getByTestId("app-sidebar-agent-tile")).toHaveCount(1);
		await expect(page.locator('[data-agent-overview="hosted"]')).toBeVisible();

		releaseFailedRefetch?.();
		await expect.poll(() => deploymentListRequests.length).toBe(4);
		await expect(rail.getByTestId("app-sidebar-agent-tile")).toHaveCount(1);
		await expect(page.locator('[data-agent-overview="hosted"]')).toBeVisible();
	} finally {
		releaseColdList?.();
		releaseFailedRefetch?.();
	}
});

test("header Wallet adapts long balances across narrow touch layouts", async ({
	page,
	browser,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Playwright baseURL is required for the Wallet header test.");
	const longBalance = "$12,345,678,901,234,567,890.12";
	await stubHostedApi(page, {
		walletResponses: [
			{
				body: { ...walletState, balance_usd: "12345678901234567890.12" },
				status: 200,
			},
		],
	});

	await page.goto("/agents");
	const walletSlot = page.getByTestId("global-wallet-balance-slot");
	const walletControl = page.getByTestId("global-wallet-balance");
	await expect(walletControl).toContainText(longBalance);
	await expect(walletControl).toHaveAttribute(
		"aria-label",
		`Wallet balance ${longBalance}. Open Wallet settings`,
	);
	const balanceText = walletControl.locator("span").filter({ hasText: longBalance });
	expect(await balanceText.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
		true,
	);

	await page.setViewportSize({ width: 320, height: 568 });
	const header = page.locator("header");
	const sidebarTrigger = page.getByRole("button", { name: "Toggle Sidebar" });
	const separator = header.locator('[data-slot="separator"]');
	const breadcrumb = header.locator('[data-slot="breadcrumb-list"]');
	const notificationCenter = page.getByRole("button", { name: "Notifications", exact: true });
	await expectNoHorizontalOverflow(header, "Wallet header at 320px");
	await expectContainedInOwnerAndViewport(
		page,
		walletControl,
		walletSlot,
		"Wallet header control at 320px",
	);
	await _expectControlsDoNotOverlap(
		[sidebarTrigger, separator, breadcrumb, walletControl, notificationCenter],
		"Wallet header at 320px",
	);
	expect(await balanceText.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
		true,
	);

	const touchContext = await browser.newContext({
		baseURL,
		hasTouch: true,
		viewport: { width: 320, height: 568 },
	});
	const touchPage = await touchContext.newPage();
	try {
		await stubHostedApi(touchPage);
		await touchPage.goto("/agents");
		expect(await touchPage.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
		const walletControl = touchPage.getByTestId("global-wallet-balance");
		const balanceText = walletControl.locator("span").filter({ hasText: "$25.00" });
		await expect(walletControl).toContainText("$25.00");
		for (const viewport of [
			{ width: 320, height: 568 },
			{ width: 390, height: 844 },
		]) {
			await touchPage.setViewportSize(viewport);
			expect(
				await balanceText.evaluate((element) => element.scrollWidth <= element.clientWidth),
			).toBe(true);
			const header = touchPage.locator("header");
			const walletSlot = touchPage.getByTestId("global-wallet-balance-slot");
			await expectNoHorizontalOverflow(header, `Wallet header at ${viewport.width}px`);
			await expectContainedInOwnerAndViewport(
				touchPage,
				walletControl,
				walletSlot,
				`Wallet header control at ${viewport.width}px touch`,
			);
			await _expectControlsDoNotOverlap(
				[
					touchPage.getByRole("button", { name: "Toggle Sidebar" }),
					header.locator('[data-slot="separator"]'),
					header.locator('[data-slot="breadcrumb-list"]'),
					walletControl,
					touchPage.getByRole("button", { name: "Notifications", exact: true }),
				],
				`Wallet header at ${viewport.width}px touch`,
			);
		}
	} finally {
		await touchContext.close();
	}
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
		cloudAgents: [railHostedCloudAgent, railConnectedCloudAgent, sharedLegacyCloudAgent],
		legacyAgentEnvironmentIds: [sharedLegacyEnvironmentId],
		canUseLegacyHostedDashboard: true,
	});

	await page.goto("/agents");
	const rail = page.getByTestId("app-sidebar-agent-rail");
	const consoleLink = rail.getByRole("link", { name: "Console", exact: true });
	const cloudButton = rail.getByRole("button", { name: "e2e-2", exact: true });
	const connectedButton = rail.getByRole("button", { name: /Rail Connected/ });

	await expect(consoleLink).toHaveAttribute("href", "/");
	await expect(cloudButton).toHaveAttribute("type", "button");
	await expect(connectedButton).toHaveAttribute("type", "button");
	await expect(rail.getByRole("button", { name: /^Reorder / })).toHaveCount(0);
	await expect(rail.getByTitle(/^Reorder /)).toHaveCount(0);
	const cloudMarker = rail.locator('[data-agent-rail-corner-marker="cloud"]');
	const legacyMarker = rail.locator('[data-agent-rail-corner-marker="legacy"]');
	await expect(cloudMarker).toHaveCount(1);
	await expect(legacyMarker).toHaveCount(1);
	const connectedTileBox = await rail
		.getByTestId("app-sidebar-agent-tile")
		.filter({ hasText: "Rail Connected" })
		.boundingBox();
	const connectedButtonBox = await connectedButton.boundingBox();
	if (!connectedTileBox || !connectedButtonBox) {
		throw new Error("Hosted rail agent tile should be a whole interactive button.");
	}
	expect(connectedButtonBox.x).toBeCloseTo(connectedTileBox.x, 0);
	expect(connectedButtonBox.y).toBeCloseTo(connectedTileBox.y, 0);
	expect(connectedButtonBox.height).toBeCloseTo(connectedTileBox.height, 0);
	expect(connectedButtonBox.width).toBeCloseTo(connectedTileBox.width, 0);

	await consoleLink.click();
	await expect(page).toHaveURL("/");
	await cloudButton.click();
	await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}`);
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

test("Breadcrumbs show the full trail on desktop and only the current page on narrow screens", async ({
	page,
}) => {
	await stubHostedApi(page, {
		agentResourceFixtures: true,
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
	});
	const query = "";
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/agents/${railHostedEnvironmentId}/memories${query}`);

	const breadcrumb = page.locator('[data-slot="breadcrumb-list"]');
	await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]:visible')).toHaveText([
		"e2e-2",
		"Memories",
	]);
	await expect(breadcrumb.locator('[data-slot="breadcrumb-separator"]:visible')).toHaveCount(1);

	await page.setViewportSize({ width: 320, height: 568 });
	await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]:visible')).toHaveText([
		"Memories",
	]);
	await expect(breadcrumb.locator('[data-slot="breadcrumb-separator"]:visible')).toHaveCount(0);
	await expectNoHorizontalOverflow(page.locator("header"), "breadcrumb header at 320px");
});

test("Console shows every agent when the fleet exceeds six", async ({ page }) => {
	const agents = Array.from({ length: 8 }, (_, index) => ({
		...railConnectedCloudAgent,
		id: `99999999-9999-4999-8999-${String(index).padStart(12, "0")}`,
		display_name: `Console Agent ${index + 1}`,
		sort_order: index,
	}));
	await stubHostedApi(page, { cloudAgents: agents });
	await page.goto("/");
	const main = page.locator("main");
	for (const agent of agents) {
		await expect(
			main.getByRole("link", { name: `Open ${agent.display_name}.`, exact: false }),
		).toBeVisible();
	}
});

test("Console actions remain reachable on narrow screens", async ({ page }) => {
	await stubHostedApi(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/");

	const main = page.locator("main");
	await page.setViewportSize({ width: 320, height: 568 });
	const connectAgent = main.getByRole("button", { name: "Connect an agent on your machine" });
	await expect(connectAgent).toBeVisible();
	await expectContainedInOwnerAndViewport(
		page,
		connectAgent,
		connectAgent.locator(".."),
		"320px onboarding action",
	);
	await expectNoHorizontalOverflow(page.locator("html"), "320px Console document");

	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoHorizontalOverflow(page.locator("html"), "390px Console document");

	const connectors = main.getByRole("link", { name: /^Connectors/ });
	await connectors.focus();
	await page.keyboard.press("Tab");
	await expect(main.getByRole("button", { name: "View all" })).toBeFocused();
});

test("Wallet auto-reload authorizes and replaces its dedicated card responsively", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const walletSetupCreates: Array<{ body: string; idempotencyKey: string | null }> = [];
	const walletSetupFinalizes: string[] = [];
	await stubWalletStripeSetup(page);
	await stubHostedApi(page, {
		walletSetupCreates,
		walletSetupFinalizeFailures: 1,
		walletSetupFinalizes,
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	const settingsDialog = await _gotoHostedSettingsDialog(page, "billing-wallet");
	const autoReload = settingsDialog.getByTestId("auto-reload-section");
	await expect(autoReload.getByRole("switch", { name: "Auto-reload" })).not.toBeChecked();
	await autoReload.getByRole("switch", { name: "Auto-reload" }).click();
	await autoReload.getByRole("button", { name: "Review and authorize" }).click();

	let setupDialog = page.getByRole("dialog", { name: "Authorize a card for auto-reload" });
	await expect(setupDialog).toContainText(
		"Each reload adds $25.00, plus any amount needed to bring a negative balance back to $0.",
	);
	await expect(setupDialog).toContainText(
		"charges it off-session when your balance drops below $5.00",
	);
	await expect(setupDialog).toContainText("You can disable auto-reload at any time.");
	await expect(setupDialog.getByText("Mock Wallet card form", { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(setupDialog, "desktop Wallet card setup");
	await _expectControlsDoNotOverlap(
		[
			setupDialog.getByRole("button", { name: "Cancel" }),
			setupDialog.getByRole("button", { name: "Authorize card and enable auto-reload" }),
		],
		"desktop Wallet card setup actions",
	);
	await expect.poll(() => walletSetupCreates.length).toBe(1);
	const firstStart = walletSetupCreates[0];
	expect(firstStart?.idempotencyKey).toBeTruthy();
	expect(JSON.parse(firstStart?.body ?? "{}")).toEqual({
		auto_reload_amount_cents: 2_500,
		auto_reload_monthly_cap_cents: 10_000,
		auto_reload_threshold_usd: "5",
		consent_version: "wallet_auto_reload_off_session_v2",
	});
	expect(await page.evaluate(() => window.__stripeWalletAppearanceThemes)).toContain("stripe");
	const initialClientSecrets = await page.evaluate(() => window.__stripeWalletClientSecrets ?? []);
	expect(new Set(initialClientSecrets)).toEqual(new Set(["seti_wallet_1_secret_mock_1"]));

	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await expect
		.poll(() => page.evaluate(() => window.__stripeWalletAppearanceThemes))
		.toContain("night");
	expect(await page.evaluate(() => window.__stripeWalletClientSecrets)).toHaveLength(
		initialClientSecrets.length,
	);
	await setupDialog.getByRole("button", { name: "Authorize card and enable auto-reload" }).click();
	await expect.poll(() => walletSetupFinalizes.length).toBe(1);
	await expect(
		setupDialog.getByRole("button", { name: "Retry enabling auto-reload" }),
	).toBeVisible();
	expect(await page.evaluate(() => window.__stripeWalletConfirmCalls)).toBe(1);
	await setupDialog.getByRole("button", { name: "Retry enabling auto-reload" }).click();
	await expect.poll(() => walletSetupFinalizes.length).toBe(2);
	await expect(setupDialog).toHaveCount(0);
	await expect(autoReload.getByText("Visa ending in 4242", { exact: true })).toBeVisible();
	await expect(autoReload.getByRole("button", { name: "Replace card" })).toBeVisible();
	expect(JSON.parse(walletSetupFinalizes[0] ?? "{}")).toEqual({
		setup_identity: `wsetup_${"a".repeat(64)}`,
		setup_intent_id: "seti_wallet_1",
	});
	expect(walletSetupFinalizes[1]).toBe(walletSetupFinalizes[0]);
	const firstReturnUrl = new URL(
		(await page.evaluate(() => window.__stripeWalletReturnUrls?.[0])) ?? "",
	);
	expect(firstReturnUrl.searchParams.get("wallet_setup_return")).toBe("1");
	expect(firstReturnUrl.searchParams.get("wallet_setup_id")).toBe(`wsetup_${"a".repeat(64)}`);
	expect(firstReturnUrl.search).not.toContain("secret");

	await page.setViewportSize({ width: 375, height: 700 });
	await autoReload.getByRole("button", { name: "Replace card" }).click();
	setupDialog = page.getByRole("dialog", { name: "Replace auto-reload card" });
	await expect(setupDialog.getByText("Mock Wallet card form", { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page.locator("html"), "mobile Wallet settings document");
	await expectNoHorizontalOverflow(setupDialog, "mobile Wallet card setup");
	await _expectControlsDoNotOverlap(
		[
			setupDialog.getByRole("button", { name: "Cancel" }),
			setupDialog.getByRole("button", { name: "Authorize card and enable auto-reload" }),
		],
		"mobile Wallet card setup actions",
	);
	await expect.poll(() => walletSetupCreates.length).toBe(2);
	const secondStart = walletSetupCreates[1];
	expect(secondStart?.body).toBe(firstStart?.body);
	expect(secondStart?.idempotencyKey).toBeTruthy();
	expect(secondStart?.idempotencyKey).not.toBe(firstStart?.idempotencyKey);
	expect(new Set(await page.evaluate(() => window.__stripeWalletClientSecrets ?? []))).toEqual(
		new Set(["seti_wallet_1_secret_mock_1", "seti_wallet_2_secret_mock_2"]),
	);
	await setupDialog.getByRole("button", { name: "Authorize card and enable auto-reload" }).click();
	await expect.poll(() => walletSetupFinalizes.length).toBe(3);
	await expect(autoReload.getByText("Mastercard ending in 4444", { exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.__stripeWalletConfirmCalls)).toBe(2);
	await autoReload.getByRole("switch", { name: "Auto-reload" }).click();
	await autoReload.getByRole("button", { name: "Disable auto-reload" }).click();
	await expect(autoReload.getByRole("switch", { name: "Auto-reload" })).not.toBeChecked();
	await expect(autoReload.getByText("Mastercard ending in 4444", { exact: true })).toHaveCount(0);
	await expect(autoReload.getByRole("button", { name: "Replace card" })).toHaveCount(0);
	await page.goto(
		"/channels?settings=billing-wallet&keep=1&wallet_payment_return=1&wallet_payment_flow=auto_reload&payment_intent=pi_auto_reload_return&payment_intent_client_secret=pi_auto_reload_return_secret_mock&redirect_status=succeeded#billing",
	);
	await expect(page.getByText("Auto-reload payment confirmed", { exact: true })).toBeVisible();
	await expect(page.getByText("Payment accepted", { exact: true })).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => `${window.location.search}${window.location.hash}`))
		.toBe("?settings=billing-wallet&keep=1#billing");
	const expectedFinalizeErrors = errors.filter((error) =>
		error.includes("503 (Service Unavailable)"),
	);
	expect(expectedFinalizeErrors).toHaveLength(1);
	const unexpectedErrors = errors.filter((error) => !expectedFinalizeErrors.includes(error));
	expect(unexpectedErrors, `Wallet card authorization: ${unexpectedErrors.join(" | ")}`).toEqual(
		[],
	);
});

for (const entry of ["inline", "return"] as const) {
	test(`rejected trial refreshes eligibility after ${entry} checkout`, async ({ page }) => {
		let rejected = false;
		const checkoutRequests: string[] = [];
		await stubCompletedStripeCheckout(page);
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
						client_secret: "cs_test_rejected_trial",
						trial_period_days: 7,
					},
				},
			],
			deployments: [includedBasicDeployment],
			plans: [basicPlan],
		});
		await page.route("**/v2/subscription/plans", (route) =>
			fulfillJson(route, [
				{
					...basicPlan,
					offers: basicPlan.offers.map((offer) => ({
						...offer,
						card_trial_period_days: rejected ? null : 7,
					})),
				},
			]),
		);
		await page.route("**/v2/deployments/by-request/**", (route) => {
			rejected = true;
			return fulfillJson(route, {
				deploy_request_id: "rejected-trial",
				request_status: "failed",
				failure_code: "trial_ineligible",
				lineage_tail: null,
			});
		});
		await page.goto(
			entry === "return"
				? "/deploy?session_id=cs_trial&deploy_request_id=rejected-trial"
				: "/deploy",
		);
		if (entry === "inline") {
			await expect(page.getByText("7-day free trial", { exact: true }).first()).toBeVisible();
			await page.getByRole("button", { name: "Continue" }).click();
			await page
				.getByRole("dialog", { name: /Complete .* checkout/ })
				.getByRole("button", { name: "Subscribe", exact: true })
				.click();
		}
		await expect(page.getByText("Free trial unavailable", { exact: true })).toBeVisible();
		await expect(page.getByText("7-day free trial", { exact: true })).toHaveCount(0);
		await expect(page.getByText("Checkout status refreshed", { exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
	});
}

test("paid checkout navigates on deployment acceptance without LRO convergence", async ({
	page,
}) => {
	const checkoutRequests: string[] = [];
	const deploymentDetailRequests: string[] = [];
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
		deploymentDetailRequests,
		deploymentRequestReads,
		deployments: [includedBasicDeployment, startingDeployment],
		plans: [basicPlan],
		unfinishedDeploymentRequests: true,
	});
	await page.goto("/deploy");

	await page.getByRole("button", { name: "Continue" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({ ui_mode: "custom" });
	const checkoutDialog = page.getByRole("dialog", { name: /Complete .* checkout/ });
	await expect(checkoutDialog.getByText("Mock secure payment form", { exact: true })).toBeVisible();
	await checkoutDialog.getByRole("button", { name: "Subscribe", exact: true }).click();

	await expect.poll(() => deploymentRequestReads).toHaveLength(1);
	await expect.poll(() => deploymentDetailRequests).toEqual([startingDeployment.id]);
	await expect(page).toHaveURL(`/agents/${fixtureAgentId(startingDeployment)}`);
	await expect(page.getByText("Setting up Hermes", { exact: true })).toBeVisible();
	await expect(page.getByText("Preparing cloud resources", { exact: true })).toBeVisible();
	expect(operationPollRequests).toEqual([]);
	await expect(page.getByText("Couldn’t deploy", { exact: true })).toHaveCount(0);
});

test("accepted detail delete dismisses immediately while teardown finishes in the background", async ({
	page,
}) => {
	const deleteRequestBodies: string[] = [];
	const deleteRequests: string[] = [];
	const deploymentListRequests: string[] = [];
	const completedDeleteIds = new Set<string>();
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
		completedDeleteIds,
		deleteRequestBodies,
		deleteRequests,
		deploymentListRequests,
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(includedBasicDeployment), "Basic");
	const historyLengthBeforeDelete = await page.evaluate(() => window.history.length);
	await page.evaluate(() => {
		document.documentElement.dataset.deleteNotFoundFlash = "false";
		const observer = new MutationObserver(() => {
			if (document.body.textContent?.includes("Clawdi Cloud agent not found")) {
				document.documentElement.dataset.deleteNotFoundFlash = "true";
			}
			if (window.location.pathname === "/") observer.disconnect();
		});
		observer.observe(document.body, { childList: true, subtree: true });
	});

	await page.locator("main").getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete agent", exact: true })
		.click();

	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_included"]);
	await expect
		.poll(() => deleteRequestBodies.map((body) => JSON.parse(body)))
		.toEqual([{ subscription_choice: "cancel_subscription" }]);
	await expect.poll(() => new URL(page.url()).pathname).toBe("/");
	await expect
		.poll(() => page.evaluate(() => window.history.length))
		.toBe(historyLengthBeforeDelete);
	await expect(page.locator("html")).toHaveAttribute("data-delete-not-found-flash", "false");
	await expect(page.getByText("Agent removed", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Open Basic", exact: true })).toHaveCount(0);
	await expect(page.getByTestId("app-sidebar-agent-tiles").getByLabel("Basic")).toHaveCount(0);
	// The deployment is still in the stubbed inventory as `deleting`; dismissal
	// therefore precedes teardown rather than waiting for a completed list read.
	expect(completedDeleteIds.has("hdep_included")).toBe(false);

	const readsBeforeCompletion = deploymentListRequests.length;
	completedDeleteIds.add("hdep_included");
	await page.reload();
	await expect.poll(() => deploymentListRequests.length).toBeGreaterThan(readsBeforeCompletion);
	await expect(page.getByRole("link", { name: "Open Basic", exact: true })).toHaveCount(0);
});

test("hosted locale settings submit canonical deployment PATCH", async ({ page }) => {
	const updateDeploymentRequests: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}> = [];
	await stubHostedApi(page, {
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
		plans: [basicPlan],
		updateDeploymentRequests,
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(railHostedDeployment), "Basic");

	const displayName = page.getByRole("textbox", { name: "Agent name" });
	await displayName.fill("Unsaved Cloud name");
	await page.locator("#hosted-agent-language").click();
	await page.getByRole("option", { name: "Español" }).click();
	await page.getByRole("link", { name: "Sessions", exact: true }).click();
	const discardDialog = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
	await expect(discardDialog).toHaveCount(1);
	await discardDialog.getByRole("button", { name: "Keep editing" }).click();
	await expect(displayName).toHaveValue("Unsaved Cloud name");
	await expect(page.locator("#hosted-agent-language")).toContainText("Español");
	await page.locator("main").getByRole("button", { name: "Save changes" }).click();
	await expect.poll(() => updateDeploymentRequests.length).toBe(1);

	expect(updateDeploymentRequests[0]?.idempotencyKey).toMatch(/^deployment-update-/);
	expect(updateDeploymentRequests[0]?.ifMatch).toBe('"rv_hdep_rail_cloud"');
	expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		language: "es",
	});
});

test("env-keyed failed overview is action-free while Settings keeps management", async ({
	page,
}) => {
	const restartRequests: string[] = [];
	const deleteRequests: string[] = [];
	const failedRestartRead = mutationDeploymentReadFixture(failedMissingProjectionDeployment);
	failedRestartRead.accepted_operation = completedDeploymentOperation(
		failedMissingProjectionDeployment,
		"restart",
	);
	const runtimeFailure = failedRestartRead.resource.status?.failure;
	if (!runtimeFailure) throw new Error("Expected runtime failure fixture");
	runtimeFailure.phase = "reconcile";
	runtimeFailure.detail = "runtime apply failed: internal dashboard prerequisite output";
	runtimeFailure.conditionMessage = "internal runtime health error";
	await stubHostedApi(page, {
		deployments: [failedMissingProjectionDeployment],
		deploymentListResponses: [[failedRestartRead]],
		plans: [basicPlan, performancePlan],
		cloudAgentNotFoundIds: [missingProjectionEnvironmentId],
		restartRequests,
		deleteRequests,
	});

	await page.goto(`/agents/${missingProjectionEnvironmentId}`);
	const main = page.locator("main");
	await expect.poll(() => new URL(page.url()).search).toBe("");
	// The overview renders from deployment authority even while the agent
	// projection 404s; internal failure details never reach the page.
	await expect(main.getByText("Recent sessions", { exact: true })).toBeVisible();
	await expect(main.getByText(missingProjectionFailureReason, { exact: true })).toHaveCount(0);
	await expect(
		main.getByText("Clawdi is checking this agent.", {
			exact: true,
		}),
	).toHaveCount(0);
	await expect(main.getByText("Agent temporarily unavailable", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Agent restart failed", { exact: true })).toHaveCount(0);
	await expect(main.getByText("internal runtime health error", { exact: true })).toHaveCount(0);
	await expect(main.getByText(/dashboard prerequisite/i)).toHaveCount(0);
	const compute = main.locator('[data-overview-status="compute"]');
	await expect(main.getByRole("button", { name: "Chat on the web", exact: true })).toBeDisabled();
	const computeStatus = compute.locator("[data-overview-compute-status]");
	await expect(computeStatus).toHaveText("Temporarily unavailable");
	await expect(computeStatus.locator('[data-slot="status-dot"]')).toHaveAttribute(
		"data-status",
		"warning",
	);
	await expect(compute.getByText("Failed", { exact: true })).toHaveCount(0);
	const sidebarStatus = page.getByTestId("app-sidebar-agent-status");
	await expect(sidebarStatus).toContainText("Temporarily unavailable");
	await expect(sidebarStatus.getByText("Failed", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("alert")).toHaveCount(0);
	await expect(main.getByText("Basic plan", { exact: true })).toBeVisible();
	for (const action of ["Retry startup", "Retry restart", "Start", "Restart", "Delete"])
		await expect(compute.getByRole("button", { name: action, exact: true })).toHaveCount(0);
	await expect(compute.getByRole("button")).toHaveCount(0);
	const computeSettingsLink = compute.getByRole("link", { name: "Compute", exact: true });
	await expect(computeSettingsLink).toHaveAttribute("href", /\/settings/);
	await expect(compute.locator("a a, a button, button a")).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Hermes Dashboard", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();

	expect(restartRequests).toEqual([]);
	await page.setViewportSize({ width: 1280, height: 1400 });

	await computeSettingsLink.click();
	await expect(page).toHaveURL(/\/settings/);
	await expect(
		main.getByText("Clawdi is checking this agent.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await main.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete agent", exact: true })
		.click();
	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_failed_projection"]);
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
				delayMs: 3_000,
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
	await gotoHostedAgentSettings(page, fixtureAgentId(paidBasicDeployment), "Basic");

	await page
		.locator('[data-slot="compute-subscription-card"]')
		.getByRole("button", { name: "Manage", exact: true })
		.click();
	const changeDialog = page.getByRole("dialog");
	await expect(changeDialog).toHaveAccessibleName("Manage compute subscription");
	await expect(
		changeDialog.getByRole("button", { name: "Plan & billing", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await changeDialog.getByRole("combobox", { name: "Compute plan" }).click();
	await page.getByRole("option", { name: "Performance", exact: true }).click();
	await changeDialog.getByRole("button", { name: "Review change" }).click();
	await expect.poll(() => planQuoteRequests.length).toBe(1);
	await expect(changeDialog.getByText("$93.60", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		deployment_id: "hdep_paid",
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
	await expect(
		page
			.locator('[data-slot="compute-subscription-card"]')
			.getByRole("button", { name: "Manage", exact: true }),
	).toBeVisible();
	await expect(page.getByText("Plan changed", { exact: true })).toBeVisible();
	expect(errors, `paid card upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("paid card subscription switches future renewals to Wallet", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [paidBasicDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_card_to_wallet",
				subscriptionId: 42,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_basic",
				targetBillingTermMonths: 12,
				changeKind: "funding_source_switch",
				status: "complete",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_card_to_wallet",
				subscriptionId: 42,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_basic",
				currentBillingTermMonths: 12,
				targetBillingTermMonths: 12,
				changeKind: "funding_source_switch",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 0,
				amountUsd: "0.00",
			}),
		],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(paidBasicDeployment), "Basic");

	await page
		.locator('[data-slot="compute-subscription-card"]')
		.getByRole("button", { name: "Manage", exact: true })
		.click();
	const changeDialog = page.getByRole("dialog");
	await expect(changeDialog).toHaveAccessibleName("Manage compute subscription");
	await changeDialog.getByRole("button", { name: "Payment source", exact: true }).click();
	await changeDialog.getByRole("button", { name: "Wallet", exact: true }).click();
	await changeDialog.getByRole("button", { name: "Review change" }).click();

	await expect.poll(() => planQuoteRequests.length).toBe(1);
	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		deployment_id: "hdep_paid",
		target_plan_slug: "compute_basic",
		target_billing_term_months: 12,
		funding_source: "wallet",
	});
	await expect(changeDialog.getByText("$0.00", { exact: true })).toBeVisible();
	await expect(changeDialog.getByText("Future renewals use Wallet", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Update payment source" }).click();

	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_card_to_wallet",
	});
	await expect(page.getByText("Payment method updated", { exact: true })).toBeVisible();
	await expect(page.getByText("Future renewals will use Wallet.", { exact: true })).toBeVisible();
	expect(errors, `card to Wallet switch: ${errors.join(" | ")}`).toEqual([]);
});

test("accepted plan change recovers from the deployment projection after refresh", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const operation = (status: "awaiting_projection" | "complete") =>
		planChangeResponse({
			operationId: "op_recovered_card",
			subscriptionId: 42,
			fundingSource: "stripe",
			currentPlanSlug: "compute_basic",
			targetPlanSlug: "compute_performance",
			targetBillingTermMonths: 12,
			status,
			effectiveAt: "2026-07-16T00:00:00Z",
		});
	const pendingOperation = operation("awaiting_projection").body;
	const failedOperation: NonNullable<DeploymentRead["accepted_operation"]> = {
		...pendingOperation,
		done: true,
		error: { code: 9, message: "Plan change failed", details: [] },
	};
	const projectedDeployment = mutationDeploymentReadFixture(terminalFallbackDeployment);
	projectedDeployment.accepted_operation = {
		...pendingOperation,
		metadata: { ...pendingOperation.metadata, deploymentId: projectedDeployment.resource.id },
	};
	const terminalDeployment = {
		...projectedDeployment,
		accepted_operation: {
			...failedOperation,
			metadata: { ...failedOperation.metadata, deploymentId: projectedDeployment.resource.id },
		},
	};
	const deployments: DeploymentRead[] = [projectedDeployment];

	await stubHostedApi(page, {
		deployments,
		planChangeRequests,
		plans: [basicPlan, performancePlan],
	});
	await page.route(`${DEPLOY_API}/v2/${pendingOperation.name}`, async (route) => {
		deployments[0] = terminalDeployment;
		await fulfillJson(route, terminalDeployment.accepted_operation);
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(terminalFallbackDeployment), "Basic");
	await page.reload();

	await page.getByRole("button", { name: "Check subscription change status" }).click();
	const recoveryDialog = page.getByRole("dialog", { name: "Check subscription change status" });
	await expect(
		recoveryDialog.getByText(
			"This subscription change was already accepted. Checking its status will not submit another request or charge.",
			{ exact: true },
		),
	).toBeVisible();
	await recoveryDialog.getByRole("button", { name: "Check status", exact: true }).click();
	await expect(page.getByText("Couldn’t update subscription", { exact: true })).toBeVisible();
	await expect(recoveryDialog).toBeHidden();
	await expect(
		page.locator("#compute-plan-controls").getByRole("button", { name: "Choose a subscription" }),
	).toBeVisible();
	expect(planChangeRequests).toEqual([]);
	expect(errors, `recovered plan change: ${errors.join(" | ")}`).toEqual([]);
});

for (const firstTimeViewport of [
	{ label: "desktop", size: { width: 1440, height: 900 } },
	{ label: "320x568", size: { width: 320, height: 568 } },
] as const) {
	test(`first-time Agent connects, links, and pairs a Custom bot at ${firstTimeViewport.label}`, async ({
		page,
	}) => {
		await page.setViewportSize(firstTimeViewport.size);
		const errors = collectBrowserErrors(page);
		const channelId = "11111111-1111-4111-8111-111111111111";
		const linkId = "22222222-2222-4222-8222-222222222222";
		const channelAccounts: unknown[] = [];
		const channelAgentLinks: unknown[] = [];
		const channelBindings: unknown[] = [];
		const createChannelRequests: string[] = [];
		const linkAgentRequests: Array<{ accountId: string; body: string }> = [];
		const pairCodeRequests: string[] = [];
		const validExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
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
			binding_count: 0,
			account: channelAccount,
		};
		await stubHostedApi(page, {
			deployments: [runningMissingProjectionDeployment],
			channelAccounts,
			channelAgentLinks,
			channelBindings,
			createChannelRequests,
			createChannelResponse: {
				status: 201,
				delayMs: 1_500,
				body: {
					...channelAccount,
					webhook_secret: "one-time-webhook-secret",
					agent_link_id: linkId,
					agent_id: missingProjectionEnvironmentId,
					agent_token: "agent-custom-bot-token-must-not-render",
				},
			},
			onCreateChannel: () => {
				channelAccounts.push(channelAccount);
				channelAgentLinks.push(channelLink);
			},
			linkAgentRequests,
			pairCodeRequests,
			pairCodeResponses: [
				{
					status: 201,
					body: {
						id: "connected-bot-pair-code",
						agent_link_id: linkId,
						agent_id: missingProjectionEnvironmentId,
						code: "NPQRSTVWXY",
						expires_at: validExpiry,
						pairing_command: "/clawdi_pair NPQRSTVWXY",
						bot_username: "Browser_Telegram_Bot",
						deep_link: "https://t.me/Browser_Telegram_Bot?start=NPQRSTVWXY",
						qr_payload: "https://t.me/Browser_Telegram_Bot?start=NPQRSTVWXY",
					},
				},
			],
		});

		await page.goto(`/agents/${missingProjectionEnvironmentId}/channel-links`);
		const clawdiSection = page.locator('[data-agent-channel-section="clawdi"]');
		const customSection = page.locator('[data-agent-channel-section="custom"]');
		const unavailableHeading = page.getByRole("heading", { name: "Page Unavailable" });
		await expect(clawdiSection.or(unavailableHeading)).toBeVisible();
		if (await unavailableHeading.isVisible()) {
			await page.getByRole("button", { name: "Try Again", exact: true }).click();
		}
		await expect(clawdiSection.getByText("Clawdi bots", { exact: true })).toBeVisible();
		await expect(customSection.getByText("Custom bots", { exact: true })).toBeVisible();
		await expect(
			clawdiSection.getByText("No Clawdi bots available", { exact: true }),
		).toBeVisible();
		await expect(customSection.getByText("No custom bots yet", { exact: true })).toBeVisible();
		await expectNoHorizontalOverflow(page.locator("html"), `${firstTimeViewport.label} document`);
		await expectNoHorizontalOverflow(clawdiSection, `${firstTimeViewport.label} Clawdi bots`);
		await expectNoHorizontalOverflow(customSection, `${firstTimeViewport.label} Custom bots`);
		const connectCustom = customSection.getByRole("button", {
			name: "Add channel",
			exact: true,
		});
		await expect(connectCustom.getByText("Add channel", { exact: true })).toBeVisible();
		await expectContainedInOwnerAndViewport(
			page,
			connectCustom,
			customSection,
			`${firstTimeViewport.label} Add channel`,
		);

		await connectCustom.click();
		const connectDialog = page.getByRole("dialog", { name: "Add channel" });
		await expect(connectDialog).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await expect(connectDialog).toContainText(
			"Add a Custom bot you manage. When possible, it will be linked to this Agent automatically.",
		);
		const agentInterfaceHint = connectDialog.locator("[data-other-provider-hint]");
		await expect(agentInterfaceHint).toContainText(
			"Need a provider that Clawdi Channels doesn't support?",
		);
		await expect(
			agentInterfaceHint.getByRole("link", { name: "Hermes Dashboard" }),
		).toHaveAttribute("href", `/agents/${missingProjectionEnvironmentId}/console`);
		await expect(agentInterfaceHint.locator('[data-slot="alert"]')).toHaveCount(0);
		await expect(connectDialog.locator("[data-agent-link-warning]")).toHaveCount(0);
		await expect(connectDialog.getByRole("status")).toContainText(
			"The new Custom bot will be linked to this Agent automatically.",
		);
		await connectDialog.getByRole("button", { name: "WhatsApp", exact: true }).click();
		await expect(connectDialog.getByRole("heading", { name: "Configure WhatsApp" })).toBeVisible();
		await expect(connectDialog.getByText("Clawdi WhatsApp", { exact: true })).toHaveCount(0);
		await expect(connectDialog.locator("[data-whatsapp-account-choice] section")).toHaveCount(0);
		await connectDialog.getByRole("button", { name: "Telegram", exact: true }).click();
		await expect(
			connectDialog.getByRole("button", { name: "Telegram", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
		await connectDialog.getByLabel("Name").fill("Browser Telegram");
		await connectDialog.getByLabel("Bot token").fill("123456:browser-test-token");
		await expectNoHorizontalOverflow(
			connectDialog,
			`${firstTimeViewport.label} Connect custom bot Dialog`,
		);
		for (const input of await connectDialog.locator("input").all()) {
			await expectContainedInOwnerAndViewport(
				page,
				input,
				connectDialog,
				`${firstTimeViewport.label} Custom bot credential input`,
			);
		}
		const submitCustomBot = connectDialog.getByRole("button", {
			name: "Add custom bot",
			exact: true,
		});
		await expectContainedInOwnerAndViewport(
			page,
			submitCustomBot,
			connectDialog,
			`${firstTimeViewport.label} Connect custom bot submit`,
		);

		await submitCustomBot.click();
		const connecting = connectDialog.getByRole("button", { name: "Adding…", exact: true });
		await expect(connecting).toBeVisible();
		for (const providerChoice of await connectDialog
			.getByRole("group", { name: "Choose provider" })
			.getByRole("button")
			.all()) {
			await expect(providerChoice).toBeDisabled();
		}
		await expectContainedInOwnerAndViewport(
			page,
			connecting,
			connectDialog,
			`${firstTimeViewport.label} pending Connect custom bot`,
		);

		await expect.poll(() => createChannelRequests.length).toBe(1);
		expect(JSON.parse(createChannelRequests[0] ?? "{}")).toEqual({
			provider: "telegram",
			name: "Browser Telegram",
			provider_token: "123456:browser-test-token",
			agent_id: missingProjectionEnvironmentId,
		});
		expect(linkAgentRequests).toEqual([]);

		await expect.poll(() => pairCodeRequests.length).toBe(1);
		const pairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
		await expect(connectDialog).toHaveCount(0);
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await expect(pairDialog.getByRole("img", { name: "Telegram pairing QR code" })).toBeVisible();
		await expectNoHorizontalOverflow(
			pairDialog,
			`${firstTimeViewport.label} first-time Telegram Pair Dialog`,
		);
		await expectContainedInOwnerAndViewport(
			page,
			pairDialog.getByRole("button", { name: "Open Telegram" }),
			pairDialog,
			`${firstTimeViewport.label} first-time Open Telegram`,
		);

		expect(JSON.parse(pairCodeRequests[0] ?? "{}")).toEqual({
			ttl_seconds: 300,
			agent_link_id: linkId,
		});
		await expect(page.locator("body")).not.toContainText("agent-custom-bot-token-must-not-render");
		await page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname === "/v1/channels/agent-links" && response.request().method() === "GET";
		});
		const pairingObservedAt = Date.now();
		channelBindings.push({
			id: "33333333-3333-4333-8333-333333333333",
			account_id: channelId,
			agent_link_id: linkId,
			external_chat_id: "first-time-private-chat",
			external_chat_type: "private",
			external_chat_name: "First-time private chat",
			status: "active",
			created_at: "2026-08-01T01:00:00Z",
			last_message_at: null,
		});
		channelLink.binding_count = 1;
		await expect(pairDialog).toHaveCount(0, { timeout: 5_000 });
		const pairingElapsed = Date.now() - pairingObservedAt;
		console.log(
			`[channel-pairing-e2e] ${firstTimeViewport.label} polling convergence: ${pairingElapsed}ms`,
		);
		expect(pairingElapsed).toBeGreaterThanOrEqual(2_000);
		expect(pairingElapsed).toBeLessThan(4_500);
		const successToast = page.locator("[data-sonner-toast]").filter({ hasText: "Chat paired" });
		await expect(successToast).toHaveCount(1);
		await expect(successToast).toContainText("Telegram chat is ready.");
		await expectNoHorizontalOverflow(
			successToast,
			`${firstTimeViewport.label} first-time pair success toast`,
		);
		await expectContainedInOwnerAndViewport(
			page,
			successToast,
			page.locator("html"),
			`${firstTimeViewport.label} first-time pair success toast`,
		);

		await expect(page.getByText("No connected channels", { exact: true })).toHaveCount(0);
		await expect(page.getByText("Browser Telegram", { exact: true }).first()).toBeVisible();
		await expect(
			page.locator(`[data-agent-paired-chats-trigger="${linkId}"]`),
		).toHaveAccessibleName("1 paired chat");
		expect(
			errors,
			`${firstTimeViewport.label} first-time channel path: ${errors.join(" | ")}`,
		).toEqual([]);
	});
}

test("channel detail links, pairs, and unlinks an Agent in place", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const errors = collectBrowserErrors(page);
	const channelId = "11111111-1111-4111-8111-111111111112";
	const agentId = "55555555-5555-4555-8555-555555555556";
	const linkId = "22222222-2222-4222-8222-222222222223";
	const sharedChannelId = "11111111-1111-4111-8111-111111111114";
	const sharedAgentId = "55555555-5555-4555-8555-555555555557";
	const sharedLinkId = "22222222-2222-4222-8222-222222222224";
	const channelAgentLinks: unknown[] = [];
	const linkAgentRequests: Array<{ accountId: string; body: string }> = [];
	const unlinkAgentRequests: string[] = [];
	const pairCodeRequests: string[] = [];
	const channelAccount = {
		id: channelId,
		provider: "telegram",
		name: "Channel Detail Telegram",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud.example.test/channels/detail",
		created_at: "2026-08-20T12:00:00Z",
	};
	const channelLink = {
		id: linkId,
		account_id: channelId,
		agent_id: agentId,
		status: "active",
		runtime_status: "connecting",
		created_at: "2026-08-20T12:05:00Z",
	};
	const sharedChannelLink = {
		id: sharedLinkId,
		account_id: sharedChannelId,
		agent_id: sharedAgentId,
		status: "active",
		runtime_status: "connecting",
		created_at: "2026-08-20T12:04:00Z",
	};
	await stubHostedApi(page, {
		channelAccount,
		channelAccounts: [channelAccount],
		channelBotPool: {
			providers: {
				telegram: [
					{
						id: sharedChannelId,
						provider: "telegram",
						name: "Shared Channel Telegram",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://cloud.example.test/channels/shared",
						created_at: "2026-08-20T12:00:00Z",
						access: "public",
						capabilities: {
							link_agent: true,
							pair_chat: true,
							send_message: true,
							manage_account: false,
							sync_commands: false,
						},
						link_count: 0,
						max_links: null,
						available: true,
					},
				],
			},
		},
		channelAgentLinks,
		channelBindings: [],
		cloudAgents: [
			{
				id: agentId,
				name: "channel-agent",
				default_name: "Channel Agent",
				machine_name: "channel-agent.local",
				display_name: "Channel Agent",
				avatar_url: null,
				sort_order: 0,
				agent_type: "hermes",
				agent_version: "1.0.0",
				os: "linux",
				last_seen_at: "2026-08-20T12:00:00Z",
				last_sync_at: "2026-08-20T12:00:00Z",
			},
			{
				id: sharedAgentId,
				name: "shared-bot-agent",
				default_name: "Shared Bot Agent",
				machine_name: "shared-bot-agent.local",
				display_name: "Shared Bot Agent",
				avatar_url: null,
				sort_order: 1,
				agent_type: "hermes",
				agent_version: "1.0.0",
				os: "linux",
				last_seen_at: "2026-08-20T12:00:00Z",
				last_sync_at: "2026-08-20T12:00:00Z",
			},
		],
		linkAgentRequests,
		linkAgentResponses: [
			{ body: sharedChannelLink, status: 201 },
			{ body: channelLink, status: 201 },
		],
		onLinkAgent: (response) => channelAgentLinks.push(response),
		unlinkAgentRequests,
		onUnlinkAgent: () => channelAgentLinks.splice(0),
		pairCodeRequests,
		pairCodeResponses: [
			{
				status: 201,
				body: {
					id: "channel-list-pair-code",
					agent_link_id: sharedLinkId,
					agent_id: sharedAgentId,
					code: "LISTPAIR",
					expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
					pairing_command: "/clawdi_pair LISTPAIR",
					bot_username: "Channel_List_Bot",
					deep_link: "https://t.me/Channel_List_Bot?start=LISTPAIR",
					qr_payload: "https://t.me/Channel_List_Bot?start=LISTPAIR",
				},
			},
			{
				status: 201,
				body: {
					id: "channel-detail-pair-code",
					agent_link_id: linkId,
					agent_id: agentId,
					code: "DETAILPAIR",
					expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
					pairing_command: "/clawdi_pair DETAILPAIR",
					bot_username: "Channel_Detail_Bot",
					deep_link: "https://t.me/Channel_Detail_Bot?start=DETAILPAIR",
					qr_payload: "https://t.me/Channel_Detail_Bot?start=DETAILPAIR",
				},
			},
		],
	});

	await page.goto("/channels");
	const sharedBotCard = page.locator(`[data-shared-channel-account-id="${sharedChannelId}"]`);
	await sharedBotCard.getByRole("button", { name: "Link Agent", exact: true }).click();
	const sharedBotLinkDialog = page.getByRole("dialog", { name: "Link Agent" });
	await sharedBotLinkDialog.getByRole("combobox", { name: "Agent" }).click();
	await page.getByRole("option", { name: "Shared Bot Agent" }).click();
	await sharedBotLinkDialog.getByRole("button", { name: "Link Agent", exact: true }).click();
	await expect
		.poll(() => linkAgentRequests)
		.toEqual([{ accountId: sharedChannelId, body: JSON.stringify({ agent_id: sharedAgentId }) }]);
	const sharedPairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
	await expect(
		sharedPairDialog.getByRole("img", { name: "Telegram pairing QR code" }),
	).toBeVisible();
	await expect.poll(() => pairCodeRequests).toHaveLength(1);
	expect(JSON.parse(pairCodeRequests[0] ?? "{}")).toEqual({
		ttl_seconds: 300,
		agent_link_id: sharedLinkId,
	});
	await page.keyboard.press("Escape");
	await expect(sharedPairDialog).toHaveCount(0);
	await expect(page).toHaveURL("/channels");

	await page.goto(`/channels/${channelId}`);
	await expect(page.getByRole("heading", { name: "Channel Detail Telegram" })).toBeVisible();
	await page.getByRole("button", { name: "Link Agent", exact: true }).click();
	const linkDialog = page.getByRole("dialog", { name: "Link Agent" });
	await linkDialog.getByRole("combobox", { name: "Agent" }).click();
	await page.getByRole("option", { name: "Channel Agent" }).click();
	await linkDialog.getByRole("button", { name: "Link Agent", exact: true }).click();

	await expect
		.poll(() => linkAgentRequests)
		.toEqual([
			{ accountId: sharedChannelId, body: JSON.stringify({ agent_id: sharedAgentId }) },
			{ accountId: channelId, body: JSON.stringify({ agent_id: agentId }) },
		]);
	const pairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
	await expect(pairDialog.getByRole("img", { name: "Telegram pairing QR code" })).toBeVisible();
	await expect.poll(() => pairCodeRequests).toHaveLength(2);
	expect(JSON.parse(pairCodeRequests[1] ?? "{}")).toEqual({
		ttl_seconds: 300,
		agent_link_id: linkId,
	});
	await expect(page).toHaveURL(`/channels/${channelId}`);
	await expectNoHorizontalOverflow(pairDialog, "Channel detail pairing dialog");

	await page.keyboard.press("Escape");
	await expect(pairDialog).toHaveCount(0);

	const linkedAgent = page.locator(`[data-channel-agent-link-id="${linkId}"]`);
	await expect(linkedAgent.getByText("Channel Agent", { exact: true })).toBeVisible();
	await linkedAgent.getByRole("button", { name: "Unlink Agent" }).click();
	const unlinkDialog = page.getByRole("alertdialog", { name: "Unlink Agent?" });
	await unlinkDialog.getByRole("button", { name: "Unlink Agent", exact: true }).click();
	await expect
		.poll(() => unlinkAgentRequests)
		.toEqual([`/v1/channels/${channelId}/agent-links/${linkId}`]);
	await expect(page.getByText("No Agents linked", { exact: true })).toBeVisible();
	await expect(page).toHaveURL(`/channels/${channelId}`);
	expect(errors, `channel detail relationship flow: ${errors.join(" | ")}`).toEqual([]);
});
