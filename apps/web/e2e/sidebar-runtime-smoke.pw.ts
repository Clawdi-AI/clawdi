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
];

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

async function stubDashboardApi(page: Page) {
	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/v1/agents") {
			await fulfillJson(route, agents);
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

	await agentTile.locator("a").hover();
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
