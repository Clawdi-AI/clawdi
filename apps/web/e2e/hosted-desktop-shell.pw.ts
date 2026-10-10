import { expect, test } from "@playwright/test";
import {
	basicPlan,
	collectBrowserErrors,
	fixtureAgentId,
	gotoHostedAgentSettings,
	gotoHostedSettingsDialog,
	includedBasicDeployment,
	performancePlan,
	stubHostedApi,
} from "./hosted-stub-api";
import { desktopBridgeCalls, injectDesktopBridge } from "./support/desktop-bridge";

test.beforeEach(async ({ page }) => {
	await injectDesktopBridge(page);
});

test("Inside Clawdi Desktop, the New agent chooser opens the Connect window", async ({ page }) => {
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

test("Inside Clawdi Desktop, payment methods and auto-reload open in the browser", async ({
	page,
}) => {
	await stubHostedApi(page);
	const dialog = await gotoHostedSettingsDialog(page, "billing-wallet");

	const editPaymentMethods = dialog.getByRole("button", { name: "Edit payment methods" });
	await expect(editPaymentMethods).toHaveAccessibleDescription("Opens in your browser.");
	const autoReload = dialog.getByTestId("auto-reload-section");
	await expect(autoReload.getByRole("switch", { name: "Auto-reload" })).toHaveCount(0);
	const turnOn = autoReload.getByRole("button", { name: "Turn on" });
	await expect(turnOn).toHaveAccessibleDescription("Opens in your browser.");

	await editPaymentMethods.click();
	await turnOn.click();
	await expect.poll(() => desktopBridgeCalls(page)).toHaveLength(2);
	for (const [action, url] of await desktopBridgeCalls(page)) {
		expect(action).toBe("openInBrowser");
		expect(new URL(url ?? "").searchParams.get("settings")).toBe("billing-wallet");
	}
	await expect(page.getByRole("dialog", { name: /Authorize a card/ })).toHaveCount(0);
});

test("Inside Clawdi Desktop, compute plan changes open in the browser", async ({ page }) => {
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	const agentId = fixtureAgentId(includedBasicDeployment);
	await gotoHostedAgentSettings(page, agentId, "Basic");

	const card = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic plan" });
	const upgrade = card.getByRole("button", { name: "Upgrade" });
	await expect(upgrade).toHaveAccessibleDescription("Opens in your browser.");
	await upgrade.click();

	await expect.poll(() => desktopBridgeCalls(page)).toHaveLength(1);
	const [[action, url]] = await desktopBridgeCalls(page);
	expect(action).toBe("openInBrowser");
	expect(new URL(url ?? "").pathname).toBe(`/agents/${agentId}/settings`);
	await expect(page.getByRole("dialog", { name: "Change compute subscription" })).toHaveCount(0);
});
