import { expect, type Page, type Route, test } from "@playwright/test";

const CLOUD_API = "http://127.0.0.1:8000";
const DEPLOY_API = "http://127.0.0.1:8001";
const account = {
	id: "33333333-3333-4333-8333-333333333333",
	provider: "telegram",
	name: "Stable Telegram",
	status: "active",
	visibility: "private",
	has_provider_token: true,
	webhook_url: "https://example.test/channels/stable",
	created_at: "2026-08-02T12:00:00.000Z",
};
const health = {
	account_id: account.id,
	provider: account.provider,
	name: account.name,
	visibility: account.visibility,
	channel_status: account.status,
	health_status: "ok",
	reasons: [],
	pending_inbox: 0,
	pending_deliveries: 0,
	in_progress_deliveries: 0,
	failed_deliveries: 0,
	last_message_at: null,
	last_event_at: null,
	last_error_at: null,
	last_error: null,
	last_error_stage: null,
	last_error_outcome: null,
	native_transport: null,
};

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

async function stubChannels(page: Page) {
	const refreshStarted = deferred();
	const releaseRefresh = deferred();
	let healthRequests = 0;
	await page.route(`${DEPLOY_API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/me" || path === "/v1/me") {
			return fulfillJson(route, {
				capabilities: { can_use_v1: false, can_use_v2: true },
			});
		}
		if (path === "/v1/agent-environments") {
			return fulfillJson(route, { environment_ids: [] });
		}
		if (path === "/v2/deployments") return fulfillJson(route, []);
		return fulfillJson(route, {});
	});
	await page.route(`${CLOUD_API}/v1/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/v1/channels") return fulfillJson(route, [account]);
		if (path === "/v1/channels/bot-pool") return fulfillJson(route, { providers: {} });
		if (path === "/v1/channels/health") {
			healthRequests += 1;
			if (healthRequests > 1) {
				refreshStarted.resolve();
				await releaseRefresh.promise;
			}
			return fulfillJson(route, { items: [health] });
		}
		if (path === "/v1/agents" || path === "/v1/projects") return fulfillJson(route, []);
		return fulfillJson(route, {});
	});
	return { refreshStarted, releaseRefresh, healthRequests: () => healthRequests };
}

for (const viewport of [
	{ label: "desktop", width: 1440, height: 1000 },
	{ label: "320px", width: 320, height: 800 },
]) {
	test(`Channels content stays stable during health polling at ${viewport.label}`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		const refresh = await stubChannels(page);
		await page.goto("/channels");

		const card = page.locator(`[data-channel-account-id="${account.id}"]`);
		await expect(card).toContainText(account.name);
		await expect(page.getByRole("button", { name: /All\s+1/ })).toBeVisible();
		const before = await card.boundingBox();
		if (!before) throw new Error("Expected the Channel card to have layout bounds");

		await expect.poll(refresh.healthRequests, { timeout: 25_000 }).toBeGreaterThan(1);
		await refresh.refreshStarted.promise;
		try {
			await expect(card).toContainText(account.name);
			await expect(page.getByRole("button", { name: /All\s+1/ })).toBeVisible();
			expect(await card.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
			expect(await card.locator(".animate-pulse").count()).toBe(0);
			const during = await card.boundingBox();
			if (!during) throw new Error("Expected the Channel card to remain mounted during refresh");
			expect(during).toEqual(before);
		} finally {
			refresh.releaseRefresh.resolve();
		}
	});
}
