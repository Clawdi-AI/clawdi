import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReusableSubscription } from "@/hosted/billing/contracts";
import { SubscriptionSourcePicker } from "@/hosted/billing/subscription/subscription-source-picker";

const reusableSubscription: ReusableSubscription = {
	subscription_id: "csub_reusable",
	plan_slug: "compute_basic",
	billing_term_months: 1,
	funding_source: "wallet",
	status: "active",
	currency: "usd",
	price_cents: 1_000,
	current_period_end: "2026-09-17T00:00:00Z",
	entitled_until: "2026-09-17T00:00:00Z",
	cancel_at_period_end: false,
};

describe("SubscriptionSourcePicker", () => {
	test("renders the selected reusable subscription and included option", () => {
		const markup = renderToStaticMarkup(
			<SubscriptionSourcePicker
				value={{ mode: "existing", subscriptionId: reusableSubscription.subscription_id }}
				onChange={() => undefined}
				reusableSubscriptions={[reusableSubscription]}
				isLoading={false}
				error={null}
				onRetry={() => undefined}
				showIncluded
			/>,
		);

		expect(markup).toContain('aria-pressed="true"');
		expect(markup).toContain("Plan price");
		expect(markup).toContain("Included");
	});

	test("shows store subscriptions as unavailable on Web without card or price details", () => {
		const storeSubscription: ReusableSubscription = {
			...reusableSubscription,
			subscription_id: "csub_store",
			funding_source: "store",
			price_cents: null,
			store_management: {
				contract_id: "11111111-1111-4111-8111-111111111111",
				provider: "play_store",
				product_id: "ai.clawdi.app.compute.basic.monthly",
				management_url: null,
				auto_renews: true,
				renews_or_ends_at: "2026-10-17T00:00:00Z",
				state: "grace",
			},
		};
		const markup = renderToStaticMarkup(
			<SubscriptionSourcePicker
				value={null}
				onChange={() => undefined}
				reusableSubscriptions={[storeSubscription]}
				isLoading={false}
				error={null}
				onRetry={() => undefined}
			/>,
		);

		expect(markup).toContain("Available in the Clawdi app");
		expect(markup).toContain("Google Play");
		expect(markup).toContain("Grace period");
		// Disabled choices render without a button; only "New paid subscription" is selectable.
		expect(markup.match(/<button/g)).toHaveLength(1);
		expect(markup).toContain("pointer-events-none opacity-60");
		expect(markup).not.toContain("Card");
		expect(markup).not.toContain("Plan price");
		expect(markup).not.toContain("$0 due now");
	});
});
