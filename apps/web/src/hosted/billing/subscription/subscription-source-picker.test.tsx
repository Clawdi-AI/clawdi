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
	test("keeps reusable compute compact and readable at card-local breakpoints", () => {
		const markup = renderToStaticMarkup(
			<SubscriptionSourcePicker
				value={{ mode: "existing", subscriptionId: reusableSubscription.subscription_id }}
				onChange={() => undefined}
				reusableSubscriptions={[reusableSubscription]}
				isLoading={false}
				error={null}
				onRetry={() => undefined}
			/>,
		);

		expect(markup).toContain("@container/subscription-source");
		expect(markup).toContain("items-start gap-2 @3xl/subscription-source:grid-cols-2");
		expect(markup).toContain("@container/choice");
		expect(markup).toContain("@md/choice:flex-row");
		expect(markup).toContain('aria-pressed="true"');
		expect(markup).toContain("Basic subscription");
		expect(markup).toContain("Plan price");
	});
});
