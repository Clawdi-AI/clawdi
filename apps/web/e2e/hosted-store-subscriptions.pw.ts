import type { DeployComponents } from "@clawdi/shared/api";
import { expect, test } from "@playwright/test";
import {
	appStoreManagement,
	basicPlan,
	collectBrowserErrors,
	fixtureAgentId,
	gotoHostedAgentSettings,
	gotoHostedSettingsDialog,
	performancePlan,
	storeEndedDeployment,
	storeFundedDeployment,
	stubHostedApi,
} from "./hosted-stub-api";

type Subscription = DeployComponents["schemas"]["V2ComputeSubscriptionListItem"];
type ReusableSubscription = DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"];
type StoreManagement = DeployComponents["schemas"]["StoreManagement"];

function storeSubscription(
	subscriptionId: string,
	management: Partial<StoreManagement>,
	overrides: Partial<Subscription> = {},
): Subscription {
	return {
		subscription_id: subscriptionId,
		subscription_kind: "paid",
		plan_slug: "compute_performance",
		funding_source: "store",
		status: "active",
		actions: { cancel: null, resume: false, command_state: null },
		price_cents: null,
		currency: "usd",
		billing_term_months: 1,
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
		store_management: { ...appStoreManagement, ...management },
		...overrides,
	};
}

const storeSubscriptionPages = {
	initial: {
		items: [
			storeSubscription(
				"store_active",
				{},
				{ deployment_id: storeFundedDeployment.id, agent_name: storeFundedDeployment.name },
			),
			storeSubscription(
				"store_grace",
				{ provider: "play_store", management_url: null, state: "grace" },
				{
					plan_slug: "compute_basic",
					billing_term_months: 12,
					status: "past_due",
					payment_state: "past_due",
					recovery_action: "manage_store_subscription",
					agent_name: "Google Play agent",
				},
			),
			storeSubscription(
				"store_canceling",
				{ state: "canceled_pending_end", auto_renews: false },
				{ status: "canceling", agent_name: "Canceling store agent" },
			),
			storeSubscription(
				"store_test",
				{ provider: "test_store", management_url: null },
				{ plan_slug: "compute_basic", agent_name: "Test Store agent" },
			),
		],
		has_more: false,
		next_cursor: null,
	},
};

const storeReusableSubscriptionPages = {
	initial: {
		items: [
			{
				subscription_id: "csub_store_slot",
				plan_slug: "compute_basic",
				billing_term_months: 1,
				funding_source: "store",
				status: "active",
				price_cents: null,
				currency: "usd",
				current_period_end: "2099-09-12T12:00:00Z",
				entitled_until: "2099-09-12T12:00:00Z",
				cancel_at_period_end: false,
				store_management: {
					...appStoreManagement,
					provider: "play_store",
					product_id: "ai.clawdi.app.compute.basic.monthly",
					management_url: null,
					renews_or_ends_at: "2099-09-12T12:00:00Z",
				},
			},
			{
				subscription_id: "csub_card_slot",
				plan_slug: "compute_performance",
				billing_term_months: 1,
				funding_source: "stripe",
				status: "active",
				price_cents: 1_900,
				currency: "usd",
				current_period_end: "2099-09-12T12:00:00Z",
				entitled_until: "2099-09-12T12:00:00Z",
				cancel_at_period_end: false,
			},
		] satisfies ReusableSubscription[],
		has_more: false,
		next_cursor: null,
	},
};

