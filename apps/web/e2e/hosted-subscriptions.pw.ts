import type { DeployComponents } from "@clawdi/shared/api";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	basicPlan,
	cancelPendingBasicDeployment,
	cardPastDueDeployment,
	collectBrowserErrors,
	gotoHostedAgentSettings,
	gotoHostedSettingsDialog,
	paidBasicDeployment,
	performancePlan,
	stubHostedApi,
	terminalFallbackDeployment,
} from "./hosted-stub-api";

type Subscription = DeployComponents["schemas"]["V2ComputeSubscriptionListItem"];

const longAgentName =
	"Production research agent with an intentionally long name for compact subscription layouts";

function subscription(
	subscriptionId: string,
	status: Subscription["status"],
	overrides: Partial<Subscription> = {},
): Subscription {
	return {
		subscription_id: subscriptionId,
		plan_slug: "compute_performance",
		funding_source: "stripe",
		status,
		price_cents: 19_000,
		currency: "usd",
		billing_term_months: 12,
		current_period_end: "2099-08-12T12:00:00Z",
		cancel_at_period_end: false,
		deployment_id: `hdep_${subscriptionId}`,
		agent_name: subscriptionId,
		is_orphan: false,
		...overrides,
	};
}

async function expectCardsFit(container: Locator) {
	const metrics = await container
		.locator('[data-slot="compute-subscription-card"]')
		.evaluateAll((cards) =>
			cards.map((card) => {
				const box = card.getBoundingClientRect();
				const action = card.querySelector<HTMLElement>(
					'[data-slot="compute-subscription-actions"]',
				);
				const actionBox = action?.getBoundingClientRect();
				return {
					clientWidth: card.clientWidth,
					scrollWidth: card.scrollWidth,
					box: box.toJSON(),
					actionBox: actionBox?.toJSON() ?? null,
					detailCount: card.querySelectorAll("dl > div").length,
				};
			}),
		);

	expect(metrics).not.toHaveLength(0);
	for (const metric of metrics) {
		expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
		expect(metric.detailCount).toBe(4);
		if (metric.actionBox) {
			expect(metric.actionBox.x).toBeGreaterThanOrEqual(metric.box.x - 1);
			expect(metric.actionBox.x + metric.actionBox.width).toBeLessThanOrEqual(
				metric.box.x + metric.box.width + 1,
			);
			expect(metric.actionBox.y).toBeGreaterThanOrEqual(metric.box.y - 1);
		}
	}
}

async function openSubscriptions(page: Page) {
	return gotoHostedSettingsDialog(page, "billing-plan");
}

