import { expect, type Page, test } from "@playwright/test";
import type {} from "./lifecycle.browser";

async function start(page: Page) {
	await page.route("http://127.0.0.1:8000/**", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: route.request().url().endsWith("private-data")
				? route.request().headers().authorization?.replace("Bearer ", "")
				: "{}",
		}),
	);
	await page.goto("/e2e/auth/");
	await page.evaluate(() => window.authTest.navigate("/private/a"));
	await expect(page.locator("[data-private]")).toHaveText("user-a:session-a");
}

test("same identity keeps cache, draft and iframe document across navigation and history", async ({
	page,
}) => {
	await start(page);
	const frame = page.frameLocator("iframe");
	await frame.getByRole("textbox").fill("retained-runtime-draft");
	await page.getByRole("link", { name: "B", exact: true }).click();
	await expect(page.getByRole("heading")).toHaveText("Destination B");
	await page.goBack();
	await expect(page.getByRole("heading")).toHaveText("Destination A");
	await page.goForward();
	await expect(page.getByRole("heading")).toHaveText("Destination B");
	await expect(frame.getByRole("textbox")).toHaveValue("retained-runtime-draft");
	await page.getByRole("textbox", { name: "Draft", exact: true }).fill("unsaved");
	await page.getByRole("link", { name: "A", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await page.getByRole("button", { name: "Keep editing" }).click();
	await expect(page.getByRole("textbox", { name: "Draft", exact: true })).toHaveValue("unsaved");
});

test("public routes stay available while loading and signed-out client navigation stays protected", async ({
	page,
}) => {
	await page.goto("/e2e/auth/");
	await page.evaluate(() => window.authTest.emitSdk({ isLoaded: false }));
	await page.evaluate(() => window.authTest.navigate("/private/a"));
	await expect(page.locator("main")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
	await page.evaluate(() => window.authTest.navigate("/public"));
	await expect(page.getByRole("heading")).toHaveText("Public content");
	await page.evaluate(() =>
		window.authTest.emitSdk({ isLoaded: true, userId: null, sessionId: null }),
	);
	await page.evaluate(() => window.authTest.navigate("/private/a"));
	await expect(page.getByRole("heading")).toHaveText("Sign in");
	await expect(page.locator("[data-private]")).toHaveCount(0);
});

for (const update of [{ userId: "user-b", sessionId: "session-b" }, { sessionId: "session-b" }]) {
	test(`identity switch isolates cached destinations and retires preloads: ${JSON.stringify(update)}`, async ({
		page,
	}) => {
		await start(page);
		await page.evaluate(() => window.authTest.navigate("/private/b"));
		await page.evaluate(() => window.authTest.navigate("/private/a"));
		await page.evaluate(() => window.authTest.holdPreload());
		await page.frameLocator("iframe").getByRole("textbox").fill("old-session");
		await page.evaluate((update) => window.authTest.emitSdk(update), update);
		await expect(page.locator("[data-private]")).toHaveText(
			`${update.userId ?? "user-a"}:session-b`,
		);
		await expect(page.frameLocator("iframe").getByRole("textbox")).toHaveValue("");
		expect(await page.evaluate(() => window.authTest.abortedPreload)).toBe(true);
		await page.evaluate(() => window.authTest.releasePreload());
		const commits = await page.evaluate(() => window.authTest.commits);
		expect(commits.filter((commit) => commit.data && commit.data !== commit.identity)).toEqual([]);
		await page.goBack();
		await expect(page.locator("[data-private]")).toHaveText(
			`${update.userId ?? "user-a"}:session-b`,
		);
	});
}

for (const update of [{ userId: null, sessionId: null }, { pending: true }]) {
	test(`logout/session-task emissions remove protected UI and cached history: ${JSON.stringify(update)}`, async ({
		page,
	}) => {
		await start(page);
		await page.evaluate(() => window.authTest.navigate("/private/b"));
		await page.evaluate((update) => window.authTest.emitSdk(update), update);
		await expect(page.locator("iframe")).toHaveCount(0);
		await expect(page.getByRole("heading")).toHaveText("Sign in");
		await page.goBack();
		await expect(page.locator("[data-private]")).toHaveCount(0);
		await page.evaluate(() => window.authTest.navigate("/public"));
		await expect(page.getByRole("heading")).toHaveText("Public content");
	});
}

for (const status of ["degraded", "error"] as const) {
	test(`SDK ${status} blocks stale snapshots without signing out and recovers by event`, async ({
		page,
	}) => {
		await start(page);
		await page.evaluate((status) => window.authTest.emitSdk({ status }), status);
		await expect(page.locator("iframe")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
		expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
		await page.evaluate(() => window.authTest.emitSdk({ status: "ready" }));
		await expect(page.locator("[data-private]")).toHaveText("user-a:session-a");
	});
}

test("native unknown auth removes an admitted session independently of script status", async ({
	page,
}) => {
	await start(page);
	await page.evaluate(() => window.authTest.emitSdk({ isLoaded: false }));
	await expect(page.locator("iframe")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await page.evaluate(() => window.authTest.emitSdk({ isLoaded: true }));
	await expect(page.locator("[data-private]")).toHaveText("user-a:session-a");
});

test("late old-identity queries cannot publish in the new identity", async ({ page }) => {
	await start(page);
	const late = Promise.withResolvers<void>();
	let seen = false;
	await page.route("**/private-data", async (route) => {
		if (route.request().headers().authorization?.includes("user-a")) {
			seen = true;
			await late.promise;
		}
		await route.fallback();
	});
	await page.evaluate(() => {
		void window.authTest.refetch();
	});
	await expect.poll(() => seen).toBe(true);
	await page.evaluate(() => window.authTest.emitSdk({ userId: "user-b", sessionId: "session-b" }));
	late.resolve();
	await expect(page.locator("[data-private]")).toHaveText("user-b:session-b");
	expect(
		await page.evaluate(() =>
			window.authTest.commits.filter((c) => c.data && c.data !== c.identity),
		),
	).toEqual([]);
});

test("401 account admission is denied; resource 403 and refresh/network failures do not hard-logout", async ({
	page,
}) => {
	await start(page);
	await page.route("**/private-data", (route) => route.fulfill({ status: 403, body: "Forbidden" }));
	await page.evaluate(() => window.authTest.refetch());
	await expect(page.getByRole("alert")).toBeVisible();
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await expect(page.locator("iframe")).toBeVisible();
	await page.route("**/v1/auth/me", (route) => route.fulfill({ status: 403, body: "Forbidden" }));
	await page.evaluate(() => window.authTest.refetch());
	await expect(page.getByText("Session unavailable.", { exact: true })).toBeVisible();
	await expect(page.locator("iframe")).toHaveCount(0);
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await page.unroute("**/v1/auth/me");
	await page.evaluate(() => window.authTest.emitSdk({ tokenFailure: true }));
	await page.evaluate(() => window.authTest.refetch());
	await expect(page.getByText("Session unavailable.", { exact: true })).toBeVisible();
	await expect(page.locator("iframe")).toHaveCount(0);
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await page.evaluate(() => window.authTest.emitSdk({ tokenFailure: false }));
	await page.route("**/v1/auth/me", (route) =>
		route.fulfill({
			status: 401,
			contentType: "application/json",
			body: '{"detail":"Invalid session"}',
		}),
	);
	await page.evaluate(() => window.authTest.refetch());
	await expect(page.locator("iframe")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await page.getByRole("button", { name: "Sign in again", exact: true }).click();
	await expect(page.getByRole("heading")).toHaveText("Sign in");
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(1);
});
