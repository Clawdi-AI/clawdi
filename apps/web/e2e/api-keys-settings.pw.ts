import { expect, type Page, type Route, test } from "@playwright/test";

type ApiKeyFixture = {
	id: string;
	label: string;
	key_prefix: string;
	created_at: string;
	last_used_at: string | null;
	expires_at: string | null;
	revoked_at: string | null;
};

const longLabel =
	"Production automation key with a deliberately long descriptive name that must truncate";
const now = "2026-07-28T12:00:00.000Z";

function apiKey(id: string, label: string, overrides: Partial<ApiKeyFixture> = {}): ApiKeyFixture {
	return {
		id,
		label,
		key_prefix: `clawdi_${id}_prefix`,
		created_at: now,
		last_used_at: null,
		expires_at: null,
		revoked_at: null,
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
	await expect(async () => {
		await page.getByTestId("app-sidebar-settings-button").click();
		await expect(page).toHaveURL(/[?&]settings=general/, { timeout: 1_000 });
	}).toPass({ timeout: 15_000 });
	const settingsDialog = page.getByTestId("settings-dialog");
	await expect(settingsDialog).toBeVisible({ timeout: 15_000 });
	await settingsDialog.getByRole("button", { name: /^API Keys/ }).click();
	await expect(settingsDialog.getByRole("heading", { name: "API Keys" })).toBeVisible();
}

async function stubApiKeys(
	page: Page,
	options: { initialKeys?: ApiKeyFixture[]; failFirstList?: boolean } = {},
) {
	let keys = options.initialKeys ?? [
		apiKey("active-long", longLabel, { last_used_at: "2026-07-27T08:00:00.000Z" }),
		apiKey("active-short", "CI runner", { expires_at: "2026-12-31T00:00:00.000Z" }),
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

	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		const method = route.request().method();
		if (url.pathname === "/v1/auth/keys" && method === "GET") {
			listRequests += 1;
			if (options.failFirstList && listRequests === 1) {
				await fulfillJson(route, { detail: "Mock list failure" }, 400);
				return;
			}
			await fulfillJson(route, keys);
			return;
		}
		if (url.pathname === "/v1/auth/keys" && method === "POST") {
			const body = route.request().postDataJSON() as { label: string };
			const created = apiKey("created", body.label);
			keys = [created, ...keys];
			await fulfillJson(route, { ...created, raw_key: "clawdi_created_one_time_secret" });
			return;
		}
		if (url.pathname.startsWith("/v1/auth/keys/") && method === "DELETE") {
			const keyId = url.pathname.split("/").at(-1) ?? "";
			deleteRequests.push(keyId);
			const pendingDelete = nextDelete;
			if (pendingDelete) await pendingDelete.gate.promise;
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
		deleteRequests,
		setNextDelete(fail: boolean) {
			const gate = deferred();
			nextDelete = { gate, fail };
			return gate;
		},
	};
}

test("API key settings protects secrets and reconciles optimistic revokes", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: () => Promise.reject(new DOMException("Clipboard blocked")),
			},
		});
	});
	const api = await stubApiKeys(page);

	await openApiKeySettings(page);
	await expect(page.getByText("Revoked key from an older backend", { exact: true })).toHaveCount(0);
	const desktopTable = page.getByRole("table");
	await expect(desktopTable.getByText(longLabel, { exact: true })).toBeVisible();

	const longName = desktopTable.getByText(longLabel, { exact: true });
	const truncation = await longName.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(truncation.scrollWidth).toBeGreaterThan(truncation.clientWidth);

	await page.getByRole("button", { name: "Create API key", exact: true }).first().click();
	let createDialog = page.getByRole("dialog", { name: "Create API key" });
	await createDialog.getByLabel("Key name").fill("Retained through exit");
	await page.keyboard.press("Escape");
	await expect(createDialog.getByLabel("Key name")).toHaveValue("Retained through exit");
	await expect(createDialog).toHaveCount(0);

	await page.getByRole("button", { name: "Create API key", exact: true }).first().click();
	createDialog = page.getByRole("dialog", { name: "Create API key" });
	await expect(createDialog.getByLabel("Key name")).toHaveValue("");
	await createDialog.getByLabel("Key name").fill("Backup container");
	await createDialog.getByRole("button", { name: "Create API key", exact: true }).click();

	const secretDialog = page.getByRole("dialog", { name: "Save your API key" });
	await expect(
		secretDialog.getByText("clawdi_created_one_time_secret", { exact: true }),
	).toBeVisible();
	await expect(secretDialog.getByRole("button", { name: "Done" })).toBeDisabled();
	await expect(secretDialog.getByRole("button", { name: "Close" })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(secretDialog).toBeVisible();
	await secretDialog.getByRole("button", { name: "Copy" }).click();
	await expect(
		page.getByText("Couldn’t copy the API key — select and copy it manually.", { exact: true }),
	).toBeVisible();
	await secretDialog
		.getByRole("checkbox", { name: "I have copied and stored this API key safely." })
		.click();
	await secretDialog.getByRole("button", { name: "Done" }).click();
	await expect(secretDialog).toHaveCount(0);
	await expect(desktopTable.getByText("Backup container", { exact: true })).toBeVisible();

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
});

test("API key list error is retryable and the active-only empty state can create a key", async ({
	page,
}) => {
	await stubApiKeys(page, { initialKeys: [], failFirstList: true });

	await openApiKeySettings(page);
	await expect(page.getByText("Couldn’t load API keys", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByText("No active API keys", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Create API key", exact: true }).last().click();
	await expect(page.getByRole("dialog", { name: "Create API key" })).toBeVisible();
});
