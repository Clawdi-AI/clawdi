import { beforeAll, describe, expect, test } from "bun:test";
import type { StoreManagement } from "@clawdi/shared/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComputeSubscriptionListItem } from "@/hosted/billing/contracts";

type SubscriptionsSectionModule =
	typeof import("@/hosted/billing/subscription/subscriptions-section");

let SubscriptionRow: SubscriptionsSectionModule["SubscriptionRow"] | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	process.env.VITE_DEV_AUTH_BYPASS = "true";
	({ SubscriptionRow } = await import("@/hosted/billing/subscription/subscriptions-section"));
});

const STRIPE_COPY = ["Fix payment", "Top up", "Card", "Retries", "Past due"];

function management(overrides: Partial<StoreManagement> = {}): StoreManagement {
	return {
		provider: "app_store",
		product_id: "ai.clawdi.app.compute.performance.monthly",
		management_url: "https://apps.apple.com/account/subscriptions",
		auto_renews: true,
		renews_or_ends_at: "2026-11-07T12:00:00Z",
		state: "active",
		...overrides,
	};
}

function storeRow(
	overrides: Partial<ComputeSubscriptionListItem> = {},
): ComputeSubscriptionListItem {
	return {
		subscription_id: "csub_store",
		subscription_kind: "paid",
		plan_slug: "compute_performance",
		funding_source: "store",
		status: "active",
		price_cents: null,
		currency: "usd",
		billing_term_months: 1,
		current_period_end: "2026-11-07T12:00:00Z",
		cancel_at_period_end: false,
		deployment_id: "hdep_store",
		agent_name: "Store agent",
		is_orphan: false,
		payment_state: "ok",
		latest_failed_invoice_hosted_url: null,
		next_payment_attempt_at: null,
		recovery_action: null,
		pending_plan_slug: null,
		actions: { cancel: null, resume: false, command_state: null },
		store_management: management(),
		...overrides,
	};
}

function render(subscription: ComputeSubscriptionListItem): string {
	if (!SubscriptionRow) throw new Error("Subscriptions section was not loaded");
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<SubscriptionRow
				subscription={subscription}
				management={{ action: "hidden", target: null, unavailableReason: null }}
				onPlanChange={() => {
					throw new Error("Store rows must not open plan changes");
				}}
				reusableSubscriptionIds={new Set()}
				reusableInventoryUncertain={false}
			/>
		</QueryClientProvider>,
	);
}

function buttonLabels(markup: string): string[] {
	return [...markup.matchAll(/<(?:button|a)\b[^>]*>(.*?)<\/(?:button|a)>/g)].map((match) =>
		(match[1] ?? "").replace(/<[^>]+>/g, "").trim(),
	);
}

describe("store-funded subscription rows", () => {
	test("render each store state read-only with the store billing notice", () => {
		const cases = [
			[{ state: "active" }, { status: "active" }, "Active"],
			[
				{ state: "grace" },
				{
					status: "past_due",
					payment_state: "past_due",
					recovery_action: "manage_store_subscription",
				},
				"Grace period",
			],
			[
				{ state: "lapsed" },
				{
					status: "past_due",
					payment_state: "past_due",
					recovery_action: "manage_store_subscription",
				},
				"Billing issue",
			],
			[
				{ state: "paused" },
				{ status: "past_due", recovery_action: "manage_store_subscription" },
				"Paused",
			],
			[{ state: "canceled_pending_end", auto_renews: false }, { status: "canceling" }, "Canceling"],
			[{ state: "expired" }, { status: "canceled" }, "Expired"],
		] as const;
		for (const [store, row, label] of cases) {
			const markup = render(storeRow({ ...row, store_management: management(store) }));
			expect(markup).toContain(label);
			expect(markup).toContain("App Store");
			expect(markup).toContain("Billed through the App Store. Manage it on your device.");
			expect(markup).not.toContain("apps.apple.com");
			for (const stripeCopy of STRIPE_COPY) expect(markup).not.toContain(stripeCopy);
			expect(buttonLabels(markup)).toEqual([]);
		}
	});

	test("explains store renewal failures without card recovery", () => {
		const markup = render(
			storeRow({
				status: "past_due",
				payment_state: "past_due",
				recovery_action: "manage_store_subscription",
				latest_failed_invoice_hosted_url: "https://invoice.stripe.com/should-not-render",
				store_management: management({ provider: "play_store", state: "lapsed" }),
			}),
		);
		expect(markup).toContain("Google Play");
		expect(markup).toContain("Billed through Google Play. Manage it on your device.");
		expect(markup).toContain("Update the payment method on your device");
		expect(markup).not.toContain("invoice.stripe.com");
		expect(markup).not.toContain("Past due");
	});

	test("labels Test Store rows without a management link", () => {
		const markup = render(
			storeRow({ store_management: management({ provider: "test_store", management_url: null }) }),
		);
		expect(markup).toContain("Test Store");
		expect(markup).toContain("Billed through Test Store.");
		expect(markup).not.toContain("Manage it on your device");
		expect(markup).not.toContain('href="http');
	});

	test("keeps an ended store row free of card recovery", () => {
		const markup = render(
			storeRow({
				status: "canceled",
				recovery_action: "start_new",
				store_management: management({ state: "expired", auto_renews: false }),
			}),
		);
		expect(markup).toContain("Expired");
		expect(markup).toContain("Ended ");
		expect(buttonLabels(markup)).toEqual([]);
	});

	test("never presents an unknown funding source as Card", () => {
		const markup = render(
			storeRow({ funding_source: null, store_management: null, price_cents: null }),
		);
		expect(markup).not.toContain("Card");
	});
});
