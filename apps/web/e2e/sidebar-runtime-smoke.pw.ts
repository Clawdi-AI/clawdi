import { expect, type Locator, type Page, type Route, test } from "@playwright/test";

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
				const card = element.getBoundingClientRect();
				const header = element.querySelector<HTMLElement>('[data-slot="card-header"]');
				const headerLink = header?.querySelector<HTMLElement>("a");
				const content = element.querySelector<HTMLElement>('[data-slot="card-content"]');
				const linkStyle = headerLink ? getComputedStyle(headerLink) : null;
				const contentStyle = content ? getComputedStyle(content) : null;
				return {
					headerHeight: header?.getBoundingClientRect().height ?? 0,
					contentOffset: (content?.getBoundingClientRect().y ?? card.y) - card.y,
					headerPaddingInline: [linkStyle?.paddingLeft, linkStyle?.paddingRight],
					headerPaddingBlock: [linkStyle?.paddingTop, linkStyle?.paddingBottom],
					contentPadding: [
						contentStyle?.paddingLeft,
						contentStyle?.paddingRight,
						contentStyle?.paddingBottom,
					],
				};
			}),
		),
	]);
	expect(gridBox).not.toBeNull();
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
	const contentMetrics = shellMetrics.filter((metric) => metric.contentOffset > 0);
	expect(contentMetrics.length).toBeGreaterThan(0);
	expect(new Set(contentMetrics.map((metric) => JSON.stringify(metric.contentPadding))).size).toBe(
		1,
	);
	expect(Number.parseFloat(contentMetrics[0]?.contentPadding[2] ?? "0")).toBeGreaterThan(0);
}

