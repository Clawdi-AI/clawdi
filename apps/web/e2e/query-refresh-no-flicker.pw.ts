import { expect, type Page, type Route, test } from "@playwright/test";

const now = "2026-08-02T12:00:00.000Z";
const agent = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "stable-agent",
	default_name: "Stable Agent",
	machine_name: "stable-agent.local",
	display_name: "Stable Agent",
	avatar_url: null,
	sort_order: 0,
	agent_type: "codex",
	agent_version: "1.0.0",
	os: "linux",
	last_seen_at: now,
	last_sync_at: now,
	last_sync_error: null,
	last_revision_seen: 1,
	queue_depth_high_water: 0,
	dropped_count: 0,
	sync_enabled: true,
	explicit_identity: true,
	default_project_id: "22222222-2222-4222-8222-222222222222",
};
const project = {
	id: agent.default_project_id,
	name: "Stable Project",
	slug: "stable-project",
	kind: "environment",
	origin_environment_id: agent.id,
	archived_at: null,
	created_at: now,
	is_owner: true,
	owner_display: "Browser User",
	owner_handle: "browser-user",
};
const stats = {
	total_sessions: 1,
	total_messages: 1,
	total_tokens: 1,
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
	contribution: [{ date: "2026-08-02", count: 1, level: 1 }],
};
const emptyPage = { items: [], total: 0, page: 1, page_size: 25 };

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function fulfillJson(route: Route, body: unknown) {
	await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubDashboard(page: Page) {
	const refreshStarted = deferred();
	const releaseRefresh = deferred();
	let agentRequests = 0;
	await page.route("**/v1/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/v1/agents") {
			agentRequests += 1;
			if (agentRequests > 1) {
				refreshStarted.resolve();
				await releaseRefresh.promise;
			}
			return fulfillJson(route, [agent]);
		}
		if (path === "/v1/dashboard/stats") return fulfillJson(route, stats);
		if (path === "/v1/projects") return fulfillJson(route, [project]);
		if (path === "/v1/sessions") return fulfillJson(route, emptyPage);
		return fulfillJson(route, {});
	});
	return { refreshStarted, releaseRefresh, agentRequests: () => agentRequests };
}

for (const viewport of [
	{ label: "desktop", width: 1440, height: 1000 },
	{ label: "320px", width: 320, height: 800 },
]) {
	test(`dashboard Agent content stays stable during polling at ${viewport.label}`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		const refresh = await stubDashboard(page);
		await page.goto("/");

		const link = page.getByRole("link", { name: /Open Stable Agent/ }).first();
		// The agents query can error once during SSR (no stub server-side) and
		// only resolve on a client retry, so the first paint allowance matches
		// the suite-wide 15s convention instead of the 5s default.
		await expect(link).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("1 agent", { exact: true })).toBeVisible();
		const card = link.locator("..");
		const before = await card.boundingBox();
		if (!before) throw new Error("Expected the Agent card to have layout bounds");

		await expect.poll(refresh.agentRequests, { timeout: 15_000 }).toBeGreaterThan(1);
		await refresh.refreshStarted.promise;
		try {
			await expect(link).toBeVisible();
			await expect(page.getByText("1 agent", { exact: true })).toBeVisible();
			expect(await card.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
			expect(await card.locator(".animate-pulse").count()).toBe(0);
			const during = await card.boundingBox();
			if (!during) throw new Error("Expected the Agent card to remain mounted during refresh");
			expect(during).toEqual(before);
		} finally {
			refresh.releaseRefresh.resolve();
		}
	});
}
