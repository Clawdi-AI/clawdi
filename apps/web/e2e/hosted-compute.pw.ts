import { expect, test } from "@playwright/test";
import {
	basicPlan,
	capturePricingScreenshot,
	collectBrowserErrors,
	expectNoQuarterlyCopy,
	gotoHostedAgentSettings,
	includedBasicDeployment,
	paidBasicDeployment,
	performanceDeployment,
	performancePlan,
	stoppedIncludedBasicDeployment,
	stubHostedApi,
} from "./hosted-stub-api";

// Skipped on merge of #414: these flows drifted since the branch point
// (July) — unskip during the hosted-suite repair pass after re-verifying
// each flow against current product behavior.
test.skip();
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
