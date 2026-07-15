import { expect, test } from "@playwright/test";
import { CLOUD_CHANNEL_ID, collectBrowserErrors, stubCloudApi } from "./hosted-fixtures";

test.beforeEach(async ({ page }) => {
	await stubCloudApi(page);
});

test("channels list/detail flow can unlink an agent", async ({ page }) => {
	const errors = collectBrowserErrors(page);

	await page.goto("/channels");
	await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
	await expect(page.getByText("E2E Telegram", { exact: true }).first()).toBeVisible();

	await page.goto(`/channels/${CLOUD_CHANNEL_ID}`);
	await expect(page.getByRole("heading", { name: "E2E Telegram" })).toBeVisible();
	await expect(page.getByText("Linked agents")).toBeVisible();
	await expect(page.getByTitle("E2E Codex", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Unlink agent" }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await page.getByRole("button", { name: "Unlink" }).click();
	await expect(page.getByText("No agents linked")).toBeVisible();
	expect(errors, `channels flow: ${errors.join(" | ")}`).toEqual([]);
});

test("AI providers BYOK flow saves and renders a custom provider", async ({ page }) => {
	const errors = collectBrowserErrors(page);

	await page.goto("/ai-providers");
	await expect(page.getByRole("heading", { name: "Model Providers" })).toBeVisible();
	await page.getByRole("button", { name: /Add provider/i }).click();
	await expect(page.getByRole("dialog", { name: "Add a provider" })).toBeVisible();

	await page.getByLabel(/API key/).fill("sk-e2e-test-key");
	await page.getByRole("button", { name: "Add provider" }).click();

	await expect(page.getByRole("dialog", { name: "Add a provider" })).toBeHidden();
	await expect(page.getByText("OpenAI", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("Vault key").first()).toBeVisible();
	expect(errors, `providers flow: ${errors.join(" | ")}`).toEqual([]);
});
