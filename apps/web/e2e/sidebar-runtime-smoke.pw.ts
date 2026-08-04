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
	expect(primaryMetrics.length).toBeGreaterThanOrEqual(3);
	expect(new Set(primaryMetrics.map(({ fontSize }) => fontSize))).toEqual(new Set(["14px"]));
	expect(new Set(primaryMetrics.map(({ fontWeight }) => fontWeight))).toEqual(new Set(["400"]));

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
	accountResourceRequests?: string[];
	projectResourceRequests?: string[];
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
	connectorMetadataGate?: Promise<void>;
	memoryDetailGate?: Promise<void>;
	memoryDetailResponse?: { body: unknown; status: number };
	projectBindingRequests?: string[];
	projectRequests?: string[];
	projectBindings?: readonly unknown[];
	projectBindingsError?: { status: number; detail: string };
	projectBindingsGate?: Promise<void>;
	projects?: readonly unknown[];
	projectsGate?: Promise<void>;
	projectsResponse?: { body: unknown; status: number };
	legacySkillDetailRequests?: string[];
	skillDetailRequests?: string[];
	skillDetailResponses?: Readonly<Record<string, { body: unknown; status: number }>>;
	skillRequests?: string[];
	skillsByProjectId?: Readonly<Record<string, readonly unknown[]>>;
	vaultRequests?: string[];
	vaultItems?: readonly (typeof vaults.items)[number][];
};

async function stubDashboardApi(
	page: Page,
	agentOrderRequests: string[] = [],
	options: DashboardApiStubOptions = {},
) {
	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (
			/^\/v1\/memories\/[^/]+$/.test(url.pathname) ||
			url.pathname === "/v1/connectors" ||
			url.pathname.startsWith("/v1/connectors/")
		) {
			options.accountResourceRequests?.push(`${route.request().method()} ${url.pathname}`);
		}
		if (
			/^\/v1\/agents\/[^/]+\/project-bindings$/.test(url.pathname) ||
			url.pathname === "/v1/projects" ||
			url.pathname === "/v1/skills" ||
			url.pathname.startsWith("/v1/vault") ||
			/^\/v1\/projects\/[^/]+\/skills\//.test(url.pathname)
		) {
			options.projectResourceRequests?.push(`${route.request().method()} ${url.pathname}`);
		}
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
			await fulfillJson(route, agent ?? { detail: "Agent not found" }, agent ? 200 : 404);
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
		const projectSkillDetailMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/skills\/(.+)$/);
		if (projectSkillDetailMatch && route.request().method() === "GET") {
			options.skillDetailRequests?.push(route.request().url());
			const projectId = decodeURIComponent(projectSkillDetailMatch[1] ?? "");
			const skillKey = decodeURIComponent(projectSkillDetailMatch[2] ?? "");
			const response = options.skillDetailResponses?.[`${projectId}/${skillKey}`];
			await fulfillJson(
				route,
				response?.body ?? { detail: "Skill not found" },
				response?.status ?? 404,
			);
			return;
		}
		if (/^\/v1\/skills\/.+/.test(url.pathname) && route.request().method() === "GET") {
			options.legacySkillDetailRequests?.push(route.request().url());
			await fulfillJson(route, { detail: "Skill not found" }, 404);
			return;
		}
		if (url.pathname === "/v1/vault" && route.request().method() === "POST") {
			await fulfillJson(route, {});
			return;
		}
		if (url.pathname === "/v1/vault") {
			options.vaultRequests?.push(route.request().url());
			const projectId = url.searchParams.get("project_id");
			const availableVaults = options.vaultItems ?? vaults.items;
			const items = projectId
				? availableVaults.filter((vault) => vault.project_ids.includes(projectId))
				: availableVaults;
			await fulfillJson(route, {
				...vaults,
				items,
				total: items.length,
				page: Number(url.searchParams.get("page") ?? "1"),
				page_size: Number(url.searchParams.get("page_size") ?? "25"),
			});
			return;
		}
		if (url.pathname === "/v1/vault/detail") {
			const vaultId = url.searchParams.get("vault_id");
			const vault = (options.vaultItems ?? vaults.items).find(
				(candidate) => candidate.id === vaultId,
			);
			await fulfillJson(route, vault ?? { detail: "Vault not found" }, vault ? 200 : 404);
			return;
		}
		if (/^\/v1\/vault\/[^/]+\/items$/.test(url.pathname)) {
			await fulfillJson(route, { "(default)": ["API_KEY", "ACCESS_TOKEN"] });
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
			await options.connectorMetadataGate;
			const app = (
				options.connectorCatalog ?? [
					{
						name: "gmail",
						display_name: "Gmail",
						logo: "",
						description: "Email connector",
						auth_type: "oauth",
						connect_disabled: false,
						connect_disabled_reason: null,
					},
				]
			).find((item) => item.name === decodeURIComponent(connectorAppMatch[1]));
			await fulfillJson(route, app ?? { detail: "App not found" }, app ? 200 : 404);
			return;
		}
		if (/^\/v1\/connectors\/[^/]+\/tools$/.test(url.pathname)) {
			await fulfillJson(route, []);
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
		const memoryDetailMatch = url.pathname.match(/^\/v1\/memories\/([^/]+)$/);
		if (memoryDetailMatch) {
			await options.memoryDetailGate;
			if (options.memoryDetailResponse) {
				await fulfillJson(
					route,
					options.memoryDetailResponse.body,
					options.memoryDetailResponse.status,
				);
				return;
			}
			const memory = memories.items.find(
				(item) => item.id === decodeURIComponent(memoryDetailMatch[1]),
			);
			await fulfillJson(route, memory ?? { detail: "Memory not found" }, memory ? 200 : 404);
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
		{ label: "Resources", items: ["Projects", "Memories", "Connectors"] },
		{ label: "Workspace", items: ["Skills", "Vaults"] },
		{ label: null, items: ["Settings"] },
	]);
});

