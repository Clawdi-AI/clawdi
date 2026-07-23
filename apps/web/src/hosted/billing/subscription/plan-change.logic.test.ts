import { describe, expect, test } from "bun:test";
import {
	defaultPlanChangeSelection,
	isSamePlanChangeSelection,
	performanceUpgradeUnavailableReason,
	planChangeUnavailableReason,
	walletBalanceAfterDebit,
} from "./plan-change.logic";

describe("walletBalanceAfterDebit", () => {
	test("preserves the exact quoted decimal debit", () => {
		expect(walletBalanceAfterDebit("25000", "19000.125")).toBe("5999.875");
		expect(walletBalanceAfterDebit("25000.5000", "0.5")).toBe("25000");
		expect(walletBalanceAfterDebit("500", "501.25")).toBe("-1.25");
	});

	test("rejects malformed or signed contract values", () => {
		expect(walletBalanceAfterDebit("1e6", "500")).toBeNull();
		expect(walletBalanceAfterDebit("1000", "-1")).toBeNull();
	});
});

describe("plan change selection", () => {
	test("defaults to the other compute tier while preserving the term", () => {
		expect(defaultPlanChangeSelection("compute_basic", 12, "wallet")).toEqual({
			target_plan_slug: "compute_performance",
			target_billing_term_months: 12,
			funding_source: "wallet",
		});
		expect(defaultPlanChangeSelection("compute_performance", 1, "stripe")).toEqual({
			target_plan_slug: "compute_basic",
			target_billing_term_months: 1,
			funding_source: "stripe",
		});
	});

	test("detects a no-op plan and term selection", () => {
		expect(
			isSamePlanChangeSelection(
				{
					target_plan_slug: "compute_performance",
					target_billing_term_months: 12,
					funding_source: "stripe",
				},
				"compute_performance",
				12,
			),
		).toBe(true);
		expect(
			isSamePlanChangeSelection(
				{
					target_plan_slug: "compute_performance",
					target_billing_term_months: 1,
					funding_source: "stripe",
				},
				"compute_performance",
				12,
			),
		).toBe(false);
	});
});

describe("planChangeUnavailableReason", () => {
	test("fails closed with a temporary unavailability reason", () => {
		expect(
			planChangeUnavailableReason({
				canCreateCloudAgents: false,
				cancelAtPeriodEnd: false,
				status: "active",
				subscriptionId: 42,
			}),
		).toBe("Plan changes are temporarily unavailable.");
	});

	test("requires pending cancellation to be resumed first", () => {
		expect(
			planChangeUnavailableReason({
				canCreateCloudAgents: true,
				cancelAtPeriodEnd: true,
				status: "active",
				subscriptionId: 42,
			}),
		).toBe("Resume this subscription before changing its plan or billing term.");
	});

	test("allows only active subscriptions with a server id", () => {
		expect(
			planChangeUnavailableReason({
				canCreateCloudAgents: true,
				cancelAtPeriodEnd: false,
				status: "active",
				subscriptionId: 42,
			}),
		).toBeNull();
		expect(
			planChangeUnavailableReason({
				canCreateCloudAgents: true,
				cancelAtPeriodEnd: false,
				status: "trialing",
				subscriptionId: 42,
			}),
		).toContain("Resolve the subscription status");
	});
});

describe("performanceUpgradeUnavailableReason", () => {
	const available = {
		plansLoading: false,
		canCreateCloudAgents: true,
		isIncludedBasic: true,
		performancePlanAvailable: true,
		pendingPlanSlug: null,
		planChangeUnavailable: null,
		deploymentStatusSupportsUpgrade: true,
		upgradeAvailable: true,
	};

	test("distinguishes each upgrade block from a pending upgrade", () => {
		expect(performanceUpgradeUnavailableReason({ ...available, isIncludedBasic: false })).toContain(
			"only available for included Basic",
		);
		expect(
			performanceUpgradeUnavailableReason({ ...available, performancePlanAvailable: false }),
		).toBe("Performance compute is unavailable right now.");
		expect(
			performanceUpgradeUnavailableReason({
				...available,
				planChangeUnavailable: "Subscription details are still syncing.",
			}),
		).toBe("Subscription details are still syncing.");
		expect(
			performanceUpgradeUnavailableReason({
				...available,
				pendingPlanSlug: "compute_performance",
			}),
		).toBe("An upgrade to Performance is already scheduled.");
		expect(performanceUpgradeUnavailableReason({ ...available, upgradeAvailable: false })).toBe(
			"This Basic agent is not currently eligible for an upgrade.",
		);
	});

	test("returns no reason only when every upgrade condition is met", () => {
		expect(performanceUpgradeUnavailableReason(available)).toBeNull();
	});
});