async function expectOverviewSessionSlot({
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
	for (const placeholder of placeholderSemantics)
		expect(placeholder).toEqual({
			ariaHidden: "true",
			role: null,
			tabIndex: null,
			pointerEvents: "none",
		});
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
	const [regionBox, gridBox, statusBox] = await Promise.all([
		region.boundingBox(),
		grid.boundingBox(),
		statusCard.boundingBox(),
	]);
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

async function sessionCardVisualContract(card: Locator) {
	await expect(card).toHaveCount(1);
	await expect(card.locator(":scope > a")).toHaveCount(1);
	await expect(card.locator("a a, a button, button a")).toHaveCount(0);
	return card.evaluate((article) => {
		const link = article.querySelector<HTMLElement>(":scope > a");
		const avatar = article.querySelector<HTMLElement>('[data-testid="session-card-avatar"]');
		const text = article.querySelector<HTMLElement>('[data-testid="session-card-text"]');
		const title = article.querySelector<HTMLElement>('[data-testid="session-card-title"]');
		const meta = article.querySelector<HTMLElement>('[data-testid="session-card-meta"]');
		if (!link || !avatar || !text || !title || !meta) throw new Error("Incomplete SessionCard");
		const cardBox = article.getBoundingClientRect();
		const avatarBox = avatar.getBoundingClientRect();
		const textBox = text.getBoundingClientRect();
		const linkStyle = getComputedStyle(link);
		const titleStyle = getComputedStyle(title);
		const metaStyle = getComputedStyle(meta);
		return {
			height: cardBox.height,
			avatarSize: [avatarBox.width, avatarBox.height],
			centerDelta: Math.abs(avatarBox.y + avatarBox.height / 2 - (textBox.y + textBox.height / 2)),
			padding: [
				linkStyle.paddingTop,
				linkStyle.paddingRight,
				linkStyle.paddingBottom,
				linkStyle.paddingLeft,
			],
			gap: linkStyle.gap,
			title: [
				titleStyle.fontSize,
				titleStyle.fontWeight,
				titleStyle.lineHeight,
				titleStyle.whiteSpace,
				titleStyle.overflow,
				titleStyle.textOverflow,
			],
			meta: [metaStyle.fontSize, metaStyle.fontWeight, metaStyle.lineHeight, metaStyle.color],
			directChildren: Array.from(link.children).map((child) => child.getAttribute("data-testid")),
		};
	});
}

async function expectNoHorizontalOverflow(locator: Locator) {
	const overflow = await locator.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
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

	const detailMetrics = await main
		.locator('[data-testid="overview-resource-badges"] [data-slot="badge"]')
		.evaluateAll((elements) =>
			elements.map((element) => {
				const style = getComputedStyle(element);
				return { fontSize: style.fontSize, fontWeight: style.fontWeight };
			}),
		);
	expect(detailMetrics.length).toBeGreaterThan(0);
	expect(new Set(detailMetrics.map(({ fontSize }) => fontSize))).toEqual(new Set(["12px"]));
	expect(new Set(detailMetrics.map(({ fontWeight }) => fontWeight))).toEqual(new Set(["500"]));

	const metadataMetrics = await main
		.locator('[data-testid="session-card-meta"], [data-overview-status] dl')
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

const now = new Date("2026-07-04T12:00:00.000Z");

const agents = [
	{
		id: "agent-smoke-1",
		name: "smoke-codex",
		default_name: "Smoke Codex",
		machine_name: "smoke-machine.local",
		display_name: "Smoke Codex",
		avatar_url: null,
		sort_order: 0,
		agent_type: "codex",
		agent_version: "1.0.0",
		os: "linux",
		last_seen_at: now.toISOString(),
		last_sync_at: now.toISOString(),
		last_sync_error: null,
		last_revision_seen: 12,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: "project-smoke",
	},
	{
		id: "agent-smoke-2",
		name: "smoke-hermes",
		default_name: "Smoke Hermes",
		machine_name: "smoke-hermes.local",
		display_name: "Smoke Hermes",
		avatar_url: null,
		sort_order: 1,
		agent_type: "hermes",
		agent_version: "1.0.0",
		os: "linux",
		last_seen_at: now.toISOString(),
		last_sync_at: now.toISOString(),
		last_sync_error: null,
		last_revision_seen: 8,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: "project-smoke",
	},
];

const projects = [
	{
		id: "project-smoke",
		name: "Smoke Project",
		slug: "smoke-project",
		kind: "environment",
		origin_environment_id: "agent-smoke-1",
		archived_at: null,
		created_at: now.toISOString(),
		is_owner: true,
		owner_display: "Dev User",
		owner_handle: "dev-user",
	},
	{
		id: "project-unrelated",
		name: "Unrelated Project",
		slug: "unrelated-project",
		kind: "workspace",
		origin_environment_id: null,
		archived_at: null,
		created_at: now.toISOString(),
		is_owner: true,
		owner_display: "Dev User",
		owner_handle: "dev-user",
	},
];

const projectBindings = [
	{
		id: "binding-primary",
		agent_id: "agent-smoke-1",
		project_id: "project-smoke",
		binding_type: "primary",
		priority: 0,
		default_write_enabled: true,
		created_at: now.toISOString(),
	},
];

const vaults = {
	items: [
		{
			id: "vault-scoped",
			slug: "scoped-vault",
			name: "Scoped Vault",
			project_ids: ["project-smoke"],
			is_owner: true,
			item_count: 2,
			created_at: now.toISOString(),
		},
		{
			id: "vault-unrelated",
			slug: "unrelated-vault",
			name: "Unrelated Vault",
			project_ids: ["project-unrelated"],
			is_owner: true,
			item_count: 3,
			created_at: now.toISOString(),
		},
	],
	total: 2,
	page: 1,
	page_size: 200,
};

const dashboardStats = {
	total_sessions: 1,
	total_messages: 2,
	total_tokens: 300,
	active_days: 1,
	current_streak: 1,
	longest_streak: 1,
	peak_hour: 12,
	favorite_model: "gpt-5",
	skills_count: 1,
	memories_count: 1,
	vault_count: 1,
	vault_keys_count: 1,
	connectors_count: 1,
	manual_sessions_last_7_days: 1,
	contribution: [{ date: "2026-07-04", count: 1, level: 1 }],
};

const sessions = {
	items: [
		{
			id: "session-smoke-1",
			local_session_id: "local-smoke-1",
			project_path: "/smoke",
			agent_name: "smoke-codex",
			agent_display_name: "Smoke Codex",
			agent_default_name: "Smoke Codex",
			agent_type: "codex",
			machine_name: "smoke-machine.local",
			started_at: now.toISOString(),
			ended_at: null,
			updated_at: now.toISOString(),
			last_activity_at: now.toISOString(),
			duration_seconds: 60,
			message_count: 2,
			input_tokens: 100,
			output_tokens: 200,
			cache_read_tokens: 0,
			model: "gpt-5",
			models_used: ["gpt-5"],
			summary: "Smoke session",
			tags: [],
			status: "active",
			content_hash: "smoke-hash",
		},
	],
	total: 1,
	page: 1,
	page_size: 25,
};
const overviewSessions = {
	...sessions,
	items: Array.from({ length: 5 }, (_, index) => ({
		...sessions.items[0],
		id: `session-overview-${index + 1}`,
		local_session_id: `local-overview-${index + 1}`,
		summary: [
			"Plan release",
			"Review customer notes before the quarterly planning meeting",
			"Investigate a very long synchronization issue affecting several workspaces and prepare a clear remediation plan for the team before the next release review with every regional owner",
			"Draft update",
			"Fifth hidden session",
		][index],
		message_count: index + 2,
		input_tokens: [8, 1200, 18_500, 420, 60][index],
		output_tokens: [4, 340, 9200, 80, 20][index],
		last_activity_at: new Date(now.getTime() - index * 60 * 60 * 1000).toISOString(),
	})),
	total: 5,
	page_size: 3,
};

function connectedOverviewSessionsPage(itemCount: number) {
	return {
		...overviewSessions,
		items: overviewSessions.items.slice(0, itemCount),
		total: itemCount,
	};
}

const memories = {
	items: [
		{
			id: "memory-smoke-1",
			content: "Shared account context",
			category: "context",
			tags: ["shared"],
			source: "web",
			source_session_id: null,
			source_machine_name: "smoke-machine.local",
			access_count: 1,
			created_at: now.toISOString(),
		},
	],
	total: 1,
	page: 1,
	page_size: 25,
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

type DashboardApiStubOptions = {
	sessionsPage?: unknown;
	sessionRequests?: string[];
	connectorConnections?: readonly unknown[];
	connectorConnectionsGate?: Promise<void>;
	connectorConnectionsResponse?: { body: unknown; status: number };
	connectorCatalog?: readonly {
		name: string;
		display_name: string;
		logo: string;
		description: string;
		auth_type: string;
		connect_disabled: boolean;
		connect_disabled_reason: null;
	}[];
	connectorCatalogGate?: Promise<void>;
	connectorCatalogResponse?: { body: unknown; status: number };
	connectorMetadataRequests?: string[];
	projectBindingRequests?: string[];
	projectRequests?: string[];
	projectBindings?: readonly unknown[];
	projectBindingsError?: { status: number; detail: string };
	projectBindingsGate?: Promise<void>;
	projects?: readonly unknown[];
	projectsGate?: Promise<void>;
	projectsResponse?: { body: unknown; status: number };
	skillRequests?: string[];
	skillsByProjectId?: Readonly<Record<string, readonly unknown[]>>;
	vaultRequests?: string[];
};

async function stubDashboardApi(
	page: Page,
	agentOrderRequests: string[] = [],
	options: DashboardApiStubOptions = {},
) {
	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/v1/agents/order" && route.request().method() === "PATCH") {
			agentOrderRequests.push(route.request().postData() ?? "");
			const requested = JSON.parse(route.request().postData() ?? "{}") as {
				agent_ids?: string[];
			};
			const byId = new Map(agents.map((agent) => [agent.id, agent]));
			const ordered = (requested.agent_ids ?? [])
				.map((id) => byId.get(id))
				.filter((agent) => agent !== undefined)
				.map((agent, index) => ({ ...agent, sort_order: index }));
			await fulfillJson(route, ordered);
			return;
		}
		if (url.pathname === "/v1/agents") {
			await fulfillJson(route, agents);
			return;
		}
		const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
		if (agentMatch) {
			const agent = agents.find((candidate) => candidate.id === decodeURIComponent(agentMatch[1]));
			await fulfillJson(route, agent ?? { detail: "Agent not found" });
			return;
		}
		if (url.pathname === "/v1/agents/agent-smoke-1/project-bindings") {
			options.projectBindingRequests?.push(route.request().url());
			await options.projectBindingsGate;
			if (options.projectBindingsError) {
				await fulfillJson(
					route,
					{ detail: options.projectBindingsError.detail },
					options.projectBindingsError.status,
				);
				return;
			}
			await fulfillJson(route, options.projectBindings ?? projectBindings);
			return;
		}
		if (url.pathname === "/v1/dashboard/stats") {
			await fulfillJson(route, dashboardStats);
			return;
		}
		if (url.pathname === "/v1/projects") {
			options.projectRequests?.push(route.request().url());
			await options.projectsGate;
			if (options.projectsResponse) {
				await fulfillJson(route, options.projectsResponse.body, options.projectsResponse.status);
				return;
			}
			await fulfillJson(route, options.projects ?? projects);
			return;
		}
		if (url.pathname === "/v1/skills") {
			options.skillRequests?.push(route.request().url());
			const projectId = url.searchParams.get("project_id") ?? "";
			const pageNumber = Number(url.searchParams.get("page") ?? "1");
			const pageSize = Number(url.searchParams.get("page_size") ?? "25");
			const projectSkills = options.skillsByProjectId?.[projectId] ?? [];
			const start = (pageNumber - 1) * pageSize;
			await fulfillJson(route, {
				items: projectSkills.slice(start, start + pageSize),
				total: projectSkills.length,
				page: pageNumber,
				page_size: pageSize,
			});
			return;
		}
		if (url.pathname === "/v1/vault") {
			options.vaultRequests?.push(route.request().url());
			const projectId = url.searchParams.get("project_id");
			const items = projectId
				? vaults.items.filter((vault) => vault.project_ids.includes(projectId))
				: vaults.items;
			await fulfillJson(route, {
				...vaults,
				items,
				total: items.length,
				page: Number(url.searchParams.get("page") ?? "1"),
				page_size: Number(url.searchParams.get("page_size") ?? "25"),
			});
			return;
		}
		if (url.pathname === "/v1/connectors") {
			await options.connectorConnectionsGate;
			if (options.connectorConnectionsResponse) {
				await fulfillJson(
					route,
					options.connectorConnectionsResponse.body,
					options.connectorConnectionsResponse.status,
				);
				return;
			}
			await fulfillJson(route, options.connectorConnections ?? []);
			return;
		}
		const connectorAppMatch = url.pathname.match(/^\/v1\/connectors\/available\/([^/]+)$/);
		if (connectorAppMatch) {
			options.connectorMetadataRequests?.push(route.request().url());
			const app = options.connectorCatalog?.find(
				(item) => item.name === decodeURIComponent(connectorAppMatch[1]),
			);
			await fulfillJson(route, app ?? { detail: "App not found" }, app ? 200 : 404);
			return;
		}
		if (url.pathname === "/v1/connectors/available") {
			await options.connectorCatalogGate;
			if (options.connectorCatalogResponse) {
				await fulfillJson(
					route,
					options.connectorCatalogResponse.body,
					options.connectorCatalogResponse.status,
				);
				return;
			}
			await fulfillJson(route, {
				items: options.connectorCatalog ?? [
					{
						name: "gmail",
						display_name: "Gmail",
						logo: "",
						description: "Email connector",
						auth_type: "oauth",
						connect_disabled: false,
						connect_disabled_reason: null,
					},
				],
				total: 48,
				page: Number(url.searchParams.get("page") ?? "1"),
				page_size: 24,
			});
			return;
		}
		if (url.pathname === "/v1/sessions") {
			options.sessionRequests?.push(route.request().url());
			await fulfillJson(route, options.sessionsPage ?? sessions);
			return;
		}
		if (url.pathname === "/v1/memories") {
			await fulfillJson(route, memories);
			return;
		}
		if (url.pathname === "/v1/settings") {
			await fulfillJson(route, { memory_provider: "builtin", mem0_api_key: null });
			return;
		}
		if (url.pathname === "/v1/auth/keys") {
			await fulfillJson(route, []);
			return;
		}
		await fulfillJson(route, {});
	});
}

async function expectNoBrowserErrors(page: Page, errors: string[], label: string) {
	await page.waitForTimeout(100);
	expect(errors, label).toEqual([]);
}

async function expectSidebarNavigationGroups(
	page: Page,
	expected: Array<{ label: string | null; items: string[] }>,
) {
	const groups = page
		.getByTestId("app-sidebar")
		.locator('[data-slot="sidebar-content"] > [data-slot="sidebar-group"]');
	await expect(groups).toHaveCount(expected.length);
	for (const [index, group] of expected.entries()) {
		const heading = groups.nth(index).locator('[data-slot="sidebar-group-label"]');
		if (group.label) await expect(heading).toHaveText(group.label);
		else await expect(heading).toHaveCount(0);
		await expect(groups.nth(index).getByRole("link")).toHaveText(group.items);
	}
	await expect(
		groups.locator('[data-slot="sidebar-group-label"]').filter({ hasText: /^Resources$/ }),
	).toHaveCount(1);
	await expect(groups.locator('[data-slot="sidebar-group-label"]:empty')).toHaveCount(0);
}

test("dashboard sidebar primitives run without browser errors", async ({ page }) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => {
		browserErrors.push(error.message);
	});

	await stubDashboardApi(page);

	await page.goto("/");
	await expect(page.getByTestId("app-sidebar")).toBeVisible();
	await expect(page.getByTestId("app-sidebar-agent-rail")).toBeVisible();
	const agentTiles = page.getByTestId("app-sidebar-agent-tiles");
	await expect(agentTiles).toBeVisible();
	const agentTile = page.getByTestId("app-sidebar-agent-tile").filter({ hasText: "Smoke Codex" });
	// A cold parallel Vite graph can defer the mocked agents fetch beyond the
	// suite-wide 5s assertion default even though the response is healthy.
	await expect(agentTile).toHaveCount(1, { timeout: 15_000 });
	await expectNoBrowserErrors(page, browserErrors, "dashboard render");

	await agentTile.locator("button").hover();
	await expect(
		page.locator('[data-slot="tooltip-content"]').filter({ hasText: "Smoke Codex" }),
	).toBeVisible();
	await expectNoBrowserErrors(page, browserErrors, "agent rail tooltip");
	await page.mouse.move(900, 300);

	await page.getByTestId("app-sidebar-user-menu-button").click();
	await expect(page.getByText("dev@clawdi.local")).toBeVisible();
	await page.getByText("Theme").hover();
	await expect(page.getByRole("menuitemradio", { name: "System" })).toBeVisible();
	await expectNoBrowserErrors(page, browserErrors, "user dropdown menu");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");

	await page.getByTestId("app-sidebar-help-menu-button").click();
	await expect(page.getByRole("menuitem", { name: /Docs/ })).toBeVisible();
	await expectNoBrowserErrors(page, browserErrors, "help dropdown menu");
	await page.keyboard.press("Escape");

	await page.getByTestId("app-sidebar-settings-button").click();
	await expect(page.getByTestId("settings-dialog")).toBeVisible();
	await expectNoBrowserErrors(page, browserErrors, "settings dialog");

	await page.getByTestId("settings-theme-select").click();
	await expect(page.getByRole("option", { name: "Dark" })).toBeVisible();
	await expectNoBrowserErrors(page, browserErrors, "settings select");
});

