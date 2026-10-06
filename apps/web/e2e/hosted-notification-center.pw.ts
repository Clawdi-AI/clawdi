import { expect, test } from "@playwright/test";
import {
	collectBrowserErrors,
	fixtureAgentId,
	includedBasicDeployment,
	stubHostedApi,
} from "./hosted-stub-api";

const newestId = "11111111-1111-4111-8111-111111111111";
const welcomeId = "22222222-2222-4222-8222-222222222222";
const arrivedId = "33333333-3333-4333-8333-333333333333";
const walletTitle = "Your wallet balance is down to $1.25";

function accountNotifications(
	actionUrl = "https://cloud.clawdi.ai/?settings=billing-wallet#billing",
) {
	return [
		{
			id: newestId,
			kind: "v2_wallet_low_balance",
			title: walletTitle,
			description: "Top up now or turn on auto-reload.",
			category: "Wallet",
			severity: "warning" as const,
			action_label: "Open Wallet",
			action_url: actionUrl,
			created_at: "2026-09-01T10:00:00Z",
			read_at: null,
		},
		{
			id: welcomeId,
			kind: "v2_user_registered",
			title: "Welcome to Clawdi",
			description: "Your agents have a home now.",
			category: "Welcome",
			severity: "info" as const,
			action_label: "Create your first agent",
			action_url: "https://cloud.clawdi.ai/deploy",
			created_at: "2026-08-31T10:00:00Z",
			read_at: "2026-08-31T10:05:00Z",
		},
	];
}

function newerNotification() {
	return {
		id: arrivedId,
		kind: "v2_wallet_low_balance",
		title: "A newer wallet update",
		description: "This arrived after the first read watermark.",
		category: "Wallet",
		severity: "warning" as const,
		action_label: null,
		action_url: null,
		created_at: "2026-09-02T10:00:00Z",
		read_at: null,
	};
}

test("opening notifications marks loaded history and new arrivals independently", async ({
	page,
}) => {
	const browserErrors = collectBrowserErrors(page);
	const readAllRequests: { up_to_id?: string | null }[] = [];
	await page.clock.install();
	const stub = await stubHostedApi(page, {
		readAllRequests,
		accountNotifications: accountNotifications(),
	});

	await page.goto("/");
	const trigger = page.getByRole("button", { name: /^Notifications/ });
	await expect(page.getByRole("button", { name: "Notifications, 1 new item" })).toBeVisible();
	await trigger.click();

	const accountUpdates = page.getByLabel("Account updates");
	await expect(accountUpdates.getByText(walletTitle)).toBeVisible();
	await expect(accountUpdates.getByText("Welcome to Clawdi")).toBeVisible();
	await expect.poll(() => readAllRequests.length).toBe(1);
	expect(readAllRequests[0]).toEqual({ up_to_id: newestId });
	await expect(trigger).toHaveAttribute("aria-label", "Notifications");

	const walletRow = accountUpdates.getByText(walletTitle).locator("xpath=ancestor::li");
	await expect(walletRow).toHaveClass(/bg-muted\/35/);
	await expect(walletRow.getByText("(new)", { exact: true })).toBeAttached();

	stub.addAccountNotification(newerNotification());
	await page.clock.fastForward(60_001);
	await expect.poll(() => readAllRequests.length).toBe(2);
	expect(readAllRequests[1]).toEqual({ up_to_id: arrivedId });
	const newerRow = accountUpdates.getByText("A newer wallet update").locator("xpath=ancestor::li");
	await expect(newerRow).toHaveClass(/bg-muted\/35/);
	await expect(newerRow.getByText("(new)", { exact: true })).toBeAttached();

	await trigger.click();
	await trigger.click();
	await expect(accountUpdates.getByText("Welcome to Clawdi")).toBeVisible();
	await expect.poll(() => readAllRequests.length).toBe(2);

	await walletRow.getByRole("button", { name: `More actions for ${walletTitle}` }).click();
	await page.getByRole("menuitem", { name: "Remove" }).click();
	await expect(accountUpdates.getByText(walletTitle)).toHaveCount(0);
	await expect(browserErrors).toEqual([]);
});

