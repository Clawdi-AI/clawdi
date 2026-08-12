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
type ReusableSubscription = DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"];

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

async function sourceDialogGeometry(dialog: Locator) {
	const metrics = await dialog.evaluate((element) => {
		const box = element.getBoundingClientRect();
		return {
			clientHeight: element.clientHeight,
			clientWidth: element.clientWidth,
			documentClientWidth: document.documentElement.clientWidth,
			documentScrollWidth: document.documentElement.scrollWidth,
			height: box.height,
			innerHeight: window.innerHeight,
			scrollHeight: element.scrollHeight,
			scrollWidth: element.scrollWidth,
			width: box.width,
		};
	});
	return metrics;
}

async function expectSourceDialogGeometry(
	dialog: Locator,
	viewport: { width: number; height: number },
	requireScroll: boolean,
) {
	await expect
		.poll(async () => {
			const metrics = await sourceDialogGeometry(dialog);
			return {
				documentClientWidth: metrics.documentClientWidth,
				innerHeight: metrics.innerHeight,
			};
		})
		.toEqual({ documentClientWidth: viewport.width, innerHeight: viewport.height });
	const metrics = await sourceDialogGeometry(dialog);
	expect(metrics.documentClientWidth).toBe(viewport.width);
	expect(metrics.documentScrollWidth).toBeLessThanOrEqual(viewport.width);
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
	expect(metrics.width).toBeLessThanOrEqual(viewport.width + 1);
	if (requireScroll) {
		expect(metrics.height).toBeLessThanOrEqual(viewport.height + 1);
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
		await dialog.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
		await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
	} else {
		expect(metrics.height).toBeLessThanOrEqual(viewport.height + 1);
	}
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
	await expect(fallbackCard.getByRole("button", { name: "Choose a subscription" })).toBeVisible();
	expect(errors, `agent subscription cards: ${errors.join(" | ")}`).toEqual([]);
});

