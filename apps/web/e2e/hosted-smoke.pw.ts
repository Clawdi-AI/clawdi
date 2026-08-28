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

async function expectOverviewResourceGeometry(grid: Locator, expectedRows: readonly number[]) {
	const [gridBox, cards, shellMetrics] = await Promise.all([
		grid.boundingBox(),
		grid
			.locator("[data-overview-module]")
			.evaluateAll((elements) =>
				elements.map((element) => element.getBoundingClientRect().toJSON()),
			),
		grid.locator("[data-overview-module]").evaluateAll((elements) =>
			elements.map((element) => {
				const cardBox = element.getBoundingClientRect();
				const header = element.querySelector<HTMLElement>('[data-slot="card-header"]');
				const headerLink = header?.querySelector<HTMLElement>("a");
				const linkBox = headerLink?.getBoundingClientRect();
				const headerStyle = header ? getComputedStyle(header) : null;
				const linkStyle = headerLink ? getComputedStyle(headerLink) : null;
				return {
					headerHeight: header?.getBoundingClientRect().height ?? 0,
					headerCount: element.querySelectorAll(':scope > [data-slot="card-header"]').length,
					contentCount: element.querySelectorAll('[data-slot="card-content"]').length,
					headerPaddingInline: [headerStyle?.paddingLeft, headerStyle?.paddingRight],
					headerPaddingBlock: [headerStyle?.paddingTop, headerStyle?.paddingBottom],
					linkPadding: [
						linkStyle?.paddingTop,
						linkStyle?.paddingRight,
						linkStyle?.paddingBottom,
						linkStyle?.paddingLeft,
					],
					verticalInsetDelta: linkBox
						? Math.abs(linkBox.top - cardBox.top - (cardBox.bottom - linkBox.bottom))
						: Number.POSITIVE_INFINITY,
				};
			}),
		),
	]);
	expect(gridBox).not.toBeNull();
	expect(cards).toHaveLength(expectedRows.reduce((total, count) => total + count, 0));
	const rowYs = [...new Set(cards.map((card) => Math.round(card.y)))];
	const rows = rowYs.map((rowY) => cards.filter((card) => Math.abs(card.y - rowY) <= 2));
	expect(rows.map((row) => row.length)).toEqual(expectedRows);
	expect(
		Math.max(...cards.map((card) => card.width)) - Math.min(...cards.map((card) => card.width)),
	).toBeLessThanOrEqual(2);
	for (const row of rows) {
		expect(
			Math.max(...row.map((card) => card.height)) - Math.min(...row.map((card) => card.height)),
		).toBeLessThanOrEqual(2);
	}
	for (const card of cards) {
		expect(card.x).toBeGreaterThanOrEqual((gridBox?.x ?? 0) - 1);
		expect(card.x + card.width).toBeLessThanOrEqual((gridBox?.x ?? 0) + (gridBox?.width ?? 0) + 1);
	}
	const finalRow = rows.at(-1) ?? [];
	expect(finalRow).not.toHaveLength(0);
	expect(Math.abs((finalRow[0]?.x ?? 0) - (gridBox?.x ?? 0))).toBeLessThanOrEqual(2);
	const overflow = await grid.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
	expect(new Set(shellMetrics.map((metric) => metric.headerHeight)).size).toBe(1);
	expect(shellMetrics[0]?.headerHeight ?? 0).toBeGreaterThan(0);
	expect(new Set(shellMetrics.map((metric) => metric.headerCount))).toEqual(new Set([1]));
	expect(new Set(shellMetrics.map((metric) => metric.contentCount))).toEqual(new Set([0]));
	expect(new Set(shellMetrics.map((metric) => JSON.stringify(metric.headerPaddingInline)))).toEqual(
		new Set([JSON.stringify(["16px", "16px"])]),
	);
	expect(new Set(shellMetrics.map((metric) => JSON.stringify(metric.linkPadding)))).toEqual(
		new Set([JSON.stringify(["0px", "0px", "0px", "0px"])]),
	);
	for (const metric of shellMetrics) expect(metric.verticalInsetDelta).toBeLessThanOrEqual(1);
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

async function _expectOverviewSessionSlot({
	region,
	statusCard,
	realCount,
}: {
	region: Locator;
	statusCard: Locator;
	realCount: number;
}) {
	const grid = region.getByTestId("overview-session-grid");
	const placeholders = grid.getByTestId("overview-session-placeholder");
	await expect(grid.locator(":scope > article")).toHaveCount(realCount);
	await expect(placeholders).toHaveCount(3 - realCount);
	await expect(grid.getByRole("link")).toHaveCount(realCount);
	await expect(placeholders.locator("a, button, article")).toHaveCount(0);
	const cardAlignment = await grid.locator(":scope > article").evaluateAll((articles) =>
		articles.map((article) => {
			const avatar = article.querySelector<HTMLElement>('[data-testid="session-card-avatar"]');
			const textBlock = article.querySelector<HTMLElement>('[data-testid="session-card-text"]');
			const avatarBox = avatar?.getBoundingClientRect();
			const textBox = textBlock?.getBoundingClientRect();
			return {
				avatarCenter: (avatarBox?.top ?? 0) + (avatarBox?.height ?? 0) / 2,
				textCenter: (textBox?.top ?? 0) + (textBox?.height ?? 0) / 2,
			};
		}),
	);
	for (const alignment of cardAlignment)
		expect(Math.abs(alignment.avatarCenter - alignment.textCenter)).toBeLessThanOrEqual(2);
	const placeholderSemantics = await placeholders.evaluateAll((elements) =>
		elements.map((element) => ({
			ariaHidden: element.getAttribute("aria-hidden"),
			role: element.getAttribute("role"),
			tabIndex: element.getAttribute("tabindex"),
			pointerEvents: getComputedStyle(element).pointerEvents,
		})),
	);
	for (const placeholder of placeholderSemantics) {
		expect(placeholder).toEqual({
			ariaHidden: "true",
			role: null,
			tabIndex: null,
			pointerEvents: "none",
		});
	}
	const slotRows = grid.locator(
		':scope > article, :scope > [data-testid="overview-session-placeholder"]',
	);
	await expect(slotRows).toHaveCount(3);
	const rowBoxes = await slotRows.evaluateAll((elements) =>
		elements.map((element) => element.getBoundingClientRect().toJSON()),
	);
	expect(
		Math.max(...rowBoxes.map((box) => box.height)) - Math.min(...rowBoxes.map((box) => box.height)),
	).toBeLessThanOrEqual(2);
	for (let index = 1; index < rowBoxes.length; index += 1) {
		expect(Math.abs(rowBoxes[index].x - rowBoxes[0].x)).toBeLessThanOrEqual(1);
		expect(Math.abs(rowBoxes[index].width - rowBoxes[0].width)).toBeLessThanOrEqual(1);
	}
	const [regionBox, gridBox, statusBox] = await Promise.all([
		region.boundingBox(),
		grid.boundingBox(),
		statusCard.boundingBox(),
	]);
	expect(regionBox).not.toBeNull();
	expect(gridBox).not.toBeNull();
	expect(statusBox).not.toBeNull();
	expect(Math.abs((gridBox?.height ?? 0) - (regionBox?.height ?? 0))).toBeLessThanOrEqual(2);
	expect(Math.abs((statusBox?.y ?? 0) - (regionBox?.y ?? 0))).toBeLessThanOrEqual(2);
	expect(
		Math.abs(
			(statusBox?.y ?? 0) +
				(statusBox?.height ?? 0) -
				((regionBox?.y ?? 0) + (regionBox?.height ?? 0)),
		),
	).toBeLessThanOrEqual(2);
	return regionBox?.height ?? 0;
}

async function expectInlineSidebarStatus(sidebar: Locator, source: "hosted" | "connected") {
	const status = sidebar.getByTestId("app-sidebar-agent-status");
	await expect(status).toHaveAttribute("data-agent-status-source", source);
	await expect(status.locator("[aria-hidden]").first()).toBeVisible();
	const shell = await status.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			backgroundColor: style.backgroundColor,
			borderWidths: [
				style.borderTopWidth,
				style.borderRightWidth,
				style.borderBottomWidth,
				style.borderLeftWidth,
			],
			padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
		};
	});
	expect(new Set(shell.borderWidths)).toEqual(new Set(["0px"]));
	expect(new Set(shell.padding)).toEqual(new Set(["0px"]));
	expect(shell.backgroundColor).toBe("rgba(0, 0, 0, 0)");
}

