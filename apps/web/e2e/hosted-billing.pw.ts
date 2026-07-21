import { expect, test } from "@playwright/test";
import { collectBrowserErrors, stubCloudApi } from "./hosted-fixtures";

test.beforeEach(async ({ page }) => {
	await stubCloudApi(page);
});

test("billing entry points render when cloud features are enabled", async ({ page }) => {
	const errors = collectBrowserErrors(page);

	await page.goto("/?settings=billing-wallet");
	const settings = page.getByTestId("settings-dialog");
	if ((await settings.count()) === 0) {
		await expect(page.getByTestId("app-sidebar")).toBeVisible();
		await page.getByRole("button", { name: "Settings" }).click();
		await settings.getByRole("button", { name: /Wallet/ }).click();
	}
	await expect(settings).toBeVisible();
	await expect(settings.getByRole("button", { name: /Wallet/ })).toBeVisible();
	await expect(settings.getByRole("button", { name: /Compute/ })).toBeVisible();
	await expect(settings.getByRole("button", { name: /Usage/ })).toBeVisible();
	await expect(settings.getByRole("heading", { name: "Wallet" })).toBeVisible();
	await expect(settings.getByText("$42.00").first()).toBeVisible();
	await expect(settings.getByRole("button", { name: /Top up/ }).first()).toBeVisible();
	await expect(settings.getByRole("table").getByText("Mock top-up")).toBeVisible();

	await page.goto("/?settings=billing-plan");
	if ((await settings.count()) === 0) {
		await expect(page.getByTestId("app-sidebar")).toBeVisible();
		await page.getByRole("button", { name: "Settings" }).click();
	}
	await settings.getByRole("button", { name: /Compute/ }).click();
	await expect(settings.getByRole("heading", { name: "Compute", exact: true })).toBeVisible();
	await expect(settings.getByText("Compute is managed per agent")).toBeVisible();
	await expect(settings.getByRole("region", { name: "Billing history" })).toBeVisible();
	await expect(settings.getByRole("table").getByText("Paid", { exact: true })).toBeVisible();
	await expect(settings.getByText("Performance").first()).toBeVisible();
	expect(errors, `billing entry points: ${errors.join(" | ")}`).toEqual([]);
});
