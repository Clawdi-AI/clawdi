import type { DeployComponents } from "@clawdi/shared/api";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	basicPlan,
	cancelPendingBasicDeployment,
	cardPastDueDeployment,
	collectBrowserErrors,
	fixtureAgentId,
	gotoHostedAgentSettings,
	gotoHostedSettingsDialog,
	includedBasicDeployment,
	mutationDeploymentReadFixture,
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
const endedEnvironmentId = "66666666-6666-4666-8666-666666666666";
const accountActiveDeployment = {
	...paidBasicDeployment,
	id: "hdep_active",
	agent_id: activeEnvironmentId,
	name: "Account active deployment",
	config_info: {
		...paidBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: activeEnvironmentId },
	},
};
const accountCancelingDeployment = {
	...cancelPendingBasicDeployment,
	id: "hdep_canceling",
	agent_id: cancelingEnvironmentId,
	name: "Account canceling deployment",
	config_info: {
		...cancelPendingBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: cancelingEnvironmentId },
	},
};
const accountPastDueDeployment = {
	...walletActiveDeployment,
	id: "hdep_past_due",
	agent_id: pastDueEnvironmentId,
	name: "Account past due deployment",
	config_info: {
		...walletActiveDeployment.config_info,
		clawdi_cloud_environments: { hermes: pastDueEnvironmentId },
	},
};
const accountIncludedDeployment = {
	...includedBasicDeployment,
	agent_id: includedEnvironmentId,
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: includedEnvironmentId },
	},
};
const accountEndedDeployment = {
	...paidBasicDeployment,
	id: "hdep_ended_second",
	agent_id: endedEnvironmentId,
	name: "Ended subscription agent",
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
		subscription_kind: "paid",
		plan_slug: "compute_performance",
		funding_source: "stripe",
		status,
		lifecycle_status: status === "canceling" ? "active" : status,
		actions: {
			cancel: status === "active" || status === "past_due" ? "cancel_at_period_end" : null,
			resume: status === "canceling",
			command_state: null,
		},
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

function reusableSubscription(
	subscriptionId: string,
	overrides: Partial<ReusableSubscription> = {},
): ReusableSubscription {
	return {
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
	};
}

async function expectCardsFit(container: Locator) {
	const metrics = await container
		.locator('[data-slot="compute-subscription-card"]')
		.evaluateAll((cards) =>
			cards.map((card) => {
				const box = card.getBoundingClientRect();
				const headingBox = card.querySelector("h3, h4")?.getBoundingClientRect();
				const meta = card.querySelector<HTMLElement>('[data-slot="compute-subscription-meta"]');
				const action = card.querySelector<HTMLElement>(
					'[data-slot="compute-subscription-actions"]',
				);
				const metaBox = meta?.getBoundingClientRect();
				const metaItemBoxes = Array.from(meta?.children ?? []).map((item) =>
					item.getBoundingClientRect().toJSON(),
				);
				const actionRect = action?.getBoundingClientRect();
				const actionBox = actionRect && actionRect.height > 0 ? actionRect : null;
				const actionItemBoxes = Array.from(
					card.querySelectorAll<HTMLElement>(
						'[data-slot="compute-subscription-actions"] button, [data-slot="compute-subscription-actions"] a',
					),
				).map((item) => item.getBoundingClientRect().toJSON());
				const sectionBoxes = [
					"compute-subscription-header",
					"compute-subscription-meta",
					"compute-subscription-identity",
					"compute-subscription-notice",
					"compute-subscription-actions",
				]
					.map((slot) =>
						card.querySelector<HTMLElement>(`[data-slot="${slot}"]`)?.getBoundingClientRect(),
					)
					.filter((section): section is DOMRect => Boolean(section && section.height > 0))
					.map((section) => section.toJSON());
				return {
					clientWidth: card.clientWidth,
					scrollWidth: card.scrollWidth,
					box: box.toJSON(),
					headingBox: headingBox?.toJSON() ?? null,
					metaBox: metaBox?.toJSON() ?? null,
					metaItemBoxes,
					actionBox: actionBox?.toJSON() ?? null,
					actionItemBoxes,
					sectionBoxes,
				};
			}),
		);

	expect(metrics).not.toHaveLength(0);
	for (const metric of metrics) {
		expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
		if (metric.headingBox) expect(metric.headingBox.height).toBeLessThanOrEqual(49);
		for (let index = 1; index < metric.sectionBoxes.length; index += 1) {
			const previous = metric.sectionBoxes[index - 1];
			const current = metric.sectionBoxes[index];
			if (!previous || !current) continue;
			expect(current.y).toBeGreaterThanOrEqual(previous.bottom - 1);
			expect(current.y - previous.bottom).toBeLessThanOrEqual(48);
		}
		if (metric.metaBox) {
			for (const itemBox of metric.metaItemBoxes) {
				expect(itemBox.x).toBeGreaterThanOrEqual(metric.metaBox.x - 1);
				expect(itemBox.right).toBeLessThanOrEqual(metric.metaBox.right + 1);
			}
			for (let index = 1; index < metric.metaItemBoxes.length; index += 1) {
				const previous = metric.metaItemBoxes[index - 1];
				const current = metric.metaItemBoxes[index];
				if (!previous || !current) continue;
				const overlapWidth =
					Math.min(previous.right, current.right) - Math.max(previous.left, current.left);
				const overlapHeight =
					Math.min(previous.bottom, current.bottom) - Math.max(previous.top, current.top);
				expect(overlapWidth <= 0 || overlapHeight <= 0).toBe(true);
			}
		}
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

async function gotoSubscriptionAction(page: Page, action: "start_new") {
	const url = new URL(page.url());
	url.searchParams.set("subscription_action", action);
	await page.goto(url.toString());
}

async function expectSubscriptionCardRowAligned(left: Locator, right: Locator) {
	const [leftLayout, rightLayout] = await Promise.all(
		[left, right].map((card) =>
			card.evaluate((element) => {
				const slotBox = (slot: string) => {
					const target = element.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
					if (!target) throw new Error(`Missing ${slot}`);
					return target.getBoundingClientRect().toJSON();
				};
				return {
					card: element.getBoundingClientRect().toJSON(),
					header: slotBox("compute-subscription-header"),
					meta: slotBox("compute-subscription-meta"),
					identity: slotBox("compute-subscription-identity"),
					actions: slotBox("compute-subscription-actions"),
				};
			}),
		),
	);

	expect(Math.abs(leftLayout.card.y - rightLayout.card.y)).toBeLessThanOrEqual(1);
	expect(Math.abs(leftLayout.card.height - rightLayout.card.height)).toBeLessThanOrEqual(1);
	for (const slot of ["header", "meta", "identity"] as const) {
		expect(Math.abs(leftLayout[slot].y - rightLayout[slot].y)).toBeLessThanOrEqual(1);
	}
	expect(Math.abs(leftLayout.actions.bottom - rightLayout.actions.bottom)).toBeLessThanOrEqual(1);
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
		"Agent controls",
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

test("subscription cards preserve pagination and reveal loaded history", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const errors = collectBrowserErrors(page);
	const fixPaymentRequests: string[] = [];
	const scheduledPlanCancellationRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [
			accountActiveDeployment,
			accountIncludedDeployment,
			accountPastDueDeployment,
			accountCancelingDeployment,
			accountEndedDeployment,
		],
		cloudAgents: accountCloudAgents,
		plans: [basicPlan, performancePlan],
		fixPaymentRequests,
		scheduledPlanCancellationRequests,
		reusableSubscriptionPages: {
			initial: {
				items: [
					reusableSubscription("reusable_active", {
						plan_slug: "compute_performance",
						funding_source: "wallet",
						price_cents: 1_000,
					}),
				],
				has_more: false,
				next_cursor: null,
			},
		},
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
						recovery_action: "start_new",
					}),
				],
				has_more: true,
				next_cursor: "current-page",
			},
			"current-page": {
				items: [
					subscription("active", "active", { agent_name: longAgentName }),
					subscription("included", "active", {
						subscription_kind: "included_basic",
						plan_slug: "compute_basic",
						funding_source: null,
						price_cents: 0,
						billing_term_months: 1,
						agent_name: "Included agent",
					}),
					subscription("reusable_active", "active", {
						funding_source: "wallet",
						price_cents: 1_000,
						billing_term_months: 1,
						deployment_id: "hdep_deleted_stale_projection",
						agent_name: "Stale deleted agent",
						is_orphan: true,
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
					subscription("orphan_past_due", "past_due", {
						deployment_id: null,
						agent_name: null,
						is_orphan: true,
						payment_state: "requires_action",
						recovery_action: "fix_payment",
					}),
					subscription("csub_canceling", "canceling", {
						cancel_at_period_end: true,
						current_period_end: "2025-08-12T12:00:00Z",
						deployment_id: "hdep_canceling",
						agent_name: "Canceling agent",
						pending_plan_slug: "compute_basic",
					}),
					subscription("ended_second", "canceled", {
						current_period_end: "2099-09-11T12:00:00Z",
						recovery_action: "start_new",
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
	const activeIdentity = dialog
		.locator('[data-slot="compute-subscription-identity"] a')
		.filter({ has: page.locator(`span[title="${longAgentName}"]`) });
	await expect(activeIdentity).toBeVisible();
	await expect(activeIdentity.locator("span[title]")).toHaveAttribute("title", longAgentName);
	await expect(dialog.getByText("Canceling agent", { exact: true })).toBeVisible();
	await expect(dialog.getByText("Active", { exact: true })).toHaveCount(3);
	await expect(dialog.getByText("Canceling", { exact: true })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(6);
	await expect(dialog.getByRole("button", { name: "Manage", exact: true })).toHaveCount(2);
	await expect(dialog.getByRole("button", { name: "Upgrade", exact: true })).toHaveCount(1);
	await expect(dialog.getByRole("button", { name: "Cancel scheduled change" })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Show history (2)" })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"] h4')).toHaveCount(6);
	const currentCards = dialog.locator('[data-slot="compute-subscription-card"]');
	const activeCard = currentCards.nth(0);
	const includedCard = currentCards.nth(1);
	const availableCard = currentCards.nth(2);
	const pastDueCard = currentCards.nth(3);
	const orphanPastDueCard = currentCards.nth(4);
	const cancelingCard = currentCards.nth(5);
	await expect(activeCard.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
	await expect(activeCard.locator("h4")).toHaveText("Performance compute");
	await expect(activeCard.getByText("Used by", { exact: true })).toBeVisible();
	await expect(activeCard.locator('[data-slot="compute-subscription-identity"] a')).toBeVisible();
	await expect(activeCard.locator("span[title]")).toHaveAttribute("title", longAgentName);
	await expect(activeCard.locator("img")).toHaveCount(1);
	await expect(activeCard.locator('[data-slot="compute-subscription-identity"] a')).toHaveAttribute(
		"href",
		new RegExp(`/agents/${activeEnvironmentId}/settings\\?.*settings=billing-plan`),
	);
	await expect(activeCard.getByText("Card", { exact: true })).toBeVisible();
	await expect(activeCard.getByText("$190.00/yr", { exact: true })).toBeVisible();
	await expect(includedCard.locator("h4")).toHaveText("Basic compute");
	await expect(includedCard.getByText("Free", { exact: true })).toBeVisible();
	await expect(includedCard.getByText("Included agent", { exact: true })).toBeVisible();
	const includedUpgrade = includedCard.getByRole("button", { name: "Upgrade", exact: true });
	await expect(includedUpgrade).toBeEnabled();
	await expect(includedUpgrade.locator("svg.lucide-arrow-up")).toHaveCount(1);
	await expect(includedCard.getByRole("button")).toHaveCount(1);
	await expect(includedCard.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
	await expect(availableCard.getByText("Available for a new agent", { exact: true })).toBeVisible();
	await expect(availableCard.getByText("Stale deleted agent", { exact: true })).toHaveCount(0);
	await expect(availableCard.getByText("Used by", { exact: true })).toHaveCount(0);
	await expect(availableCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	await expect(availableCard.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
	await expect(pastDueCard.getByText("Past due", { exact: true })).toBeVisible();
	await expect(pastDueCard.getByText("Retries Aug 10, 2099", { exact: true })).toBeVisible();
	const pastDueManage = pastDueCard.getByRole("button", { name: "Manage", exact: true });
	await expect(pastDueManage).toBeEnabled();
	await expect(pastDueCard.getByRole("button", { name: "Top up", exact: true })).toBeVisible();
	await expect(pastDueCard.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
	await expect(orphanPastDueCard.getByText("Deleted agent", { exact: true })).toBeVisible();
	const orphanFixPayment = orphanPastDueCard.getByRole("button", { name: "Fix payment" });
	await expect(orphanFixPayment).toBeEnabled();
	await orphanFixPayment.click();
	await expect.poll(() => fixPaymentRequests.map((body) => JSON.parse(body))).toEqual([{}]);
	await expect(
		orphanPastDueCard.getByRole("button", { name: "Cancel subscription" }),
	).toBeVisible();
	await expect(cancelingCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	const cancelScheduledAccount = cancelingCard.getByRole("button", {
		name: "Cancel scheduled change",
	});
	await expect(cancelScheduledAccount).toBeEnabled();
	await expect(cancelingCard.getByRole("button", { name: "Keep subscription" })).toHaveCount(0);
	await cancelScheduledAccount.click();
	await expect
		.poll(() => scheduledPlanCancellationRequests.map((body) => JSON.parse(body)))
		.toEqual([{ subscription_id: "csub_canceling" }]);
	await expect(
		page.locator("[data-sonner-toast]").filter({ hasText: "Scheduled plan change canceled" }),
	).toBeVisible();
	const currentStatuses = await currentCards.evaluateAll((cards) =>
		cards.map((card) => card.getAttribute("data-subscription-status")),
	);
	expect(currentStatuses).toEqual([
		"active",
		"active",
		"active",
		"past-due",
		"payment-action-required",
		"canceling",
	]);
	const desktopGrid = await activeCard.evaluate((card) => {
		const grid = card.closest("ul");
		if (!grid) throw new Error("Subscription card grid is missing");
		const style = getComputedStyle(grid);
		return {
			columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
			columnGap: style.columnGap,
			rowGap: style.rowGap,
		};
	});
	expect(desktopGrid).toEqual({ columns: 2, columnGap: "8px", rowGap: "8px" });
	await expectSubscriptionCardRowAligned(activeCard, includedCard);
	const desktopCardBoxes = await currentCards.evaluateAll((cards) =>
		cards.map((card) => card.getBoundingClientRect().toJSON()),
	);
	expect(desktopCardBoxes[0]?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(200);
	expect(desktopCardBoxes[2]?.y ?? 0).toBeGreaterThanOrEqual(
		Math.max(desktopCardBoxes[0]?.bottom ?? 0, desktopCardBoxes[1]?.bottom ?? 0) - 1,
	);
	await expectCardsFit(dialog);
	await activeCard.evaluate((element) => element.scrollIntoView({ block: "start" }));
	await dialog.screenshot({ path: testInfo.outputPath("account-compute-plans-desktop.png") });
	await includedUpgrade.click();
	const upgradeDialog = page.getByRole("dialog", { name: "Change compute subscription" });
	await expect(upgradeDialog).toBeVisible();
	await expect(
		upgradeDialog.getByRole("group", { name: "Subscription management mode" }),
	).toHaveCount(0);
	await expect(upgradeDialog.getByLabel("Compute plan")).toHaveText(/Performance/);
	await expect(upgradeDialog.getByLabel("Payment source")).toBeVisible();
	await upgradeDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(upgradeDialog).toBeHidden();
	await expect(dialog).toBeVisible();

	await dialog.getByRole("button", { name: "Show history (2)" }).click();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(8);
	await expect(dialog.locator('[data-slot="compute-subscription-card"] h4')).toHaveCount(8);
	await expect(dialog.getByText("Ended", { exact: true })).toHaveCount(2);
	const visibleStatuses = await dialog
		.locator('[data-slot="compute-subscription-card"]')
		.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-subscription-status")));
	expect(visibleStatuses).toEqual([
		"active",
		"active",
		"active",
		"past-due",
		"payment-action-required",
		"canceling",
		"ended",
		"ended",
	]);
	const endedCards = dialog.locator('[data-subscription-status="ended"]');
	const orphanCard = endedCards.filter({ hasText: "Ended" }).filter({ hasText: "Deleted agent" });
	const linkedEndedCard = endedCards.filter({ hasText: "Ended subscription agent" });
	await expect(orphanCard).toBeVisible();
	await expect(dialog.getByText("Orphaned", { exact: true })).toHaveCount(0);
	await expect(orphanCard.getByText("Former deleted agent", { exact: true })).toHaveCount(0);
	await expect(orphanCard.getByText("Unknown", { exact: true })).toHaveCount(0);
	await expect(orphanCard.getByText("No linked agent", { exact: true })).toHaveCount(0);
	await expect(
		linkedEndedCard.getByText("Ended subscription agent", { exact: true }),
	).toBeVisible();
	await expect(
		linkedEndedCard.locator('[data-slot="compute-subscription-identity"] a'),
	).toHaveAttribute(
		"href",
		new RegExp(`/agents/${endedEnvironmentId}/settings\\?.*settings=billing-plan`),
	);
	await expect(orphanCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	await expect(orphanCard.locator('[data-slot="compute-subscription-notice"]')).toHaveCount(0);
	await expect(endedCards.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	await expect(endedCards.getByText("Schedule", { exact: true })).toHaveCount(0);
	await expect(endedCards.getByText(/(Aug 12, 2025|Sep 11, 2099)/)).toHaveCount(0);
	await expect(dialog.getByText("Start a new subscription from Agent settings.")).toHaveCount(1);
	await expect(dialog.getByText(/This subscription ended\./)).toHaveCount(0);
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
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(8);
	expect(page.url()).toBe(accountSettingsUrl);

	await pastDueManage.click();
	const pastDueManagementDialog = page.getByRole("dialog", { name: "Change payment source" });
	await expect(pastDueManagementDialog).toBeVisible();
	await expect(
		pastDueManagementDialog.getByRole("group", { name: "Subscription management mode" }),
	).toHaveCount(0);
	await expect(pastDueManagementDialog.getByLabel("Compute plan")).toHaveCount(0);
	await expect(pastDueManagementDialog.getByLabel("Payment source")).toBeVisible();
	await pastDueManagementDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(pastDueManagementDialog).toBeHidden();
	await expect(dialog).toBeVisible();

	await pastDueCard.getByRole("button", { name: "Top up", exact: true }).click();
	const topUpDialog = page.getByRole("dialog", { name: "Top up Wallet", exact: true });
	await expect(topUpDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(topUpDialog).toBeHidden();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Hide history" })).toBeVisible();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(8);
	expect(page.url()).toBe(accountSettingsUrl);

	await dialog.getByRole("button", { name: "Hide history" }).click();
	await expect(dialog.locator('[data-slot="compute-subscription-card"]')).toHaveCount(6);
	await expect(dialog.getByText("ended_first", { exact: true })).toHaveCount(0);

	await page.setViewportSize({ width: 800, height: 1000 });
	await expectCardsFit(dialog);
	const tabletCardBoxes = await dialog
		.locator('[data-slot="compute-subscription-card"]')
		.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().toJSON()));
	expect(tabletCardBoxes[1]?.y ?? 0).toBeGreaterThanOrEqual((tabletCardBoxes[0]?.bottom ?? 0) - 1);
	await currentCards.nth(0).scrollIntoViewIfNeeded();
	await dialog.screenshot({ path: testInfo.outputPath("account-compute-plans-tablet-800.png") });

	await page.setViewportSize({ width: 320, height: 1000 });
	await expect(dialog).toBeVisible();
	await expectCardsFit(dialog);
	await expectNoHorizontalOverflow(page);
	await dialog.screenshot({ path: testInfo.outputPath("account-compute-plans-mobile-320.png") });
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
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	const errors = collectBrowserErrors(page);
	const planQuoteRequests: string[] = [];
	const scheduledPlanCancellationRequests: string[] = [];
	await stubHostedApi(page, {
		cloudAgentOverrides: {
			display_name: "Paid research agent",
			avatar_url: testAvatarUrl,
		},
		deployments: [
			{
				...paidBasicDeployment,
				agent_id: paidEnvironmentId,
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
					status: "active",
					payment_state: "requires_action",
					latest_failed_invoice_id: "in_card_action_required",
					latest_failed_invoice_hosted_url: "https://billing.example/invoice/action-required",
					recovery_action: "fix_payment",
				},
			},
			{
				...mutationDeploymentReadFixture({
					...paidBasicDeployment,
					id: "hdep_plan_change_pending",
					name: "Plan change pending",
					compute_subscription: {
						...paidBasicDeployment.compute_subscription,
						status: "past_due",
						payment_state: "requires_action",
						recovery_action: "fix_payment",
					},
				}),
				accepted_operation: {
					name: "operations/pending-plan-change",
					metadata: {
						"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
						deploymentId: "hdep_plan_change_pending",
						verb: "plan_change",
						targetGeneration: 1,
						manifestETag: "plan-change-pending",
						createTime: "2026-07-16T00:00:00Z",
						updateTime: "2026-07-16T00:00:00Z",
					},
					done: false,
					error: null,
					response: null,
				},
			},
			{
				...paidBasicDeployment,
				id: "hdep_scheduled_downgrade",
				name: "Scheduled downgrade",
				config_info: {
					...paidBasicDeployment.config_info,
					compute_plan_slug: "compute_performance",
				},
				compute_subscription: {
					...paidBasicDeployment.compute_subscription,
					pending_plan_slug: "compute_basic",
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
		planQuoteRequests,
		scheduledPlanCancellationRequests,
		scheduledPlanCancellationResponses: [
			{
				status: 200,
				delayMs: 100,
				body: {
					status: "active",
					funding_source: "stripe",
					billing_term_months: 12,
					cancel_at_period_end: false,
					pending_plan_slug: "compute_basic",
					action_state: "reconciling",
				},
			},
		],
	});

	await gotoHostedAgentSettings(page, paidEnvironmentId, "Basic");
	await gotoSubscriptionAction(page, "start_new");
	await expect(page.getByRole("dialog", { name: "Choose a paid subscription" })).toHaveCount(0);
	await expect.poll(() => new URL(page.url()).searchParams.has("subscription_action")).toBe(false);
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
	await expect(activeCard.locator('[data-slot="compute-subscription-identity"]')).toBeEmpty();
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

	await gotoHostedAgentSettings(page, fixtureAgentId(cancelPendingBasicDeployment), "Basic");
	const cancelingCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(cancelingCard.getByText("Canceling", { exact: true })).toHaveAttribute(
		"data-status",
		"warning",
	);
	await expect(cancelingCard.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
	await expect(cancelingCard.getByRole("button", { name: "Keep subscription" })).toBeEnabled();
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(page, fixtureAgentId(cardPastDueDeployment), "Basic");
	const pastDueCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(pastDueCard.getByText("Past due", { exact: true })).toHaveAttribute(
		"data-status",
		"destructive",
	);
	await expect(pastDueCard.getByText("Retries Jul 16, 2026", { exact: true })).toBeVisible();
	const pastDueManage = pastDueCard.getByRole("button", { name: "Manage", exact: true });
	await expect(pastDueManage).toBeEnabled();
	await expect(pastDueCard.getByRole("button", { name: "Fix payment", exact: true })).toBeVisible();
	await expect(pastDueCard.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
	await pastDueManage.click();
	const pastDueManagementDialog = page.getByRole("dialog", { name: "Change payment source" });
	await expect(pastDueManagementDialog).toBeVisible();
	await expect(
		pastDueManagementDialog.getByRole("group", { name: "Subscription management mode" }),
	).toHaveCount(0);
	await expect(pastDueManagementDialog.getByLabel("Compute plan")).toHaveCount(0);
	await expect(pastDueManagementDialog.getByLabel("Payment source")).toBeVisible();
	await pastDueManagementDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(pastDueManagementDialog).toBeHidden();
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(
		page,
		fixtureAgentId({ ...paidBasicDeployment, id: "hdep_scheduled_downgrade" }),
		"Performance",
	);
	const scheduledDowngradeCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Performance compute" });
	const cancelScheduledAgent = scheduledDowngradeCard.getByRole("button", {
		name: "Cancel scheduled change",
	});
	await cancelScheduledAgent.click();
	await expect(cancelScheduledAgent).toBeDisabled();
	await expect
		.poll(() => scheduledPlanCancellationRequests.map((body) => JSON.parse(body)))
		.toEqual([{ deployment_id: "hdep_scheduled_downgrade" }]);
	await expect(
		page.locator("[data-sonner-toast]").filter({ hasText: "Subscription details are updating" }),
	).toBeVisible();
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(
		page,
		fixtureAgentId({ ...paidBasicDeployment, id: "hdep_card_action_required" }),
		"Basic",
	);
	const actionRequiredCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(
		actionRequiredCard.getByText("Payment action required", { exact: true }),
	).toHaveAttribute("data-status", "warning");
	const actionRequiredManage = actionRequiredCard.getByRole("button", {
		name: "Manage",
		exact: true,
	});
	await expect(actionRequiredManage).toBeEnabled();
	await expect(actionRequiredCard.getByRole("button", { name: "Fix payment" })).toBeVisible();
	await expect(
		actionRequiredCard.getByRole("button", { name: "Cancel subscription" }),
	).toBeVisible();
	await actionRequiredManage.click();
	const actionRequiredManagementDialog = page.getByRole("dialog", {
		name: "Change payment source",
	});
	await expect(actionRequiredManagementDialog).toBeVisible();
	await expect(
		actionRequiredManagementDialog.getByRole("group", {
			name: "Subscription management mode",
		}),
	).toHaveCount(0);
	await expect(actionRequiredManagementDialog.getByLabel("Compute plan")).toHaveCount(0);
	await expect(actionRequiredManagementDialog.getByLabel("Payment source")).toBeVisible();
	await actionRequiredManagementDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(actionRequiredManagementDialog).toBeHidden();
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(
		page,
		fixtureAgentId({ ...paidBasicDeployment, id: "hdep_plan_change_pending" }),
		"Basic",
	);
	const pendingChangeCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	const cardCheckChange = pendingChangeCard.getByRole("button", {
		name: "Check subscription change status",
	});
	await expect(cardCheckChange).toBeVisible();
	await cardCheckChange.click();
	await expect(
		page.getByRole("dialog", { name: "Check subscription change status" }),
	).toBeVisible();
	expect(planQuoteRequests).toEqual([]);
	await page.keyboard.press("Escape");
	await expectCardsFit(page.locator("body"));

	await gotoHostedAgentSettings(page, fixtureAgentId(terminalFallbackDeployment), "Basic");
	await gotoSubscriptionAction(page, "start_new");
	const routedCreateDialog = page.getByRole("dialog", { name: "Choose a paid subscription" });
	await expect(routedCreateDialog).toBeVisible();
	await expect.poll(() => new URL(page.url()).searchParams.has("subscription_action")).toBe(false);
	await page.keyboard.press("Escape");
	await expect(routedCreateDialog).toBeHidden();
	const fallbackCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(fallbackCard.getByText("Active", { exact: true })).toHaveAttribute(
		"data-status",
		"success",
	);
	await expect(fallbackCard.getByText("Free", { exact: true })).toBeVisible();
	await expect(fallbackCard.getByRole("button", { name: "Choose a subscription" })).toBeVisible();

	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoHostedAgentSettings(page, fixtureAgentId(includedBasicDeployment), "Basic");
	const includedCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	await expect(includedCard.getByText("Active", { exact: true })).toHaveAttribute(
		"data-status",
		"success",
	);
	await expect(includedCard.getByText("Free", { exact: true })).toBeVisible();
	await expect(includedCard.locator('[data-slot="compute-subscription-identity"]')).toBeEmpty();
	const agentUpgrade = includedCard.getByRole("button", { name: "Upgrade", exact: true });
	await expect(agentUpgrade).toBeEnabled();
	await expect(agentUpgrade.locator("svg.lucide-arrow-up")).toHaveCount(1);
	await expect(includedCard.getByRole("button")).toHaveCount(1);
	const desktopIncludedBox = await includedCard.boundingBox();
	if (!desktopIncludedBox) throw new Error("Included Basic card has no desktop layout box");
	expect(desktopIncludedBox.height).toBeLessThan(160);
	await includedCard.screenshot({ path: testInfo.outputPath("agent-compute-plan-desktop.png") });
	await agentUpgrade.click();
	const agentUpgradeDialog = page.getByRole("dialog", { name: "Change compute subscription" });
	await expect(agentUpgradeDialog).toBeVisible();
	await expect(agentUpgradeDialog.getByLabel("Compute plan")).toHaveText(/Performance/);
	await agentUpgradeDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(agentUpgradeDialog).toBeHidden();
	await expectCardsFit(page.locator("body"));
	await page.setViewportSize({ width: 320, height: 568 });
	await expect(includedCard).toBeVisible();
	await expectCardsFit(page.locator("body"));
	await expectNoHorizontalOverflow(page);
	const mobileIncludedBox = await includedCard.boundingBox();
	if (!mobileIncludedBox) throw new Error("Included Basic card has no mobile layout box");
	expect(mobileIncludedBox.height).toBeLessThan(200);
	await includedCard.screenshot({ path: testInfo.outputPath("agent-compute-plan-mobile-320.png") });

	await gotoHostedAgentSettings(page, fixtureAgentId(ineligibleIncludedDeployment), "Basic");
	const unavailableCard = page
		.locator('[data-slot="compute-subscription-card"]')
		.filter({ hasText: "Basic compute" });
	const unavailableUpgrade = unavailableCard.getByRole("button", {
		name: "Upgrade",
		exact: true,
	});
	await expect(unavailableUpgrade).toBeDisabled();
	await expect(unavailableCard.getByRole("button")).toHaveCount(1);
	await expect(
		unavailableCard.getByText(
			"Wait until this agent is running or stopped before trying to upgrade again.",
			{ exact: true },
		),
	).toBeVisible();
	await unavailableCard.screenshot({
		path: testInfo.outputPath("agent-compute-plan-disabled.png"),
	});
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
				items: [reusableSubscription("csub_card_active")],
				has_more: true,
				next_cursor: "second-page",
			},
			"second-page": {
				items: [
					reusableSubscription("csub_wallet_canceling", {
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
		await expect(sourceDialog.getByRole("button", { name: /^Basic\b/ })).toBeVisible();
		await expect(sourceDialog.getByRole("button", { name: /^Performance\b/ })).toBeVisible();
		return sourceDialog;
	};
	const closeSourceDialog = async () => {
		await page.keyboard.press("Escape");
		await expect(sourceDialog).toBeHidden();
	};
	await page.setViewportSize(desktop);
	await gotoHostedAgentSettings(page, fixtureAgentId(terminalFallbackDeployment), "Basic");
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

	const active = dialog.getByRole("button", { name: /^Basic\b/ });
	const canceling = dialog.getByRole("button", { name: /^Performance\b/ });
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