async function expectAgentOverviewTypography(page: Page) {
	const main = page.locator("main");
	const sectionTitleMetrics = await main
		.locator('h2[id$="recent-sessions"], [data-agent-overview] section > div > h2')
		.evaluateAll((elements) =>
			elements.map((element) => {
				const style = getComputedStyle(element);
				return { fontSize: style.fontSize, fontWeight: style.fontWeight };
			}),
		);
	expect(sectionTitleMetrics.length).toBeGreaterThan(1);
	expect(new Set(sectionTitleMetrics.map(({ fontSize }) => fontSize))).toEqual(new Set(["14px"]));
	expect(new Set(sectionTitleMetrics.map(({ fontWeight }) => fontWeight))).toEqual(
		new Set(["600"]),
	);

	const cardTitleMetrics = await main
		.locator(
			'[data-overview-status] [data-slot="card-title"], [data-overview-module] [data-slot="card-title"]',
		)
		.evaluateAll((elements) =>
			elements.map((element) => {
				const style = getComputedStyle(element);
				return { fontSize: style.fontSize, fontWeight: style.fontWeight };
			}),
		);
	expect(cardTitleMetrics.length).toBeGreaterThan(3);
	expect(new Set(cardTitleMetrics.map(({ fontSize }) => fontSize))).toEqual(new Set(["14px"]));
	expect(new Set(cardTitleMetrics.map(({ fontWeight }) => fontWeight))).toEqual(new Set(["500"]));

	const primaryMetrics = await main
		.locator("[data-overview-primary-value]")
		.evaluateAll((elements) =>
			elements.map((element) => {
				const style = getComputedStyle(element);
				return { fontSize: style.fontSize, fontWeight: style.fontWeight };
			}),
		);
	expect(primaryMetrics.length).toBeGreaterThan(3);
	expect(new Set(primaryMetrics.map(({ fontSize }) => fontSize))).toEqual(new Set(["14px"]));
	expect(new Set(primaryMetrics.map(({ fontWeight }) => fontWeight))).toEqual(new Set(["400"]));

	const metadataMetrics = await main
		.locator(
			'[data-testid="session-card-meta"], [data-overview-status] dl, [data-testid="overview-compute-summary"] ul',
		)
		.evaluateAll((elements) =>
			elements.map((element) => {
				const style = getComputedStyle(element);
				return { fontSize: style.fontSize, color: style.color };
			}),
		);
	expect(metadataMetrics.length).toBeGreaterThan(2);
	expect(new Set(metadataMetrics.map(({ fontSize }) => fontSize))).toEqual(new Set(["12px"]));
	expect(new Set(metadataMetrics.map(({ color }) => color)).size).toBe(1);
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

function hostedOverviewSessionsPage(itemCount: number) {
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
			agent_type: "hermes",
			machine_name: "hermes-3",
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

async function _expectVisibleLobeHubIconsContained(page: Page, minimumCount: number) {
	const icons = page.locator('[data-icon-source="lobehub"]:visible');
	await expect.poll(() => icons.count()).toBeGreaterThanOrEqual(minimumCount);
	const measurements = await icons.evaluateAll((elements) =>
		elements.map((element) => {
			const icon = element.getBoundingClientRect();
			const tile = element.parentElement?.getBoundingClientRect();
			return {
				width: element.getAttribute("width"),
				height: element.getAttribute("height"),
				iconWidth: icon.width,
				iconHeight: icon.height,
				tileWidth: tile?.width ?? 0,
				tileHeight: tile?.height ?? 0,
				contained: Boolean(
					tile &&
						icon.left >= tile.left &&
						icon.top >= tile.top &&
						icon.right <= tile.right &&
						icon.bottom <= tile.bottom,
				),
				noOverflow: Boolean(
					element.parentElement &&
						element.parentElement.scrollWidth <= element.parentElement.clientWidth &&
						element.parentElement.scrollHeight <= element.parentElement.clientHeight,
				),
			};
		}),
	);
	for (const measurement of measurements) {
		expect(["70%", "75%", "84%"]).toContain(measurement.width);
		expect(measurement.height).toBe(measurement.width);
		expect(measurement.contained).toBe(true);
		expect(measurement.noOverflow).toBe(true);
		const expectedRatio = Number.parseInt(measurement.width ?? "", 10) / 100;
		expect(measurement.iconWidth).toBeCloseTo((measurement.tileWidth - 2) * expectedRatio, 1);
		expect(measurement.iconHeight).toBeCloseTo((measurement.tileHeight - 2) * expectedRatio, 1);
	}
}

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

function _deferred() {
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

const _dynamicManagedModelCatalog: { models: ManagedModelCatalogItem[] } = {
	models: [
		{
			id: "gpt-5.6-terra",
			display_name: "GPT-5.6 Terra",
			provider_id: "openai-codex",
			is_default: true,
			is_featured: true,
			description: "Balanced cost for everyday work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.6-luna",
			display_name: "GPT-5.6 Luna",
			provider_id: "openai-codex",
			is_default: false,
			is_featured: true,
			description: "Low cost for routine work.",
			capabilities: textModelCapabilities,
		},
		{
			id: "gpt-5.6-sol",
			display_name: "GPT-5.6 Sol",
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
			display_name: "GPT-5.4 mini",
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
			display_name: "Kimi For Coding HighSpeed",
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

const _deepSeekProxyProvider = {
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

const _performanceDeployment = {
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

const _stoppedIncludedBasicDeployment = {
	...includedBasicDeployment,
	id: "hdep_stopped",
	name: "Stopped Basic",
	status: "stopped",
};

const _stoppedProjectionEnvironmentId = "44444444-4444-4444-8444-444444444444";
const _stoppedProjectionGoneDeployment: DeploymentMutationFixture = {
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

const retainedProjectionEnvironmentId = "66666666-6666-4666-8666-666666666666";
const retainedProjectionFailureReason =
	"startup_probe_failing; restart_count=4; runtime daemon exited and is no longer reachable";
const _failedRetainedProjectionDeployment = {
	...includedBasicDeployment,
	id: "hdep_failed_retained_projection",
	agent_id: retainedProjectionEnvironmentId,
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
const _olderSharedEnvironmentDeployment = {
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

const _interruptedIdentitylessDeployment = {
	...includedBasicDeployment,
	id: "hdep_creation_interrupted",
	name: "Interrupted deployment",
	status: "failed",
	failure_reason: "creation_interrupted",
};

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

const _walletPastDueDeployment = {
	...walletActiveDeployment,
	compute_subscription: {
		...walletActiveDeployment.compute_subscription,
		status: "past_due",
		payment_state: "past_due",
		latest_failed_invoice_id: "in_wallet_open",
		next_payment_attempt_at: "2026-07-16T00:00:00Z",
	},
};

const _cardPastDueDeployment = {
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

const _cancelPendingBasicDeployment = {
	...paidBasicDeployment,
	id: "hdep_cancel_pending",
	name: "Cancel-pending Basic",
	compute_subscription: {
		...paidBasicDeployment.compute_subscription,
		cancel_at_period_end: true,
		cancel_at: "2027-07-15T00:00:00Z",
	},
};

const _walletAnnualDeployment = {
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

function _checkoutDeployRequestId(requestBody: string): string | null {
	const request: unknown = JSON.parse(requestBody);
	if (!isRecord(request) || !isRecord(request.deploy_config)) return null;
	return typeof request.deploy_config.deploy_request_id === "string"
		? request.deploy_config.deploy_request_id
		: null;
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

async function _stubRetriedStripeCheckoutLoad(page: Page) {
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

async function _expectNoQuarterlyCopy(page: Page) {
	await expect(page.getByText("Quarterly", { exact: true })).toHaveCount(0);
	await expect(page.getByText(/\/qtr/)).toHaveCount(0);
}

async function _expectActionCenterUncovered(action: Locator) {
	await expect(action).toBeVisible();
	expect(
		await action.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return hit !== null && (hit === element || element.contains(hit));
		}),
	).toBe(true);
}

async function _capturePricingScreenshot(page: Page, path: string) {
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

async function _captureModelScreenshot(page: Page, path: string) {
	const modelPicker = page.locator("#deploy-catalog-model");
	await modelPicker.evaluate((element) => {
		element.scrollIntoView({ block: "center", inline: "nearest" });
	});
	await page.waitForTimeout(100);
	await modelPicker.locator("xpath=ancestor::section[1]").screenshot({ path });
}

const AI_CHOICE_VIEWPORTS = [
	{ height: 900, modelColumns: 4, providerColumns: 2, width: 1280 },
	{ height: 900, modelColumns: 2, providerColumns: 1, width: 800 },
	{ height: 900, modelColumns: 2, providerColumns: 2, width: 700 },
	{ height: 844, modelColumns: 1, providerColumns: 1, width: 390 },
] as const;

async function aiChoiceLayoutMetrics(page: Page) {
	return page.evaluate(() => {
		const rect = (element: Element) => {
			const box = element.getBoundingClientRect();
			return { left: box.left, right: box.right, top: box.top, width: box.width };
		};
		const lineCount = (element: Element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			return new Set(Array.from(range.getClientRects()).map((box) => Math.round(box.top * 10)))
				.size;
		};
		const providerGrid = document.querySelector('[data-testid="provider-choice-grid"]');
		const modelGrid = document.querySelector('[data-testid="managed-model-choices"]');
		const modelPicker = document.querySelector('[data-testid="model-binding-picker"]');
		if (!providerGrid || !modelGrid || !modelPicker) return null;
		const modelPickerStyle = getComputedStyle(modelPicker);
		return {
			document: {
				clientWidth: document.documentElement.clientWidth,
				scrollWidth: document.documentElement.scrollWidth,
			},
			model: {
				cards: Array.from(modelGrid.querySelectorAll(":scope > label")).map(rect),
				columns: getComputedStyle(modelGrid).gridTemplateColumns.split(/\s+/).filter(Boolean)
					.length,
				descriptions: Array.from(modelGrid.querySelectorAll('[id$="-description"]')).map(
					(description) => ({
						clientWidth: description.clientWidth,
						lineClamp: getComputedStyle(description).webkitLineClamp,
						lines: lineCount(description),
						scrollWidth: description.scrollWidth,
					}),
				),
				grid: rect(modelGrid),
				scrollWidth: modelGrid.scrollWidth,
				titles: Array.from(modelGrid.querySelectorAll('[id$="-title"]')).map((title) => ({
					clientWidth: title.clientWidth,
					lines: lineCount(title),
					overflow: getComputedStyle(title).overflow,
					scrollWidth: title.scrollWidth,
					text: title.textContent?.trim() ?? "",
					textOverflow: getComputedStyle(title).textOverflow,
				})),
			},
			picker: {
				backgroundColor: modelPickerStyle.backgroundColor,
				borderTopWidth: Number.parseFloat(modelPickerStyle.borderTopWidth),
				paddingTop: Number.parseFloat(modelPickerStyle.paddingTop),
				rect: rect(modelPicker),
			},
			provider: {
				cards: Array.from(providerGrid.querySelectorAll(":scope > button, :scope > a")).map(rect),
				columns: getComputedStyle(providerGrid).gridTemplateColumns.split(/\s+/).filter(Boolean)
					.length,
				grid: rect(providerGrid),
				scrollWidth: providerGrid.scrollWidth,
			},
		};
	});
}

async function _expectResponsiveAiChoiceLayout(
	page: Page,
	surface: "agent" | "deploy",
	screenshotPath: (width: number) => string,
) {
	for (const viewport of AI_CHOICE_VIEWPORTS) {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await expect(page.getByTestId("managed-model-choices")).toBeVisible();
		const metrics = await aiChoiceLayoutMetrics(page);
		expect(metrics, `${surface} layout at ${viewport.width}px`).not.toBeNull();
		if (!metrics) continue;
		expect(metrics.document.scrollWidth, `${surface} document at ${viewport.width}px`).toBe(
			metrics.document.clientWidth,
		);
		expect(metrics.provider.columns, `${surface} provider columns at ${viewport.width}px`).toBe(
			viewport.providerColumns,
		);
		expect(metrics.model.columns, `${surface} model columns at ${viewport.width}px`).toBe(
			viewport.modelColumns,
		);
		expect(metrics.provider.scrollWidth, `${surface} provider grid overflow`).toBeLessThanOrEqual(
			metrics.provider.grid.width,
		);
		expect(metrics.model.scrollWidth, `${surface} model grid overflow`).toBeLessThanOrEqual(
			metrics.model.grid.width,
		);
		expect(metrics.provider.grid.right, `${surface} provider grid right edge`).toBeLessThanOrEqual(
			viewport.width,
		);
		expect(metrics.model.grid.right, `${surface} model grid right edge`).toBeLessThanOrEqual(
			viewport.width,
		);
		expect(metrics.picker.rect.right, `${surface} picker right edge`).toBeLessThanOrEqual(
			viewport.width,
		);
		expect(metrics.picker).toMatchObject({
			backgroundColor: "rgba(0, 0, 0, 0)",
			borderTopWidth: 0,
			paddingTop: 0,
		});
		for (const card of metrics.model.cards) {
			expect(
				card.width,
				`${surface} model card width at ${viewport.width}px`,
			).toBeGreaterThanOrEqual(200);
		}
		for (const title of metrics.model.titles) {
			expect(
				title.scrollWidth,
				`${surface} ${title.text} title at ${viewport.width}px`,
			).toBeLessThanOrEqual(title.clientWidth);
			expect(title.textOverflow, `${surface} ${title.text} title ellipsis`).not.toBe("ellipsis");
			expect(title.overflow, `${surface} ${title.text} title clipping`).not.toBe("hidden");
			if (viewport.width === 1280) {
				expect(title.lines, `${surface} ${title.text} desktop title`).toBe(1);
			}
		}
		for (const description of metrics.model.descriptions) {
			expect(description.scrollWidth, `${surface} model description overflow`).toBeLessThanOrEqual(
				description.clientWidth,
			);
			expect(description.lineClamp, `${surface} model description clamp`).toBe("2");
			expect(description.lines, `${surface} model description lines`).toBeLessThanOrEqual(2);
		}
		const providerGrid = page.getByTestId("provider-choice-grid");
		await providerGrid.evaluate((element) => element.scrollIntoView({ block: "center" }));
		await providerGrid.locator("..").screenshot({ path: screenshotPath(viewport.width) });
	}
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

async function expectPointerCursor(locator: ReturnType<Page["locator"]>, label: string) {
	const cursor = await locator.evaluate((element) => getComputedStyle(element).cursor);
	expect(cursor, `${label} cursor`).toBe("pointer");
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

	await context.route("https://runtime.example/**", async (route) => {
		if (route.request().frame().parentFrame()) {
			const gate = nextFrameGate;
			nextFrameGate = null;
			if (gate) {
				gate.signalStarted();
				await gate.released;
			}
		}
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
	const dashboardContent = page.getByTestId("dashboard-page-content");
	await expect(launcher).toBeHidden();
	await expect(dashboardContent).toHaveCSS("padding-bottom", "20px");

	await page.locator('a[href="/agents"]').first().click();
	await expect(page).toHaveURL("/agents");
	await expect(launcher).toBeVisible();
	await expect(dashboardContent).toHaveCSS("padding-bottom", "80px");
});

test("hosted agent overview uses the modular hierarchy", async ({ page }, testInfo) => {
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

	const overview = page.locator('[data-agent-overview="hosted"]');
	const overviewHeading = page.getByRole("heading", { name: "Hosted agent", exact: true });
	const overviewTitleRow = overviewHeading.locator("..");
	await expect(overviewTitleRow.getByText("Cloud", { exact: true })).toHaveCount(1);
	await expect(overviewTitleRow.getByText("Legacy", { exact: true })).toHaveCount(0);
	await expect(overview.getByRole("heading", { name: "Workspace", exact: true })).toBeVisible({
		timeout: 12_000,
	});
	await expect(overview.getByRole("heading", { name: "Shared", exact: true })).toBeVisible();
	await expect(overview.locator("[data-overview-access-scope]")).toHaveCount(0);
	expect(
		await overview
			.locator("[data-overview-module]")
			.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-overview-module"))),
	).toEqual([
		"projects",
		"skills",
		"vaults",
		"memories",
		"connectors",
		"model-provider",
		"channels",
	]);
	expect(
		await page
			.locator("#hosted-recent-sessions, #agent-overview-workspace, #agent-overview-shared")
			.evaluateAll((headings) => headings.map((heading) => heading.id)),
	).toEqual(["hosted-recent-sessions", "agent-overview-workspace", "agent-overview-shared"]);
	await expect(overview.locator('[data-overview-module] [data-slot="card-title"]')).toHaveCount(7);
	await expect(
		overview.locator('[data-overview-module] [data-slot="card-description"]'),
	).toHaveCount(7);
	expect(
		await overview
			.locator("[data-overview-module]")
			.evaluateAll((cards) =>
				cards.map((card) => card.querySelectorAll(':scope > [data-slot="card-content"]').length),
			),
	).toEqual([0, 0, 0, 0, 0, 0, 0]);
	await expect(overview.locator('[data-overview-module] > [data-slot="card-header"]')).toHaveCount(
		7,
	);
	await expect(overview.locator("[data-overview-module-error]")).toHaveCount(0);
	await expect(
		overview.locator(
			"[data-overview-module] a a, [data-overview-module] a button, [data-overview-module] button a",
		),
	).toHaveCount(0);
	await expect(overview.getByRole("heading", { name: "Tools", exact: true })).toBeVisible();
	await expect(overview.locator('[data-overview-module="sessions"]')).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="projects"]')).not.toContainText(
		"Hosted Agent Project",
	);
	await expect(overview.getByText("Default Project", { exact: true })).toHaveCount(0);
	await expect(overview.getByTestId("agent-project-grid")).toHaveCount(0);
	expect(agentProjectRequests).toHaveLength(1);
	expect(skillRequests).toEqual([]);
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
	const sessionBoxes = await recentSessions.locator("article").evaluateAll((cards) =>
		cards.map((card) => {
			const rect = card.getBoundingClientRect();
			const title = card.querySelector<HTMLElement>('[data-testid="session-card-title"]');
			const meta = card.querySelector<HTMLElement>('[data-testid="session-card-meta"]');
			const titleStyle = title ? getComputedStyle(title) : null;
			return {
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				metaOffset: (meta?.getBoundingClientRect().y ?? rect.y) - rect.y,
				titleWhiteSpace: titleStyle?.whiteSpace,
				titleOverflow: titleStyle?.overflow,
				titleTextOverflow: titleStyle?.textOverflow,
				titleClipped: (title?.scrollWidth ?? 0) > (title?.clientWidth ?? 0),
			};
		}),
	);
	expect(
		Math.max(...sessionBoxes.map((box) => box.height)) -
			Math.min(...sessionBoxes.map((box) => box.height)),
	).toBeLessThanOrEqual(2);
	expect(Math.min(...sessionBoxes.map((box) => box.height))).toBeGreaterThanOrEqual(64);
	expect(Math.max(...sessionBoxes.map((box) => box.height))).toBeLessThanOrEqual(72);
	expect(sessionBoxes[2]?.titleWhiteSpace).toBe("nowrap");
	expect(sessionBoxes[2]?.titleOverflow).toBe("hidden");
	expect(sessionBoxes[2]?.titleTextOverflow).toBe("ellipsis");
	expect(sessionBoxes[2]?.titleClipped).toBe(true);
	expect(
		Math.max(...sessionBoxes.map((box) => box.metaOffset)) -
			Math.min(...sessionBoxes.map((box) => box.metaOffset)),
	).toBeLessThanOrEqual(1);
	for (let index = 1; index < sessionBoxes.length; index += 1) {
		expect(Math.abs(sessionBoxes[index].x - sessionBoxes[0].x)).toBeLessThanOrEqual(1);
		expect(Math.abs(sessionBoxes[index].width - sessionBoxes[0].width)).toBeLessThanOrEqual(1);
		expect(sessionBoxes[index].y).toBeGreaterThanOrEqual(
			sessionBoxes[index - 1].y + sessionBoxes[index - 1].height,
		);
	}
	const [recentSessionsBox, computeBox, viewAllBox] = await Promise.all([
		recentSessions.boundingBox(),
		page.locator('[data-overview-status="compute"]').boundingBox(),
		viewAllSessions.boundingBox(),
	]);
	expect(
		Math.abs(
			(viewAllBox?.x ?? 0) +
				(viewAllBox?.width ?? 0) -
				((recentSessionsBox?.x ?? 0) + (recentSessionsBox?.width ?? 0)),
		),
	).toBeLessThanOrEqual(2);
	expect(Math.abs((computeBox?.y ?? 0) - (recentSessionsBox?.y ?? 0))).toBeLessThanOrEqual(2);
	expect(
		Math.abs(
			(computeBox?.y ?? 0) +
				(computeBox?.height ?? 0) -
				((recentSessionsBox?.y ?? 0) + (recentSessionsBox?.height ?? 0)),
		),
	).toBeLessThanOrEqual(2);
	await expect(overview.locator('[data-overview-module="agent-interface"]')).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Open Agent Interface" })).toHaveAttribute(
		"href",
		/console/,
	);
	const compute = page.locator('[data-overview-status="compute"]');
	await expect(compute).toContainText("Running");
	await expect(compute).toContainText("Basic plan");
	await expect(compute.getByRole("link", { name: "Compute", exact: true })).toHaveAttribute(
		"href",
		/\/settings/,
	);
	await expect(compute.getByRole("button")).toHaveCount(0);
	await expect(compute.locator("a a, a button, button a")).toHaveCount(0);
	const computePlanTypography = await compute
		.locator("[data-overview-compute-plan]")
		.evaluate((element) => {
			const style = getComputedStyle(element);
			return { fontSize: style.fontSize, fontWeight: style.fontWeight };
		});
	expect(computePlanTypography).toEqual({ fontSize: "14px", fontWeight: "400" });
	await expect(compute.getByTestId("overview-compute-summary")).not.toHaveClass(
		/rounded|border|bg-/,
	);
	await expect(
		compute.getByRole("list", {
			name: "Configuration: 2 vCPU, 4 GiB memory, 20 GiB storage",
		}),
	).toBeVisible();
	await expect(page.getByText("Your agent is running", { exact: true })).toHaveCount(0);
	await expect(overview.locator('[data-slot="badge"]')).toHaveCount(0);
	await expect(overview.getByTestId("overview-channel-rail")).toHaveCount(0);
	await expect(overview.getByTestId("overview-connector-rail")).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="model-provider"]')).toContainText("Model");
	expect(aiProviderRequests).toEqual([]);
	await expect.poll(() => managedModelRequests.length).toBe(1);
	for (const configuration of ["2 vCPU", "4 GiB memory", "20 GiB storage"])
		await expect(compute.getByText(configuration, { exact: true })).toBeVisible();
	await expect(compute.getByText("Plan", { exact: true })).toHaveCount(0);
	await expect(compute.getByText("CPU", { exact: true })).toHaveCount(0);
	await expect(compute.getByText("Memory", { exact: true })).toHaveCount(0);
	await expect(compute.getByText("Storage", { exact: true })).toHaveCount(0);
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
	).toHaveAttribute(
		"href",
		`/agents/${railHostedEnvironmentId}/project-access/project-hosted/vaults`,
	);
	await expect(overview.locator('[data-overview-module="memories"]')).toContainText("1 memory");
	await expect(overview.locator('[data-overview-module="connectors"]')).toContainText(
		"2 connected",
	);
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
	await expect(vaultsLink).toHaveAttribute("href", `${expectedProjectHub}/vaults`);
	await vaultsLink.focus();
	await expect(vaultsLink).toBeFocused();
	await vaultsLink.click();
	await expect(page).toHaveURL(`${expectedProjectHub}/vaults`);
	await expect(vaultsLink).toHaveAttribute("data-active", "");
	await expect(skillsLink).not.toHaveAttribute("data-active", "");
	await page.goto(`/agents/${railHostedEnvironmentId}`);
	await expect(overview.locator("[data-overview-module]")).toHaveCount(7);
	await expect(overview.getByText("Scope", { exact: true })).toHaveCount(0);
	await expect(overview.getByText("Access", { exact: true })).toHaveCount(0);
	await expect(overview.getByText("Managed", { exact: true })).toHaveCount(0);
	await expect(overview.getByText("Activity and current state", { exact: true })).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="live-sync"]')).toHaveCount(0);
	const workspaceGrid = overview.locator(
		'section[aria-labelledby="agent-overview-workspace"] [data-overview-layout="three-column"]',
	);
	const sharedGrid = overview.locator(
		'section[aria-labelledby="agent-overview-shared"] [data-overview-layout="three-column"]',
	);
	const toolsGrid = overview.locator(
		'section[aria-labelledby="agent-overview-operate"] [data-overview-layout="three-column"]',
	);
	const resourceGeometry = await workspaceGrid
		.locator("[data-overview-module]")
		.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().toJSON()));
	expect(resourceGeometry).toHaveLength(3);
	expect(
		Math.max(...resourceGeometry.map((box) => box.width)) -
			Math.min(...resourceGeometry.map((box) => box.width)),
	).toBeLessThanOrEqual(2);
	for (const rowY of new Set(resourceGeometry.map((box) => Math.round(box.y)))) {
		const row = resourceGeometry.filter((box) => Math.abs(box.y - rowY) <= 2);
		expect(
			Math.max(...row.map((box) => box.height)) - Math.min(...row.map((box) => box.height)),
		).toBeLessThanOrEqual(2);
	}
	expect(
		await workspaceGrid
			.locator("[data-overview-module]")
			.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-overview-module"))),
	).toEqual(["projects", "skills", "vaults"]);
	await expectOverviewResourceGeometry(workspaceGrid, [3]);
	await expectOverviewResourceGeometry(sharedGrid, [2]);
	await expectOverviewResourceGeometry(toolsGrid, [2]);
	const toolGeometry = await toolsGrid
		.locator("[data-overview-module]")
		.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().toJSON()));
	expect(toolGeometry).toHaveLength(2);
	for (let index = 0; index < toolGeometry.length; index += 1) {
		expect(
			Math.abs((toolGeometry[index]?.width ?? 0) - (resourceGeometry[index]?.width ?? 0)),
		).toBeLessThanOrEqual(2);
		expect(
			Math.abs((toolGeometry[index]?.x ?? 0) - (resourceGeometry[index]?.x ?? 0)),
		).toBeLessThanOrEqual(2);
	}
	const moduleHeights = [...resourceGeometry, ...toolGeometry].map((box) => box.height);
	expect(Math.max(...moduleHeights) - Math.min(...moduleHeights)).toBeLessThanOrEqual(2);
	for (const height of moduleHeights) {
		expect(Math.abs(height - (sessionBoxes[0]?.height ?? 0))).toBeLessThanOrEqual(2);
	}
	expect((toolGeometry[1]?.x ?? 0) + (toolGeometry[1]?.width ?? 0)).toBeLessThan(
		(resourceGeometry[2]?.x ?? 0) + 1,
	);
	await expectAgentOverviewTypography(page);
	await page.setViewportSize({ width: 1024, height: 1200 });
	await expectOverviewResourceGeometry(workspaceGrid, [2, 1]);
	await expectOverviewResourceGeometry(sharedGrid, [2]);
	await expectOverviewResourceGeometry(toolsGrid, [2]);
	await page.setViewportSize({ width: 768, height: 1200 });
	await expectOverviewResourceGeometry(workspaceGrid, [1, 1, 1]);
	await expectOverviewResourceGeometry(sharedGrid, [1, 1]);
	await expectOverviewResourceGeometry(toolsGrid, [1, 1]);
	await page.setViewportSize({ width: 390, height: 1200 });
	await expectOverviewResourceGeometry(workspaceGrid, [1, 1, 1]);
	await expectOverviewResourceGeometry(sharedGrid, [1, 1]);
	await expectOverviewResourceGeometry(toolsGrid, [1, 1]);
	const [mobileSessionsBox, mobileViewAllBox] = await Promise.all([
		recentSessions.boundingBox(),
		viewAllSessions.boundingBox(),
	]);
	expect((mobileViewAllBox?.y ?? 0) + (mobileViewAllBox?.height ?? 0)).toBeLessThanOrEqual(
		(mobileSessionsBox?.y ?? 0) + 1,
	);
	expect(
		Math.abs(
			(mobileViewAllBox?.x ?? 0) +
				(mobileViewAllBox?.width ?? 0) -
				((mobileSessionsBox?.x ?? 0) + (mobileSessionsBox?.width ?? 0)),
		),
	).toBeLessThanOrEqual(2);
	await page.screenshot({
		path: testInfo.outputPath("hosted-agent-overview-mobile.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
	const mobileSidebar = page.getByRole("dialog");
	await expectInlineSidebarStatus(mobileSidebar, "hosted");
	await page.screenshot({
		path: testInfo.outputPath("hosted-sidebar-status-mobile.png"),
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 1280, height: 1600 });
	await page.screenshot({ path: testInfo.outputPath("hosted-agent-overview.png"), fullPage: true });
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await expect(page.locator("html")).toHaveClass(/dark/);
	await page.waitForTimeout(250);
	await page.screenshot({
		path: testInfo.outputPath("hosted-agent-overview-dark.png"),
		fullPage: true,
	});
	await page.locator("html").evaluate((element) => element.classList.remove("dark"));
	await page.goto(`/agents/${railHostedEnvironmentId}/sessions`);
	const sessionsHeading = page.getByRole("heading", { name: "Sessions", exact: true });
	await expect(sessionsHeading).toBeVisible();
	await expect(sessionsHeading.locator("..").getByText("Cloud", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Open Agent Interface" })).toHaveCount(0);
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

test("agent provider creation stays in context and updates only after Save changes", async ({
	page,
}) => {
	const providerAcceptRequests: string[] = [];
	const updateDeploymentRequests: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}> = [];
	const createdProvider: AiProvider = {
		...userProvider("openai", "OpenAI", [{ id: "gpt-5", label: "GPT-5" }]),
		type: "openai",
		base_url: "https://api.openai.com/v1",
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
	await dialog.getByRole("button", { name: /^OpenAI/ }).click();
	await expect(dialog).toHaveAccessibleName("Set up OpenAI");
	await dialog.getByRole("textbox", { name: "API key" }).fill("sk-e2e-agent-provider");
	await dialog.getByRole("button", { name: "Add provider", exact: true }).click();

	await expect(dialog).toBeHidden();
	await expect.poll(() => providerAcceptRequests.length).toBe(1);
	expect(page.url()).toBe(agentPageUrl);
	const providerCard = page
		.getByTestId("provider-choice-grid")
		.getByRole("button", { pressed: true })
		.filter({ hasText: "OpenAI" });
	await expect(providerCard).toContainText("Selected");
	const mainModel = page.getByRole("combobox", { name: "Main model" });
	await expect(mainModel).toBeVisible();
	const accountProviderLink = page
		.locator("main p")
		.filter({ hasText: "Add, validate, or remove providers" })
		.getByRole("link", { name: "AI Providers" });
	await expect(accountProviderLink).toHaveAttribute("href", "/ai-providers");
	expect(updateDeploymentRequests).toEqual([]);

	await mainModel.fill("gpt-5-confirmed");
	expect(updateDeploymentRequests).toEqual([]);
	await page.locator("main").getByRole("button", { name: "Save changes" }).click();
	await expect.poll(() => updateDeploymentRequests.length).toBe(1);
	expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		ai_provider_auth_kind: "api_key",
		ai_provider_id: "openai",
		provider_ids: ["openai"],
		primary_model: { provider_id: "openai", model: "gpt-5-confirmed" },
	});
});

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
		await expect(dashboardContent).toHaveCSS("padding-bottom", "0px");
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
		await expect(dashboardContent).toHaveCSS("padding-bottom", "0px");
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
	expect(
		await openButton.evaluate((button) => button === button.parentElement?.lastElementChild),
	).toBe(true);
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
		await expect(rail.getByTestId("app-sidebar-agent-loading-slot")).toHaveCount(2);
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
	const notificationCenter = page.getByRole("button", { name: "Notification Center" });
	await expectNoHorizontalOverflow(header, "Wallet header at 320px");
	await expect(separator).toHaveCSS("width", "1px");
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
					touchPage.getByRole("button", { name: "Notification Center" }),
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
	await expectPointerCursor(cloudButton, "Cloud tile");
	await expectPointerCursor(connectedButton, "connected tile");
	await expect(rail.getByRole("button", { name: /^Reorder / })).toHaveCount(0);
	await expect(rail.getByTitle(/^Reorder /)).toHaveCount(0);
	const cloudMarker = rail.locator('[data-agent-rail-corner-marker="cloud"]');
	const legacyMarker = rail.locator('[data-agent-rail-corner-marker="legacy"]');
	await expect(cloudMarker).toHaveCount(1);
	await expect(legacyMarker).toHaveCount(1);
	const [cloudMarkerBox, legacyMarkerBox, cloudIconBox, legacyIconBox] = await Promise.all([
		cloudMarker.boundingBox(),
		legacyMarker.boundingBox(),
		cloudMarker.locator("svg").boundingBox(),
		legacyMarker.locator("svg").boundingBox(),
	]);
	if (!cloudMarkerBox || !legacyMarkerBox || !cloudIconBox || !legacyIconBox) {
		throw new Error("Cloud and Legacy rail corner markers should render.");
	}
	expect(cloudMarkerBox.width).toBe(legacyMarkerBox.width);
	expect(cloudMarkerBox.height).toBe(legacyMarkerBox.height);
	expect(cloudIconBox.width).toBe(legacyIconBox.width);
	expect(cloudIconBox.height).toBe(legacyIconBox.height);
	expect(cloudMarkerBox.width).toBe(20);
	expect(cloudIconBox.width).toBe(14);

	const connectedTileBox = await rail
		.getByTestId("app-sidebar-agent-tile")
		.filter({ hasText: "Rail Connected" })
		.boundingBox();
	const connectedButtonBox = await connectedButton.boundingBox();
	if (!connectedTileBox || !connectedButtonBox) {
		throw new Error("Hosted rail agent tile should be a whole interactive button.");
	}
	expect(connectedTileBox.height).toBeCloseTo(68, 0);
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
}, testInfo) => {
	await stubHostedApi(page, {
		agentResourceFixtures: true,
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
	});
	const query = "";
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/agents/${railHostedEnvironmentId}/memories${query}`);

	const breadcrumb = page.locator('[data-slot="breadcrumb-list"]');
	expect(
		await breadcrumb.evaluate((element) =>
			Array.from(element.children).map((child) => child.tagName),
		),
	).toEqual(["LI", "LI", "LI"]);
	await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]:visible')).toHaveText([
		"e2e-2",
		"Memories",
	]);
	await expect(breadcrumb.locator('[data-slot="breadcrumb-separator"]:visible')).toHaveCount(1);
	await page.screenshot({
		path: testInfo.outputPath("responsive-breadcrumb-desktop.png"),
		fullPage: false,
	});

	await page.setViewportSize({ width: 320, height: 568 });
	await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]:visible')).toHaveText([
		"Memories",
	]);
	await expect(breadcrumb.locator('[data-slot="breadcrumb-separator"]:visible')).toHaveCount(0);
	await expectNoHorizontalOverflow(page.locator("header"), "breadcrumb header at 320px");
	await page.screenshot({
		path: testInfo.outputPath("responsive-breadcrumb-320x568.png"),
		fullPage: false,
	});
});

test("Console keeps its desktop columns and places Recent sessions last on narrow screens", async ({
	page,
}, testInfo) => {
	await stubHostedApi(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/");

	const main = page.locator("main");
	const activity = main.getByText("Activity", { exact: true });
	const library = main.getByText("Library", { exact: true });
	const recentSessions = main.getByRole("heading", { name: "Recent sessions", exact: true });
	await expect(recentSessions).toBeVisible();

	const [desktopActivity, desktopLibrary, desktopRecent] = await Promise.all([
		activity.boundingBox(),
		library.boundingBox(),
		recentSessions.boundingBox(),
	]);
	if (!desktopActivity || !desktopLibrary || !desktopRecent) {
		throw new Error("Console sections should render in the desktop grid.");
	}
	expect(desktopRecent.y).toBeGreaterThan(desktopActivity.y);
	expect(desktopLibrary.x).toBeGreaterThan(desktopActivity.x);

	await page.setViewportSize({ width: 320, height: 568 });
	const sectionOrder = await main
		.locator('[data-slot="card-title"], h2')
		.evaluateAll((elements) =>
			elements
				.map((element) => element.textContent?.trim())
				.filter((text) =>
					["Activity", "Library", "Last 7 days", "Recent sessions"].includes(text ?? ""),
				),
		);
	expect(sectionOrder).toEqual(["Activity", "Library", "Last 7 days", "Recent sessions"]);

	const connectAgent = main.getByRole("button", { name: "Connect an agent on your machine" });
	await expect(connectAgent).toBeVisible();
	await expectContainedInOwnerAndViewport(
		page,
		connectAgent,
		connectAgent.locator(".."),
		"320px onboarding action",
	);
	await expectNoHorizontalOverflow(page.locator("html"), "320px Console document");
	await page.screenshot({
		path: testInfo.outputPath("console-320x568.png"),
		fullPage: true,
	});

	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoHorizontalOverflow(page.locator("html"), "390px Console document");
	await page.screenshot({
		path: testInfo.outputPath("console-390x844.png"),
		fullPage: true,
	});

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
	await expect(
		page.getByText("Setup usually takes about 7–10 minutes.", { exact: false }),
	).toBeVisible();
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
	await expect(
		page.getByText("Cleanup continues in the background.", { exact: true }),
	).toBeVisible();
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
}, testInfo) => {
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
		main.getByText("Clawdi is checking the runtime. Open Compute settings for details.", {
			exact: true,
		}),
	).toHaveCount(1);
	await expect(main.getByText("Agent temporarily unavailable", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Agent restart failed", { exact: true })).toHaveCount(0);
	await expect(main.getByText("internal runtime health error", { exact: true })).toHaveCount(0);
	await expect(main.getByText(/dashboard prerequisite/i)).toHaveCount(0);
	const compute = main.locator('[data-overview-status="compute"]');
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
	await expect(page.getByRole("link", { name: "Agent Interface", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();

	expect(restartRequests).toEqual([]);
	await page.setViewportSize({ width: 1280, height: 1400 });
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await page.screenshot({
		path: testInfo.outputPath("hosted-agent-overview-failed-dark.png"),
		fullPage: true,
	});
	await page.locator("html").evaluate((element) => element.classList.remove("dark"));

	await computeSettingsLink.click();
	await expect(page).toHaveURL(/\/settings/);
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
	const failedOperation = {
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

	await stubHostedApi(page, {
		deployments: [terminalDeployment],
		deploymentListResponses: [[projectedDeployment], [projectedDeployment]],
		planChangeRequests,
		planChangeOperationResponses: [{ body: terminalDeployment.accepted_operation, status: 200 }],
		plans: [basicPlan, performancePlan],
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
	const retryDialog = page.getByRole("dialog", { name: "Change compute subscription" });
	await expect(retryDialog).toBeVisible();
	await retryDialog.getByRole("button", { name: "Cancel", exact: true }).click();
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
	}, testInfo) => {
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
		await expect(connectCustom.locator("svg")).toHaveCount(1);
		await expect(connectCustom.getByText("Add channel", { exact: true })).toBeVisible();
		await expectContainedInOwnerAndViewport(
			page,
			connectCustom,
			customSection,
			`${firstTimeViewport.label} Add channel`,
		);
		await page.screenshot({
			path: testInfo.outputPath(`agent-first-time-bot-groups-${firstTimeViewport.label}.png`),
			fullPage: false,
		});

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
		await expect(agentInterfaceHint.getByRole("link", { name: "Agent Interface" })).toHaveAttribute(
			"href",
			`/agents/${missingProjectionEnvironmentId}/console`,
		);
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
		await connectDialog.screenshot({
			path: testInfo.outputPath(`agent-first-time-custom-bot-form-${firstTimeViewport.label}.png`),
		});

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
		await connectDialog.screenshot({
			path: testInfo.outputPath(
				`agent-first-time-custom-bot-pending-${firstTimeViewport.label}.png`,
			),
		});
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
		await pairDialog.screenshot({
			path: testInfo.outputPath(`agent-first-time-pair-telegram-${firstTimeViewport.label}.png`),
		});
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
		await page.screenshot({
			path: testInfo.outputPath(`agent-first-time-pair-success-${firstTimeViewport.label}.png`),
			fullPage: false,
		});
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
