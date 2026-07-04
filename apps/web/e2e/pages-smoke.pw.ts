import { expect, type Page, type Route, test } from "@playwright/test";

// Broad OSS-page smoke: exercises Base UI primitives (command palette / cmdk,
// dropdown menus, page-level dialogs/selects) across reachable dashboard pages
// and asserts ZERO browser console/page errors — guards the class of runtime
// Base UI regression (e.g. MenuGroupContext) that unit tests + typecheck miss.

const now = new Date("2026-07-04T12:00:00.000Z").toISOString();

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
		last_seen_at: now,
		last_sync_at: now,
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
		created_at: now,
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
	skills_count: 0,
	memories_count: 0,
	vault_count: 0,
	vault_keys_count: 0,
	connectors_count: 0,
	manual_sessions_last_7_days: 1,
	contribution: [{ date: "2026-07-04", count: 1, level: 1 }],
};

const emptyPage = { items: [], total: 0, page: 1, page_size: 25 };

async function fulfillJson(route: Route, body: unknown) {
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

async function stubApi(page: Page) {
	await page.route("**/v1/**", async (route) => {
		const p = new URL(route.request().url()).pathname;
		if (p === "/v1/agents") return fulfillJson(route, agents);
		if (p === "/v1/dashboard/stats") return fulfillJson(route, dashboardStats);
		if (p === "/v1/projects") return fulfillJson(route, projects);
		if (p === "/v1/sessions") return fulfillJson(route, emptyPage);
		if (p === "/v1/skills") return fulfillJson(route, emptyPage);
		if (p === "/v1/connectors") return fulfillJson(route, []);
		if (p === "/v1/connectors/available") return fulfillJson(route, emptyPage);
		if (p === "/v1/memories") return fulfillJson(route, emptyPage);
		if (p === "/v1/vault") return fulfillJson(route, []);
		if (p === "/v1/auth/keys") return fulfillJson(route, []);
		// Default: empty object is the safest generic shape.
		return fulfillJson(route, {});
	});
}

function collectBrowserErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	page.on("pageerror", (e) => errors.push(e.message));
	return errors;
}

async function expectNoErrors(page: Page, errors: string[], label: string) {
	await page.waitForTimeout(150);
	expect(errors, `${label}: ${errors.join(" | ")}`).toEqual([]);
}

for (const path of ["/skills", "/sessions", "/connectors", "/memories", "/vault", "/projects"]) {
	test(`page ${path} renders without browser errors`, async ({ page }) => {
		const errors = collectBrowserErrors(page);
		await stubApi(page);
		await page.goto(path);
		await expect(page.getByTestId("app-sidebar")).toBeVisible();
		await expectNoErrors(page, errors, `render ${path}`);
	});
}
