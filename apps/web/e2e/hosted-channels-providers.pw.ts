import { expect, test } from "@playwright/test";
import { collectBrowserErrors, stubCloudApi } from "./hosted-fixtures";

test.beforeEach(async ({ page }) => {
	await stubCloudApi(page);
});
// The save flow's stub endpoints predate the current validate-then-accept
// contract — re-enable after re-stubbing to the live API shape.
test.skip("AI providers BYOK flow saves and renders a custom provider", async ({ page }) => {
	const errors = collectBrowserErrors(page);

	await page.goto("/ai-providers");
	await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
	await page.getByRole("button", { name: "Add provider" }).first().click();
	await expect(page.getByRole("dialog", { name: "Add a provider" })).toBeVisible();

	// The chooser gates the fields: pick a provider first.
	await page.getByRole("button", { name: /^OpenAI/ }).click();
	await page.getByRole("textbox", { name: "API key" }).fill("sk-e2e-test-key");
	await page.getByRole("button", { name: "Add provider", exact: true }).click();

	await expect(page.getByRole("dialog", { name: /Set up OpenAI/ })).toBeHidden();
	await expect(page.getByText("OpenAI", { exact: true }).first()).toBeVisible();
	expect(errors, `providers flow: ${errors.join(" | ")}`).toEqual([]);
});

test("channels connect dialog opens without browser errors", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	await page.goto("/channels");

	const connect = page.getByRole("button", { name: "Add channel" }).first();
	await expect(connect).toBeVisible();
	expect(errors, `channels render: ${errors.join(" | ")}`).toEqual([]);

	await connect.click();
	await expect(page.getByRole("dialog", { name: "Add channel" })).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `connect dialog: ${errors.join(" | ")}`).toEqual([]);
});