test("terminal fallback selects reusable subscriptions and keeps the long dialog reachable", async ({
	page,
}) => {
	const checkoutIdempotencyKeys: string[] = [];
	const checkoutRequests: string[] = [];
	const reusableSubscriptionRequests: string[] = [];
	const errors = collectBrowserErrors(page);
	const reusable = (
		subscriptionId: string,
		overrides: Partial<ReusableSubscription>,
	): ReusableSubscription => ({
		subscription_id: subscriptionId,
		plan_slug: "compute_basic",
		billing_term_months: 1,
		funding_source: "stripe",
		status: "active",
		price_cents: 900,
		currency: "usd",
		current_period_end: "2099-09-12T12:00:00Z",
		entitled_until: "2099-09-12T12:00:00Z",
		cancel_at_period_end: false,
		...overrides,
	});
	await stubHostedApi(page, {
		checkoutIdempotencyKeys,
		checkoutRequests,
		checkoutResponses: [
			{
				status: 409,
				body: {
					detail: {
						code: "reusable_subscription_unavailable",
						title: "Reusable subscription unavailable",
					},
				},
			},
			{
				status: 200,
				body: {
					flow_type: "subscription_activation",
					funding_source: "wallet",
					action_url: null,
					checkout_url: "",
					client_secret: null,
					subscription_id: "csub_wallet_canceling",
					invoice_id: null,
					deployment_id: "hdep_terminal_fallback",
					deployment_name: "Fallback Basic",
					metadata_generation: 2,
					deploy_request_id: null,
					debited_usd: null,
					balance_after_usd: null,
					current_period_start: "2098-09-12T12:00:00Z",
					current_period_end: "2099-09-12T12:00:00Z",
					entitled_until: "2099-09-12T12:00:00Z",
				},
			},
		],
		deployments: [terminalFallbackDeployment],
		plans: [basicPlan, performancePlan],
		reusableSubscriptionRequests,
		reusableSubscriptionPages: {
			initial: {
				items: [reusable("csub_card_active", {})],
				has_more: true,
				next_cursor: "second-page",
			},
			"second-page": {
				items: [
					reusable("csub_wallet_canceling", {
						plan_slug: "compute_performance",
						billing_term_months: 12,
						funding_source: "wallet",
						status: "canceling",
						price_cents: 18_000,
						cancel_at_period_end: true,
					}),
				],
				has_more: false,
				next_cursor: null,
			},
		},
	});

	const desktop = { width: 1440, height: 900 };
	const mobile390 = { width: 390, height: 568 };
	const mobile320 = { width: 320, height: 568 };
	const sourceDialog = page.getByRole("dialog", { name: "Choose a paid subscription" });
	const openSourceDialog = async (viewport: { width: number; height: number }) => {
		await page.setViewportSize(viewport);
		await page
			.locator("#compute-plan-controls")
			.getByRole("button", { name: "Choose a subscription" })
			.click();
		await expect(sourceDialog).toBeVisible();
		await expect(sourceDialog.getByRole("button", { name: /Basic subscription/ })).toBeVisible();
		await expect(
			sourceDialog.getByRole("button", { name: /Performance subscription/ }),
		).toBeVisible();
		return sourceDialog;
	};
	const closeSourceDialog = async () => {
		await page.keyboard.press("Escape");
		await expect(sourceDialog).toBeHidden();
	};
	await page.setViewportSize(desktop);
	await gotoHostedAgentSettings(page, "hdep_terminal_fallback", "Basic");
	let dialog = await openSourceDialog(desktop);
	await expect(dialog.getByText("Active", { exact: true })).toBeVisible();
	await expect(dialog.getByText("Canceling", { exact: true })).toBeVisible();
	await expect(dialog.getByText("Renews", { exact: true })).toBeVisible();
	await expect(dialog.getByText("Ends", { exact: true })).toBeVisible();
	await expect(dialog.getByText("$180.00/yr", { exact: true })).toBeVisible();
	await expectSourceDialogGeometry(dialog, desktop, false);
	await closeSourceDialog();

	dialog = await openSourceDialog(mobile390);
	await expectSourceDialogGeometry(dialog, mobile390, true);
	await closeSourceDialog();

	dialog = await openSourceDialog(mobile320);
	await expectSourceDialogGeometry(dialog, mobile320, true);

	const active = dialog.getByRole("button", { name: /Basic subscription/ });
	const canceling = dialog.getByRole("button", { name: /Performance subscription/ });
	await active.click();
	await expect(active).toHaveAttribute("aria-pressed", "true");
	await canceling.click();
	await expect(canceling).toHaveAttribute("aria-pressed", "true");
	await expect(active).toHaveAttribute("aria-pressed", "false");
	await dialog.getByRole("button", { name: "Use subscription" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	await expect(page.getByText("Subscription no longer available", { exact: true })).toBeVisible();
	await expect(active).toHaveAttribute("aria-pressed", "false");
	await expect(canceling).toHaveAttribute("aria-pressed", "false");
	await expect(dialog.getByRole("button", { name: /New paid subscription/ })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect.poll(() => reusableSubscriptionRequests.length).toBeGreaterThanOrEqual(4);
	const cursors = reusableSubscriptionRequests.slice(0, 4).map((url) => {
		return new URL(url).searchParams.get("cursor");
	});
	expect(cursors).toEqual([null, "second-page", null, "second-page"]);

	await canceling.click();
	await expect(canceling).toHaveAttribute("aria-pressed", "true");
	await dialog.getByRole("button", { name: "Use subscription" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(2);
	expect(JSON.parse(checkoutRequests[1] ?? "{}")).toMatchObject({
		funding_source: "wallet",
		plan_slug: "compute_performance",
		billing_term_months: 12,
		subscription_selection: {
			mode: "existing",
			subscription_id: "csub_wallet_canceling",
		},
		upgrade_deployment_id: "hdep_terminal_fallback",
	});
	expect(checkoutIdempotencyKeys).toHaveLength(2);
	expect(checkoutIdempotencyKeys[0]).not.toBe(checkoutIdempotencyKeys[1]);
	expect(errors, `reusable subscription picker: ${errors.join(" | ")}`).toEqual([
		"Failed to load resource: the server responded with a status of 409 (Conflict)",
	]);
});