test("Console and connected agents use the scoped navigation grammar", async ({ page }) => {
	await stubDashboardApi(page);
	await page.goto("/");
	await expectSidebarNavigationGroups(page, [
		{ label: null, items: ["Overview", "Agents", "Sessions", "Memories"] },
		{ label: "Resources", items: ["Connectors", "Projects", "Skills", "Vaults"] },
	]);

	await page.goto("/agents/agent-smoke-1");
	await expectSidebarNavigationGroups(page, [
		{ label: null, items: ["Overview", "Sessions"] },
		{ label: "Resources", items: ["Projects", "Skills", "Memories", "Vaults", "Connectors"] },
		{ label: null, items: ["Settings"] },
	]);
});

test("connected agent overview uses the modular hierarchy", async ({ page }, testInfo) => {
	await stubDashboardApi(page, [], {
		sessionsPage: overviewSessions,
		connectorConnections: [
			{ id: "conn-github", app_name: "github", status: "ACTIVE" },
			{ id: "conn-slack", app_name: "slack", status: "ACTIVE" },
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
			"project-smoke": [
				{
					id: "skill-smoke-research",
					skill_key: "research",
					name: "Research",
					description: "Research workflow",
					version: 1,
					source: "cloud",
					authority: "cloud",
					source_repo: null,
					agent_types: ["codex"],
					file_count: 1,
					content_hash: "a".repeat(64),
					is_active: true,
					created_at: now.toISOString(),
					updated_at: now.toISOString(),
					project_id: "project-smoke",
					project_name: "Smoke Project",
					project_kind: "environment",
				},
			],
		},
	});
	await page.goto("/agents/agent-smoke-1");

	const overview = page.locator('[data-agent-overview="connected"]');
	await expect(page.getByRole("heading", { name: "Recent sessions", exact: true })).toBeVisible({
		timeout: 12_000,
	});
	await expect(overview.locator('[data-overview-module] [data-slot="card-title"]')).toHaveCount(5);
	await expect(
		overview.locator('[data-overview-module] [data-slot="card-description"]'),
	).toHaveCount(5);
	expect(
		await overview
			.locator("[data-overview-module]")
			.evaluateAll((cards) =>
				cards.map((card) => card.querySelectorAll(':scope > [data-slot="card-content"]').length),
			),
	).toEqual([1, 1, 0, 1, 1]);
	await expect(overview.getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
	await expect(overview.locator('[data-overview-module="sessions"]')).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="projects"]')).toContainText(
		"Smoke Project",
	);
	await expect(page.locator('[data-overview-status="live-sync"]')).toContainText(
		"smoke-machine.local",
	);
	await expect(page.locator('[data-overview-status="live-sync"]')).toContainText("Machine");
	await expect(page.locator('[data-overview-status="live-sync"]')).toContainText("Last seen");
	const viewAllSessions = page
		.locator("#connected-recent-sessions")
		.locator("..")
		.getByRole("button", { name: "View all", exact: true });
	await expect(viewAllSessions).toHaveAttribute("href", "/agents/agent-smoke-1/sessions");
	const recentSessions = page.getByRole("region", { name: "Recent sessions" });
	await expect(recentSessions.locator("article")).toHaveCount(3);
	await expect(recentSessions).not.toContainText("Draft update");
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
	const [recentSessionsBox, liveSyncBox, viewAllBox] = await Promise.all([
		recentSessions.boundingBox(),
		page.locator('[data-overview-status="live-sync"]').boundingBox(),
		viewAllSessions.boundingBox(),
	]);
	expect(
		Math.abs(
			(viewAllBox?.x ?? 0) +
				(viewAllBox?.width ?? 0) -
				((recentSessionsBox?.x ?? 0) + (recentSessionsBox?.width ?? 0)),
		),
	).toBeLessThanOrEqual(2);
	expect(Math.abs((liveSyncBox?.y ?? 0) - (recentSessionsBox?.y ?? 0))).toBeLessThanOrEqual(2);
	expect(
		Math.abs(
			(liveSyncBox?.y ?? 0) +
				(liveSyncBox?.height ?? 0) -
				((recentSessionsBox?.y ?? 0) + (recentSessionsBox?.height ?? 0)),
		),
	).toBeLessThanOrEqual(2);
	await expect(overview.locator('[data-overview-module="skills"]')).toContainText("Research");
	const resourceBadges = overview.getByTestId("overview-resource-badges");
	await expect(resourceBadges).toHaveCount(3);
	await expect(
		overview.locator('[data-overview-module="projects"] [data-slot="badge"]'),
	).toHaveAccessibleName("Smoke Project");
	await expect(
		overview.locator('[data-overview-module="skills"] [data-slot="badge"]'),
	).toHaveAccessibleName("Research");
	await expect(
		overview.locator('[data-overview-module="vaults"] [data-slot="badge"]'),
	).toHaveAccessibleName("Scoped Vault");
	await expect(
		overview.locator('[data-overview-module="memories"] [data-slot="badge"]'),
	).toHaveCount(0);
	for (const moduleId of ["memories", "vaults", "connectors"]) {
		await expect(overview.locator(`[data-overview-module="${moduleId}"]`)).toBeVisible();
	}
	const connectors = overview.locator('[data-overview-module="connectors"]');
	await expect(connectors).toContainText("2 connected");
	const connectorLinks = connectors.getByTestId("overview-connector-rail").getByRole("link");
	await expect(connectorLinks).toHaveCount(5);
	await expect(connectorLinks.nth(0)).toHaveAccessibleName("Connected app: Github");
	await expect(connectorLinks.nth(1)).toHaveAccessibleName("Connected app: Slack");
	await expect(connectorLinks.nth(2)).toHaveAccessibleName("Suggested app: Gmail");
	await expect(connectors.getByRole("link", { name: "Suggested app: Github" })).toHaveCount(0);
	const sidebar = page.getByTestId("app-sidebar");
	await expect(sidebar.getByText("Paused", { exact: true })).toBeVisible();
	await expect(sidebar.getByText(/last seen/i)).toBeVisible();
	await expectInlineSidebarStatus(sidebar, "connected");
	for (const section of ["Memories", "Vaults", "Connectors"]) {
		await expect(sidebar.getByRole("link", { name: section, exact: true })).toBeVisible();
	}
	await expect(overview.locator('[data-overview-module="agent-interface"]')).toHaveCount(0);
	await expect(overview.getByText("Activity and current state", { exact: true })).toHaveCount(0);
	const resourceGrid = overview.locator('[data-overview-layout="three-column"]');
	const resourceGeometry = await resourceGrid
		.locator("[data-overview-module]")
		.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().toJSON()));
	expect(resourceGeometry).toHaveLength(5);
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
		Math.max(...resourceGeometry.map((box) => box.height)) -
			Math.min(...resourceGeometry.map((box) => box.height)),
	).toBeLessThanOrEqual(2);
	expect(new Set(resourceGeometry.map((box) => Math.round(box.height)))).toEqual(new Set([128]));
	expect(Math.max(...resourceGeometry.map((box) => box.height))).toBeLessThan(144);
	expect(
		await resourceGrid
			.locator("[data-overview-module]")
			.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-overview-module"))),
	).toEqual(["projects", "skills", "memories", "vaults", "connectors"]);
	await expectOverviewResourceGeometry(resourceGrid, [3, 2]);
	await expectAgentOverviewTypography(page);
	await page.setViewportSize({ width: 1024, height: 1200 });
	await expectOverviewResourceGeometry(resourceGrid, [2, 2, 1]);
	await page.setViewportSize({ width: 768, height: 1200 });
	await expectOverviewResourceGeometry(resourceGrid, [1, 1, 1, 1, 1]);
	await page.setViewportSize({ width: 390, height: 844 });
	await expectOverviewResourceGeometry(resourceGrid, [1, 1, 1, 1, 1]);
	const mobileSessionBoxes = await recentSessions
		.locator("article")
		.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().toJSON()));
	expect(mobileSessionBoxes).toHaveLength(3);
	for (let index = 1; index < mobileSessionBoxes.length; index += 1) {
		expect(Math.abs(mobileSessionBoxes[index].x - mobileSessionBoxes[0].x)).toBeLessThanOrEqual(1);
		expect(mobileSessionBoxes[index].y).toBeGreaterThanOrEqual(
			mobileSessionBoxes[index - 1].y + mobileSessionBoxes[index - 1].height,
		);
	}
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
		path: testInfo.outputPath("connected-agent-overview-mobile.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
	const mobileSidebar = page.getByRole("dialog");
	await expectInlineSidebarStatus(mobileSidebar, "connected");
	await page.screenshot({
		path: testInfo.outputPath("connected-sidebar-status-mobile.png"),
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 1280, height: 1400 });
	await page.screenshot({
		path: testInfo.outputPath("connected-agent-overview.png"),
		fullPage: true,
	});
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await expectInlineSidebarStatus(page.getByTestId("app-sidebar"), "connected");
	await page.waitForTimeout(250);
	await page.screenshot({
		path: testInfo.outputPath("connected-sidebar-status-dark.png"),
		fullPage: true,
	});
	await page.locator("html").evaluate((element) => element.classList.remove("dark"));
});

