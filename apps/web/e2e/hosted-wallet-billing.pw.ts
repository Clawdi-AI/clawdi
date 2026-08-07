import { expect, test } from "@playwright/test";
import {
	basicPlan,
	collectBrowserErrors,
	gotoHostedAgentSettings,
	performancePlan,
	stubHostedApi,
	walletActiveDeployment,
	walletPastDueDeployment,
} from "./hosted-stub-api";

test("wallet top-up completion refreshes an automatically paid open invoice", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [walletPastDueDeployment];
	const topUpRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		topUpRequests,
		onTopUpSuccess: () => deployments.splice(0, 1, walletActiveDeployment),
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_due", "Basic");

	const pastDueAlert = page.getByRole("alert").filter({ hasText: "Wallet payment past due" });
	await expect(pastDueAlert).toBeVisible();
	await expect(pastDueAlert).toContainText(
		"Stripe will keep the invoice open while funds are short",
	);
	await expect(pastDueAlert.getByRole("button", { name: "Top up" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Fix payment" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Retry payment/ })).toHaveCount(0);

	await pastDueAlert.getByRole("button", { name: "Top up" }).click();
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up Wallet" });
	await expect(topUpDialog).toBeVisible();
	await topUpDialog.getByRole("button", { name: "Continue with $25.00" }).click();

	await expect.poll(() => topUpRequests.length).toBe(1);
	await expect(page.getByText("Payment accepted", { exact: true })).toBeVisible();
	await expect(pastDueAlert).toHaveCount(0);
	await expect(page.getByText("Wallet", { exact: true })).toBeVisible();
	expect(JSON.parse(topUpRequests[0] ?? "{}")).toEqual({ amount_cents: 2_500 });
	expect(errors, `wallet open-invoice top-up: ${errors.join(" | ")}`).toEqual([]);
});