test("store-funded subscriptions are read-only and name the billing store", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planCMutationRequests: string[] = [];
	await page.setViewportSize({ width: 1440, height: 900 });
	await stubHostedApi(page, {
		deployments: [storeFundedDeployment],
		plans: [basicPlan, performancePlan],
		planCMutationRequests,
		subscriptionPages: storeSubscriptionPages,
	});
	const dialog = await gotoHostedSettingsDialog(page, "billing-plan");
	const cards = dialog.locator('[data-slot="compute-subscription-card"]');
	await expect(cards).toHaveCount(4);

	const card = (agentName: string) => cards.filter({ hasText: agentName });
	const appStore = card(storeFundedDeployment.name);
	await expect(appStore).toContainText("Active");
	await expect(appStore).toContainText("App Store");
	await expect(appStore).toContainText("Renews Aug 12, 2099");
	await expect(appStore).toContainText("Billed through the App Store. Manage it on your device.");
	const grace = card("Google Play agent");
	await expect(grace).toContainText("Grace period");
	await expect(grace).toContainText("Google Play");
	await expect(grace).toContainText("Annual");
	await expect(grace).toContainText("Update the payment method on your device");
	const canceling = card("Canceling store agent");
	await expect(canceling).toContainText("Canceling");
	await expect(canceling).toContainText("Ends Aug 12, 2099");
	const testStore = card("Test Store agent");
	await expect(testStore).toContainText("Test Store");
	await expect(testStore).toContainText("Billed through Test Store.");

	for (const storeCard of await cards.all()) {
		await expect(storeCard.getByRole("button")).toHaveCount(0);
		await expect(storeCard.locator('a[href^="http"]')).toHaveCount(0);
		await expect(storeCard).not.toContainText(/Card|Past due|Fix payment|Top up|Retries/);
	}
	expect(planCMutationRequests).toEqual([]);
	expect(errors).toEqual([]);
});

test("store-funded Agent shows store billing and deletion keeps the store subscription", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const deleteRequests: unknown[] = [];
	await page.setViewportSize({ width: 1440, height: 900 });
	await stubHostedApi(page, {
		deployments: [storeFundedDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.route(`**/v2/deployments/${storeFundedDeployment.id}`, async (route) => {
		if (route.request().method() !== "DELETE") return route.fallback();
		deleteRequests.push(route.request().postDataJSON());
		await route.fulfill({ json: { deployment_id: storeFundedDeployment.id, status: "absent" } });
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(storeFundedDeployment), "Performance");

	const computeCard = page.locator('[data-slot="compute-subscription-card"]').first();
	await expect(computeCard).toContainText("App Store");
	await expect(computeCard).toContainText(
		"Billed through the App Store. Manage it on your device.",
	);
	await expect(page.locator("#compute-plan-controls").getByRole("button")).toHaveCount(0);

	await page.getByRole("button", { name: "Delete", exact: true }).click();
	const deleteDialog = page.getByRole("alertdialog");
	await expect(deleteDialog).toContainText(
		"Deleting this agent doesn't cancel your App Store subscription. Manage it on your device.",
	);
	await expect(deleteDialog.getByRole("radio")).toHaveCount(0);
	await expect(deleteDialog).not.toContainText(/cancel subscription/i);
	await deleteDialog.getByRole("button", { name: "Delete agent", exact: true }).click();
	await expect.poll(() => deleteRequests).toEqual([{ subscription_choice: "keep_subscription" }]);
	expect(errors).toEqual([]);
});

test("an ended store Agent can choose card or Wallet funding; store slots stay in the app", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await stubHostedApi(page, {
		deployments: [storeEndedDeployment],
		plans: [basicPlan, performancePlan],
		reusableSubscriptionPages: storeReusableSubscriptionPages,
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(storeEndedDeployment), "Performance");
	const controls = page.locator("#compute-plan-controls");
	await expect(page.locator('[data-slot="compute-subscription-card"]').first()).toContainText(
		"Expired",
	);
	await controls.getByRole("button", { name: "Choose a subscription" }).click();

	const sourceDialog = page.getByRole("dialog", { name: "Choose a paid subscription" });
	await expect(sourceDialog).toBeVisible();
	await expect(sourceDialog).toContainText("Available in the Clawdi app");
	await expect(sourceDialog).toContainText("Google Play");
	await expect(sourceDialog.getByRole("button", { name: /^Basic\b/ })).toHaveCount(0);
	await expect(sourceDialog.getByRole("button", { name: /^Performance\b/ })).toBeEnabled();
	await expect(sourceDialog.getByRole("button", { name: /^New paid subscription/ })).toBeEnabled();
	expect(errors).toEqual([]);
});
