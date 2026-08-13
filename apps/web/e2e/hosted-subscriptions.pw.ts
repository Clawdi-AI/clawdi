import type { DeployComponents } from "@clawdi/shared/api";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	basicPlan,
	cancelPendingBasicDeployment,
	cardPastDueDeployment,
	collectBrowserErrors,
	gotoHostedAgentSettings,
	gotoHostedSettingsDialog,
	includedBasicDeployment,
	paidBasicDeployment,
	performancePlan,
	sharedLegacyCloudAgent,
	stubHostedApi,
	terminalFallbackDeployment,
	walletActiveDeployment,
} from "./hosted-stub-api";

type Subscription = DeployComponents["schemas"]["V2ComputeSubscriptionListItem"];
type ReusableSubscription = DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"];

const longAgentName =
	"Production research agent with an intentionally long name for compact subscription layouts";
const testAvatarUrl =
	"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Crect%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22%230f766e%22%2F%3E%3C%2Fsvg%3E";

const activeEnvironmentId = "11111111-1111-4111-8111-111111111111";
const cancelingEnvironmentId = "22222222-2222-4222-8222-222222222222";
const paidEnvironmentId = "33333333-3333-4333-8333-333333333333";
const pastDueEnvironmentId = "44444444-4444-4444-8444-444444444444";
const includedEnvironmentId = "55555555-5555-4555-8555-555555555555";
const accountActiveDeployment = {
	...paidBasicDeployment,
	id: "hdep_active",
	name: "Account active deployment",
	config_info: {
		...paidBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: activeEnvironmentId },
	},
};
const accountCancelingDeployment = {
	...cancelPendingBasicDeployment,
	id: "hdep_canceling",
	name: "Account canceling deployment",
	config_info: {
		...cancelPendingBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: cancelingEnvironmentId },
	},
};
const accountPastDueDeployment = {
	...walletActiveDeployment,
	id: "hdep_past_due",
	name: "Account past due deployment",
	config_info: {
		...walletActiveDeployment.config_info,
		clawdi_cloud_environments: { hermes: pastDueEnvironmentId },
	},
};
const accountIncludedDeployment = {
	...includedBasicDeployment,
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: includedEnvironmentId },
	},
};
const ineligibleIncludedDeployment = {
	...includedBasicDeployment,
	id: "hdep_included_ineligible",
	name: "Included Basic temporarily unavailable",
	status: "starting",
	upgrade_available: false,
	upgrade_eligibility: {
		eligible: false,
		reason: "deployment_must_be_running_or_stopped",
	},
};
const accountCloudAgents = [
	{
		...sharedLegacyCloudAgent,
		id: activeEnvironmentId,
		name: "account-active",
		default_name: "Account active",
		display_name: longAgentName,
		avatar_url: testAvatarUrl,
	},
	{
		...sharedLegacyCloudAgent,
		id: cancelingEnvironmentId,
		name: "account-canceling",
		default_name: "Canceling agent",
		display_name: null,
	},
	{
		...sharedLegacyCloudAgent,
		id: pastDueEnvironmentId,
		name: "account-past-due",
		default_name: "Past due agent",
		display_name: null,
	},
	{
		...sharedLegacyCloudAgent,
		id: includedEnvironmentId,
		name: "account-included",
		default_name: "Included agent",
		display_name: null,
	},
];

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
		payment_state: "ok",
		latest_failed_invoice_hosted_url: null,
		next_payment_attempt_at: null,
		recovery_action: null,
		pending_plan_slug: null,
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
				const actionItemBoxes = Array.from(
					card.querySelectorAll<HTMLElement>(
						'[data-slot="compute-subscription-actions"] button, [data-slot="compute-subscription-actions"] a',
					),
				).map((item) => item.getBoundingClientRect().toJSON());
				return {
					clientWidth: card.clientWidth,
					scrollWidth: card.scrollWidth,
					box: box.toJSON(),
					actionBox: actionBox?.toJSON() ?? null,
					actionItemBoxes,
				};
			}),
		);

	expect(metrics).not.toHaveLength(0);
	for (const metric of metrics) {
		expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
		if (metric.actionBox) {
			expect(metric.actionBox.x).toBeGreaterThanOrEqual(metric.box.x - 1);
			expect(metric.actionBox.x + metric.actionBox.width).toBeLessThanOrEqual(
				metric.box.x + metric.box.width + 1,
			);
			expect(metric.actionBox.y).toBeGreaterThanOrEqual(metric.box.y - 1);
			for (const itemBox of metric.actionItemBoxes) {
				expect(itemBox.x).toBeGreaterThanOrEqual(metric.actionBox.x - 1);
				expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(
					metric.actionBox.x + metric.actionBox.width + 1,
				);
			}
			for (let index = 1; index < metric.actionItemBoxes.length; index += 1) {
				const previous = metric.actionItemBoxes[index - 1];
				const current = metric.actionItemBoxes[index];
				if (!previous || !current) continue;
				const overlapWidth =
					Math.min(previous.right, current.right) - Math.max(previous.left, current.left);
				const overlapHeight =
					Math.min(previous.bottom, current.bottom) - Math.max(previous.top, current.top);
				expect(overlapWidth <= 0 || overlapHeight <= 0).toBe(true);
			}
		}
	}
}