test("same-origin action navigates in-app and closes the panel", async ({ page, baseURL }) => {
	if (!baseURL) throw new Error("Playwright baseURL is required for notification navigation.");
	const browserErrors = collectBrowserErrors(page);
	const path = `/agents/${fixtureAgentId(includedBasicDeployment)}?notification=ready#overview`;
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		accountNotifications: accountNotifications(new URL(path, baseURL).href),
	});

	await page.goto("/");
	const trigger = page.getByRole("button", { name: /^Notifications/ });
	await expect(page.getByRole("button", { name: "Notifications, 1 new item" })).toBeVisible();
	await trigger.click();
	const accountUpdates = page.getByLabel("Account updates");
	await expect(accountUpdates.getByText(walletTitle)).toBeVisible();
	await page.evaluate(() => Reflect.set(window, "notificationNavigationMarker", true));

	await accountUpdates.getByRole("button", { name: "Open Wallet" }).click();
	await expect(page).toHaveURL(path);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(accountUpdates).toBeHidden();
	expect(await page.evaluate(() => Reflect.get(window, "notificationNavigationMarker"))).toBe(true);
	await expect(browserErrors).toEqual([]);
});

test("legacy allowlisted action navigates to a new document", async ({ page }) => {
	const target = "https://clawdi.ai/dashboard?settings=billing-wallet#billing";
	await stubHostedApi(page, { accountNotifications: accountNotifications(target) });
	await page.route(/^https:\/\/clawdi\.ai\/dashboard/, (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html><title>Legacy dashboard</title><main>Legacy dashboard</main>",
		}),
	);

	await page.goto("/");
	await page.getByRole("button", { name: "Notifications, 1 new item" }).click();
	const accountUpdates = page.getByLabel("Account updates");
	await expect(accountUpdates.getByText(walletTitle)).toBeVisible();
	await page.evaluate(() => Reflect.set(window, "notificationNavigationMarker", true));
	const documentRequest = page.waitForRequest(
		(request) =>
			request.url() === target.split("#")[0] &&
			request.isNavigationRequest() &&
			request.resourceType() === "document",
	);

	await accountUpdates.getByRole("button", { name: "Open Wallet" }).click();
	await documentRequest;
	await expect(page).toHaveURL(target);
	await expect(page.getByRole("main")).toHaveText("Legacy dashboard");
	expect(
		await page.evaluate(() => Reflect.get(window, "notificationNavigationMarker")),
	).toBeUndefined();
});

test("invalid action closes the panel without marking later notifications", async ({ page }) => {
	const readAllRequests: { up_to_id?: string | null }[] = [];
	const stub = await stubHostedApi(page, {
		readAllRequests,
		accountNotifications: accountNotifications("https://evil.example.invalid/not-allowed"),
	});

	await page.goto("/");
	await page.getByRole("button", { name: "Notifications, 1 new item" }).click();
	const accountUpdates = page.getByLabel("Account updates");
	await expect(accountUpdates.getByText(walletTitle)).toBeVisible();
	await expect.poll(() => readAllRequests.length).toBe(1);

	await accountUpdates.getByRole("button", { name: "Open Wallet" }).click();
	await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible();
	await expect(page.getByText("This notification link is invalid")).toBeVisible();

	stub.addAccountNotification(newerNotification());
	await page.reload();
	await expect(page.getByRole("button", { name: "Notifications, 1 new item" })).toBeVisible();
	await expect.poll(() => readAllRequests.length).toBe(1);
});

test("read-all failure restores the unread badge without a toast", async ({ page }) => {
	const readAllRequests: { up_to_id?: string | null }[] = [];
	await stubHostedApi(page, {
		readAllRequests,
		accountNotifications: accountNotifications(),
		readAllResponses: [{ status: 500, body: { detail: "temporary failure" } }],
	});

	await page.goto("/");
	await page.getByRole("button", { name: "Notifications, 1 new item" }).click();
	await expect.poll(() => readAllRequests.length).toBe(1);
	await expect(page.getByRole("button", { name: "Notifications, 1 new item" })).toBeVisible();
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("delete failure restores the row and shows the existing toast", async ({ page }) => {
	await stubHostedApi(page, {
		accountNotifications: accountNotifications().map((item) =>
			item.id === newestId ? { ...item, read_at: null } : item,
		),
		deleteNotificationResponses: [{ status: 500, body: { detail: "temporary failure" } }],
	});

	await page.goto("/");
	await page.getByRole("button", { name: "Notifications, 1 new item" }).click();
	const accountUpdates = page.getByLabel("Account updates");
	await expect(accountUpdates.getByText(walletTitle)).toBeVisible();
	await accountUpdates.getByRole("button", { name: `More actions for ${walletTitle}` }).click();
	await page.getByRole("menuitem", { name: "Remove" }).click();
	await expect(accountUpdates.getByText(walletTitle)).toBeVisible();
	await expect(page.locator("[data-sonner-toast]")).toContainText("Couldn't remove notification");
});
