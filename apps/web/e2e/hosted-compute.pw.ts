import { expect, test } from "@playwright/test";
import {
	basicPlan,
	cancelPendingBasicDeployment,
	capturePricingScreenshot,
	collectBrowserErrors,
	expectNoQuarterlyCopy,
	gotoHostedAgentSettings,
	includedBasicDeployment,
	paidBasicDeployment,
	performanceDeployment,
	performancePlan,
	planChangeQuoteResponse,
	planChangeResponse,
	stoppedIncludedBasicDeployment,
	stubHostedApi,
	terminalFallbackDeployment,
	walletActiveDeployment,
	walletAnnualDeployment,
	walletState,
	walletSubscriptionQuote,
} from "./hosted-stub-api";

test("paid-funded Basic leaves the included slot available for direct compute_basic deploy", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const createRequests: string[] = [];
	await page.setViewportSize({ width: 1_440, height: 1_100 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await stubHostedApi(page, {
		createRequests,
		deployments: [paidBasicDeployment],
		plans: [{ ...basicPlan, offers: [] }, performancePlan],
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await expect(page.getByText("First slot free", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/First active agent free.*paid additional agents unavailable/),
	).toBeVisible();
	await expectNoQuarterlyCopy(page);
	await capturePricingScreenshot(page, "/tmp/basic-paid-funded-slot-available-final.png");

	await page.getByRole("button", { name: "Deploy agent" }).click();
	await expect.poll(() => createRequests.length).toBe(1);
	expect(JSON.parse(createRequests[0] ?? "{}")).toMatchObject({
		compute_plan_slug: "compute_basic",
	});
	expect(errors, `direct Basic deploy: ${errors.join(" | ")}`).toEqual([]);
});

test("free-funded Basic uses annual compute_basic checkout when the included slot is occupied", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	await page.setViewportSize({ width: 1_440, height: 1_100 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await expect(page.getByText("$9/mo additional", { exact: true })).toBeVisible();
	await expect(page.getByText("Monthly", { exact: true })).toBeVisible();
	const annualTerm = page.getByRole("button", { name: /Annual.*%/ });
	await expect(annualTerm).toBeVisible();
	await expectNoQuarterlyCopy(page);
	await annualTerm.click();
	await expect(page.getByText("Wallet balance", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /Wallet balance/ })).toBeVisible();
	await expect(
		page.getByText(
			/First active agent free.*then \$7.2\/mo, billed \$86.4\/yr per additional agent/,
		),
	).toBeVisible();
	await expect(
		page.getByText(/additional Basic agent at \$7.2\/mo, billed \$86.4\/yr/),
	).toBeVisible();
	await capturePricingScreenshot(page, "/tmp/basic-free-funded-slot-occupied-final.png");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
		plan_slug: "compute_basic",
		billing_term_months: 12,
		funding_source: "stripe",
		deploy_config: { compute_plan_slug: "compute_basic" },
	});
	expect(errors, `paid Basic checkout: ${errors.join(" | ")}`).toEqual([]);
});

test("wallet annual quotes the exact debit and activates the created deployment", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	const deployments: unknown[] = [includedBasicDeployment];
	const subscriptionQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments,
		plans: [basicPlan, performancePlan],
		subscriptionQuoteRequests,
		subscriptionQuoteResponses: [
			walletSubscriptionQuote({
				planSlug: "compute_basic",
				billingTermMonths: 12,
				termPriceCents: 8_640,
				exactDebitCredits: "86400",
				balanceBeforeCredits: "100000",
				balanceAfterCredits: "13600",
			}),
		],
		walletState: { ...walletState, balance_credits: 100_000 },
		onWalletCheckoutSuccess: () => deployments.push(walletAnnualDeployment),
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await page.getByRole("button", { name: /Annual.*%/ }).click();
	await page.getByRole("button", { name: /Wallet balance/ }).click();
	await expect.poll(() => subscriptionQuoteRequests.length).toBe(1);
	const equation = page.getByTestId("wallet-debit-equation");
	await expect(equation).toContainText("Balance before");
	await expect(equation).toContainText("100,000 credits");
	await expect(equation).toContainText("Exact debit");
	await expect(equation).toContainText("86,400 credits");
	await expect(equation).toContainText("$86.40");
	await expect(equation).toContainText("Balance after");
	await expect(equation).toContainText("13,600 credits");

	await page.getByRole("button", { name: "Pay $86.40 from Wallet & deploy" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	const quote = JSON.parse(subscriptionQuoteRequests[0] ?? "{}");
	const activation = JSON.parse(checkoutRequests[0] ?? "{}");
	expect(quote).toEqual({
		plan_slug: "compute_basic",
		billing_term_months: 12,
		funding_source: "wallet",
	});
	expect(activation).toMatchObject({
		plan_slug: "compute_basic",
		billing_term_months: 12,
		funding_source: "wallet",
		deploy_config: { compute_plan_slug: "compute_basic" },
		quote: {
			funding_source: "wallet",
			term_price_cents: 8_640,
			debit_credits: "86400",
			balance_after_credits: "13600",
		},
	});
	await expect(page).toHaveURL(/\/agents\/hdep_wallet_created(?:\?|\/)/);
	expect(errors, `wallet annual deploy: ${errors.join(" | ")}`).toEqual([]);
});

test("included Basic uses unified card quote and change without creating a second subscription", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	const subscriptionQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_free_card",
				subscriptionId: 7,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 12,
				status: "complete",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_free_card",
				subscriptionId: 7,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				currentBillingTermMonths: 1,
				targetBillingTermMonths: 12,
				changeKind: "immediate_upgrade",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 18_000,
				amountCredits: null,
			}),
		],
		plans: [basicPlan, performancePlan],
		subscriptionQuoteRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic");

	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);

	await page.getByRole("button", { name: "Upgrade to Performance" }).click();
	const changeDialog = page.getByRole("dialog");
	await expect(
		changeDialog.getByText("Change compute subscription", { exact: true }),
	).toBeVisible();
	await changeDialog.getByRole("button", { name: /Annual/ }).click();
	await changeDialog.getByRole("button", { name: "Review change" }).click();

	await expect.poll(() => planQuoteRequests.length).toBe(1);
	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 7,
		target_plan_slug: "compute_performance",
		target_billing_term_months: 12,
		funding_source: "stripe",
	});
	await expect(changeDialog.getByText("Confirm immediate upgrade", { exact: true })).toBeVisible();
	await expect(changeDialog.getByText("$180.00", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_free_card",
	});
	expect(checkoutRequests).toEqual([]);
	expect(subscriptionQuoteRequests).toEqual([]);
	await expect(page.getByText("Plan change started", { exact: true })).toBeVisible();
	expect(errors, `included Basic card upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("included Basic uses unified wallet quote and change with exact debit", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	const subscriptionQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_free_wallet",
				subscriptionId: 7,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 1,
				status: "awaiting_projection",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_free_wallet",
				subscriptionId: 7,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				currentBillingTermMonths: 1,
				targetBillingTermMonths: 1,
				changeKind: "immediate_upgrade",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 1_900,
				amountCredits: "19000",
			}),
		],
		plans: [basicPlan, performancePlan],
		subscriptionQuoteRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic");

	await page.getByRole("button", { name: "Upgrade to Performance" }).click();
	const changeDialog = page.getByRole("dialog");
	await changeDialog.getByRole("button", { name: "Wallet", exact: true }).click();
	const review = changeDialog.getByRole("button", { name: "Review change" });
	await expect(review).toBeEnabled();
	await review.click();

	await expect.poll(() => planQuoteRequests.length).toBe(1);
	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 7,
		target_plan_slug: "compute_performance",
		target_billing_term_months: 1,
		funding_source: "wallet",
	});
	const equation = changeDialog.getByTestId("wallet-debit-equation");
	await expect(equation).toContainText("25,000 credits");
	await expect(equation).toContainText("19,000 credits");
	await expect(equation).toContainText("6,000 credits");
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_free_wallet",
	});
	expect(checkoutRequests).toEqual([]);
	expect(subscriptionQuoteRequests).toEqual([]);
	await expect(page.getByText("Plan change started", { exact: true })).toBeVisible();
	expect(errors, `included Basic wallet upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("paid card subscription confirms an immediate quoted upgrade", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [paidBasicDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_paid_card",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 12,
				status: "complete",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_paid_card",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				currentBillingTermMonths: 12,
				targetBillingTermMonths: 12,
				changeKind: "immediate_upgrade",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 9_360,
				amountCredits: null,
			}),
		],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_paid", "Basic");

	await page.getByRole("button", { name: "Change plan or billing term" }).click();
	const changeDialog = page.getByRole("dialog");
	await expect(changeDialog.getByText("Funding source: Card", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Review change" }).click();
	await expect.poll(() => planQuoteRequests.length).toBe(1);
	await expect(changeDialog.getByText("$93.60", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 42,
		target_plan_slug: "compute_performance",
		target_billing_term_months: 12,
		funding_source: "stripe",
	});
	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_paid_card",
	});
	expect(errors, `paid card upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("paid wallet subscription confirms an immediate quoted upgrade", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	const subscriptionQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [walletActiveDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_paid_wallet",
				subscriptionId: 42,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 1,
				status: "awaiting_projection",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_paid_wallet",
				subscriptionId: 42,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				currentBillingTermMonths: 1,
				targetBillingTermMonths: 1,
				changeKind: "immediate_upgrade",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 1_000,
				amountCredits: "10000",
			}),
		],
		plans: [basicPlan, performancePlan],
		subscriptionQuoteRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_wallet_due", "Basic");

	await page.getByRole("button", { name: "Change plan or billing term" }).click();
	const changeDialog = page.getByRole("dialog");
	await expect(changeDialog.getByText("Funding source: Wallet", { exact: true })).toBeVisible();
	const review = changeDialog.getByRole("button", { name: "Review change" });
	await expect(review).toBeEnabled();
	await review.click();
	await expect.poll(() => planQuoteRequests.length).toBe(1);
	const equation = changeDialog.getByTestId("wallet-debit-equation");
	await expect(equation).toContainText("25,000 credits");
	await expect(equation).toContainText("10,000 credits");
	await expect(equation).toContainText("15,000 credits");
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 42,
		target_plan_slug: "compute_performance",
		target_billing_term_months: 1,
		funding_source: "wallet",
	});
	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_paid_wallet",
	});
	expect(subscriptionQuoteRequests).toEqual([]);
	expect(errors, `paid wallet upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("paid Performance schedules its quoted downgrade for the effective date", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [performanceDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_downgrade",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_performance",
				targetPlanSlug: "compute_basic",
				targetBillingTermMonths: 12,
				status: "scheduled",
				effectiveAt: "2027-07-15T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_downgrade",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_performance",
				targetPlanSlug: "compute_basic",
				currentBillingTermMonths: 12,
				targetBillingTermMonths: 12,
				changeKind: "scheduled_downgrade",
				effectiveAt: "2027-07-15T00:00:00Z",
				amountCents: 0,
				amountCredits: null,
			}),
		],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_performance", "Performance");

	await page.getByRole("button", { name: "Change plan or billing term" }).click();
	const changeDialog = page.getByRole("dialog");
	await changeDialog.getByRole("button", { name: "Review change" }).click();
	await expect.poll(() => planQuoteRequests.length).toBe(1);
	await expect(changeDialog.getByRole("heading", { name: "Schedule downgrade" })).toBeVisible();
	await expect(changeDialog.getByText("No charge today", { exact: true })).toBeVisible();
	await expect(changeDialog).toContainText(/Jul 1[45], 2027/);
	await changeDialog.getByRole("button", { name: "Schedule downgrade" }).click();

	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		subscription_id: 42,
		target_plan_slug: "compute_basic",
		target_billing_term_months: 12,
		funding_source: "stripe",
	});
	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_downgrade",
	});
	await expect(page.getByText("Downgrade scheduled", { exact: true })).toBeVisible();
	expect(errors, `scheduled downgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("pending cancellation blocks plan changes and resumes through the primary CTA", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	const resumeRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [cancelPendingBasicDeployment],
		planChangeRequests,
		planQuoteRequests,
		plans: [basicPlan, performancePlan],
		resumeRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_cancel_pending", "Basic");

	await expect(page.getByRole("button", { name: "Change plan or billing term" })).toHaveCount(0);
	await expect(page.getByText(/Resume this subscription before changing/)).toBeVisible();
	await page.getByRole("button", { name: "Resume subscription" }).click();

	await expect.poll(() => resumeRequests.length).toBe(1);
	expect(JSON.parse(resumeRequests[0] ?? "{}")).toEqual({
		deployment_id: "hdep_cancel_pending",
	});
	expect(planQuoteRequests).toEqual([]);
	expect(planChangeRequests).toEqual([]);
	await expect(page.getByText("Subscription resumed", { exact: true })).toBeVisible();
	expect(errors, `pending cancellation resume: ${errors.join(" | ")}`).toEqual([]);
});

test("terminal fallback starts a new subscription against the fallback deployment", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [terminalFallbackDeployment],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_terminal_fallback", "Basic");

	await expect(page.getByText("Compute subscription ended", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("alert").getByRole("button", { name: "Start a new subscription" }),
	).toBeVisible();
	const startNewButton = page
		.locator("#compute-plan-controls")
		.getByRole("button", { name: "Start a new subscription" });
	await expect(startNewButton).toBeVisible();
	await startNewButton.click();
	const createDialog = page.getByRole("dialog");
	await expect(createDialog.getByText("Start a new subscription", { exact: true })).toBeVisible();
	await expect(createDialog.locator("#subscription-create-plan")).toContainText("Performance");
	await createDialog.getByRole("button", { name: "Continue to card checkout" }).click();

	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
		plan_slug: "compute_performance",
		billing_term_months: 1,
		funding_source: "stripe",
		upgrade_deployment_id: "hdep_terminal_fallback",
	});
	expect(errors, `terminal fallback reactivation: ${errors.join(" | ")}`).toEqual([]);
});

test("included Basic checkout abandonment preserves the current plan", async ({ page }) => {
	const checkoutRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_included", "Basic", "?checkout=cancel");
	const errors = collectBrowserErrors(page);

	await expect(page.getByText("Checkout canceled", { exact: true })).toBeVisible();
	await expect(
		page.getByText("You were not charged. Your compute plan is unchanged.", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
	expect(checkoutRequests).toEqual([]);
	expect(errors, `included Basic checkout abandonment: ${errors.join(" | ")}`).toEqual([]);
});

test("paid Basic cancellation stays conditional with the included slot vacant or occupied", async ({
	page,
}) => {
	const cancelRequests: string[] = [];
	const deployments: unknown[] = [paidBasicDeployment];
	await stubHostedApi(page, {
		cancelRequests,
		deployments,
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_paid", "Basic");
	const errors = collectBrowserErrors(page);

	for (const [index, label] of ["vacant", "occupied"].entries()) {
		if (label === "occupied") deployments.push(includedBasicDeployment);
		if (index > 0) await gotoHostedAgentSettings(page, "hdep_paid", "Basic");

		await expect(page.getByRole("button", { name: "Change plan or billing term" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toHaveCount(0);

		await page.getByRole("button", { name: "Cancel subscription" }).click();
		const cancelDialog = page.getByRole("alertdialog");
		await expect(
			cancelDialog.getByText("Cancel Basic subscription?", { exact: true }),
		).toBeVisible();
		await expect(
			cancelDialog.getByText(
				/falls back to included Basic funding if available; otherwise, it stops/,
			),
		).toBeVisible();
		await cancelDialog.getByRole("button", { name: "Cancel at period end" }).click();

		await expect.poll(() => cancelRequests.length, { message: label }).toBe(index + 1);
		expect(JSON.parse(cancelRequests[index] ?? "{}")).toMatchObject({
			deployment_id: "hdep_paid",
		});
		await expect(
			page.getByText("Subscription cancellation scheduled", { exact: true }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "Resume subscription" })).toBeVisible();
	}
	expect(errors, `paid Basic cancellation: ${errors.join(" | ")}`).toEqual([]);
});

test("paid Performance exposes subscription actions without a direct Basic switch", async ({
	page,
}) => {
	await stubHostedApi(page, {
		deployments: [performanceDeployment],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, "hdep_performance", "Performance");
	const errors = collectBrowserErrors(page);

	await expect(page.getByRole("button", { name: "Change plan or billing term" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Upgrade to Performance" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /switch|downgrade/i })).toHaveCount(0);
	expect(errors, `paid Performance actions: ${errors.join(" | ")}`).toEqual([]);
});

test("occupied included Basic start surfaces the backend slot entitlement error", async ({
	page,
}) => {
	const startRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [stoppedIncludedBasicDeployment, includedBasicDeployment],
		plans: [basicPlan, performancePlan],
		startError: {
			status: 403,
			detail: "The Compute Basic free slot allows only one active deployment.",
		},
		startRequests,
	});
	await gotoHostedAgentSettings(page, "hdep_stopped", "Basic");
	const errors = collectBrowserErrors(page);

	await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Start", exact: true }).click();

	await expect.poll(() => startRequests.length).toBe(1);
	await expect(page.getByText("Couldn't update lifecycle", { exact: true })).toBeVisible();
	await expect(
		page.getByText("The Compute Basic free slot allows only one active deployment.", {
			exact: true,
		}),
	).toBeVisible();
	expect(errors.length, `included Basic start entitlement: ${errors.join(" | ")}`).toBeGreaterThan(
		0,
	);
	expect(
		errors.every((error) => /status of 403 \(Forbidden\)/.test(error)),
		`included Basic start entitlement: ${errors.join(" | ")}`,
	).toBe(true);
});

test("paid Basic checkout abandonment preserves the checkout-ready wizard", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	const createRequests: string[] = [];
	await stubHostedApi(page, {
		checkoutRequests,
		createRequests,
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/deploy?checkout=cancel");

	await expect(page.getByText("Checkout canceled", { exact: true })).toBeVisible();
	await expect(page.getByText("You were not charged. Your agent was not deployed.")).toBeVisible();
	await expect(page.getByText("$9/mo additional", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Continue to checkout" })).toBeVisible();
	await expect(page.getByText("First slot free", { exact: true })).toHaveCount(0);
	expect(checkoutRequests).toEqual([]);
	expect(createRequests).toEqual([]);
	expect(errors, `checkout abandonment: ${errors.join(" | ")}`).toEqual([]);
});