async function expectNoHorizontalOverflow(page: Page) {
	const metrics = await page.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

async function expectAgentSettingsSectionsAligned(
	page: Page,
	width: { min?: number; max?: number },
) {
	const main = page.locator("main");
	const sectionNames = [
		"Name",
		"Avatar",
		"Language & timezone",
		"Compute plan",
		"Lifecycle",
		"Danger zone",
	];
	const boxes = await Promise.all(
		sectionNames.map(async (name) => {
			const section = main
				.getByRole("heading", { name, exact: true })
				.locator("xpath=ancestor::section[1]");
			await expect(section).toBeVisible();
			const box = await section.boundingBox();
			if (!box) throw new Error(`${name} settings section has no layout box`);
			const overflow = await section.evaluate((element) => ({
				clientWidth: element.clientWidth,
				scrollWidth: element.scrollWidth,
			}));
			expect(overflow.scrollWidth, `${name} section overflow`).toBeLessThanOrEqual(
				overflow.clientWidth + 1,
			);
			return box;
		}),
	);

	const [reference] = boxes;
	if (!reference) throw new Error("Expected Agent Settings section boxes");
	if (width.min !== undefined) expect(reference.width).toBeGreaterThanOrEqual(width.min - 1);
	if (width.max !== undefined) expect(reference.width).toBeLessThanOrEqual(width.max + 1);
	for (const box of boxes.slice(1)) {
		expect(Math.abs(box.x - reference.x), "section left edge").toBeLessThanOrEqual(1);
		expect(Math.abs(box.width - reference.width), "section width").toBeLessThanOrEqual(1);
		expect(
			Math.abs(box.x + box.width / 2 - (reference.x + reference.width / 2)),
			"section center axis",
		).toBeLessThanOrEqual(1);
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
		deployments: [
			accountActiveDeployment,
			accountIncludedDeployment,
			accountPastDueDeployment,
			accountCancelingDeployment,
		],
		cloudAgents: accountCloudAgents,
		plans: [basicPlan, performancePlan],
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
						agent_name: "Former deleted agent",
						deployment_id: null,
						is_orphan: true,
					}),
				],
				has_more: true,
				next_cursor: "current-page",
			},
			"current-page": {
				items: [
					subscription("active", "active", { agent_name: longAgentName }),
					subscription("included", "active", {
						plan_slug: "compute_basic",
						funding_source: null,
						price_cents: 0,
						billing_term_months: 1,
						agent_name: "Included agent",
					}),
					subscription("past_due", "past_due", {
						plan_slug: "compute_basic",
						funding_source: "wallet",
						price_cents: 900,
						billing_term_months: 1,
						agent_name: "Past due agent",
						payment_state: "past_due",
						next_payment_attempt_at: "2099-08-10T12:00:00Z",
						recovery_action: "top_up",
					}),
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
	await expect(dialog.getByText("Active", { exact: true })).toHaveCount(2);
	await expect(dialog.getByText("Canceling", { exact: true })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(4);
	await expect(dialog.getByRole("button", { name: "Manage", exact: true })).toHaveCount(2);
	await expect(dialog.getByRole("button", { name: "Resume subscription" })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Show history (2)" })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"] h4')).toHaveCount(4);
	const currentCards = dialog.locator('[data-slot="compute-subscription-card"]');
	const activeCard = currentCards.nth(0);
	const includedCard = currentCards.nth(1);
	const pastDueCard = currentCards.nth(2);
	const cancelingCard = currentCards.nth(3);
	await expect(activeCard.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
	await expect(activeCard.locator("h4")).toHaveText("Performance compute");
	await expect(activeCard.getByText("Used by", { exact: true })).toBeVisible();
	await expect(activeCard.getByText(longAgentName, { exact: true })).toBeVisible();
	await expect(activeCard.locator("img")).toHaveCount(1);
	await expect(activeCard.locator('[data-slot="compute-subscription-identity"] a')).toHaveAttribute(
		"href",
		/\/agents\/hdep_active\/settings\?.*settings=billing-plan/,
	);
	await expect(activeCard.getByText("Card", { exact: true })).toBeVisible();
	await expect(activeCard.getByText("$190.00/yr", { exact: true })).toBeVisible();
	await expect(includedCard.locator("h4")).toHaveText("Basic compute");
	await expect(includedCard.getByText("Free", { exact: true })).toBeVisible();
	await expect(includedCard.getByText("Included agent", { exact: true })).toBeVisible();
	const includedManage = includedCard.getByRole("button", { name: "Manage", exact: true });
	await expect(includedManage).toBeVisible();
	await expect(includedManage.locator("svg.lucide-settings")).toHaveCount(1);
	await expect(includedCard.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
	await expect(pastDueCard.getByText("Past due", { exact: true })).toBeVisible();
	await expect(pastDueCard.getByText("Retries Aug 10, 2099", { exact: true })).toBeVisible();
	await expect(pastDueCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	await expect(pastDueCard.getByRole("button", { name: "Top up", exact: true })).toBeVisible();
	await expect(cancelingCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	const currentStatuses = await currentCards.evaluateAll((cards) =>
		cards.map((card) => card.getAttribute("data-subscription-status")),
	);
	expect(currentStatuses).toEqual(["active", "active", "past-due", "canceling"]);
	const desktopCardBoxes = await currentCards.evaluateAll((cards) =>
		cards.map((card) => card.getBoundingClientRect().toJSON()),
	);
	expect(
		Math.abs((desktopCardBoxes[0]?.y ?? 0) - (desktopCardBoxes[1]?.y ?? 1)),
	).toBeLessThanOrEqual(1);
	expect(Math.abs((desktopCardBoxes[0]?.x ?? 0) - (desktopCardBoxes[1]?.x ?? 0))).toBeGreaterThan(
		100,
	);
	await expectCardsFit(dialog);

	await dialog.getByRole("button", { name: "Show history (2)" }).click();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(6);
	await expect(dialog.locator('[data-slot="compute-subscription-card"] h4')).toHaveCount(6);
	await expect(dialog.getByText("Canceled", { exact: true })).toHaveCount(2);
	const visibleStatuses = await dialog
		.locator('[data-slot="compute-subscription-card"]')
		.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-subscription-status")));
	expect(visibleStatuses).toEqual([
		"active",
		"active",
		"past-due",
		"canceling",
		"canceled",
		"canceled",
	]);
	const orphanCard = dialog
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Deleted agent" });
	await expect(orphanCard).toBeVisible();
	await expect(orphanCard.getByText("Orphaned", { exact: true })).toBeVisible();
	await expect(orphanCard.getByText("Former deleted agent", { exact: true })).toHaveCount(0);
	await expect(orphanCard.getByText("Unknown", { exact: true })).toHaveCount(0);
	await expect(orphanCard.getByText("No linked agent", { exact: true })).toHaveCount(0);
	await expect(dialog.getByText("ended_second", { exact: true })).toBeVisible();
	await expect(orphanCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	const canceledCards = dialog
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Canceled" });
	await expect(canceledCards.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	await expectCardsFit(dialog);

	const accountSettingsUrl = page.url();
	await activeCard.getByRole("button", { name: "Manage", exact: true }).click();
	const fullManagementDialog = page.getByRole("dialog", { name: "Manage compute subscription" });
	await expect(fullManagementDialog).toBeVisible();
	await expect(dialog).toBeVisible();
	expect(page.url()).toBe(accountSettingsUrl);
	await expect(
		fullManagementDialog.getByRole("group", { name: "Subscription management mode" }),
	).toBeVisible();
	await expect(
		fullManagementDialog.getByRole("button", { name: "Plan & billing", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(fullManagementDialog.getByLabel("Payment source")).toHaveCount(0);
	await expect(fullManagementDialog.getByLabel("Compute plan")).toHaveText(/Performance/);
	await fullManagementDialog.getByLabel("Compute plan").click();
	await page.getByRole("option", { name: "Basic", exact: true }).click();
	await expect(fullManagementDialog.getByLabel("Compute plan")).toHaveText(/Basic/);
	await fullManagementDialog.getByRole("button", { name: "Payment source", exact: true }).click();
	await expect(fullManagementDialog.getByLabel("Compute plan")).toHaveCount(0);
	await expect(fullManagementDialog.getByText("Current plan", { exact: true })).toBeVisible();
	await expect(fullManagementDialog.getByLabel("Payment source")).toBeVisible();
	await fullManagementDialog.getByRole("button", { name: "Plan & billing", exact: true }).click();
	await expect(fullManagementDialog.getByLabel("Compute plan")).toHaveText(/Performance/);
	await expect(fullManagementDialog.getByLabel("Payment source")).toHaveCount(0);
	await fullManagementDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(fullManagementDialog).toBeHidden();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Hide history" })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(6);
	expect(page.url()).toBe(accountSettingsUrl);

	await includedManage.click();
	const includedManagementDialog = page.getByRole("dialog", {
		name: "Change compute subscription",
	});
	await expect(includedManagementDialog).toBeVisible();
	await expect(
		includedManagementDialog.getByRole("group", { name: "Subscription management mode" }),
	).toHaveCount(0);
	await expect(includedManagementDialog.getByLabel("Compute plan")).toHaveText(/Performance/);
	await expect(includedManagementDialog.getByLabel("Payment source")).toBeVisible();
	await expect(
		includedManagementDialog.getByRole("button", { name: "Cancel subscription" }),
	).toHaveCount(0);
	await includedManagementDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(includedManagementDialog).toBeHidden();
	await expect(dialog).toBeVisible();

	await pastDueCard.getByRole("button", { name: "Top up", exact: true }).click();
	const topUpDialog = page.getByRole("dialog", { name: "Top up Wallet", exact: true });
	await expect(topUpDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(topUpDialog).toBeHidden();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Hide history" })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(6);
	expect(page.url()).toBe(accountSettingsUrl);

	await dialog.getByRole("button", { name: "Hide history" }).click();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(4);
	await expect(dialog.getByText("ended_first", { exact: true })).toHaveCount(0);

	await page.setViewportSize({ width: 320, height: 568 });
	await expect(dialog).toBeVisible();
	await expectCardsFit(dialog);
	await expectNoHorizontalOverflow(page);
	const mobileCardBoxes = await dialog
		.locator('[data-slot="compute-subscription-card"]')
		.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().toJSON()));
	expect(mobileCardBoxes[1]?.y ?? 0).toBeGreaterThanOrEqual(mobileCardBoxes[0]?.bottom ?? 0);
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

test("agent settings uses compact canonical subscription management", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page, {
		cloudAgentOverrides: {
			display_name: "Paid research agent",
			avatar_url: testAvatarUrl,
		},
		deployments: [
			{
				...paidBasicDeployment,
				config_info: {
					...paidBasicDeployment.config_info,
					clawdi_cloud_environments: { hermes: paidEnvironmentId },
				},
			},
			cancelPendingBasicDeployment,
			{
				...paidBasicDeployment,
				id: "hdep_card_action_required",
				name: "Card authentication required",
				compute_subscription: {
					...paidBasicDeployment.compute_subscription,
					status: "past_due",
					payment_state: "requires_action",
					latest_failed_invoice_id: "in_card_action_required",
					latest_failed_invoice_hosted_url: "https://billing.example/invoice/action-required",
					recovery_action: "fix_payment",
				},
			},
			{
				...cardPastDueDeployment,
				compute_subscription: {
					...cardPastDueDeployment.compute_subscription,
					recovery_action: "fix_payment",
				},
			},
			terminalFallbackDeployment,
			includedBasicDeployment,
			ineligibleIncludedDeployment,
		],
		plans: [basicPlan, performancePlan],
	});

	await gotoHostedAgentSettings(page, paidEnvironmentId, "Basic", "?source=on-clawdi&d=hdep_paid");
	const activeCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(activeCard).toBeVisible();
	await expect(activeCard.getByText("Active", { exact: true })).toHaveAttribute(
		"data-status",
		"success",
	);
	await expect(activeCard.locator("h3")).toHaveText("Basic compute");
	await expect(activeCard.getByText("Paid research agent", { exact: true })).toHaveCount(0);
	await expect(activeCard.locator("img")).toHaveCount(0);
	await expect(activeCard.locator('[data-slot="compute-subscription-identity"]')).toHaveCount(0);
	await expect(activeCard).toHaveAttribute("data-layout", "management");
	const agentManage = activeCard.getByRole("button", { name: "Manage", exact: true });
	await expect(agentManage).toBeVisible();
	await expect(agentManage.locator("svg.lucide-settings")).toHaveCount(1);
	await expect(activeCard.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
	const activeCardWidth = await activeCard.evaluate((card) => card.getBoundingClientRect().width);
	expect(activeCardWidth).toBeGreaterThan(896);
	await expectCardsFit(page.locator("body"));
	await expectAgentSettingsSectionsAligned(page, { min: 896 });

	await page.setViewportSize({ width: 320, height: 568 });
	await expectCardsFit(page.locator("body"));
	await expectAgentSettingsSectionsAligned(page, { max: 320 });
	await expectNoHorizontalOverflow(page);
	await expect(activeCard.getByRole("button", { name: "Manage", exact: true })).toBeVisible();
	await expect(activeCard.getByRole("button", { name: "Cancel subscription" })).toBeVisible();

	await gotoHostedAgentSettings(page, "hdep_cancel_pending", "Basic");
	const cancelingCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(cancelingCard.getByText("Canceling", { exact: true })).toHaveAttribute(
		"data-status",
		"warning",
	);
	await expect(cancelingCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
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
	await expect(pastDueCard.getByText("Retries Jul 16, 2026", { exact: true })).toBeVisible();
	await expect(pastDueCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(page, "hdep_card_action_required", "Basic");
	const actionRequiredCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(
		actionRequiredCard.getByText("Payment action required", { exact: true }),
	).toHaveAttribute("data-status", "warning");
	await expect(actionRequiredCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(
		0,
	);
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(page, "hdep_terminal_fallback", "Basic");
	const fallbackCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(fallbackCard.getByText("Current", { exact: true })).toHaveAttribute(
		"data-status",
		"success",
	);
	await expect(fallbackCard.getByText("Free", { exact: true })).toBeVisible();
	await expect(fallbackCard.getByRole("button", { name: "Choose a subscription" })).toBeVisible();

	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoHostedAgentSettings(page, "hdep_included", "Basic");
	const includedCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(includedCard).toHaveAttribute("data-layout", "management");
	await expect(includedCard.getByText("Free", { exact: true })).toBeVisible();
	await expect(includedCard.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
	const includedManage = includedCard.getByRole("button", { name: "Manage", exact: true });
	await expect(includedManage).toBeEnabled();
	await expect(includedManage.locator("svg.lucide-settings")).toHaveCount(1);
	const desktopIncludedBox = await includedCard.boundingBox();
	if (!desktopIncludedBox) throw new Error("Included Basic card has no desktop layout box");
	expect(desktopIncludedBox.height).toBeLessThan(120);
	await includedCard.screenshot({ path: testInfo.outputPath("agent-compute-plan-desktop.png") });
	await expectCardsFit(page.locator("body"));
	await includedManage.click();
	const includedManagementDialog = page.getByRole("dialog", {
		name: "Change compute subscription",
	});
	await expect(includedManagementDialog).toBeVisible();
	await expect(
		includedManagementDialog.getByRole("group", { name: "Subscription management mode" }),
	).toHaveCount(0);
	await expect(includedManagementDialog.getByLabel("Compute plan")).toBeVisible();
	await expect(includedManagementDialog.getByLabel("Payment source")).toBeVisible();
	await includedManagementDialog.getByRole("button", { name: "Cancel", exact: true }).click();

	await page.setViewportSize({ width: 320, height: 568 });
	await expect(includedCard).toBeVisible();
	await expectCardsFit(page.locator("body"));
	await expectNoHorizontalOverflow(page);
	const mobileIncludedBox = await includedCard.boundingBox();
	if (!mobileIncludedBox) throw new Error("Included Basic card has no mobile layout box");
	expect(mobileIncludedBox.height).toBeLessThan(180);
	await includedCard.screenshot({ path: testInfo.outputPath("agent-compute-plan-mobile-320.png") });

	await gotoHostedAgentSettings(page, "hdep_included_ineligible", "Basic");
	const unavailableCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	const unavailableReason = unavailableCard.getByText(
		"Wait until this agent is running or stopped before trying to upgrade again.",
		{ exact: true },
	);
	const unavailableManage = unavailableCard.getByRole("button", { name: "Manage", exact: true });
	await expect(unavailableManage).toBeDisabled();
	await expect(unavailableReason).toBeVisible();
	const unavailableLayout = await unavailableCard.evaluate((card) => {
		const notice = card.querySelector<HTMLElement>('[data-slot="compute-subscription-notice"]');
		const actions = card.querySelector<HTMLElement>('[data-slot="compute-subscription-actions"]');
		if (!notice || !actions) return null;
		const noticeBox = notice.getBoundingClientRect();
		const actionsBox = actions.getBoundingClientRect();
		return {
			gap: actionsBox.top - noticeBox.bottom,
			scrollWidth: card.scrollWidth,
			clientWidth: card.clientWidth,
		};
	});
	expect(unavailableLayout).not.toBeNull();
	expect(unavailableLayout?.gap).toBeGreaterThanOrEqual(0);
	expect(unavailableLayout?.gap).toBeLessThanOrEqual(12);
	expect(unavailableLayout?.scrollWidth).toBeLessThanOrEqual(
		(unavailableLayout?.clientWidth ?? 0) + 1,
	);
	await expectNoHorizontalOverflow(page);
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
