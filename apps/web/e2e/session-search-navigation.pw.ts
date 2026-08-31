import { expect, type Locator, type Route, test } from "@playwright/test";

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

async function horizontalBounds(locator: Locator) {
	return locator.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		return { x: bounds.x, width: bounds.width };
	});
}

test("opens a global Session body match at the exact message", async ({ page }) => {
	const query = "global palette anchor";
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
			return fulfillJson(route, { items: [], total: 0, page: 1, page_size: 25 });
		}
		if (url.pathname === "/v1/search") {
			expect(url.searchParams.get("q")).toBe(query);
			return fulfillJson(route, {
				query,
				results: [
					{
						type: "session",
						id: SESSION_ID,
						title: "Global search result",
						subtitle: "codex · /workspace/clawdi",
						href: `/sessions/${SESSION_ID}`,
						search_match: {
							role: "assistant",
							excerpt: `Found the ${query} in this response`,
							anchor,
						},
					},
				],
			});
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}`) {
			return fulfillJson(route, session);
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
			expect(url.searchParams.get("search_query")).toBe(query);
			expect(url.searchParams.get("anchor_position")).toBe(String(anchor.position));
			return fulfillJson(route, {
				items: [
					{
						kind: "message",
						position: anchor.position,
						role: "assistant",
						content: `Found the ${query} in this response`,
						model: "gpt-5",
						timestamp: now,
					},
				],
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
		return fulfillJson(route, {});
	});

	await page.goto("/sessions");
	await page.getByTestId("app-sidebar-search-button").click();
	const palette = page.getByRole("dialog", { name: "Search" });
	await palette
		.getByPlaceholder("Search agents, sessions, memories, projects, skills, vaults…")
		.fill(query);
	await expect(palette.getByText(`Found the ${query} in this response`)).toBeVisible();
	await expect(palette.locator("mark")).toHaveText(["Global", "global palette anchor"]);
	await palette.getByText("Global search result").click();

	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === `/sessions/${SESSION_ID}` &&
			url.searchParams.get("matchPosition") === String(anchor.position) &&
			url.searchParams.get("matchQuery") === query
		);
	});
	const current = page.locator('[data-search-match="true"]');
	await expect(current).toContainText(`Found the ${query} in this response`);
	await expect(current.locator("mark")).toHaveText(["global palette anchor"]);
	expect(
		await current.evaluate((element) => {
			const style = getComputedStyle(element);
			return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
		}),
	).toEqual(["8px", "8px", "8px", "8px"]);
});

test("opens a message search result and returns to the same filtered list", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const requestedSearchQueries: string[] = [];
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
			if (searchQuery !== null) requestedSearchQueries.push(searchQuery);
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
	await expect(visibleResult.locator("mark")).toHaveText(["authentication timeout"]);

	await visibleResult
		.getByRole("link", { name: "Open session Fix authentication timeout" })
		.click();
	await expect(page.locator('[data-search-match="true"]')).toBeVisible();
	await expect(page.getByText("1 / 2")).toBeVisible();
	const detailSearch = page.getByRole("textbox", { name: "Search messages" });
	const searchInputGroup = detailSearch.locator("..");
	const clearSearchButton = page.getByRole("button", { name: "Clear search" });
	const initialSearchBounds = await horizontalBounds(searchInputGroup);
	const initialClearBounds = await horizontalBounds(clearSearchButton);
	await detailSearch.press("Enter");
	await expect(page).toHaveURL((url) => url.searchParams.get("matchPosition") === "11");
	await expect(page.locator('[data-search-match="true"]')).toContainText(
		"Verified the authentication timeout no longer recurs",
	);
	await expect(page.getByText("2 / 2")).toBeVisible();
	await detailSearch.press("Shift+Enter");
	await expect(page).toHaveURL((url) => url.searchParams.get("matchPosition") === "7");
	await detailSearch.fill("x");
	await expect(page.getByText("2+ chars")).toBeVisible();
	expect(await horizontalBounds(searchInputGroup)).toEqual(initialSearchBounds);
	expect(await horizontalBounds(clearSearchButton)).toEqual(initialClearBounds);
	await page.waitForTimeout(350);
	expect(requestedSearchQueries).not.toContain("x");
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
	await expect(page.locator('[data-search-match="true"] mark')).toHaveText(["no longer"]);
	await expect(page.getByText("1 / 1")).toBeVisible();
	expect(await horizontalBounds(clearSearchButton)).toEqual(initialClearBounds);
	await clearSearchButton.click();
	await expect(detailSearch).toHaveValue("");
	await expect(page).toHaveURL((url) => !url.searchParams.has("matchQuery"));
	expect(await horizontalBounds(searchInputGroup)).toEqual(initialSearchBounds);

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
			expect(url.searchParams.get("view")).toBe("all");
			const requestedCategories = url.searchParams.getAll("include");
			const categories = new Set(
				requestedCategories.length > 0 ? requestedCategories : ["user", "assistant", "tools"],
			);
			const items = timeline.filter((item) =>
				item.kind === "message" ? categories.has(item.role) : categories.has("tools"),
			);
			const query = url.searchParams.get("search_query");
			if (query) {
				await new Promise((resolve) => setTimeout(resolve, 450));
				const matchIndex = items.findIndex(
					(item) =>
						item.kind === "message" && item.content.toLowerCase().includes(query.toLowerCase()),
				);
				const match = matchIndex >= 0 ? items[matchIndex] : null;
				return fulfillJson(route, {
					items,
					total: items.length,
					offset: 0,
					limit: 100,
					...(match
						? {
								anchor_offset: matchIndex,
								search_navigation: {
									index: 1,
									total: 1,
									current: { ...anchor, position: match.position },
									previous: null,
									next: null,
								},
							}
						: { search_navigation: null }),
				});
			}
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
	await expect(page).toHaveURL((url) => url.searchParams.get("timelineView") === "user,tools");
	await expect(page.getByText("Read the repository instructions", { exact: true })).toBeVisible();
	await expect(toolActivity).toBeVisible();
	await page.getByRole("textbox", { name: "Search messages" }).fill("Read the repository");
	await expect(page).toHaveURL(
		(url) => url.searchParams.get("matchQuery") === "Read the repository",
	);

	await page.getByRole("button", { name: "Your messages" }).click();
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
			url.searchParams.get("timelineView") === "assistant,tools"
		);
	});
	await page.getByRole("button", { name: "Tools activity" }).click();
	await expect(page).toHaveURL((url) => url.searchParams.get("timelineView") === "assistant");
	await expect(toolActivity).not.toBeVisible();
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
	await page.getByRole("button", { name: "Your messages" }).click();
	await expect(page).toHaveURL((url) => url.searchParams.get("timelineView") === "user,assistant");
	await expect(page.getByText("Read the repository instructions", { exact: true })).toBeVisible();
	await expect(toolActivity).not.toBeVisible();
});

test("keeps a long anchored timeline windowed across desktop and mobile", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const targetPosition = 1500;
	const query = "virtualized needle";
	const revision = "events:long-head";
	const targetAnchor = { kind: "event_seq", position: targetPosition, revision };
	const makeMessage = (position: number) => ({
		kind: "message",
		position,
		role: position % 4 === 0 ? "user" : "assistant",
		content:
			position === targetPosition
				? `Current ${query} result stays mounted`
				: `Timeline message ${position} with enough content to exercise dynamic row measurement.`,
		model: position % 4 === 0 ? null : "gpt-5",
		timestamp: new Date(Date.parse(now) + position * 1_000).toISOString(),
	});
	const browseTimeline = Array.from({ length: 500 }, (_, index) => makeMessage(499 - index));
	const searchWindowOffset = 1450;
	const searchWindow = Array.from({ length: 100 }, (_, index) =>
		makeMessage(searchWindowOffset + 99 - index),
	);
	const olderSearchWindow = Array.from({ length: 100 }, (_, index) =>
		makeMessage(searchWindowOffset - 1 - index),
	);
	const searchAnchorOffset = searchWindowOffset + 49;
	const requestedOffsets = new Set<number>();
	const requestedSearchOffsets = new Set<number>();

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
			return fulfillJson(route, {
				...session,
				summary: "Long virtualized session",
				message_count: 2000,
				event_head_hash: "long-head",
			});
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
			expect(url.searchParams.get("direction")).toBe("desc");
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const isSearchPagination = offset >= searchWindowOffset;
			if (!url.searchParams.has("search_query") && !isSearchPagination) {
				requestedOffsets.add(offset);
				return fulfillJson(route, {
					items: browseTimeline.slice(offset, offset + 100),
					total: browseTimeline.length,
					offset,
					limit: 100,
				});
			}
			requestedSearchOffsets.add(offset);
			const loadingOlder = offset === searchWindowOffset + searchWindow.length;
			return fulfillJson(route, {
				items: loadingOlder ? olderSearchWindow : searchWindow,
				total: 2000,
				offset: loadingOlder ? offset : searchWindowOffset,
				limit: 100,
				...(loadingOlder
					? {}
					: {
							anchor_offset: searchAnchorOffset,
							search_navigation: {
								index: 1,
								total: 1,
								current: targetAnchor,
								previous: null,
								next: null,
							},
						}),
			});
		}
		return fulfillJson(route, {});
	});

	await page.goto(`/sessions/${SESSION_ID}`);
	const scrollContainer = page.locator("#dashboard-scroll-container");
	await expect.poll(() => requestedOffsets.size).toBeGreaterThan(0);
	await expect(page.getByText(/^Timeline message 499 /)).toBeInViewport();
	for (let attempt = 0; attempt < 8 && requestedOffsets.size < 5; attempt++) {
		const requestCount = requestedOffsets.size;
		await scrollContainer.evaluate((element) => element.scrollTo({ top: 0 }));
		await expect.poll(() => requestedOffsets.size).toBeGreaterThan(requestCount);
	}
	expect([...requestedOffsets].sort((left, right) => left - right)).toEqual([
		0, 100, 200, 300, 400,
	]);
	const jumpToLatest = page.getByRole("button", { name: "Jump to latest" });
	await expect(jumpToLatest).toBeVisible();
	const [jumpBounds, scrollBounds] = await Promise.all([
		horizontalBounds(jumpToLatest),
		horizontalBounds(scrollContainer),
	]);
	expect(
		Math.abs(jumpBounds.x + jumpBounds.width / 2 - (scrollBounds.x + scrollBounds.width / 2)),
	).toBeLessThan(2);
	await jumpToLatest.click();
	await expect(page.getByText(/^Timeline message 499 /)).toBeInViewport();
	const mountedRows = page.locator(
		'[data-testid="virtualized-session-timeline"] [data-item-index]',
	);
	await expect.poll(() => mountedRows.count()).toBeGreaterThan(0);
	expect(await mountedRows.count()).toBeLessThan(80);

	const search = new URLSearchParams({
		matchKind: targetAnchor.kind,
		matchPosition: String(targetAnchor.position),
		matchRevision: targetAnchor.revision,
		matchQuery: query,
	});
	await page.goto(`/sessions/${SESSION_ID}?${search}`);
	const current = page.locator('[data-search-match="true"]');
	await expect(current).toContainText(`Current ${query} result stays mounted`);
	await expect(current.locator("mark")).toHaveText(["virtualized needle"]);
	expect(await mountedRows.count()).toBeLessThan(80);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(current).toBeVisible();
	expect(await mountedRows.count()).toBeLessThan(80);

	await page.setViewportSize({ width: 1280, height: 900 });
	await scrollContainer.evaluate((element) => element.scrollTo({ top: 0 }));
	await page.getByRole("button", { name: "Load earlier (100/2000)" }).click();
	await expect.poll(() => requestedSearchOffsets.has(1550)).toBe(true);
	await expect(page.getByRole("button", { name: "Load earlier (200/2000)" })).toBeVisible();
	const stableScrollTop = await scrollContainer.evaluate((element) => element.scrollTop);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}),
	);
	const settledScrollTop = await scrollContainer.evaluate((element) => element.scrollTop);
	expect(Math.abs(settledScrollTop - stableScrollTop)).toBeLessThan(2);
	const currentMatchInViewport = await current.evaluateAll((elements) =>
		elements.some((element) => {
			const bounds = element.getBoundingClientRect();
			return bounds.bottom > 0 && bounds.top < window.innerHeight;
		}),
	);
	expect(currentMatchInViewport).toBe(false);
});