test("connected primary Project navigation stays hidden until scope resolves", async ({ page }) => {
	let releaseBindings: (() => void) | undefined;
	const projectBindingsGate = new Promise<void>((resolve) => {
		releaseBindings = resolve;
	});
	await stubDashboardApi(page, [], { projectBindingsGate });

	await page.goto("/agents/agent-smoke-1");
	const sidebar = page.getByTestId("app-sidebar");
	await expect(sidebar.getByRole("group", { name: "Resources", exact: true })).toBeVisible();
	await expect(sidebar.getByRole("group", { name: "Workspace", exact: true })).toHaveCount(0);

	if (!releaseBindings) throw new Error("Project binding gate was not initialized");
	releaseBindings();
	const projectGroup = sidebar.getByRole("group", { name: "Workspace", exact: true });
	await expect(projectGroup).toBeVisible();
	await expect(projectGroup.getByRole("link")).toHaveText(["Skills", "Vaults"]);
	expect(
		await sidebar.locator('[data-slot="sidebar-group-label"]').allTextContents(),
	).not.toContain("Smoke Project");
});

test("connected agent overview uses the modular hierarchy", async ({ page }, testInfo) => {
	const projectRequests: string[] = [];
	const skillRequests: string[] = [];
	const vaultRequests: string[] = [];
	await stubDashboardApi(page, [], {
		projectRequests,
		skillRequests,
		vaultRequests,
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
	await expect(overview.locator('[data-overview-module] [data-slot="card-title"]')).toHaveCount(3);
	await expect(
		overview.locator('[data-overview-module] [data-slot="card-description"]'),
	).toHaveCount(3);
	expect(
		await overview
			.locator("[data-overview-module]")
			.evaluateAll((cards) =>
				cards.map((card) => card.querySelectorAll(':scope > [data-slot="card-content"]').length),
			),
	).toEqual([0, 0, 0]);
	await expect(overview.locator('[data-overview-module] > [data-slot="card-header"]')).toHaveCount(
		3,
	);
	await expect(overview.locator("[data-overview-module-error]")).toHaveCount(0);
	await expect(
		overview.locator(
			"[data-overview-module] a a, [data-overview-module] a button, [data-overview-module] button a",
		),
	).toHaveCount(0);
	await expect(overview.getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
	await expect(overview.locator("[data-overview-access-scope]")).toHaveCount(0);
	expect(
		await overview
			.locator("[data-overview-module]")
			.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-overview-module"))),
	).toEqual(["projects", "memories", "connectors"]);
	expect(
		await page
			.locator("#connected-recent-sessions, #agent-overview-resources")
			.evaluateAll((headings) => headings.map((heading) => heading.id)),
	).toEqual(["connected-recent-sessions", "agent-overview-resources"]);
	await expect(overview.locator('[data-overview-module="sessions"]')).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="projects"]')).not.toContainText(
		"Smoke Project",
	);
	await expect(overview.getByText("Default Project", { exact: true })).toHaveCount(0);
	await expect(overview.getByTestId("agent-project-grid")).toHaveCount(0);
	expect(projectRequests).toHaveLength(1);
	expect(skillRequests).toEqual([]);
	expect(vaultRequests).toEqual([]);
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
	await expect(overview.locator('[data-slot="badge"]')).toHaveCount(0);
	await expect(overview.getByTestId("overview-connector-rail")).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="skills"]')).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="vaults"]')).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="memories"]')).toContainText("1 memory");
	await expect(overview.locator('[data-overview-module="connectors"]')).toContainText(
		"2 connected",
	);
	const sidebar = page.getByTestId("app-sidebar");
	await expect(sidebar.getByText("Paused", { exact: true })).toBeVisible();
	await expect(sidebar.getByText(/last seen/i)).toBeVisible();
	await expectInlineSidebarStatus(sidebar, "connected");
	for (const section of ["Projects", "Memories", "Connectors", "Skills", "Vaults"]) {
		await expect(sidebar.getByRole("link", { name: section, exact: true })).toBeVisible();
	}
	const projectGroup = sidebar.getByRole("group", { name: "Workspace", exact: true });
	const skillsLink = projectGroup.getByRole("link", { name: "Skills", exact: true });
	const vaultsLink = projectGroup.getByRole("link", { name: "Vaults", exact: true });
	await expect(skillsLink).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-smoke/skills",
	);
	await expect(vaultsLink).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-smoke/vaults",
	);
	await skillsLink.focus();
	await expect(skillsLink).toBeFocused();
	await skillsLink.click();
	await expect(page).toHaveURL("/agents/agent-smoke-1/project-access/project-smoke/skills");
	await expect(skillsLink).toHaveAttribute("data-active", "");
	await expect(vaultsLink).not.toHaveAttribute("data-active", "");
	await page.goto("/agents/agent-smoke-1");
	await expect(overview.locator("[data-overview-module]")).toHaveCount(3);
	await expect(overview.locator('[data-overview-module="agent-interface"]')).toHaveCount(0);
	await expect(overview.getByText("Activity and current state", { exact: true })).toHaveCount(0);
	const resourceGrid = overview.locator('[data-overview-layout="three-column"]');
	const resourceGeometry = await resourceGrid
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
		Math.max(...resourceGeometry.map((box) => box.height)) -
			Math.min(...resourceGeometry.map((box) => box.height)),
	).toBeLessThanOrEqual(2);
	for (const box of resourceGeometry) {
		expect(Math.abs(box.height - (sessionBoxes[0]?.height ?? 0))).toBeLessThanOrEqual(2);
	}
	expect(
		await resourceGrid
			.locator("[data-overview-module]")
			.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-overview-module"))),
	).toEqual(["projects", "memories", "connectors"]);
	await expectOverviewResourceGeometry(resourceGrid, [3]);
	await expectAgentOverviewTypography(page);
	await page.setViewportSize({ width: 1024, height: 1200 });
	await expectOverviewResourceGeometry(resourceGrid, [2, 1]);
	await page.setViewportSize({ width: 768, height: 1200 });
	await expectOverviewResourceGeometry(resourceGrid, [1, 1, 1]);
	await page.setViewportSize({ width: 390, height: 844 });
	await expectOverviewResourceGeometry(resourceGrid, [1, 1, 1]);
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

