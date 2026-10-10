import type { ApiKey } from "@clawdi/shared/api";
import { expect, type Page, type Route, test } from "@playwright/test";
import { desktopBridgeCalls, injectDesktopBridge } from "./support/desktop-bridge";

const longLabel =
	"Production automation key with a deliberately long descriptive name that must truncate";
const now = "2026-07-28T12:00:00.000Z";
const retiredNote =
	"API keys can no longer be created. To connect Clawdi on your computer or a server, run clawdi auth login (use --no-open on a server). Existing keys keep working until you revoke them.";

function apiKey(id: string, label: string, overrides: Partial<ApiKey> = {}): ApiKey {
	return {
		id,
		label,
		key_prefix: `clawdi_${id}_prefix`,
		created_at: now,
		last_used_at: null,
		expires_at: null,
		revoked_at: null,
		scopes: null,
		...overrides,
	};
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

// The 403 body the API returns when a route needs a recently verified Clerk session.
const reverificationRequired = {
	clerk_error: {
		type: "forbidden",
		reason: "reverification-error",
		metadata: { reverification: "strict" },
	},
};

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function openApiKeySettings(page: Page) {
	await page.goto("/");
	await expect(page.getByTestId("app-sidebar")).toBeVisible({ timeout: 15_000 });
	const settingsButton = page.getByTestId("app-sidebar-settings-button");
	await expect(settingsButton).toBeEnabled();
	await settingsButton.click();
	await expect(page).toHaveURL(/[?&]settings=general/);
	const settingsDialog = page.getByTestId("settings-dialog");
	await expect(settingsDialog).toBeVisible({ timeout: 15_000 });
	await settingsDialog.getByRole("button", { name: /^API Keys/ }).click();
	await expect(settingsDialog.getByRole("heading", { name: "API Keys" })).toBeVisible();
}

async function stubApiKeys(
	page: Page,
	options: {
		initialKeys?: ApiKey[];
		failFirstList?: boolean;
		requireReverification?: { list?: boolean; revoke?: boolean };
	} = {},
) {
	let keys = options.initialKeys ?? [
		apiKey("active-long", longLabel, { last_used_at: "2026-07-27T08:00:00.000Z" }),
		apiKey("active-short", "CI runner", {
			expires_at: "2026-12-31T12:00:00.000Z",
			scopes: ["sessions:read", "sessions:write", "skills:write"],
		}),
		apiKey("active-backup", "Backup container", { created_at: "2026-07-27T12:00:00.000Z" }),
		apiKey("revoked", "Revoked key from an older backend", {
			revoked_at: "2026-07-27T10:00:00.000Z",
		}),
	];
	let listRequests = 0;
	let nextDelete:
		| {
				gate: ReturnType<typeof deferred>;
				fail: boolean;
		  }
		| undefined;
	const deleteRequests: string[] = [];
	const createRequests: string[] = [];

	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		const method = route.request().method();
		if (url.pathname === "/v1/auth/keys" && method === "GET") {
			listRequests += 1;
			if (options.requireReverification?.list && listRequests === 1) {
				await fulfillJson(route, reverificationRequired, 403);
				return;
			}
			if (options.failFirstList && listRequests === 1) {
				await fulfillJson(route, { detail: "Mock list failure" }, 400);
				return;
			}
			await fulfillJson(route, keys);
			return;
		}
		if (url.pathname === "/v1/auth/keys" && method === "POST") {
			createRequests.push(method);
			await fulfillJson(route, { detail: "API keys can no longer be created" }, 410);
			return;
		}
		if (url.pathname.startsWith("/v1/auth/keys/") && method === "DELETE") {
			const keyId = url.pathname.split("/").at(-1) ?? "";
			deleteRequests.push(keyId);
			const pendingDelete = nextDelete;
			if (pendingDelete) await pendingDelete.gate.promise;
			if (options.requireReverification?.revoke) {
				await fulfillJson(route, reverificationRequired, 403);
				return;
			}
			if (pendingDelete?.fail) {
				await fulfillJson(route, { detail: "Mock revoke failure" }, 500);
				return;
			}
			keys = keys.filter((key) => key.id !== keyId);
			await fulfillJson(route, { status: "revoked" });
			return;
		}

		if (url.pathname === "/v1/agents") {
			await fulfillJson(route, []);
			return;
		}
		if (url.pathname === "/v1/projects") {
			await fulfillJson(route, []);
			return;
		}
		if (["/v1/sessions", "/v1/skills", "/v1/memories"].includes(url.pathname)) {
			await fulfillJson(route, { items: [], total: 0, page: 1, page_size: 25 });
			return;
		}
		if (url.pathname === "/v1/connectors/available") {
			await fulfillJson(route, { items: [], total: 0, page: 1, page_size: 25 });
			return;
		}
		if (["/v1/connectors", "/v1/vault"].includes(url.pathname)) {
			await fulfillJson(route, []);
			return;
		}
		if (url.pathname === "/v1/dashboard/stats") {
			await fulfillJson(route, {
				total_sessions: 0,
				total_messages: 0,
				total_tokens: 0,
				active_days: 0,
				current_streak: 0,
				longest_streak: 0,
				peak_hour: null,
				favorite_model: null,
				skills_count: 0,
				memories_count: 0,
				vault_count: 0,
				vault_keys_count: 0,
				connectors_count: 0,
				manual_sessions_last_7_days: 0,
				contribution: [],
			});
			return;
		}
		await fulfillJson(route, {});
	});

	return {
		createRequests,
		deleteRequests,
		setNextDelete(fail: boolean) {
			const gate = deferred();
			nextDelete = { gate, fail };
			return gate;
		},
	};
}

