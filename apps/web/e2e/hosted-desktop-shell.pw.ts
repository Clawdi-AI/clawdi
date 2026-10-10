import { expect, test } from "@playwright/test";
import { collectBrowserErrors, stubHostedApi } from "./hosted-stub-api";
import { desktopBridgeCalls, injectDesktopBridge } from "./support/desktop-bridge";

test("Inside Clawdi Desktop, the New agent chooser opens the Connect window", async ({ page }) => {
	await injectDesktopBridge(page);
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page);
	await page.goto("/");
	await page.waitForLoadState("networkidle");

	await page.getByRole("button", { name: "New agent", exact: true }).click();
	const chooser = page.getByRole("dialog", { name: "New agent" });
	await chooser.getByRole("button", { name: /Connect your own agent/ }).click();
	await expect(chooser).toBeHidden();
	await expect(page.getByRole("dialog", { name: "Add an agent" })).toHaveCount(0);

	await page.locator("main").getByRole("button", { name: "Connect your own agent" }).click();
	await expect.poll(() => desktopBridgeCalls(page)).toEqual([["openConnector"], ["openConnector"]]);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(errors).toEqual([]);
});
