import { expect, test } from "@playwright/test";

test("deployed public pages load without server errors", async ({ page }) => {
	const responses = await Promise.all([
		page.request.get("/sign-in", { timeout: 10_000 }),
		page.request.get("/sign-up", { timeout: 10_000 }),
	]);
	for (const response of responses) {
		expect(response.ok(), `${response.url()} should load`).toBe(true);
	}

	await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
	await expect(page.locator("body")).not.toBeEmpty();
	await expect(page).toHaveTitle(/Clawdi/i);
});