test("API key settings lists existing keys read-only and reconciles optimistic revokes", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const api = await stubApiKeys(page);

	await openApiKeySettings(page);
	await expect(page.getByText("Revoked key from an older backend", { exact: true })).toHaveCount(0);
	const desktopTable = page.getByRole("table");
	await expect(desktopTable.getByText(longLabel, { exact: true })).toBeVisible();
	await expect(page.getByText(retiredNote, { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /Create API key/ })).toHaveCount(0);
	const legacyRow = desktopTable.getByRole("row").filter({ hasText: longLabel });
	await expect(legacyRow.getByText("Full access (legacy)", { exact: true })).toBeVisible();
	const scopedRow = desktopTable.getByRole("row").filter({ hasText: "CI runner" });
	await expect(
		scopedRow.getByText("Sessions (read, write), Skills (write)", { exact: true }),
	).toBeVisible();
	await expect(scopedRow.getByText("Dec 31, 2026", { exact: true })).toBeVisible();

	const successfulDelete = api.setNextDelete(false);
	await page.getByRole("button", { name: "Revoke CI runner" }).click();
	await page.getByRole("button", { name: "Revoke key", exact: true }).click();
	await expect(page.getByText("CI runner", { exact: true })).toHaveCount(0);
	const retainedRevoke = page.getByRole("alertdialog", { name: "Revoke “CI runner”?" });
	await expect(retainedRevoke).toBeVisible();
	await expect(retainedRevoke.getByRole("button", { name: "Revoke key" })).toBeDisabled();
	await expect.poll(() => api.deleteRequests).toContain("active-short");
	successfulDelete.resolve();
	await expect(retainedRevoke).toHaveCount(0);
	await expect(page.getByText("API key revoked", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Revoke Backup container" })).toBeEnabled();

	const failedDelete = api.setNextDelete(true);
	await page.getByRole("button", { name: "Revoke Backup container" }).click();
	await page.getByRole("button", { name: "Revoke key", exact: true }).click();
	await expect(page.getByText("Backup container", { exact: true })).toHaveCount(0);
	failedDelete.resolve();
	await expect(page.getByText("Couldn’t revoke API key", { exact: true })).toBeVisible();
	const failedRevoke = page.getByRole("alertdialog", { name: "Revoke “Backup container”?" });
	await expect(failedRevoke).toBeVisible();
	await failedRevoke.getByRole("button", { name: "Cancel" }).click();
	await expect(desktopTable.getByText("Backup container", { exact: true })).toBeVisible();

	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.getByTestId("settings-dialog")).toBeVisible({ timeout: 15_000 });
	const mobileCard = page.getByRole("article").filter({ hasText: longLabel });
	await expect(mobileCard).toBeVisible();
	const cardBox = await mobileCard.boundingBox();
	expect(cardBox).not.toBeNull();
	expect(cardBox?.x ?? -1).toBeGreaterThanOrEqual(0);
	expect((cardBox?.x ?? 0) + (cardBox?.width ?? 0)).toBeLessThanOrEqual(390);
	await expect(mobileCard.getByRole("button", { name: `Revoke ${longLabel}` })).toBeVisible();
	await expect(mobileCard.getByText("Full access (legacy)", { exact: true })).toBeVisible();
	expect(api.createRequests).toEqual([]);
});

test("API key list error is retryable and the empty state explains how to sign in", async ({
	page,
}) => {
	const api = await stubApiKeys(page, { initialKeys: [], failFirstList: true });

	await openApiKeySettings(page);
	await expect(page.getByText("Couldn’t load API keys", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByText("No active API keys", { exact: true })).toBeVisible();
	await expect(page.getByText(retiredNote, { exact: true })).toHaveCount(1);
	await expect(page.getByRole("button", { name: /Create API key/ })).toHaveCount(0);
	expect(api.createRequests).toEqual([]);
});

test("API keys surface Clerk's reverification requirement when it isn't met", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const api = await stubApiKeys(page, { requireReverification: { list: true, revoke: true } });

	// Dev auth bypass has no Clerk session to verify, so the requirement surfaces as an error.
	await openApiKeySettings(page);
	await expect(page.getByText("Couldn’t load API keys", { exact: true })).toBeVisible();
	await expect(page.getByText("Verify your identity to continue.", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Retry" }).click();
	const table = page.getByRole("table");
	await expect(table.getByText("CI runner", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Revoke CI runner" }).click();
	await page.getByRole("button", { name: "Revoke key", exact: true }).click();
	await expect(page.getByText("Couldn’t revoke API key", { exact: true })).toBeVisible();
	await expect(page.getByText("Verify your identity to continue.", { exact: true })).toBeVisible();
	await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
	await expect(table.getByText("CI runner", { exact: true })).toBeVisible();
	expect(api.deleteRequests).toEqual(["active-short"]);
});

test("Inside Clawdi Desktop, API keys stay in the dashboard", async ({ page }) => {
	await injectDesktopBridge(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	await stubApiKeys(page);

	await openApiKeySettings(page);
	await expect(page.getByRole("button", { name: "Revoke CI runner" })).toBeVisible();
	await expect(page.getByText("Opens in your browser.")).toHaveCount(0);
	expect(await desktopBridgeCalls(page)).toEqual([]);
});
