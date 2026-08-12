import { describe, expect, test } from "bun:test";
import type { BillingClient } from "@/hosted/billing/billing-client";
import type { ReusableSubscription } from "@/hosted/billing/contracts";
import { loadReusableSubscriptions } from "./reusable-subscriptions-query";

function reusable(subscriptionId: string): ReusableSubscription {
	return {
		subscription_id: subscriptionId,
		plan_slug: "compute_basic",
		billing_term_months: 1,
		funding_source: "stripe",
		status: "active",
		currency: "usd",
		entitled_until: "2027-01-01T00:00:00Z",
		cancel_at_period_end: false,
	};
}

describe("reusable subscription pagination", () => {
	test("loads every page in stable cursor order before returning candidates", async () => {
		const cursors: Array<string | null | undefined> = [];
		const pages = [
			{ items: [reusable("csub_one")], has_more: true, next_cursor: "cursor-2" },
			{ items: [reusable("csub_two")], has_more: true, next_cursor: "cursor-3" },
			{ items: [reusable("csub_three")], has_more: false, next_cursor: null },
		];
		const getPage: BillingClient["getReusableSubscriptions"] = async (_limit, cursor) => {
			cursors.push(cursor);
			const page = pages.shift();
			if (!page) throw new Error("Unexpected page request");
			return page;
		};

		await expect(loadReusableSubscriptions(getPage)).resolves.toEqual([
			reusable("csub_one"),
			reusable("csub_two"),
			reusable("csub_three"),
		]);
		expect(cursors).toEqual([undefined, "cursor-2", "cursor-3"]);
	});

	test("rejects the whole load when a later page fails or repeats a cursor", async () => {
		let page = 0;
		const laterFailure: BillingClient["getReusableSubscriptions"] = async () => {
			page += 1;
			if (page === 1) {
				return { items: [reusable("csub_partial")], has_more: true, next_cursor: "next" };
			}
			throw new Error("page failed");
		};
		await expect(loadReusableSubscriptions(laterFailure)).rejects.toThrow("page failed");

		const repeatedCursor: BillingClient["getReusableSubscriptions"] = async () => ({
			items: [],
			has_more: true,
			next_cursor: "same",
		});
		await expect(loadReusableSubscriptions(repeatedCursor)).rejects.toThrow("invalid cursor");
	});
});
