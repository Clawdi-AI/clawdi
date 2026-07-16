import { expect, test } from "@playwright/test";
import {
	basicPlan,
	cardPastDueDeployment,
	collectBrowserErrors,
	gotoHostedAgentSettings,
	gotoHostedSettingsDialog,
	paidBasicDeployment,
	performancePlan,
	stubHostedApi,
	walletActiveDeployment,
	walletPastDueDeployment,
	walletState,
} from "./hosted-stub-api";

test("Stripe invoice history shows both rails and a server-visible zero proration", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const billingHistoryRequests: string[] = [];
	await stubHostedApi(page, {
		billingHistoryRequests,
		billingHistoryResponses: [
			{
				data: [
					{
						id: "stripe:in_wallet",
						funding_source: "wallet",
						compute_subscription_id: 42,
						plan_slug: "compute_basic",
						status: "paid",
						amount_cents: 900,
						currency: "usd",
						period_start: "2026-07-15T00:00:00Z",
						period_end: "2026-08-15T00:00:00Z",
						created: "2026-07-15T00:00:00Z",
						stripe_invoice_id: "in_wallet",
						stripe_invoice_number: "CLAWDI-WALLET-1",
						hosted_invoice_url: "https://invoice.stripe.test/in_wallet",
					},
					{
						id: "stripe:in_1",
						funding_source: "stripe",
						compute_subscription_id: 9,
						plan_slug: "compute_performance",
						status: "paid",
						amount_cents: 1900,
						currency: "usd",
						created: "2026-07-14T00:00:00Z",
						stripe_invoice_id: "in_1",
						stripe_invoice_number: "CLAWDI-CARD-1",
						hosted_invoice_url: "https://invoice.stripe.test/in_1",
					},
					{
						id: "stripe:in_zero_proration",
						funding_source: "stripe",
						compute_subscription_id: 10,
						plan_slug: "compute_performance",
						status: "paid",
						amount_cents: 0,
						currency: "usd",
						created: "2026-07-13T00:00:00Z",
						stripe_invoice_id: "in_zero_proration",
						stripe_invoice_number: "CLAWDI-PRORATION-1",
						hosted_invoice_url: "https://invoice.stripe.test/in_zero_proration",
					},
				],
				has_more: true,
				next_cursor: "cursor_2",
			},
			{
				status: 400,
				body: { detail: "billing_history_backend_unavailable" },
			},
			{
				data: [
					{
						id: "stripe:in_refunded",
						funding_source: "stripe",
						compute_subscription_id: 9,
						plan_slug: "compute_performance",
						status: "refunded",
						amount_cents: 1_900,
						currency: "usd",
						created: "2026-06-15T00:00:00Z",
						stripe_invoice_id: "in_refunded",
						stripe_invoice_number: "CLAWDI-CARD-0",
						hosted_invoice_url: "https://invoice.stripe.test/in_refunded",
					},
				],
				has_more: false,
				next_cursor: null,
			},
		],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/channels?settings=billing-plan");
	const settingsDialog = page.getByTestId("settings-dialog");
	await expect(settingsDialog.getByText("Billing history", { exact: true })).toBeVisible();
	const billingTable = settingsDialog.getByRole("table");
	await expect(billingTable.getByText("Paid with AI Credits", { exact: true })).toBeVisible();
	await expect(billingTable.getByText("Paid by card", { exact: true })).toHaveCount(2);
	await expect(
		billingTable.locator('a[href="https://invoice.stripe.test/in_wallet"]'),
	).toBeVisible();
	await expect(billingTable.locator('a[href="https://invoice.stripe.test/in_1"]')).toBeVisible();
	await expect(
		billingTable.locator('a[href="https://invoice.stripe.test/in_zero_proration"]'),
	).toBeVisible();
	await expect(billingTable.getByText("$0.00", { exact: true })).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Load more" }).click();
	await expect.poll(() => billingHistoryRequests.length).toBe(2);
	await expect(settingsDialog.getByText(/load more billing history/i)).toBeVisible();
	await expect(billingTable.getByText("Paid with AI Credits", { exact: true })).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Retry" }).click();
	await expect.poll(() => billingHistoryRequests.length).toBe(3);
	expect(new URL(billingHistoryRequests[1] ?? "http://invalid").searchParams.get("cursor")).toBe(
		"cursor_2",
	);
	await expect(billingTable.getByText("Refunded", { exact: true })).toBeVisible();
	await settingsDialog.screenshot({ path: "/tmp/stripe-billing-history.png" });
	expect(
		errors.filter((error) => !error.includes("status of 400")),
		`Stripe billing history: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("Wallet activity caps show-more requests at the ledger API limit", async ({ page }) => {
	const ledgerRequests: string[] = [];
	let expandedAttempts = 0;
	const computeCharge = {
		id: "ledger-compute-charge",
		operation: "compute_charge",
		request_id: "compute-renewal-42",
		credits_amount: -9_000,
		status: "applied",
		created_at: "2026-07-15T00:00:00Z",
	};
	await stubHostedApi(page, {
		ledgerRequests,
		ledgerResponseForRequest: (limit) => {
			if (limit === 50) return { items: [computeCharge], has_more: true };
			expandedAttempts += 1;
			return expandedAttempts === 1
				? { status: 400, body: { detail: "ledger_backend_unavailable" } }
				: {
						items: [
							computeCharge,
							{
								...computeCharge,
								id: "ledger-compute-credit",
								operation: "compute_credit",
								request_id: "compute-reversal-42",
								credits_amount: 9_000,
							},
						],
						has_more: true,
					};
		},
		plans: [basicPlan, performancePlan],
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	const errors = collectBrowserErrors(page);
	const ledgerTable = settingsDialog.getByRole("table");

	await expect(ledgerTable.getByText("Compute charge", { exact: true })).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Show more" }).click();
	await expect.poll(() => ledgerRequests.length).toBe(2);
	await expect(settingsDialog.getByText(/load more activity/i)).toBeVisible();
	await expect(ledgerTable.getByText("Compute charge", { exact: true })).toBeVisible();
	await settingsDialog.getByRole("button", { name: "Retry" }).click();
	await expect.poll(() => ledgerRequests.length).toBe(3);
	await expect(ledgerTable.getByText("Compute reversal", { exact: true })).toBeVisible();
	await expect(settingsDialog.getByRole("button", { name: "Show more" })).toHaveCount(0);
	await expect(settingsDialog).toContainText(
		"Showing your most recent activity. Older entries are archived.",
	);

	const limits = ledgerRequests.map((url) => Number(new URL(url).searchParams.get("limit")));
	expect([...new Set(limits)]).toEqual([50, 100]);
	expect(limits.every((limit) => limit <= 100)).toBe(true);
	expect(
		errors.filter((error) => !error.includes("status of 400")),
		`wallet ledger cap: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("auto-reload batches toggle and fields into one explicit save", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const autoReloadRequests: string[] = [];
	const savedWallet = {
		...walletState,
		auto_reload_enabled: true,
		auto_reload_threshold_credits: 7_500,
		auto_reload_amount_cents: 3_000,
		auto_reload_monthly_cap_cents: 12_500,
	};
	await stubHostedApi(page, {
		autoReloadRequests,
		autoReloadResponses: [
			{
				status: 400,
				body: { detail: "Auto reload requires a default payment method" },
				delayMs: 250,
			},
			{ status: 200, body: savedWallet },
		],
		plans: [basicPlan, performancePlan],
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	const card = settingsDialog.locator('[data-slot="card"]').filter({ hasText: "Auto-reload" });
	const enabled = card.getByRole("switch", { name: "Enabled" });
	const threshold = card.getByLabel("When balance is below (USD)");
	const amount = card.getByLabel("Amount to add (USD)");
	const cap = card.getByLabel("Monthly cap (USD)");
	const save = card.getByRole("button", { name: "Save changes" });
	const cancel = card.getByRole("button", { name: "Cancel changes" });

	await expect(card.getByText("All changes saved", { exact: true })).toBeVisible();
	await expect(save).toBeDisabled();
	await expect(cancel).toBeDisabled();

	await enabled.click();
	await threshold.fill("7.50");
	await amount.fill("30");
	await cap.fill("125");
	await expect(card.getByText("Unsaved changes", { exact: true })).toBeVisible();
	expect(autoReloadRequests).toEqual([]);

	await cancel.click();
	await expect(enabled).not.toBeChecked();
	await expect(threshold).toHaveValue("5");
	await expect(amount).toHaveValue("25");
	await expect(cap).toHaveValue("100");
	await expect(save).toBeDisabled();
	expect(autoReloadRequests).toEqual([]);

	await enabled.click();
	await threshold.fill("7.50");
	await amount.fill("30");
	await cap.fill("125");
	await settingsDialog.getByRole("button", { name: /^Compute/ }).click();
	const discardDialog = page.getByRole("alertdialog");
	await expect(discardDialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
	await discardDialog.getByRole("button", { name: "Keep editing" }).click();
	await expect(card).toBeVisible();

	await card.screenshot({ path: "/tmp/auto-reload-dirty.png" });
	await save.evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
	});
	await expect(card.getByRole("button", { name: /Saving/ })).toBeDisabled();
	await expect.poll(() => autoReloadRequests.length).toBe(1);
	await expect(
		card.getByText("Add a card before enabling auto-reload", { exact: true }),
	).toBeVisible();
	await expect(card.getByRole("button", { name: "Add a card" })).toBeVisible();
	await expect(card.getByText("Unsaved changes", { exact: true })).toBeVisible();
	await card.screenshot({ path: "/tmp/auto-reload-error.png" });

	await save.click();
	await expect.poll(() => autoReloadRequests.length).toBe(2);
	await expect(card.getByText("All changes saved", { exact: true })).toBeVisible();
	await expect(enabled).toBeChecked();
	await expect(save).toBeDisabled();
	await card.screenshot({ path: "/tmp/auto-reload-saved.png" });

	for (const raw of autoReloadRequests) {
		expect(JSON.parse(raw)).toEqual({
			auto_reload_enabled: true,
			auto_reload_threshold_credits: 7_500,
			auto_reload_amount_cents: 3_000,
			auto_reload_monthly_cap_cents: 12_500,
		});
	}
	expect(
		errors.filter((error) => !error.includes("status of 400")),
		`auto-reload save: ${errors.join(" | ")}`,
	).toEqual([]);
});

test("top-up validates the amount and blocks duplicate submission or close in flight", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const topUpRequests: string[] = [];
	await stubHostedApi(page, {
		topUpRequests,
		topUpResponses: [
			{
				status: 200,
				delayMs: 250,
				body: {
					status: "succeeded",
					flow_type: "mock",
					payment_intent_id: null,
					client_secret: null,
					credits_added: 40_000,
				},
			},
		],
		plans: [basicPlan, performancePlan],
	});
	const settingsDialog = await gotoHostedSettingsDialog(page, "billing-wallet");
	await settingsDialog.getByRole("button", { name: "Top up" }).click();
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up AI Credits" });
	const amount = topUpDialog.getByLabel("Amount (USD)");

	await amount.fill("25.50");
	await amount.blur();
	await expect(
		topUpDialog.getByText("Enter a whole-dollar amount from $10.00 to $2,000.00.", {
			exact: true,
		}),
	).toBeVisible();
	await amount.fill("40");
	const submit = topUpDialog.getByRole("button", { name: "Continue with $40.00" });
	await submit.evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
	});
	await expect(topUpDialog.getByRole("button", { name: /Starting/ })).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(topUpDialog).toBeVisible();
	await expect.poll(() => topUpRequests.length).toBe(1);
	await expect(topUpDialog).toHaveCount(0);
	expect(JSON.parse(topUpRequests[0] ?? "{}")).toEqual({ amount_cents: 4_000 });
	expect(errors, `top-up interaction: ${errors.join(" | ")}`).toEqual([]);
});

test("top-up rotates its idempotency key after an explicit reuse conflict", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const topUpIdempotencyKeys: string[] = [];
	await stubHostedApi(page, {
		plans: [basicPlan, performancePlan],
		topUpIdempotencyKeys,
		topUpResponses: [
			{
				status: 409,
				body: {
					detail: {
						code: "idempotency_key_reused",
						message: "The top-up key belongs to another amount.",
					},
				},
			},
		],
	});
	await page.goto("/channels?settings=billing-wallet");
	const settingsDialog = page.getByTestId("settings-dialog");
	await settingsDialog.getByRole("button", { name: "Top up" }).click();
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up AI Credits" });
	const submit = topUpDialog.getByRole("button", { name: "Continue" });

	await submit.click();
	await expect.poll(() => topUpIdempotencyKeys.length).toBe(1);
	await expect(page.getByText("Start a fresh top-up", { exact: true })).toBeVisible();
	await expect(topUpDialog).toBeVisible();
	await submit.click();
	await expect.poll(() => topUpIdempotencyKeys.length).toBe(2);

	expect(topUpIdempotencyKeys[0]).toMatch(/^topup-/);
	expect(topUpIdempotencyKeys[1]).toMatch(/^topup-/);
	expect(topUpIdempotencyKeys[1]).not.toBe(topUpIdempotencyKeys[0]);
	await expect(topUpDialog).toHaveCount(0);
	expect(
		errors.filter((error) => !error.includes("status of 409")),
		`top-up key rotation: ${errors.join(" | ")}`,
	).toEqual([]);
});

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
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up AI Credits" });
	await expect(topUpDialog).toBeVisible();
	await topUpDialog.getByRole("button", { name: "Continue with $25.00" }).click();

	await expect.poll(() => topUpRequests.length).toBe(1);
	await expect(page.getByText("Top-up complete", { exact: true })).toBeVisible();
	await expect(pastDueAlert).toHaveCount(0);
	await expect(page.getByText("Wallet", { exact: true })).toBeVisible();
	expect(JSON.parse(topUpRequests[0] ?? "{}")).toEqual({ amount_cents: 2_500 });
	expect(errors, `wallet open-invoice top-up: ${errors.join(" | ")}`).toEqual([]);
});

