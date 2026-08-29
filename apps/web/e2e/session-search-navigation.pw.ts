import { expect, type Route, test } from "@playwright/test";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-28T10:00:00.000Z";
const anchor = { kind: "event_seq", position: 7, revision: "events:head-hash" };
const nextAnchor = { kind: "event_seq", position: 11, revision: "events:head-hash" };

const session = {
	id: SESSION_ID,
	local_session_id: "local-session-search",
	project_path: "/workspace/clawdi",
	agent_name: "Search Codex",
	agent_display_name: "Search Codex",
	agent_default_name: "Codex",
	agent_type: "codex",
	machine_name: "search-machine",
	started_at: now,
	ended_at: null,
	updated_at: now,
	last_activity_at: now,
	duration_seconds: 120,
	message_count: 2,
	input_tokens: 120,
	output_tokens: 80,
	cache_read_tokens: 0,
	model: "gpt-5",
	models_used: ["gpt-5"],
	summary: "Fix authentication timeout",
	tags: [],
	status: "completed",
	content_hash: null,
	content_protocol: "events-v1",
	event_head_hash: "head-hash",
	is_shared: false,
	related_refs: null,
	has_content: true,
};

async function fulfillJson(route: Route, body: unknown) {
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

test("opens a message search result and returns to the same filtered list", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/v1/agents") {
			return fulfillJson(route, [
				{
					id: AGENT_ID,
					name: "Search Codex",
					display_name: "Search Codex",
					default_name: "Codex",
					machine_name: "search-machine",
					agent_type: "codex",
				},
			]);
		}
		if (url.pathname === "/v1/sessions") {
			return fulfillJson(route, {
				items: [
					{
						...session,
						search_match: {
							role: "assistant",
							excerpt: "Fixed the authentication timeout without retrying every request",
							anchor,
						},
					},
				],
				total: 26,
				page: 2,
				page_size: 25,
			});
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}`) {
			return fulfillJson(route, session);
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
			const searchQuery = url.searchParams.get("search_query");
			const selectedPosition = Number(url.searchParams.get("anchor_position"));
			const isDirectDetailSearch = searchQuery === "no longer";
			const isSecond = isDirectDetailSearch || selectedPosition === nextAnchor.position;
			if (searchQuery === null) {
				return fulfillJson(route, {
					items: [],
					total: 0,
					offset: 0,
					limit: 100,
				});
			}
			expect(["authentication timeout", "no longer"]).toContain(searchQuery);
			return fulfillJson(route, {
				items: [
					{
						role: "assistant",
						content: isSecond
							? "Verified the authentication timeout no longer recurs"
							: "Fixed the authentication timeout without retrying every request",
						model: "gpt-5",
						timestamp: now,
					},
				],
				total: 2,
				offset: 0,
				limit: 100,
				anchor_offset: 0,
				search_navigation: isDirectDetailSearch
					? { index: 1, total: 1, current: nextAnchor, previous: null, next: null }
					: isSecond
						? { index: 2, total: 2, current: nextAnchor, previous: anchor, next: null }
						: { index: 1, total: 2, current: anchor, previous: null, next: nextAnchor },
			});
		}
		return fulfillJson(route, {});
	});

	await page.goto("/sessions?q=authentication%20timeout&agent=codex&page=2&view=table");
	const visibleResult = page.locator('[data-testid="session-card"]:visible');
	await expect(visibleResult.locator("mark")).toHaveText("authentication timeout");

	await visibleResult
		.getByRole("link", { name: "Open session Fix authentication timeout" })
		.click();
	await expect(page.locator('[data-search-match="true"]')).toBeVisible();
	await expect(page.getByText("1 / 2")).toBeVisible();
	const detailSearch = page.getByRole("textbox", { name: "Search messages" });
	await detailSearch.press("Enter");
	await expect(page).toHaveURL((url) => url.searchParams.get("matchPosition") === "11");
	await expect(page.locator('[data-search-match="true"]')).toContainText(
		"Verified the authentication timeout no longer recurs",
	);
	await expect(page.getByText("2 / 2")).toBeVisible();
	await detailSearch.press("Shift+Enter");
	await expect(page).toHaveURL((url) => url.searchParams.get("matchPosition") === "7");
	await detailSearch.fill("no longer");
	await expect(page.getByRole("button", { name: "Next match" })).toBeDisabled();
	await expect(page).toHaveURL((url) => {
		return (
			url.searchParams.get("matchQuery") === "no longer" && !url.searchParams.has("matchPosition")
		);
	});
	await expect(page.locator('[data-search-match="true"]')).toContainText(
		"Verified the authentication timeout no longer recurs",
	);
	await expect(page.locator('[data-search-match="true"] mark')).toHaveText("no longer");
	await expect(page.getByText("1 / 1")).toBeVisible();

	await page.getByText("Back to Sessions", { exact: true }).click();
	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === "/sessions" &&
			url.searchParams.get("q") === "authentication timeout" &&
			url.searchParams.get("agent") === "codex" &&
			url.searchParams.get("page") === "2" &&
			url.searchParams.get("view") === "table"
		);
	});
});

test("filters session activity and expands paired tool details", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const timeline = [
		{
			kind: "message",
			position: 6,
			role: "assistant",
			content: "Final answer after reading the file",
			model: "gpt-5",
			timestamp: now,
		},
		{
			kind: "tool_result",
			position: 5,
			call_id: "call-search",
			name: "search",
			status: "error",
			content: "No matching file",
			result_json: null,
			timestamp: now,
		},
		{
			kind: "tool_result",
			position: 4,
			call_id: "call-read",
			name: "read",
			status: "completed",
			content: "Repository instructions",
			result_json: null,
			timestamp: now,
		},
		{
			kind: "tool_call",
			position: 3,
			call_id: "call-search",
			name: "search",
			arguments_json: '{"query":"session"}',
			model: "gpt-5",
			timestamp: now,
		},
		{
			kind: "tool_call",
			position: 2,
			call_id: "call-read",
			name: "read",
			arguments_json: '{"path":"README.md"}',
			model: "gpt-5",
			timestamp: now,
		},
		{
			kind: "message",
			position: 1,
			role: "user",
			content: "Read the repository instructions",
			model: null,
			timestamp: now,
		},
	] as const;

	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/v1/agents") {
			return fulfillJson(route, [
				{
					id: AGENT_ID,
					name: "Search Codex",
					display_name: "Search Codex",
					default_name: "Codex",
					machine_name: "search-machine",
					agent_type: "codex",
				},
			]);
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}`) {
			return fulfillJson(route, session);
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
			const view = url.searchParams.get("view");
			const query = url.searchParams.get("search_query");
			if (query) {
				await new Promise((resolve) => setTimeout(resolve, 450));
				if (view !== "assistant" && view !== "all") {
					const items = view === "tools" ? timeline.slice(1, 5) : [timeline[5]];
					return fulfillJson(route, {
						items,
						total: items.length,
						offset: 0,
						limit: 100,
						search_navigation: null,
					});
				}
				return fulfillJson(route, {
					items: [timeline[0]],
					total: 1,
					offset: 0,
					limit: 100,
					anchor_offset: 0,
					search_navigation: {
						index: 1,
						total: 1,
						current: anchor,
						previous: null,
						next: null,
					},
				});
			}
			const items =
				view === "tools" ? timeline.slice(1, 5) : view === "user" ? [timeline[5]] : timeline;
			return fulfillJson(route, {
				items,
				total: items.length,
				offset: 0,
				limit: 100,
			});
		}
		return fulfillJson(route, {});
	});

	await page.goto(`/sessions/${SESSION_ID}?timelineView=tools`);
	await expect(page.getByRole("textbox", { name: "Search messages" })).not.toBeVisible();
	const toolActivity = page.getByRole("button", { name: /read.*Done/ });
	await expect(toolActivity).toBeVisible();
	await expect(page.getByRole("button", { name: /search.*Error/ })).toBeVisible();
	await expect(page.getByText("Final answer after reading the file")).not.toBeVisible();
	await toolActivity.click();
	await expect(page.locator("pre").filter({ hasText: '"path": "README.md"' })).toBeVisible();
	await page.getByRole("tab", { name: "Output" }).click();
	await expect(page.getByText("Repository instructions", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Your messages" }).click();
	await expect(page).toHaveURL((url) => url.searchParams.get("timelineView") === "user");
	await expect(page.getByText("Read the repository instructions", { exact: true })).toBeVisible();
	await expect(toolActivity).not.toBeVisible();
	await page.getByRole("textbox", { name: "Search messages" }).fill("Read the repository");
	await expect(page).toHaveURL(
		(url) => url.searchParams.get("matchQuery") === "Read the repository",
	);

	await page.getByRole("button", { name: "Tools activity" }).click();
	await expect(page).toHaveURL((url) => {
		return url.searchParams.get("timelineView") === "tools" && !url.searchParams.has("matchQuery");
	});
	await expect(page.getByRole("textbox", { name: "Search messages" })).not.toBeVisible();
	await expect(page.getByRole("button", { name: "Tools activity" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(toolActivity).toBeVisible();

	await page.getByRole("button", { name: "Agent messages" }).click();
	const restoredSearch = page.getByRole("textbox", { name: "Search messages" });
	await expect(restoredSearch).toHaveValue("Read the repository");
	await expect(page).toHaveURL((url) => {
		return (
			url.searchParams.get("matchQuery") === "Read the repository" &&
			url.searchParams.get("timelineView") === "assistant"
		);
	});
	await restoredSearch.fill("Final answer");
	await expect(page).toHaveURL((url) => {
		return (
			url.searchParams.get("matchQuery") === "Final answer" &&
			url.searchParams.get("timelineView") === "assistant" &&
			!url.searchParams.has("matchPosition")
		);
	});
	await expect(page.locator('[data-search-match="true"]')).toContainText(
		"Final answer after reading the file",
	);
	await expect(page.getByText("1 / 1")).toBeVisible();
});
