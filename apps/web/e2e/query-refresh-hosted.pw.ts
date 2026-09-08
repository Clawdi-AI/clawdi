import { expect, type Page, type Route, test } from "@playwright/test";
import { stubHostedApi } from "./hosted-stub-api";

const CLOUD_API = "http://127.0.0.1:8000";
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
	await stubHostedApi(page);
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
		return route.fallback();
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

		await expect.poll(refresh.healthRequests, { timeout: 25_000 }).toBeGreaterThan(1);
		await refresh.refreshStarted.promise;
		try {
			await expect(card).toBeVisible();
			await expect(card).toContainText(account.name);
			await expect(page.getByRole("button", { name: /All\s+1/ })).toBeVisible();
			expect(await card.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
		} finally {
			refresh.releaseRefresh.resolve();
		}
	});
}