test("connected detail only requests overview data on Overview", async ({ page }) => {
	const sessionRequests: string[] = [];
	const projectBindingRequests: string[] = [];
	const projectRequests: string[] = [];
	const skillRequests: string[] = [];
	await stubDashboardApi(page, [], {
		sessionRequests,
		projectBindingRequests,
		projectRequests,
		skillRequests,
	});

	await page.goto("/agents/agent-smoke-1/settings");
	await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
	await page.waitForTimeout(100);
	expect(sessionRequests).toEqual([]);
	expect(projectBindingRequests).toEqual([]);
	expect(projectRequests).toEqual([]);
	expect(skillRequests).toEqual([]);

	await page.goto("/agents/agent-smoke-1/sessions");
	await expect(page.getByRole("heading", { name: "Sessions", level: 1 })).toBeVisible();
	await expect.poll(() => sessionRequests.length).toBe(1);
	expect(new URL(sessionRequests[0] ?? "http://invalid").searchParams.get("page_size")).toBe("50");
	expect(projectBindingRequests).toEqual([]);
	expect(projectRequests).toEqual([]);
	expect(skillRequests).toEqual([]);
});

test("SessionCard stays identical across Overview, Agent Sessions, and global Sessions", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 1000 });
	await stubDashboardApi(page, [], { sessionsPage: overviewSessions });

	await page.goto("/agents/agent-smoke-1");
	const overviewCard = page
		.getByRole("region", { name: "Recent sessions" })
		.getByTestId("session-card")
		.first();
	const overviewContract = await sessionCardVisualContract(overviewCard);

	await page.goto("/agents/agent-smoke-1/sessions");
	await expect(page.getByRole("heading", { name: "Sessions", level: 1 })).toBeVisible();
	const agentCard = page.getByTestId("session-card").first();
	const agentContract = await sessionCardVisualContract(agentCard);
	expect(agentContract).toEqual(overviewContract);
	await page.screenshot({
		path: testInfo.outputPath("connected-agent-sessions-light.png"),
		fullPage: true,
	});
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await page.waitForTimeout(250);
	await page.screenshot({
		path: testInfo.outputPath("connected-agent-sessions-dark.png"),
		fullPage: true,
	});
	await page.locator("html").evaluate((element) => element.classList.remove("dark"));

	await page.goto("/sessions?view=feed");
	await expect(page.getByRole("heading", { name: "Sessions", level: 1 })).toBeVisible();
	const globalCard = page.getByTestId("session-card").first();
	const globalContract = await sessionCardVisualContract(globalCard);
	expect(globalContract).toEqual(overviewContract);
	await page.screenshot({ path: testInfo.outputPath("global-sessions-light.png"), fullPage: true });
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await page.waitForTimeout(250);
	await page.screenshot({ path: testInfo.outputPath("global-sessions-dark.png"), fullPage: true });
	await page.locator("html").evaluate((element) => element.classList.remove("dark"));

	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoHorizontalOverflow(page.locator("main"));
	for (const card of await page.getByTestId("session-card").all())
		await expectNoHorizontalOverflow(card);
	const longTitle = page.getByTestId("session-card-title").nth(2);
	await expect(longTitle).toHaveCSS("white-space", "nowrap");
	await expect(longTitle).toHaveCSS("text-overflow", "ellipsis");
	expect(await longTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
		true,
	);
	await page.screenshot({
		path: testInfo.outputPath("global-sessions-mobile.png"),
		fullPage: true,
	});

	await page.goto("/agents/agent-smoke-1/sessions");
	await expect(page.getByTestId("session-card")).toHaveCount(5);
	await expectNoHorizontalOverflow(page.locator("main"));
	for (const card of await page.getByTestId("session-card").all())
		await expectNoHorizontalOverflow(card);
	await page.screenshot({
		path: testInfo.outputPath("connected-agent-sessions-mobile.png"),
		fullPage: true,
	});
});

