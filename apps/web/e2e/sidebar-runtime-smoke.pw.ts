import { expect, type Page, type Route, test } from "@playwright/test";

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
			"Review customer notes",
			"Fix sync health",
			"Draft weekly update",
			"Fifth hidden session",
		][index],
		message_count: index + 2,
		input_tokens: 100 * (index + 1),
		output_tokens: 50 * (index + 1),
		last_activity_at: new Date(now.getTime() - index * 60 * 60 * 1000).toISOString(),
	})),
	total: 5,
};

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
	await expect(overview.getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
	await expect(overview.locator('[data-overview-module="sessions"]')).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="projects"]')).not.toHaveClass(
		/md:col-span-2/,
	);
	await expect(overview.locator('[data-overview-module="projects"]')).toContainText(
		"Smoke Project",
	);
	await expect(page.locator('[data-overview-status="live-sync"]')).toContainText(
		"smoke-machine.local",
	);
	await expect(page.locator('[data-overview-status="live-sync"]')).toContainText("Machine");
	await expect(page.locator('[data-overview-status="live-sync"]')).toContainText("Last seen");
	const recentSessions = page.getByRole("region", { name: "Recent sessions" });
	await expect(recentSessions.locator("article")).toHaveCount(4);
	await expect(recentSessions).not.toContainText("Fifth hidden session");
	await expect(overview.locator('[data-overview-module="skills"]')).toContainText("Research");
	for (const moduleId of ["memories", "vaults", "connectors"]) {
		await expect(overview.locator(`[data-overview-module="${moduleId}"]`)).toBeVisible();
	}
	const connectors = overview.locator('[data-overview-module="connectors"]');
	await expect(connectors).toContainText("2 connected apps");
	await expect(connectors.getByRole("link", { name: "Connected: Github" })).toBeVisible();
	await expect(connectors.getByRole("link", { name: "Connected: Slack" })).toBeVisible();
	await expect(connectors.getByRole("link", { name: "Popular: Gmail" })).toBeVisible();
	await expect(connectors.getByRole("link", { name: "Popular: Github" })).toHaveCount(0);
	const sidebar = page.getByTestId("app-sidebar");
	for (const section of ["Memories", "Vaults", "Connectors"]) {
		await expect(sidebar.getByRole("link", { name: section, exact: true })).toBeVisible();
	}
	await expect(overview.locator('[data-overview-module="agent-interface"]')).toHaveCount(0);
	await expect(overview.getByText("Activity and current state", { exact: true })).toHaveCount(0);
	await page.setViewportSize({ width: 1280, height: 1400 });
	await page.screenshot({
		path: testInfo.outputPath("connected-agent-overview.png"),
		fullPage: true,
	});
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
	await expect(card.getByRole("link", { name: "Popular: Gmail" })).toBeVisible();
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
	await expect(card).toContainText("Can’t load connected apps", { timeout: 12_000 });
	await expect(card).toContainText("Can’t load popular apps");
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
	await expect(card).toContainText("1 connected app");
	await expect(card.getByLabel("Loading popular apps")).toBeVisible();
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