test("subscription cards preserve pagination and reveal loaded history", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page, {
		subscriptionPages: {
			initial: {
				items: [],
				has_more: true,
				next_cursor: "history-page",
			},
			"history-page": {
				items: [
					subscription("ended_first", "canceled", {
						current_period_end: "2025-08-12T12:00:00Z",
					}),
				],
				has_more: true,
				next_cursor: "current-page",
			},
			"current-page": {
				items: [
					subscription("active", "active", { agent_name: longAgentName }),
					subscription("canceling", "canceling", {
						cancel_at_period_end: true,
						current_period_end: "2025-08-12T12:00:00Z",
						agent_name: "Canceling agent",
					}),
					subscription("ended_second", "canceled", {
						current_period_end: "2024-08-12T12:00:00Z",
					}),
				],
				has_more: false,
				next_cursor: null,
			},
		},
	});

	const dialog = await openSubscriptions(page);
	await expect(dialog.getByText("No current subscriptions", { exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Load more" })).toBeVisible();
	await expect(dialog.getByRole("button", { name: /Show history/ })).toHaveCount(0);
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(0);

	await dialog.getByRole("button", { name: "Load more" }).click();
	await expect(dialog.getByText("No current subscriptions", { exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Load more" })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Show history (1)" })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(0);

	await dialog.getByRole("button", { name: "Load more" }).click();
	await expect(dialog.getByText(longAgentName, { exact: true })).toBeVisible();
	await expect(dialog.getByText("Canceling agent", { exact: true })).toBeVisible();
	await expect(dialog.getByText("Active", { exact: true })).toBeVisible();
	await expect(dialog.getByText("Canceling", { exact: true })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(2);
	await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Show history (2)" })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"] h4')).toHaveCount(2);
	await expectCardsFit(dialog);

	await dialog.getByRole("button", { name: "Show history (2)" }).click();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(4);
	await expect(dialog.locator('[data-slot="compute-subscription-card"] h4')).toHaveCount(4);
	await expect(dialog.getByText("Canceled", { exact: true })).toHaveCount(2);
	await expect(dialog.getByText("ended_first", { exact: true })).toBeVisible();
	await expect(dialog.getByText("ended_second", { exact: true })).toBeVisible();
	await expectCardsFit(dialog);

	await dialog.getByRole("button", { name: "Hide history" }).click();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(2);
	await expect(dialog.getByText("ended_first", { exact: true })).toHaveCount(0);

	await page.setViewportSize({ width: 320, height: 568 });
	await expect(dialog).toBeVisible();
	await expectCardsFit(dialog);
	const longAgentStyle = await dialog
		.getByText(longAgentName, { exact: true })
		.evaluate((agent) => {
			const style = getComputedStyle(agent);
			return {
				overflow: style.overflow,
				textOverflow: style.textOverflow,
				whiteSpace: style.whiteSpace,
				scrollWidth: agent.scrollWidth,
				clientWidth: agent.clientWidth,
			};
		});
	expect(longAgentStyle).toMatchObject({
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	});
	expect(longAgentStyle.scrollWidth).toBeGreaterThan(longAgentStyle.clientWidth);
	expect(errors, `subscription cards: ${errors.join(" | ")}`).toEqual([]);
});

test("agent settings uses the subscription card without changing plan actions", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page, {
		deployments: [
			paidBasicDeployment,
			cancelPendingBasicDeployment,
			{
				...paidBasicDeployment,
				id: "hdep_card_action_required",
				name: "Card authentication required",
				compute_subscription: {
					...paidBasicDeployment.compute_subscription,
					payment_state: "requires_action",
					latest_failed_invoice_id: "in_card_action_required",
					latest_failed_invoice_hosted_url: "https://billing.example/invoice/action-required",
				},
			},
			{
				...cardPastDueDeployment,
				compute_subscription: {
					...cardPastDueDeployment.compute_subscription,
					status: "active",
				},
			},
			terminalFallbackDeployment,
		],
		plans: [basicPlan, performancePlan],
	});

	await gotoHostedAgentSettings(page, "hdep_paid", "Basic");
	const activeCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(activeCard).toBeVisible();
	await expect(activeCard.getByText("Active", { exact: true })).toHaveAttribute(
		"data-status",
		"success",
	);
	await expect(activeCard.locator("dl > div")).toHaveCount(4);
	await expect(
		activeCard.getByRole("button", { name: "Change plan, term, or payment source" }),
	).toBeVisible();
	await expect(activeCard.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
	await expectCardsFit(page.locator("body"));

	await page.setViewportSize({ width: 320, height: 568 });
	await expectCardsFit(page.locator("body"));
	await expect(activeCard.getByRole("button", { name: "Cancel subscription" })).toBeVisible();

	await gotoHostedAgentSettings(page, "hdep_cancel_pending", "Basic");
	const cancelingCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(cancelingCard.getByText("Canceling", { exact: true })).toHaveAttribute(
		"data-status",
		"warning",
	);
	await expect(cancelingCard.locator("dl > div")).toHaveCount(4);
	await expect(cancelingCard.getByRole("button", { name: "Resume subscription" })).toBeVisible();
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(page, "hdep_card_due", "Basic");
	const pastDueCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(pastDueCard.getByText("Past due", { exact: true })).toHaveAttribute(
		"data-status",
		"destructive",
	);
	await expect(
		pastDueCard.getByRole("button", { name: "Change plan, term, or payment source" }),
	).toBeVisible();
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(page, "hdep_card_action_required", "Basic");
	const actionRequiredCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(
		actionRequiredCard.getByText("Payment action required", { exact: true }),
	).toHaveAttribute("data-status", "warning");
	await expect(
		actionRequiredCard.getByRole("button", { name: "Change plan, term, or payment source" }),
	).toBeVisible();
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(page, "hdep_terminal_fallback", "Basic");
	const fallbackCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(fallbackCard.getByText("Current", { exact: true })).toHaveAttribute(
		"data-status",
		"success",
	);
	await expect(fallbackCard.getByText("Funding", { exact: true })).toBeVisible();
	await expect(fallbackCard.getByText("Included", { exact: true })).toBeVisible();
	await expect(
		fallbackCard.getByRole("button", { name: "Start a new subscription" }),
	).toBeVisible();
	expect(errors, `agent subscription cards: ${errors.join(" | ")}`).toEqual([]);
});
