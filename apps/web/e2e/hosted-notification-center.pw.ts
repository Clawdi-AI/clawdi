import { expect, test } from "@playwright/test";
import { collectBrowserErrors, stubHostedApi } from "./hosted-stub-api";

test("account notifications support unread state and durable history", async ({ page }) => {
	const browserErrors = collectBrowserErrors(page);
	await stubHostedApi(page, {
		accountNotifications: [
			{
				id: "11111111-1111-4111-8111-111111111111",
				kind: "v2_wallet_low_balance",
				title: "Your wallet balance is down to $1.25",
				description: "Top up now or turn on auto-reload.",
				category: "Wallet",
				severity: "warning",
				action_label: "Open Wallet",
				action_url: "https://cloud.clawdi.ai/?settings=billing-wallet#billing",
				created_at: "2026-09-01T10:00:00Z",
				read_at: null,
			},
			{
				id: "22222222-2222-4222-8222-222222222222",
				kind: "v2_user_registered",
				title: "Welcome to Clawdi",
				description: "Your agents have a home now.",
				category: "Welcome",
				severity: "info",
				action_label: "Create your first agent",
				action_url: "https://cloud.clawdi.ai/deploy",
				created_at: "2026-08-31T10:00:00Z",
				read_at: "2026-08-31T10:05:00Z",
			},
		],
	});

	await page.goto("/");
	const trigger = page.getByRole("button", { name: "Notifications, 1 new item" });
	await expect(trigger).toBeVisible();
	await trigger.click();

	const accountUpdates = page.getByLabel("Account updates");
	await expect(accountUpdates.getByText("Your wallet balance is down to $1.25")).toBeVisible();
	await expect(accountUpdates.getByText("Welcome to Clawdi")).toBeVisible();
	await page.getByRole("tab", { name: /Unread/ }).click();
	await expect(accountUpdates.getByText("Your wallet balance is down to $1.25")).toBeVisible();
	await expect(accountUpdates.getByText("Welcome to Clawdi")).toHaveCount(0);

	await page
		.getByRole("button", { name: "More actions for Your wallet balance is down to $1.25" })
		.click();
	await page.getByRole("menuitem", { name: "Mark as read" }).click();
	await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible();
	await expect(page.getByText("You're all caught up")).toBeVisible();

	await page.getByRole("tab", { name: "All" }).click();
	await expect(accountUpdates.getByText("Your wallet balance is down to $1.25")).toBeVisible();
	await expect(accountUpdates.getByText("Welcome to Clawdi")).toBeVisible();
	await expect(browserErrors).toEqual([]);
});
