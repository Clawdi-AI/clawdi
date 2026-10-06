import { expect, test } from "@playwright/test";
import { collectBrowserErrors, stubHostedApi } from "./hosted-stub-api";

test("opening account notifications marks the loaded history read", async ({ page }) => {
	const browserErrors = collectBrowserErrors(page);
	const newestId = "11111111-1111-4111-8111-111111111111";
	const walletTitle = "Your wallet balance is down to $1.25";
	const readAllRequests: { up_to_id?: string | null }[] = [];
	const stub = await stubHostedApi(page, {
		readAllRequests,
		accountNotifications: [
			{
				id: newestId,
				kind: "v2_wallet_low_balance",
				title: walletTitle,
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
	const trigger = page.getByRole("button", { name: /^Notifications/ });
	const unreadTrigger = page.getByRole("button", { name: "Notifications, 1 new item" });
	await expect(unreadTrigger).toBeVisible();
	await unreadTrigger.click();

	const accountUpdates = page.getByLabel("Account updates");
	await expect(accountUpdates.getByText(walletTitle)).toBeVisible();
	await expect(accountUpdates.getByText("Welcome to Clawdi")).toBeVisible();
	await expect.poll(() => readAllRequests.length).toBe(1);
	expect(readAllRequests[0]).toEqual({ up_to_id: newestId });
	await expect(trigger).toHaveAttribute("aria-label", "Notifications");

	const walletRow = accountUpdates.getByText(walletTitle).locator("xpath=ancestor::li");
	await expect(walletRow).toHaveClass(/bg-muted\/35/);
	await expect(walletRow.getByText("(unread)", { exact: true })).toBeAttached();

	await trigger.click();
	await trigger.click();
	await expect(accountUpdates.getByText("Welcome to Clawdi")).toBeVisible();
	await expect(walletRow).not.toHaveClass(/bg-muted\/35/);
	await expect(walletRow.getByText("(unread)", { exact: true })).toHaveCount(0);

	const arrivedAfterFetch = {
		id: "33333333-3333-4333-8333-333333333333",
		kind: "v2_wallet_low_balance",
		title: "A newer wallet update",
		description: "This arrived after the read watermark.",
		category: "Wallet",
		severity: "warning" as const,
		action_label: null,
		action_url: null,
		created_at: "2026-09-02T10:00:00Z",
		read_at: null,
	};
	stub.addAccountNotification(arrivedAfterFetch);
	expect(
		stub.getAccountNotifications().find((item) => item.id === arrivedAfterFetch.id)?.read_at,
	).toBeNull();

	await accountUpdates.getByRole("button", { name: `More actions for ${walletTitle}` }).click();
	await page.getByRole("menuitem", { name: "Remove" }).click();
	await expect(accountUpdates.getByText(walletTitle)).toHaveCount(0);
	await expect(browserErrors).toEqual([]);
});
