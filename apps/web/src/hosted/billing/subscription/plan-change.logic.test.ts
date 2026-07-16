import { describe, expect, test } from "bun:test";
import {
	defaultPlanChangeSelection,
	isSamePlanChangeSelection,
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
		expect(defaultPlanChangeSelection("compute_basic", 12)).toEqual({
			planSlug: "compute_performance",
			billingTermMonths: 12,
		});
		expect(defaultPlanChangeSelection("compute_performance", 1)).toEqual({
			planSlug: "compute_basic",
			billingTermMonths: 1,
		});
	});

	test("detects a no-op plan and term selection", () => {
		expect(
			isSamePlanChangeSelection(
				{ planSlug: "compute_performance", billingTermMonths: 12 },
				"compute_performance",
				12,
			),
		).toBe(true);
		expect(
			isSamePlanChangeSelection(
				{ planSlug: "compute_performance", billingTermMonths: 1 },
				"compute_performance",
				12,
			),
		).toBe(false);
	});
});

describe("planChangeUnavailableReason", () => {
	test("fails closed for the rollout gate", () => {
		expect(
			planChangeUnavailableReason({
				canUsePlanCBilling: false,
				cancelAtPeriodEnd: false,
				status: "active",
				subscriptionId: 42,
			}),
		).toContain("rolls out");
	});

	test("requires pending cancellation to be resumed first", () => {
		expect(
			planChangeUnavailableReason({
				canUsePlanCBilling: true,
				cancelAtPeriodEnd: true,
				status: "active",
				subscriptionId: 42,
			}),
		).toBe("Resume this subscription before changing its plan or billing term.");
	});

	test("allows active and trialing subscriptions with a server id", () => {
		for (const status of ["active", "trialing"]) {
			expect(
				planChangeUnavailableReason({
					canUsePlanCBilling: true,
					cancelAtPeriodEnd: false,
					status,
					subscriptionId: 42,
				}),
			).toBeNull();
		}
	});
});