test("connected Overview queries all-agent Memories and Connectors summaries", async ({ page }) => {
	const accountResourceRequests: string[] = [];
	page.on("request", (request) => {
		const pathname = new URL(request.url()).pathname;
		if (pathname === "/v1/memories" || pathname.startsWith("/v1/connectors")) {
			accountResourceRequests.push(pathname);
		}
	});
	await stubDashboardApi(page);

	await page.goto("/agents/agent-smoke-1");
	const overview = page.locator('[data-agent-overview="connected"]');
	await expect(overview.locator('[data-overview-module="memories"]')).toContainText("1 memory", {
		timeout: 12_000,
	});
	await expect(overview.locator('[data-overview-module="connectors"]')).toContainText(
		"No apps connected",
	);
	expect(accountResourceRequests).toContain("/v1/memories");
	expect(accountResourceRequests).toContain("/v1/connectors");
});

test("connected Agent Memories keeps established UI through nested list and detail navigation", async ({
	page,
}) => {
	await stubDashboardApi(page);
	await page.goto("/agents/agent-smoke-1/memories");

	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Memories", level: 1 })).toBeVisible();
	await expect(page).toHaveTitle("Memories · Clawdi");
	await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveText("Memories");
	await expect(
		main.getByText("Memories are account-wide and available across all agents.", {
			exact: true,
		}),
	).toHaveCount(1);
	await expect(main.getByText("All agents", { exact: true })).toHaveCount(0);
	await expect(main.getByTestId("memories-surface")).toBeVisible();
	const memoryCard = main.locator("article").filter({ hasText: "Shared account context" });
	await expect(memoryCard).toBeVisible();
	await expect(memoryCard.getByRole("link")).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/memories/memory-smoke-1",
	);
	await memoryCard.getByRole("link").click();
	await expect(page).toHaveURL("/agents/agent-smoke-1/memories/memory-smoke-1");
	await expect(
		main.getByRole("heading", { name: "Shared account context", level: 1 }),
	).toBeVisible();
	await expect(main.getByText("All agents", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Open in resource library" })).toHaveCount(0);

	const sidebar = page.getByTestId("app-sidebar");
	const sessionsLink = sidebar.getByRole("link", { name: "Sessions", exact: true });
	const memoriesLink = sidebar.getByRole("link", { name: "Memories", exact: true });
	await expect(memoriesLink).toHaveAttribute("href", "/agents/agent-smoke-1/memories");
	await expect(sidebar.getByRole("link", { name: "Connectors", exact: true })).toBeVisible();
	expect(await sessionsLink.evaluate((element) => element.hasAttribute("data-active"))).toBe(false);
	expect(await memoriesLink.evaluate((element) => element.hasAttribute("data-active"))).toBe(true);
	await memoriesLink.click();
	await expect(page).toHaveURL("/agents/agent-smoke-1/memories");
});

test("connected Agent Connectors keeps established UI through nested list and detail navigation", async ({
	page,
}) => {
	await stubDashboardApi(page);
	await page.goto("/agents/agent-smoke-1/connectors");

	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Connectors", level: 1 })).toBeVisible();
	await expect(
		main.getByText("Account-wide connectors available across all agents.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(main.getByText("All agents", { exact: true })).toHaveCount(0);
	const gmailLink = main.getByRole("link", { name: "Gmail" });
	await expect(gmailLink).toHaveAttribute("href", "/agents/agent-smoke-1/connectors/gmail");
	await gmailLink.click();

	await expect(page).toHaveURL("/agents/agent-smoke-1/connectors/gmail");
	await expect(main.getByRole("heading", { name: "Gmail", level: 1 })).toBeVisible();
	await expect(main.getByText("All agents", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Open in resource library" })).toHaveCount(0);

	const sidebar = page.getByTestId("app-sidebar");
	const connectorsLink = sidebar.getByRole("link", { name: "Connectors", exact: true });
	await expect(connectorsLink).toHaveAttribute("href", "/agents/agent-smoke-1/connectors");
	expect(await connectorsLink.evaluate((element) => element.hasAttribute("data-active"))).toBe(
		true,
	);
	await connectorsLink.click();
	await expect(page).toHaveURL("/agents/agent-smoke-1/connectors");
});

test("nested account resources fail closed when the Agent does not exist", async ({ page }) => {
	const accountResourceRequests: string[] = [];
	const projectResourceRequests: string[] = [];
	await stubDashboardApi(page, [], { accountResourceRequests, projectResourceRequests });
	const main = page.locator("main");

	for (const path of [
		"/agents/does-not-exist/memories/memory-smoke-1",
		"/agents/does-not-exist/connectors/gmail",
		"/agents/does-not-exist/project-access/project-smoke",
		"/agents/does-not-exist/skills/scoped-skill?project=project-smoke",
		"/agents/does-not-exist/vaults/scoped-vault?project=project-smoke&vault=vault-scoped",
	]) {
		await page.goto(path);
		await expect(main.getByText("Agent not found", { exact: true })).toBeVisible();
		await expect(
			main.getByText("This Agent does not exist or is no longer available."),
		).toBeVisible();
		await expect(page).toHaveURL(path);
		await main.getByRole("button", { name: "Back to Agents" }).click();
		await expect(page).toHaveURL("/agents");
	}

	expect(accountResourceRequests).toEqual([]);
	expect(projectResourceRequests).toEqual([]);
});

test("connected all-agent detail loading, not-found, and error states keep Agent scope", async ({
	page,
}) => {
	let releaseMemory: (() => void) | undefined;
	let releaseConnector: (() => void) | undefined;
	const memoryDetailGate = new Promise<void>((resolve) => {
		releaseMemory = resolve;
	});
	const connectorMetadataGate = new Promise<void>((resolve) => {
		releaseConnector = resolve;
	});
	await stubDashboardApi(page, [], {
		memoryDetailGate,
		connectorMetadataGate,
		connectorConnectionsResponse: { body: { detail: "Connections unavailable" }, status: 503 },
	});
	const main = page.locator("main");

	await page.goto("/agents/agent-smoke-1/memories/memory-smoke-1");
	await expect(main.locator('[data-slot="skeleton"]').first()).toBeVisible();
	await expect(page).toHaveURL("/agents/agent-smoke-1/memories/memory-smoke-1");
	releaseMemory?.();
	await expect(
		main.getByRole("heading", { name: "Shared account context", level: 1 }),
	).toBeVisible();

	await page.goto("/agents/agent-smoke-1/memories/missing-memory");
	await expect(main.getByText("Memory not found", { exact: true })).toBeVisible();
	await expect(page).toHaveURL("/agents/agent-smoke-1/memories/missing-memory");
	await page.route("**/v1/memories/error-memory", async (route) => {
		await fulfillJson(route, { detail: "Memory service unavailable" }, 503);
	});
	await page.goto("/agents/agent-smoke-1/memories/error-memory");
	await expect(main.getByText("Couldn't load memory", { exact: true })).toBeVisible({
		timeout: 12_000,
	});
	await expect(page).toHaveURL("/agents/agent-smoke-1/memories/error-memory");

	await page.goto("/agents/agent-smoke-1/connectors/gmail");
	await expect(main.locator('[data-slot="skeleton"]').first()).toBeVisible();
	await expect(page).toHaveURL("/agents/agent-smoke-1/connectors/gmail");
	releaseConnector?.();
	await expect(main.getByRole("heading", { name: "Gmail", level: 1 })).toBeVisible();
	await expect(main.getByText("Couldn't load connections", { exact: true })).toBeVisible({
		timeout: 12_000,
	});

	await page.goto("/agents/agent-smoke-1/connectors/missing-connector");
	await expect(main.getByText("Connector unavailable", { exact: true })).toBeVisible();
	await expect(page).toHaveURL("/agents/agent-smoke-1/connectors/missing-connector");
	await page.route("**/v1/connectors/available/error-connector", async (route) => {
		await fulfillJson(route, { detail: "Connector service unavailable" }, 503);
	});
	await page.goto("/agents/agent-smoke-1/connectors/error-connector");
	await expect(main.getByText("Couldn't load connector", { exact: true })).toBeVisible({
		timeout: 12_000,
	});
	await expect(page).toHaveURL("/agents/agent-smoke-1/connectors/error-connector");
});

test("connected agent resources select Projects before scoped Skills and Vaults", async ({
	page,
}, testInfo) => {
	test.setTimeout(60_000);
	const skillRequests: string[] = [];
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
	const projectSkill = (projectId: string, skillKey: string, name: string) => ({
		id: `${projectId}-${skillKey}`,
		skill_key: skillKey,
		name,
		description: `${name} instructions`,
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
		project_id: projectId,
		project_name: projectId === "project-smoke" ? "Smoke Project" : "Team Knowledge",
		project_kind: projectId === "project-smoke" ? "environment" : "workspace",
	});
	const projectAccessVaults = [
		vaults.items[0],
		{
			...vaults.items[0],
			id: "vault-team",
			slug: "team-vault",
			name: "Team Vault",
			project_ids: ["project-context-first"],
		},
		{
			...vaults.items[0],
			id: "vault-shared",
			slug: "shared-vault",
			name: "Shared Vault",
			project_ids: ["project-smoke", "project-context-first"],
		},
		vaults.items[1],
	];
	await stubDashboardApi(page, [], {
		projectBindings: projectAccessBindings,
		projects: projectAccessProjects,
		skillsByProjectId: {
			"project-smoke": [
				projectSkill("project-smoke", "primary-only", "Primary-only Skill"),
				projectSkill("project-smoke", "shared-workflow", "Shared Workflow"),
			],
			"project-context-first": [
				projectSkill("project-context-first", "team-only", "Team-only Skill"),
				projectSkill("project-context-first", "shared-workflow", "Shared Workflow"),
			],
		},
		skillRequests,
		vaultRequests,
		vaultItems: projectAccessVaults,
	});

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/agents/agent-smoke-1/connectors?q=gmail&page=2");
	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Connectors", level: 1 })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page).toHaveTitle("Connectors · Clawdi");
	await expect(
		main.getByText("Account-wide connectors available across all agents.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(main.getByText("All agents", { exact: true })).toHaveCount(0);
	const gmailLink = main.getByRole("link", { name: "Gmail" });
	await expect(gmailLink).toHaveAttribute("href", "/agents/agent-smoke-1/connectors/gmail");
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
	).toHaveAttribute("href", "/agents/agent-smoke-1/project-access/project-smoke");
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
	await expect(page).toHaveURL(/\/agents\/agent-smoke-1\/project-access\/project-smoke$/);
	await expect(main.getByRole("heading", { name: "Smoke Project", level: 1 })).toBeVisible();
	await expect(main.getByRole("button", { name: "Agent Projects", exact: true })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access",
	);
	await expect(main.getByRole("button", { name: "Manage in resource library" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Add to agent/i })).toHaveCount(0);
	await expect(main.getByRole("heading", { name: "People", exact: true })).toHaveCount(0);
	await expect(main.getByRole("heading", { name: "Agents", exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Install skill/i })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /New vault/i })).toBeVisible();
	await expect(main.getByRole("button", { name: "View all Skills", exact: true })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-smoke/skills",
	);
	await expect(main.getByRole("button", { name: "View all Vaults", exact: true })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-smoke/vaults",
	);
	await expect(main.getByText("Primary-only Skill", { exact: true })).toBeVisible();
	await expect(main.getByText("Shared Workflow", { exact: true })).toBeVisible();
	await expect(main.getByText("Team-only Skill", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Scoped Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Shared Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Team Vault", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("link", { name: "Open Primary-only Skill" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/skills/primary-only?project=project-smoke",
	);
	await expect(main.getByRole("link", { name: "Open vault Scoped Vault" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/vaults/scoped-vault?project=project-smoke&vault=vault-scoped",
	);
	await page.goto("/agents/agent-smoke-1/project-access/project-smoke/skills");
	const focusedSkillsHeading = main.getByRole("heading", { name: "Skills", level: 1 });
	await expect(focusedSkillsHeading).toBeVisible();
	await expect(page).toHaveTitle("Skills · Clawdi");
	await expect(main.getByText("Project: Smoke Project", { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Back to Smoke Project" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-smoke",
	);
	await expect(
		focusedSkillsHeading.locator("xpath=../../..").locator(".bg-identity-2-bg svg.lucide-sparkles"),
	).toBeVisible();
	await expect(main.getByRole("heading", { name: "Skills", level: 2 })).toHaveCount(0);
	await expect(main.getByRole("heading", { name: "Vaults", level: 2 })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "View all Skills" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Install skill/i })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /New vault/i })).toHaveCount(0);
	await main.screenshot({ path: testInfo.outputPath("connected-workspace-skills-mobile.png") });
	await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
	const mobileProjectSidebar = page.getByRole("dialog");
	await expect(mobileProjectSidebar).toBeVisible();
	await expect(
		mobileProjectSidebar.getByRole("group", { name: "Workspace", exact: true }),
	).toBeVisible();
	await expect(
		mobileProjectSidebar.getByRole("link", { name: "Skills", exact: true }),
	).toHaveAttribute("data-active", "");
	await expect(
		mobileProjectSidebar.getByRole("link", { name: "Vaults", exact: true }),
	).not.toHaveAttribute("data-active", "");
	await page.waitForTimeout(250);
	await page.screenshot({
		path: testInfo.outputPath("connected-workspace-sidebar-mobile.png"),
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 1280, height: 1200 });
	await main.screenshot({ path: testInfo.outputPath("connected-workspace-skills-desktop.png") });
	await page.screenshot({
		path: testInfo.outputPath("connected-workspace-sidebar-desktop.png"),
		fullPage: true,
	});

	await page.goto("/agents/agent-smoke-1/project-access/project-smoke/vaults");
	const focusedVaultsHeading = main.getByRole("heading", { name: "Vaults", level: 1 });
	await expect(focusedVaultsHeading).toBeVisible();
	await expect(page).toHaveTitle("Vaults · Clawdi");
	await expect(main.getByText("Project: Smoke Project", { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Back to Smoke Project" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-smoke",
	);
	await expect(
		focusedVaultsHeading.locator("xpath=../../..").locator(".bg-identity-4-bg svg.lucide-key"),
	).toBeVisible();
	await expect(main.getByRole("heading", { name: "Vaults", level: 2 })).toHaveCount(0);
	await expect(main.getByRole("heading", { name: "Skills", level: 2 })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "View all Vaults" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Install skill/i })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /New vault/i })).toBeVisible();
	const desktopWorkspace = page
		.getByTestId("app-sidebar")
		.getByRole("group", { name: "Workspace", exact: true });
	await expect(desktopWorkspace.getByRole("link", { name: "Vaults", exact: true })).toHaveAttribute(
		"data-active",
		"",
	);
	await expect(
		desktopWorkspace.getByRole("link", { name: "Skills", exact: true }),
	).not.toHaveAttribute("data-active", "");
	await main.screenshot({ path: testInfo.outputPath("connected-workspace-vaults-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await main.screenshot({ path: testInfo.outputPath("connected-workspace-vaults-mobile.png") });

	await page.goto("/agents/agent-smoke-1/project-access/project-context-first");
	await expect(main.getByRole("heading", { name: "Team Knowledge", level: 1 })).toBeVisible();
	await expect(main.getByText("Team-only Skill", { exact: true })).toBeVisible();
	await expect(main.getByText("Shared Workflow", { exact: true })).toBeVisible();
	await expect(main.getByText("Primary-only Skill", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Team Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Shared Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Scoped Vault", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("link", { name: "Open Team-only Skill" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/skills/team-only?project=project-context-first",
	);
	await expect(main.getByRole("link", { name: "Open vault Team Vault" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/vaults/team-vault?project=project-context-first&vault=vault-team",
	);
	await expect(main.getByRole("button", { name: "View all Skills", exact: true })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-context-first/skills",
	);
	await expect(main.getByRole("button", { name: "View all Vaults", exact: true })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-context-first/vaults",
	);
	await main.getByRole("button", { name: "View all Skills", exact: true }).click();
	await expect(page).toHaveURL("/agents/agent-smoke-1/project-access/project-context-first/skills");
	await expect(main.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
	await expect(main.getByRole("button", { name: "Back to Team Knowledge" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-context-first",
	);
	await page.goto("/agents/agent-smoke-1/project-access/project-context-later");
	await expect(main.getByRole("heading", { name: longContextProjectName, level: 1 })).toBeVisible();
	await expect(main.getByRole("button", { name: "View all Skills" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-context-later/skills",
	);
	await expect(main.getByRole("button", { name: /Install skill/i })).toBeVisible();
	await expect(main.getByRole("button", { name: "View all Vaults" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-context-later/vaults",
	);
	await expect(main.getByRole("button", { name: /New vault/i })).toBeVisible();
	const requestsBeforeInvalidScope = skillRequests.length;
	await page.goto("/agents/agent-smoke-1/project-access/project-unrelated/skills");
	await expect(
		main.getByText("Project not available to this Agent", { exact: true }),
	).toBeVisible();
	await expect(main.getByRole("button", { name: "Back to Agent Projects" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access",
	);
	await expect(main.getByRole("heading", { name: "Skills", level: 1 })).toHaveCount(0);
	expect(skillRequests).toHaveLength(requestsBeforeInvalidScope);

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

	// Isolate the compatibility-route phase from Console-level Project queries.
	vaultRequests.length = 0;
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/agents/agent-smoke-1/skills");
	await expect(page).toHaveURL("/agents/agent-smoke-1/project-access");
	await expect(main.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
	await page.goto("/agents/agent-smoke-1/skills?project=project-context-first");
	await expect(page).toHaveURL("/agents/agent-smoke-1/project-access/project-context-first/skills");
	await expect(main.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
	await expect(main.getByText("Project: Team Knowledge", { exact: true })).toBeVisible();
	await expect(main.getByText("Team-only Skill", { exact: true })).toBeVisible();
	await expect(main.getByText("Primary-only Skill", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Install skill/i })).toHaveCount(0);
	expect(vaultRequests).toEqual([]);
	await page.goto("/agents/agent-smoke-1/project-access/project-context-later/skills");
	await expect(main.getByText(`Project: ${longContextProjectName}`, { exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: /Install skill/i })).toBeVisible();
	await expect(main.getByRole("button", { name: /New vault/i })).toHaveCount(0);

	await page.goto("/agents/agent-smoke-1/vaults");
	await expect(page).toHaveURL("/agents/agent-smoke-1/project-access");
	await page.goto("/agents/agent-smoke-1/vaults?project=project-unrelated");
	await expect(page).toHaveURL("/agents/agent-smoke-1/project-access");
	await page.goto("/agents/agent-smoke-1/vaults?project=project-smoke");
	await expect(page).toHaveURL("/agents/agent-smoke-1/project-access/project-smoke/vaults");
	await expect(main.getByRole("heading", { name: "Vaults", level: 1 })).toBeVisible();
	const scopedVaultLink = main.getByRole("link", { name: "Open vault Scoped Vault" });
	await scopedVaultLink.click();
	await expect(page).toHaveURL(
		/\/agents\/agent-smoke-1\/vaults\/scoped-vault\?project=project-smoke&vault=vault-scoped$/,
	);
	await expect(main.getByRole("heading", { name: "Scoped Vault", level: 1 })).toBeVisible();
	await expect(main.getByRole("button", { name: "Vaults" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-smoke/vaults",
	);
	await expect(
		main
			.getByRole("navigation", { name: "breadcrumb" })
			.getByRole("link", { name: "Vaults", exact: true }),
	).toHaveAttribute("href", "/agents/agent-smoke-1/project-access/project-smoke/vaults");
	await expect(main.getByRole("button", { name: "Manage in resource library" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /^Delete$/ })).toBeVisible();
	await main.getByRole("button", { name: /Add keys/i }).click();
	await page.getByPlaceholder(/OPENAI_API_KEY/).fill("SCOPED_ADDED_KEY=secret-value");
	await page.getByRole("button", { name: "Save 1" }).click();
	await expect(page).toHaveURL(
		"/agents/agent-smoke-1/vaults/scoped-vault?project=project-smoke&vault=vault-scoped",
	);
	await expect(main.getByRole("link", { name: "Smoke Project" })).toHaveAttribute(
		"href",
		"/agents/agent-smoke-1/project-access/project-smoke",
	);
	const requestedVaultProjectIds = vaultRequests.map((request) =>
		new URL(request).searchParams.get("project_id"),
	);
	expect(requestedVaultProjectIds).toContain("project-smoke");
	expect(requestedVaultProjectIds).not.toContain("project-context-first");
	expect(requestedVaultProjectIds).not.toContain(null);
	expect(requestedVaultProjectIds).not.toContain("project-unrelated");
});

test("Workspace Vaults validate explicit Project access before reading resources", async ({
	page,
}) => {
	let releaseBindings: (() => void) | undefined;
	const projectBindingsGate = new Promise<void>((resolve) => {
		releaseBindings = resolve;
	});
	const vaultRequests: string[] = [];
	await stubDashboardApi(page, [], { projectBindingsGate, vaultRequests });

	await page.goto("/agents/agent-smoke-1/project-access/project-smoke/vaults");
	const main = page.locator("main");
	await expect(main.getByRole("button", { name: "Back to Agent Projects" })).toBeVisible();
	expect(vaultRequests).toEqual([]);
	if (!releaseBindings) throw new Error("Project binding gate was not initialized");
	releaseBindings();
	await expect(page).toHaveURL("/agents/agent-smoke-1/project-access/project-smoke/vaults");
	await expect(main.getByText("Scoped Vault", { exact: true })).toBeVisible();
	expect(vaultRequests).toHaveLength(1);
	const vaultRequest = vaultRequests[0];
	if (!vaultRequest) throw new Error("Agent Vault inventory was not requested after bindings");
	expect(new URL(vaultRequest).searchParams.get("project_id")).toBe("project-smoke");
});

test("Workspace Skills fail closed on Project binding errors without reading Skills", async ({
	page,
}) => {
	const skillRequests: string[] = [];
	await stubDashboardApi(page, [], {
		projectBindingsError: { status: 503, detail: "bindings unavailable" },
		skillRequests,
	});

	await page.goto("/agents/agent-smoke-1/project-access/project-smoke/skills");
	const main = page.locator("main");
	await expect(main.getByText("Couldn't verify Agent Project access", { exact: true })).toBeVisible(
		{ timeout: 15_000 },
	);
	await expect(
		page.getByTestId("app-sidebar").getByRole("group", { name: "Workspace", exact: true }),
	).toHaveCount(0);
	expect(skillRequests).toEqual([]);
});

test("agent Skill details resolve only through effective Projects", async ({ page }) => {
	let releaseBindings: (() => void) | undefined;
	const projectBindingsGate = new Promise<void>((resolve) => {
		releaseBindings = resolve;
	});
	const skillDetailRequests: string[] = [];
	const legacySkillDetailRequests: string[] = [];
	const contextProjectId = "project-context";
	const scopedSkill = {
		id: "skill-scoped",
		skill_key: "scoped-skill",
		name: "Scoped Skill",
		description: "Available through the primary Project",
		version: 1,
		source: "cloud",
		authority: "cloud",
		source_repo: null,
		file_count: 1,
		content: "Follow the scoped instructions.\n",
		agent_types: ["codex"],
		created_at: now.toISOString(),
		content_hash: "a".repeat(64),
		updated_at: now.toISOString(),
		project_id: "project-smoke",
		project_name: "Smoke Project",
		project_kind: "environment",
		environment_id: "agent-smoke-1",
		machine_name: "smoke-machine.local",
	};
	const contextSkill = {
		...scopedSkill,
		id: "skill-context",
		skill_key: "context-only",
		name: "Context-only Skill",
		description: "Available through an added Project",
		content: "Follow the context instructions.\n",
		project_id: contextProjectId,
		project_name: "Context Project",
		project_kind: "workspace",
		environment_id: null,
		machine_name: null,
	};
	await stubDashboardApi(page, [], {
		projectBindingsGate,
		projectBindings: [
			...projectBindings,
			{
				id: "binding-context",
				agent_id: "agent-smoke-1",
				project_id: contextProjectId,
				binding_type: "context",
				priority: 1,
				default_write_enabled: false,
				created_at: now.toISOString(),
			},
		],
		projects: [
			...projects,
			{
				id: contextProjectId,
				name: "Context Project",
				slug: "context-project",
				kind: "workspace",
				origin_environment_id: null,
				archived_at: null,
				created_at: now.toISOString(),
				is_owner: true,
				owner_display: "Dev User",
				owner_handle: "dev-user",
			},
		],
		skillDetailRequests,
		legacySkillDetailRequests,
		skillDetailResponses: {
			"project-smoke/scoped-skill": { body: scopedSkill, status: 200 },
			[`${contextProjectId}/context-only`]: { body: contextSkill, status: 200 },
		},
	});

	const deploymentQuery = "source=on-clawdi&d=deployment-smoke";
	await page.goto(
		`/agents/agent-smoke-1/skills/scoped-skill?project=project-smoke&${deploymentQuery}`,
	);
	const main = page.locator("main");
	await expect(main.getByRole("button", { name: "Back to Agent Projects" })).toBeVisible();
	expect(skillDetailRequests).toEqual([]);
	if (!releaseBindings) throw new Error("Project binding gate was not initialized");
	releaseBindings();
	await expect.poll(() => skillDetailRequests.length).toBe(1);
	await expect(main.getByRole("heading", { name: "Scoped Skill", level: 1 })).toBeVisible();
	await expect(main.getByRole("button", { name: "Agent Skills" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Manage in resource library" })).toHaveCount(0);
	const agentSkillsLink = main
		.getByRole("navigation", { name: "breadcrumb" })
		.getByRole("link", { name: "Skills", exact: true });
	await expect(agentSkillsLink).toHaveAttribute(
		"href",
		`/agents/agent-smoke-1/project-access/project-smoke/skills?${deploymentQuery}`,
	);
	expect(
		skillDetailRequests.some(
			(request) => new URL(request).pathname === "/v1/projects/project-smoke/skills/scoped-skill",
		),
	).toBe(true);
	expect(legacySkillDetailRequests).toEqual([]);

	const requestsBeforeTamperedProject = skillDetailRequests.length;
	await page.goto(
		`/agents/agent-smoke-1/skills/scoped-skill?project=project-unrelated&${deploymentQuery}`,
	);
	await expect(
		main.getByText("Project not available to this Agent", { exact: true }),
	).toBeVisible();
	await expect(main.getByRole("heading", { name: "Scoped Skill", level: 1 })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Agent Skills" })).toHaveCount(0);
	expect(skillDetailRequests).toHaveLength(requestsBeforeTamperedProject);
	expect(legacySkillDetailRequests).toEqual([]);

	await page.goto(
		`/agents/agent-smoke-1/skills/context-only?project=${contextProjectId}&${deploymentQuery}`,
	);
	await expect(main.getByRole("heading", { name: "Context-only Skill", level: 1 })).toBeVisible();
	const contextRequests = skillDetailRequests.filter((request) =>
		new URL(request).pathname.endsWith("/skills/context-only"),
	);
	expect(contextRequests.map((request) => new URL(request).pathname)).toEqual([
		`/v1/projects/${contextProjectId}/skills/context-only`,
	]);
	expect(legacySkillDetailRequests).toEqual([]);

	const requestsBeforeMissingProject = skillDetailRequests.length;
	await page.goto(`/agents/agent-smoke-1/skills/context-only?${deploymentQuery}`);
	await expect(
		main.getByText("Project not available to this Agent", { exact: true }),
	).toBeVisible();
	expect(skillDetailRequests).toHaveLength(requestsBeforeMissingProject);

	await page.goto(
		`/agents/agent-smoke-1/skills/missing-skill?project=${contextProjectId}&${deploymentQuery}`,
	);
	await expect(main.getByText("Skill not found", { exact: true })).toBeVisible();
	await expect(main.getByText("This Skill was not found in this Agent's Projects.")).toBeVisible();
	expect(legacySkillDetailRequests).toEqual([]);

	const errorPage = await page.context().newPage();
	const errorSkillDetailRequests: string[] = [];
	try {
		await stubDashboardApi(errorPage, [], {
			projectBindingsError: { status: 503, detail: "bindings unavailable" },
			skillDetailRequests: errorSkillDetailRequests,
		});
		await errorPage.goto(
			`/agents/agent-smoke-1/skills/scoped-skill?project=project-smoke&${deploymentQuery}`,
		);
		const errorMain = errorPage.locator("main");
		await expect(
			errorMain.getByText("Couldn't verify Agent Project access", { exact: true }),
		).toBeVisible({ timeout: 15_000 });
		await expect(errorMain.getByRole("button", { name: "Agent Skills" })).toHaveCount(0);
		await expect(
			errorMain
				.getByRole("navigation", { name: "breadcrumb" })
				.getByRole("link", { name: "Skills", exact: true }),
		).toHaveAttribute(
			"href",
			`/agents/agent-smoke-1/project-access/project-smoke/skills?${deploymentQuery}`,
		);
		expect(errorSkillDetailRequests).toEqual([]);
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
