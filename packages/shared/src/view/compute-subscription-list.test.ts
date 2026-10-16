import { describe, expect, test } from "bun:test";
import type { DeployComponents } from "../api";
import {
	computeSubscriptionAssignment,
	computeSubscriptionIdentity,
	reusableInventoryState,
	sortLoadedSubscriptions,
} from "./compute-subscriptions";

type ComputeSubscriptionListItem = DeployComponents["schemas"]["V2ComputeSubscriptionListItem"];

function subscription(
	subscriptionId: string,
	status: ComputeSubscriptionListItem["status"],
): ComputeSubscriptionListItem {
	return {
		subscription_id: subscriptionId,
		subscription_kind: "paid",
		plan_slug: "compute_basic",
		funding_source: "stripe",
		status,
		currency: "usd",
		billing_term_months: 1,
		cancel_at_period_end: status === "canceling",
		deployment_id: `hdep_${subscriptionId}`,
		agent_name: subscriptionId,
		is_orphan: false,
		payment_state: "ok",
		latest_failed_invoice_hosted_url: null,
		next_payment_attempt_at: null,
		recovery_action: null,
		pending_plan_slug: null,
	};
}

describe("Compute subscription list", () => {
	test("waits for canonical availability and only blocks errors without cached data", () => {
		expect([
			reusableInventoryState(null, undefined),
			reusableInventoryState(new Error("offline"), undefined),
			reusableInventoryState(null, []),
			reusableInventoryState(new Error("background refresh failed"), []),
		]).toEqual(["loading", "error", "ready", "ready"]);
	});

	test("lets canonical reusable inventory override stale deployment and orphan projections", () => {
		const staleAssigned = subscription("reusable", "active");
		const staleOrphan = {
			...subscription("orphan", "active"),
			deployment_id: null,
			is_orphan: true,
		};

		expect(
			computeSubscriptionAssignment(staleAssigned, new Set([staleAssigned.subscription_id])),
		).toBe("available");
		expect(computeSubscriptionAssignment(staleOrphan, new Set([staleOrphan.subscription_id]))).toBe(
			"available",
		);
		const staleIncluded = {
			...staleOrphan,
			subscription_kind: "included_basic" as const,
			funding_source: null,
		};
		expect(
			computeSubscriptionAssignment(staleIncluded, new Set([staleIncluded.subscription_id])),
		).toBe("unavailable");
		expect(computeSubscriptionAssignment(staleAssigned, new Set())).toBe("assigned");
		expect(computeSubscriptionAssignment(staleOrphan, new Set())).toBe("unavailable");

		expect(computeSubscriptionIdentity(staleAssigned, "assigned", undefined, null)).toMatchObject({
			kind: "agent",
			name: "reusable",
		});
		expect(
			computeSubscriptionIdentity(staleOrphan, "unavailable", undefined, null, true),
		).toBeUndefined();
		expect(computeSubscriptionIdentity(staleOrphan, "unavailable", undefined, null)).toEqual({
			kind: "unavailable",
			label: "Deleted agent",
		});
		expect(
			computeSubscriptionIdentity(staleIncluded, "unavailable", undefined, null),
		).toBeUndefined();
	});

	test("stably prioritizes loaded current subscriptions without mutating query data", () => {
		const loaded = [
			subscription("canceled", "canceled"),
			subscription("canceling-first", "canceling"),
			subscription("active-first", "active"),
			subscription("past-due", "past_due"),
			subscription("active-second", "active"),
			subscription("canceling-second", "canceling"),
		];

		expect(sortLoadedSubscriptions(loaded).map((item) => item.subscription_id)).toEqual([
			"active-first",
			"active-second",
			"past-due",
			"canceling-first",
			"canceling-second",
			"canceled",
		]);
		expect(loaded.map((item) => item.subscription_id)).toEqual([
			"canceled",
			"canceling-first",
			"active-first",
			"past-due",
			"active-second",
			"canceling-second",
		]);
	});
});