test("connected Overview keeps a three-row accessible session slot for zero through 3+ sessions", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const sessionRequests: string[] = [];
	const options = {
		sessionRequests,
		sessionsPage: connectedOverviewSessionsPage(0),
	};
	await stubDashboardApi(page, [], options);
	const measurements: number[] = [];
	for (const count of [0, 1, 2, 4]) {
		options.sessionsPage = connectedOverviewSessionsPage(count);
		if (count === 0) await page.goto("/agents/agent-smoke-1");
		else await page.reload();
		await expect(page.getByRole("heading", { name: "Recent sessions", exact: true })).toBeVisible();
		const region = page.getByRole("region", { name: "Recent sessions" });
		measurements.push(
			await expectOverviewSessionSlot({
				region,
				statusCard: page.locator('[data-overview-status="live-sync"]'),
				realCount: Math.min(count, 3),
			}),
		);
		if (count === 0)
			await expect(
				region
					.getByTestId("overview-session-placeholder")
					.first()
					.getByText("No recent sessions", { exact: true }),
			).toBeVisible();
		if (count === 4) await expect(region).not.toContainText("Draft update");
	}
	expect(sessionRequests).toHaveLength(4);
	for (const request of sessionRequests)
		expect(new URL(request).searchParams.get("page_size")).toBe("3");
	expect(Math.max(...measurements) - Math.min(...measurements)).toBeLessThanOrEqual(2);
});

test("connected Overview resolves connector metadata from catalog before fan-out", async ({
	page,
}) => {
	const connectorMetadataRequests: string[] = [];
	const catalogApp = (name: string) => ({
		name,
		display_name: name,
		logo: "",
		description: `${name} connector`,
		auth_type: "oauth",
		connect_disabled: false,
		connect_disabled_reason: null,
	});
	await stubDashboardApi(page, [], {
		connectorMetadataRequests,
		connectorConnections: [
			{ id: "conn-github", app_name: "github", status: "ACTIVE" },
			{ id: "conn-slack", app_name: "slack", status: "ACTIVE" },
		],
		connectorCatalog: [catalogApp("github"), catalogApp("gmail")],
	});

	await page.goto("/agents/agent-smoke-1");
	await expect(page.locator('[data-overview-module="connectors"]')).toContainText("2 connected");
	await expect.poll(() => connectorMetadataRequests.length).toBe(1);
	expect(new URL(connectorMetadataRequests[0] ?? "http://invalid").pathname).toBe(
		"/v1/connectors/available/slack",
	);
});

test("connected overview keeps connector and catalog states independent", async ({ page }) => {
	await stubDashboardApi(page, [], {
		connectorConnectionsGate: new Promise<void>(() => {}),
		connectorCatalog: [
			{
				name: "gmail",
				display_name: "Gmail",
				logo: "",
				description: "Email",
				auth_type: "oauth",
				connect_disabled: false,
				connect_disabled_reason: null,
			},
		],
	});
	await page.goto("/agents/agent-smoke-1");
	const card = page.locator('[data-overview-module="connectors"]');
	await expect(card.getByLabel("Loading connected apps")).toBeVisible();
	await expect(card.getByRole("link", { name: "Available app: Gmail" })).toBeVisible();
	await expect(card).not.toContainText("No apps connected");
});