test("card past due uses Fix payment instead of wallet recovery", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const fixPaymentRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [cardPastDueDeployment],
		fixPaymentRequests,
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_card_due", "Basic");

	const pastDueAlert = page.getByRole("alert").filter({ hasText: "Payment past due" });
	await expect(pastDueAlert).toBeVisible();
	await expect(pastDueAlert).toContainText("Update the card payment method");
	await expect(pastDueAlert.getByRole("button", { name: "Fix payment" })).toBeVisible();
	await expect(pastDueAlert.getByRole("button", { name: "Top up" })).toHaveCount(0);

	await pastDueAlert.getByRole("button", { name: "Fix payment" }).click();
	await expect.poll(() => fixPaymentRequests.length).toBe(1);
	expect(JSON.parse(fixPaymentRequests[0] ?? "{}")).toEqual({
		deployment_id: "hdep_card_due",
	});
	expect(errors, `card payment recovery: ${errors.join(" | ")}`).toEqual([]);
});

test("compute plans keep signup credits without advertising subscription credit grants", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page, {
		deployments: [paidBasicDeployment],
		plans: [
			{ ...basicPlan, subscription_grant_credits: 500 },
			{ ...performancePlan, subscription_grant_credits: 1_000 },
		],
	});
	await page.goto("/channels?settings=billing-plan");

	const settingsDialog = page.getByTestId("settings-dialog");
	await expect(settingsDialog).toBeVisible();
	await expect(
		settingsDialog.getByText("$5.00 in AI Credits on signup", { exact: true }),
	).toBeVisible();
	await expect(settingsDialog).not.toContainText("AI Credits per subscription");
	await expect(settingsDialog).not.toContainText("AI Credits added to Wallet");
	await expect(settingsDialog).not.toContainText("credits do not expire");
	expect(errors, `compute plan comparison: ${errors.join(" | ")}`).toEqual([]);
});
