import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComputeSubscriptionListItem } from "@/hosted/billing/contracts";

type NoticeModule = typeof import("@/hosted/account/account-deletion-store-notice");

let module: NoticeModule | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	module = await import("@/hosted/account/account-deletion-store-notice");
});

function loaded(): NoticeModule {
	if (!module) throw new Error("Account deletion notice was not loaded");
	return module;
}

function row(overrides: Partial<ComputeSubscriptionListItem> = {}): ComputeSubscriptionListItem {
	return {
		subscription_id: "csub_card",
		subscription_kind: "paid",
		plan_slug: "compute_basic",
		funding_source: "stripe",
		status: "active",
		currency: "usd",
		billing_term_months: 1,
		cancel_at_period_end: false,
		deployment_id: "hdep_card",
		agent_name: "Agent",
		is_orphan: false,
		payment_state: "ok",
		latest_failed_invoice_hosted_url: null,
		next_payment_attempt_at: null,
		recovery_action: null,
		pending_plan_slug: null,
		...overrides,
	};
}

const appStoreRow = row({
	subscription_id: "csub_store",
	funding_source: "store",
	price_cents: null,
	store_management: {
		contract_id: "11111111-1111-4111-8111-111111111111",
		provider: "app_store",
		product_id: "ai.clawdi.app.compute.basic.monthly",
		management_url: "https://apps.apple.com/account/subscriptions",
		auto_renews: true,
		renews_or_ends_at: "2026-11-07T00:00:00Z",
		state: "active",
	},
});

function noticeFor(
	data: { pages: { items: ComputeSubscriptionListItem[] }[] } | undefined,
	{ hasNextPage = false, isFetchNextPageError = false } = {},
) {
	const { accountDeletionNoticeFromSubscriptions, AccountDeletionStoreNoticeAlert } = loaded();
	const notice = accountDeletionNoticeFromSubscriptions({
		data,
		hasNextPage,
		isFetchNextPageError,
	});
	return {
		notice,
		markup: renderToStaticMarkup(<AccountDeletionStoreNoticeAlert notice={notice} />),
	};
}

describe("account deletion store notice", () => {
	test("names the billing store of a renewable store subscription without a store link", () => {
		const { notice, markup } = noticeFor({ pages: [{ items: [row(), appStoreRow] }] });
		expect(notice).toEqual({ kind: "store", provider: "app_store" });
		expect(markup).toContain("Cancel your App Store subscription first");
		expect(markup).toContain("billed by the App Store and will keep renewing");
		expect(markup).not.toContain("Google Play");
		expect(markup).not.toContain("<a");
		expect(markup).not.toContain("apps.apple.com");
	});

	test("shows no store notice when no subscription is store-billed", () => {
		const ended = row({
			...appStoreRow,
			status: "canceled",
			store_management: appStoreRow.store_management
				? { ...appStoreRow.store_management, state: "expired", auto_renews: false }
				: null,
		});
		for (const items of [[], [row()], [row(), ended]]) {
			const { notice, markup } = noticeFor({ pages: [{ items }] });
			expect(notice).toEqual({ kind: "none" });
			expect(markup).toBe("");
		}
	});

	test("keeps the generic store notice when subscriptions cannot be loaded completely", () => {
		for (const { notice, markup } of [
			noticeFor(undefined),
			noticeFor({ pages: [{ items: [row()] }] }, { hasNextPage: true }),
			noticeFor({ pages: [{ items: [row()] }] }, { isFetchNextPageError: true }),
		]) {
			expect(notice).toEqual({ kind: "generic" });
			expect(markup).toContain("Cancel App Store or Google Play subscriptions first");
			expect(markup).not.toContain("<a");
		}
	});
});
