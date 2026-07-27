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
		expect(walletBalanceAfterDebit("25", "19.000125")).toBe("5.999875");
		expect(walletBalanceAfterDebit("25.5000", "0.5")).toBe("25");
		expect(walletBalanceAfterDebit("0.5", "0.50125")).toBe("-0.00125");
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
		upgradeEligibilityReason: null,
	};

	test("distinguishes each upgrade block from a pending upgrade", () => {
		expect(performanceUpgradeUnavailableReason({ ...available, isIncludedBasic: false })).toBe(
			"This upgrade is only available for Basic agents without a separate subscription. Use this agent’s subscription controls to change its plan.",
		);
		expect(
			performanceUpgradeUnavailableReason({ ...available, performancePlanAvailable: false }),
		).toBe("The Performance plan is unavailable right now. Try again later.");
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
	});

	test("gives every server ineligibility reason its matching next step", () => {
		const cases = [
			[
				"deployment_deleted",
				"This agent has been deleted, so it can’t be upgraded. Create a new agent if you need Performance.",
			],
			[
				"compute_basic_required",
				"Only agents on the Basic plan can be upgraded to Performance. No upgrade is available for this agent’s current plan.",
			],
			[
				"compute_subscription_unavailable",
				"Clawdi couldn’t read this agent’s subscription details, so it can’t safely start an upgrade. Check again in a moment.",
			],
			[
				"included_basic_required",
				"This agent’s subscription is managed separately, so it can’t be upgraded here. Use the subscription controls to change its plan instead.",
			],
			[
				"compute_subscription_not_active",
				"This agent’s subscription is not active, so Clawdi can’t start the upgrade. Resolve the subscription status, then try again.",
			],
			[
				"compute_subscription_canceling",
				"This agent’s subscription is set to cancel, so it can’t be upgraded. Resume the subscription first, then try again.",
			],
			[
				"deployment_state_unknown",
				"Clawdi couldn’t read this agent’s current state. Check again before trying to upgrade.",
			],
			[
				"deployment_must_be_running_or_stopped",
				"Wait until this agent is running or stopped before trying to upgrade again.",
			],
			[
				"upgrade_already_in_progress",
				"An upgrade to Performance is already in progress. Wait for it to finish; there is no second upgrade to start.",
			],
		] as const;

		for (const [upgradeEligibilityReason, expected] of cases) {
			expect(
				performanceUpgradeUnavailableReason({
					...available,
					upgradeAvailable: false,
					upgradeEligibilityReason,
				}),
			).toBe(expected);
		}
	});

	test("renders an honest fallback for an absent or unrecognised reason", () => {
		const expected =
			"Clawdi can’t confirm why this agent can’t be upgraded right now. Check again later, or contact support if this continues.";
		for (const upgradeEligibilityReason of [null, "new_server_reason"]) {
			expect(
				performanceUpgradeUnavailableReason({
					...available,
					upgradeAvailable: false,
					upgradeEligibilityReason,
				}),
			).toBe(expected);
		}
	});

	test("returns no reason only when every upgrade condition is met", () => {
		expect(performanceUpgradeUnavailableReason(available)).toBeNull();
	});
});