test("connected overview reports connector errors without a false empty state", async ({
	page,
}) => {
	await stubDashboardApi(page, [], {
		connectorConnectionsResponse: { body: { detail: "failed" }, status: 500 },
		connectorCatalogResponse: { body: { detail: "failed" }, status: 500 },
	});
	await page.goto("/agents/agent-smoke-1");
	const card = page.locator('[data-overview-module="connectors"]');
	await expect(card).toContainText("Can’t load apps", { timeout: 12_000 });
	await expect(card).not.toContainText("No apps connected");
});

test("connected overview preserves active count while popular apps load", async ({ page }) => {
	await stubDashboardApi(page, [], {
		connectorConnections: [{ id: "conn-github", app_name: "github", status: "ACTIVE" }],
		connectorCatalogGate: new Promise<void>(() => {}),
		connectorCatalog: [
			{
				name: "github",
				display_name: "Github",
				logo: "",
				description: "Source",
				auth_type: "oauth",
				connect_disabled: false,
				connect_disabled_reason: null,
			},
		],
	});
	await page.goto("/agents/agent-smoke-1");
	const card = page.locator('[data-overview-module="connectors"]');
	await expect(card).toContainText("1 connected");
	await expect(card.getByLabel("Loading app").first()).toBeVisible();
});

