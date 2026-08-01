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
		kind: "custom",
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

async function fulfillJson(route: Route, body: unknown) {
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

async function stubDashboardApi(
	page: Page,
	agentOrderRequests: string[] = [],
	options: { projectBindingsGate?: Promise<void>; vaultRequests?: string[] } = {},
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
			await fulfillJson(route, projectBindings);
			return;
		}
		if (url.pathname === "/v1/dashboard/stats") {
			await fulfillJson(route, dashboardStats);
			return;
		}
		if (url.pathname === "/v1/projects") {
			await fulfillJson(route, projects);
			return;
		}
		if (url.pathname === "/v1/vault") {
			options.vaultRequests?.push(route.request().url());
			await fulfillJson(route, vaults);
			return;
		}
		if (url.pathname === "/v1/connectors") {
			await fulfillJson(route, []);
			return;
		}
		if (url.pathname === "/v1/connectors/available") {
			await fulfillJson(route, {
				items: [
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
			await fulfillJson(route, sessions);
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
		{ label: "Resources", items: ["Connectors", "Projects", "Skills", "Vaults"] },
		{ label: null, items: ["Settings"] },
	]);
});

test("connected agent resource tabs reuse scoped Projects, account Connectors, and effective Vaults", async ({
	page,
}) => {
	await stubDashboardApi(page);

	await page.goto("/agents/agent-smoke-1/connectors?q=gmail&page=2");
	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Connectors", level: 1 })).toBeVisible();
	await expect(page).toHaveTitle("Connectors · Clawdi");
	await expect(
		main.getByText("Account-wide connectors available across all agents."),
	).toBeVisible();
	await expect(main.getByRole("link", { name: "Gmail" })).toBeVisible();
	await expect(page).toHaveURL(/\/agents\/agent-smoke-1\/connectors\?q=gmail&page=2/);

	await page.goto("/agents/agent-smoke-1/project-access");
	await expect(main.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
	await expect(main.getByRole("heading", { name: "Agent Project", level: 2 })).toBeVisible();
	await expect(main.getByText("Smoke Project", { exact: true })).toBeVisible();

	await page.goto("/agents/agent-smoke-1/vaults");
	await expect(main.getByRole("heading", { name: "Vaults", level: 1 })).toBeVisible();
	await expect(page).toHaveTitle("Vaults · Clawdi");
	await expect(
		main.getByText(
			"Vaults appear here through this agent's Agent Project and added Projects. Open a Vault to manage it in the account-level Vaults area.",
		),
	).toBeVisible();
	await expect(main.getByText("Scoped Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Unrelated Vault", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /New vault/i })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Add keys/i })).toHaveCount(0);
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