test("connected overview keeps project count when names fail", async ({ page }) => {
	await stubDashboardApi(page, [], {
		projectsResponse: { status: 500, body: { detail: "project list failed" } },
	});
	await page.goto("/agents/agent-smoke-1");

	const projectsCard = page.locator('[data-overview-module="projects"]');
	await expect(projectsCard).toContainText("1 project");
	await expect(projectsCard).toContainText("Can’t load project names");
	await expect(projectsCard.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
	await expect(projectsCard).not.toContainText("No projects added");
	await expect(page.locator('[data-overview-module="vaults"]')).toBeVisible();
});

test("connected overview keeps project count while names load", async ({ page }) => {
	await stubDashboardApi(page, [], { projectsGate: new Promise<void>(() => {}) });
	await page.goto("/agents/agent-smoke-1");

	const projectsCard = page.locator('[data-overview-module="projects"]');
	await expect(projectsCard).toContainText("1 project");
	await expect(projectsCard.getByLabel("Loading project names summary")).toBeVisible();
	await expect(page.locator('[data-overview-module="vaults"]')).toBeVisible();
});

test("connected agent Memories stays account-wide with canonical detail links", async ({
	page,
}) => {
	await stubDashboardApi(page);
	await page.goto("/agents/agent-smoke-1/memories");

	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Memories", level: 1 })).toBeVisible();
	await expect(page).toHaveTitle("Memories · Clawdi");
	await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveText("Memories");
	await expect(
		main.getByText("Memories are account-wide and available across all agents.", { exact: true }),
	).toHaveCount(1);
	await expect(main.getByTestId("memories-surface")).toBeVisible();
	const memoryCard = main.locator("article").filter({ hasText: "Shared account context" });
	await expect(memoryCard).toBeVisible();
	await expect(memoryCard.getByRole("link")).toHaveAttribute("href", "/memories/memory-smoke-1");

	const sidebar = page.getByTestId("app-sidebar");
	const memoriesLink = sidebar.getByRole("link", { name: "Memories", exact: true });
	const sessionsLink = sidebar.getByRole("link", { name: "Sessions", exact: true });
	expect(await memoriesLink.evaluate((element) => element.hasAttribute("data-active"))).toBe(true);
	expect(await sessionsLink.evaluate((element) => element.hasAttribute("data-active"))).toBe(false);
});

test("connected agent resource tabs reuse scoped Projects, account Connectors, and effective Vaults", async ({
	page,
}, testInfo) => {
	const vaultRequests: string[] = [];
	const longContextProjectName =
		"Automation Library for exceptionally long production workflow names across several teams";
	const longContextProjectSlug =
		"automation-library-for-exceptionally-long-production-workflow-names-across-several-teams";
	const projectAccessBindings = [
		{
			...projectBindings[0],
		},
		{
			id: "binding-context-later",
			agent_id: "agent-smoke-1",
			project_id: "project-context-later",
			binding_type: "context",
			priority: 2,
			default_write_enabled: false,
			created_at: "2026-07-04T12:02:00.000Z",
		},
		{
			id: "binding-context-first",
			agent_id: "agent-smoke-1",
			project_id: "project-context-first",
			binding_type: "context",
			priority: 1,
			default_write_enabled: false,
			created_at: "2026-07-04T12:01:00.000Z",
		},
	];
	const projectAccessProjects = [
		...projects,
		{
			id: "project-context-first",
			name: "Team Knowledge",
			slug: "team-knowledge",
			kind: "workspace",
			origin_environment_id: null,
			archived_at: null,
			created_at: now.toISOString(),
			is_owner: false,
			owner_display: "Teammate",
			owner_handle: "teammate",
		},
		{
			id: "project-context-later",
			name: longContextProjectName,
			slug: longContextProjectSlug,
			kind: "workspace",
			origin_environment_id: null,
			archived_at: null,
			created_at: now.toISOString(),
			is_owner: true,
			owner_display: "Dev User",
			owner_handle: "dev-user",
		},
	];
	await stubDashboardApi(page, [], {
		projectBindings: projectAccessBindings,
		projects: projectAccessProjects,
		vaultRequests,
	});

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/agents/agent-smoke-1/connectors?q=gmail&page=2");
	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Connectors", level: 1 })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page).toHaveTitle("Connectors · Clawdi");
	await expect(
		main.getByText("Account-wide connectors available across all agents."),
	).toBeVisible();
	await expect(main.getByRole("link", { name: "Gmail" })).toBeVisible();
	await expect(page).toHaveURL(/\/agents\/agent-smoke-1\/connectors\?q=gmail&page=2/);

	await page.goto("/agents/agent-smoke-1/project-access");
	await expect(main.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible({
		timeout: 15_000,
	});
	const projectStack = main.getByTestId("agent-project-stack");
	const projectGrid = projectStack.getByTestId("agent-project-grid");
	const projectCards = projectGrid.getByTestId("agent-project-card");
	await expect(projectCards).toHaveCount(3);
	expect(
		await projectGrid.evaluate(
			(element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
		),
	).toBe(3);
	for (const card of await projectCards.all()) {
		await expect(card.locator(":scope > div")).toHaveCSS("border-top-width", "1px");
	}
	await expect(projectCards.nth(0)).toContainText("Smoke Project");
	await expect(projectCards.nth(0)).toContainText("Read order 1");
	await expect(projectCards.nth(0)).toContainText("Default write destination");
	await expect(projectCards.nth(0)).not.toContainText("Fixed");
	await expect(projectCards.nth(0)).not.toContainText("Owner");
	await expect(projectCards.nth(0).locator('[data-slot="badge"]')).toHaveCount(1);
	await expect(projectCards.nth(0).getByRole("button")).toHaveCount(0);
	await expect(
		projectCards.nth(0).getByRole("link", { name: "Open Smoke Project" }),
	).toHaveAttribute("href", "/projects/project-smoke");
	await expect(projectCards.nth(1)).toContainText("Team Knowledge");
	await expect(projectCards.nth(1)).toContainText("Read order 2");
	await expect(projectCards.nth(1)).toContainText("Viewer");
	await expect(projectCards.nth(1)).not.toContainText("Read access");
	await expect(projectCards.nth(1)).not.toContainText("Skills and Vaults");
	await expect(projectCards.nth(1).locator('[data-slot="badge"]')).toHaveCount(2);
	await expect(projectCards.nth(2)).toContainText(longContextProjectName);
	await expect(projectCards.nth(2)).toContainText("Read order 3");
	await expect(projectCards.nth(2).locator('[data-slot="badge"]')).toHaveCount(1);
	await projectCards.nth(1).hover();
	await expect(
		projectCards.nth(1).getByRole("button", { name: "Move Team Knowledge up" }),
	).toBeDisabled();
	await expect(
		projectCards.nth(1).getByRole("button", { name: "Remove Team Knowledge" }),
	).toBeVisible();
	await expect
		.poll(() =>
			projectCards
				.nth(1)
				.getByRole("button", { name: "Remove Team Knowledge" })
				.evaluate((element) => getComputedStyle(element.parentElement ?? element).opacity),
		)
		.toBe("1");
	await projectCards.nth(1).getByRole("button", { name: "Remove Team Knowledge" }).click();
	await expect(page).toHaveURL(/\/agents\/agent-smoke-1\/project-access$/);
	const removeProjectDialog = page.getByRole("alertdialog", { name: "Remove this Project?" });
	await expect(removeProjectDialog).toContainText(
		"Team Knowledge will no longer be available to this agent.",
	);
	await removeProjectDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(projectStack.getByLabel("Project to add")).toHaveCount(0);
	const addProjectTrigger = projectStack.getByRole("button", { name: "Add Project", exact: true });
	await expect(addProjectTrigger).toBeVisible();
	await addProjectTrigger.click();
	const addProjectDialog = page.getByTestId("agent-project-add-dialog");
	await expect(addProjectDialog).toBeVisible();
	await expect(addProjectDialog.getByRole("heading", { name: "Add Project" })).toBeVisible();
	const compactProjectPicker = addProjectDialog.getByLabel("Project to add");
	await expect(compactProjectPicker).toBeVisible();
	await compactProjectPicker.click();
	await page.getByRole("option", { name: /Unrelated Project/ }).click();
	await expect(
		addProjectDialog.getByRole("button", { name: "Add Project", exact: true }),
	).toBeEnabled();
	await addProjectDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(addProjectDialog).toHaveCount(0);

	await projectStack.screenshot({
		path: testInfo.outputPath("connected-agent-projects-desktop.png"),
	});
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await projectStack.screenshot({ path: testInfo.outputPath("connected-agent-projects-dark.png") });
	await page.locator("html").evaluate((element) => element.classList.remove("dark"));

	await page.setViewportSize({ width: 2000, height: 1000 });
	const centeredAgentSurface = projectStack.locator(
		"xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' max-w-7xl ')][1]",
	);
	expect(
		await centeredAgentSurface.evaluate((element) => element.getBoundingClientRect().width),
	).toBeLessThanOrEqual(1280);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(projectCards.nth(2)).toBeVisible();
	expect(
		await projectGrid.evaluate(
			(element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
		),
	).toBe(1);
	await expect
		.poll(() =>
			projectCards
				.nth(1)
				.getByRole("button", { name: "Remove Team Knowledge" })
				.evaluate((element) => getComputedStyle(element.parentElement ?? element).opacity),
		)
		.toBe("1");
	const longTitle = projectCards.nth(2).getByRole("heading", { name: longContextProjectName });
	const longSlug = projectCards.nth(2).getByText(longContextProjectSlug, { exact: true });
	expect(await longTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
		true,
	);
	expect(await longSlug.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
		true,
	);
	expect(
		await projectStack.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
	).toBe(true);
	expect(
		await page
			.locator("html")
			.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
	).toBe(true);
	await projectStack.screenshot({
		path: testInfo.outputPath("connected-agent-projects-mobile.png"),
	});
	const primaryProjectLink = projectCards.nth(0).getByRole("link", { name: "Open Smoke Project" });
	await primaryProjectLink.focus();
	await expect(primaryProjectLink).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/projects\/project-smoke$/);

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/projects");
	await expect(main.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
	const consoleProjectGrid = main.getByTestId("project-grid");
	const consoleSharedProject = consoleProjectGrid.getByRole("link", {
		name: "Open Team Knowledge",
	});
	await expect(consoleSharedProject).toHaveAttribute("href", "/projects/project-context-first");
	await expect(consoleSharedProject.locator("xpath=..")).toContainText("Viewer");
	await expect(consoleProjectGrid.getByText("Custom Project", { exact: true })).toHaveCount(0);
	await expect(consoleProjectGrid.getByText("Owner", { exact: true })).toHaveCount(0);
	await main.getByRole("button", { name: /System projects/i }).click();
	const systemProjectCard = main
		.getByRole("link", { name: "Open Smoke Project" })
		.locator("xpath=..");
	await expect(systemProjectCard).toContainText("Agent Project");
	await expect(systemProjectCard).toContainText("Agent: Smoke Codex");
	await expect(systemProjectCard).not.toContainText("Owner");
	await main.screenshot({ path: testInfo.outputPath("console-projects-desktop.png") });
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await main.screenshot({ path: testInfo.outputPath("console-projects-dark.png") });
	await page.locator("html").evaluate((element) => element.classList.remove("dark"));
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(consoleSharedProject).toBeVisible();
	expect(
		await page
			.locator("html")
			.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
	).toBe(true);
	await main.screenshot({ path: testInfo.outputPath("console-projects-mobile.png") });

	await page.goto("/agents/agent-smoke-1/vaults");
	await expect(main.getByRole("heading", { name: "Vaults", level: 1 })).toBeVisible();
	await expect(page).toHaveTitle("Vaults · Clawdi");
	await expect(
		main.getByText("Vaults available through this agent's Projects.", { exact: true }),
	).toHaveCount(1);
	await expect(main.getByText("Vaults appear here through", { exact: false })).toHaveCount(0);
	await expect(main.getByText("Scoped Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Unrelated Vault", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /New vault/i })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Add keys/i })).toHaveCount(0);
	const vaultRequest = vaultRequests[0];
	if (!vaultRequest) throw new Error("Agent Vault inventory was not requested");
	const vaultRequestUrl = new URL(vaultRequest);
	expect(vaultRequestUrl.searchParams.get("project_id")).toBe("project-smoke");
	expect(vaultRequestUrl.searchParams.get("page")).toBe("1");
	expect(vaultRequestUrl.searchParams.get("page_size")).toBe("200");
});

test("agent Vaults wait for effective Project bindings before requesting inventory", async ({
	page,
}) => {
	let releaseBindings: (() => void) | undefined;
	const projectBindingsGate = new Promise<void>((resolve) => {
		releaseBindings = resolve;
	});
	const vaultRequests: string[] = [];
	await stubDashboardApi(page, [], { projectBindingsGate, vaultRequests });

	await page.goto("/agents/agent-smoke-1/vaults");
	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Vaults", level: 1 })).toBeVisible();
	await expect(main.getByTestId("agent-vaults-loading")).toBeVisible();
	expect(vaultRequests).toEqual([]);
	if (!releaseBindings) throw new Error("Project binding gate was not initialized");
	releaseBindings();
	await expect(main.getByText("Scoped Vault", { exact: true })).toBeVisible();
	expect(vaultRequests).toHaveLength(1);
	const vaultRequest = vaultRequests[0];
	if (!vaultRequest) throw new Error("Agent Vault inventory was not requested after bindings");
	expect(new URL(vaultRequest).searchParams.get("project_id")).toBe("project-smoke");
});

test("agent Skills wait for effective Project bindings and fail closed on binding errors", async ({
	page,
}) => {
	let releaseBindings: (() => void) | undefined;
	const projectBindingsGate = new Promise<void>((resolve) => {
		releaseBindings = resolve;
	});
	const skillRequests: string[] = [];
	await stubDashboardApi(page, [], { projectBindingsGate, skillRequests });

	await page.goto("/agents/agent-smoke-1/skills");
	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
	await expect(main.getByTestId("agent-skills-inventory")).toBeVisible();
	await expect(
		main.getByText("Skills available through this agent's Projects.", { exact: true }),
	).toHaveCount(1);
	await expect(main.getByText("Skills appear here through", { exact: false })).toHaveCount(0);
	expect(skillRequests).toEqual([]);
	if (!releaseBindings) throw new Error("Project binding gate was not initialized");
	releaseBindings();
	await expect(main.getByText("No Skills yet.", { exact: true })).toBeVisible();
	await expect(main.getByText("No Skills are available through", { exact: false })).toHaveCount(0);
	expect(skillRequests).toHaveLength(1);

	const errorPage = await page.context().newPage();
	const errorSkillRequests: string[] = [];
	try {
		await stubDashboardApi(errorPage, [], {
			projectBindingsError: { status: 503, detail: "bindings unavailable" },
			skillRequests: errorSkillRequests,
		});
		await errorPage.goto("/agents/agent-smoke-1/skills");
		await expect(
			errorPage.locator("main").getByText("Couldn't load agent Skills", { exact: true }),
		).toBeVisible({ timeout: 15_000 });
		expect(errorSkillRequests).toEqual([]);
	} finally {
		await errorPage.close();
	}
});

test("every agent rail tile button navigates on click", async ({ page }) => {
	await stubDashboardApi(page);

	for (const agent of agents) {
		await page.goto("/");
		const tileButton = page
			.getByTestId("app-sidebar-agent-tile")
			.filter({ hasText: agent.display_name })
			.locator("button");
		await expect(tileButton).toBeVisible({ timeout: 15_000 });
		await expect(tileButton).toHaveAttribute("type", "button");

		await tileButton.click();
		await expect(page).toHaveURL(`/agents/${agent.id}`);
	}
});

test("agent rail tile buttons support touch taps and Enter activation", async ({
	browser,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Playwright baseURL is required for the sidebar smoke test.");
	const [firstAgent, secondAgent] = agents;
	if (!firstAgent || !secondAgent) throw new Error("Two sidebar agent fixtures are required.");
	const context = await browser.newContext({
		baseURL,
		hasTouch: true,
		viewport: { width: 1280, height: 720 },
	});
	const page = await context.newPage();

	try {
		await stubDashboardApi(page);
		await page.goto("/");
		const touchTarget = page
			.getByTestId("app-sidebar-agent-tile")
			.filter({ hasText: firstAgent.display_name })
			.locator("button");
		await expect(touchTarget).toBeVisible({ timeout: 15_000 });
		await touchTarget.tap();
		await expect(page).toHaveURL(`/agents/${firstAgent.id}`);

		await page.goto("/");
		const keyboardTarget = page
			.getByTestId("app-sidebar-agent-tile")
			.filter({ hasText: secondAgent.display_name })
			.locator("button");
		await expect(keyboardTarget).toBeVisible({ timeout: 15_000 });
		await keyboardTarget.focus();
		await expect(keyboardTarget).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(`/agents/${secondAgent.id}`);
	} finally {
		await context.close();
	}
});

test("Enter drops an active keyboard sort before navigating when inactive", async ({ page }) => {
	const agentOrderRequests: string[] = [];
	await stubDashboardApi(page, agentOrderRequests);
	await page.goto("/");

	const tiles = page.getByTestId("app-sidebar-agent-tile");
	await expect(tiles).toHaveCount(2, { timeout: 15_000 });
	const firstButton = tiles.filter({ hasText: "Smoke Codex" }).locator("button");
	await firstButton.focus();
	await page.keyboard.down("Space");
	await expect(firstButton).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.up("Space");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");

	await expect(firstButton).not.toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL("/");
	await expect.poll(() => agentOrderRequests.length).toBe(1);
	await expect(tiles.nth(0)).toContainText("Smoke Hermes");
	await expect(firstButton).toBeFocused();

	await page.keyboard.press("Enter");
	await expect(page).toHaveURL("/agents/agent-smoke-1");
});

test("agent rail uses each whole tile for Space keyboard sorting", async ({ page }) => {
	const agentOrderRequests: string[] = [];
	await stubDashboardApi(page, agentOrderRequests);
	await page.goto("/");

	const tiles = page.getByTestId("app-sidebar-agent-tile");
	await expect(tiles).toHaveCount(2, { timeout: 15_000 });
	await expect(page.getByRole("button", { name: /^Reorder / })).toHaveCount(0);
	const firstTile = tiles.filter({ hasText: "Smoke Codex" });
	const firstButton = firstTile.locator("button");
	const firstTileBox = await firstTile.boundingBox();
	const firstButtonBox = await firstButton.boundingBox();
	if (!firstTileBox || !firstButtonBox) throw new Error("Agent rail tile should be interactive.");
	expect(firstTileBox.height).toBeCloseTo(72, 0);
	expect(firstButtonBox.height).toBeCloseTo(firstTileBox.height, 0);
	expect(firstButtonBox.width).toBeCloseTo(firstTileBox.width, 0);

	await firstButton.focus();
	await page.keyboard.down("Space");
	await expect(firstButton).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.up("Space");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Escape");
	await expect(firstButton).not.toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL("/");
	expect(agentOrderRequests).toEqual([]);
	await expect(tiles.nth(0)).toContainText("Smoke Codex");

	await firstButton.focus();
	await page.keyboard.down("Space");
	await expect(firstButton).toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL("/");
	await page.keyboard.up("Space");
	await expect(page).toHaveURL("/");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.down("Space");
	await expect(firstButton).not.toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL("/");
	await page.keyboard.up("Space");

	await expect(page).toHaveURL("/");
	await expect.poll(() => agentOrderRequests.length).toBe(1);
	expect(JSON.parse(agentOrderRequests[0] ?? "{}")).toEqual({
		agent_ids: ["agent-smoke-2", "agent-smoke-1"],
	});
	await expect(tiles.nth(0)).toContainText("Smoke Hermes");

	const postDragTarget = tiles.filter({ hasText: "Smoke Hermes" }).locator("button");
	await postDragTarget.click();
	await expect(page).toHaveURL("/agents/agent-smoke-2");
});
