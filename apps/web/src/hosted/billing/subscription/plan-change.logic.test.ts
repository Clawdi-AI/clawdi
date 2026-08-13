import { describe, expect, test } from "bun:test";
import { hostedDeploymentFixture } from "../../hosted-deployment.test-fixture";
import type { ComputePlanChangeQuoteResponse, HostedDeployment } from "../contracts";
import { BillingApiError } from "../errors";
import {
	activePlanChangeOperationName,
	defaultPlanChangeSelection,
	isCombinedPaidPlanChange,
	isFundingSourceOnlySelection,
	isSamePlanChangeSelection,
	isValidFundingSourceSwitchQuote,
	isValidPaidPlanChangeQuote,
	isWalletToCardSwitchSelection,
	performanceUpgradeUnavailableReason,
	planChangeNeedsOffer,
	planChangeNeedsWalletBalance,
	planChangeUnavailableReason,
	selectPlanChangeFundingSource,
	selectPlanChangeOffer,
	shouldRecoverWalletToCardSwitch,
	visiblePlanChangeOperationName,
	walletBalanceAfterDebit,
} from "./plan-change.logic";

describe("plan change recovery", () => {
	type AcceptedOperation = NonNullable<HostedDeployment["accepted_operation"]>;
	const acceptedPlanChange: AcceptedOperation = {
		name: "operations/plan-change-pending",
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "dep_test",
			verb: "plan_change",
			targetGeneration: 2,
			manifestETag: "etag_plan_change",
			createTime: "2026-08-11T00:00:00Z",
			updateTime: "2026-08-11T00:00:00Z",
		},
		done: false,
	};
	const recover = (operation: AcceptedOperation) =>
		activePlanChangeOperationName(hostedDeploymentFixture({ acceptedOperation: operation }));

	test("recovers only an active plan change belonging to the projected deployment", () => {
		expect(recover(acceptedPlanChange)).toBe("operations/plan-change-pending");
		expect(recover({ ...acceptedPlanChange, done: true })).toBeNull();
		expect(
			recover({
				...acceptedPlanChange,
				metadata: { ...acceptedPlanChange.metadata, verb: "restart" },
			}),
		).toBeNull();
		expect(
			recover({
				...acceptedPlanChange,
				metadata: { ...acceptedPlanChange.metadata, deploymentId: "dep_other" },
			}),
		).toBeNull();
	});

	test("does not resurrect an explicitly terminated projected operation", () => {
		expect(
			visiblePlanChangeOperationName("operations/plan-change-pending", [
				"operations/plan-change-pending",
			]),
		).toBeNull();
		expect(
			visiblePlanChangeOperationName("operations/plan-change-new", ["operations/plan-change-old"]),
		).toBe("operations/plan-change-new");
	});
});

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
	const fundingSourceSwitchQuote: ComputePlanChangeQuoteResponse = {
		operation_id: "funding-source-switch-1",
		subscription_id: 42,
		funding_source: "wallet",
		current_plan_slug: "compute_performance",
		target_plan_slug: "compute_performance",
		current_billing_term_months: 12,
		target_billing_term_months: 12,
		change_kind: "funding_source_switch",
		billing_effect: "future_renewals",
		status: "quoted",
		effective_at: "2026-08-12T00:00:00Z",
		proration_date: "2026-08-12T00:00:00Z",
		expires_at: "2026-08-12T00:10:00Z",
		amount_cents: 0,
		amount_usd: "0.00",
		currency: "usd",
		stripe_invoice_preview_id: null,
	};
	const fundingSourceSwitchSelection = {
		target_plan_slug: "compute_performance",
		target_billing_term_months: 12,
		funding_source: "wallet",
	} as const;

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

	test("can start a paid-subscription change on the current plan", () => {
		expect(
			defaultPlanChangeSelection("compute_performance", 12, "wallet", "compute_performance"),
		).toEqual({
			target_plan_slug: "compute_performance",
			target_billing_term_months: 12,
			funding_source: "wallet",
		});
	});

	test("requires the plan, term, and funding source to match for a no-op", () => {
		expect(
			isSamePlanChangeSelection(
				{
					target_plan_slug: "compute_performance",
					target_billing_term_months: 12,
					funding_source: "stripe",
				},
				"compute_performance",
				12,
				"stripe",
			),
		).toBe(true);
		expect(
			isSamePlanChangeSelection(
				{
					target_plan_slug: "compute_performance",
					target_billing_term_months: 12,
					funding_source: "wallet",
				},
				"compute_performance",
				12,
				"stripe",
			),
		).toBe(false);
	});

	test("keeps paid offer and funding-source changes mutually exclusive", () => {
		const current = {
			target_plan_slug: "compute_performance",
			target_billing_term_months: 12,
			funding_source: "stripe",
		} as const;
		const railSwitch = selectPlanChangeFundingSource(
			{ ...current, target_plan_slug: "compute_basic", target_billing_term_months: 1 },
			"wallet",
			"compute_performance",
			12,
			false,
		);
		expect(railSwitch).toEqual({
			target_plan_slug: "compute_performance",
			target_billing_term_months: 12,
			funding_source: "wallet",
		});
		expect(planChangeNeedsWalletBalance(railSwitch, "compute_performance", 12)).toBe(false);
		expect(planChangeNeedsOffer(railSwitch, "compute_performance", 12)).toBe(false);

		const offerChange = selectPlanChangeOffer(railSwitch, "compute_basic", 1, "stripe", false);
		expect(offerChange).toEqual({
			target_plan_slug: "compute_basic",
			target_billing_term_months: 1,
			funding_source: "stripe",
		});
		expect(isCombinedPaidPlanChange(offerChange, "compute_performance", 12, "stripe")).toBe(false);
		expect(planChangeNeedsOffer(offerChange, "compute_performance", 12)).toBe(true);
		expect(
			isCombinedPaidPlanChange(
				{ ...offerChange, funding_source: "wallet" },
				"compute_performance",
				12,
				"stripe",
			),
		).toBe(true);
	});

	test("allows a past-due flow to select only a different funding source", () => {
		const railOnly = {
			target_plan_slug: "compute_performance",
			target_billing_term_months: 12,
			funding_source: "wallet",
		} as const;
		expect(isFundingSourceOnlySelection(railOnly, "compute_performance", 12, "stripe")).toBe(true);
		expect(
			isFundingSourceOnlySelection(
				{ ...railOnly, target_plan_slug: "compute_basic" },
				"compute_performance",
				12,
				"stripe",
			),
		).toBe(false);
		expect(
			isFundingSourceOnlySelection(
				{ ...railOnly, funding_source: "stripe" },
				"compute_performance",
				12,
				"stripe",
			),
		).toBe(false);
	});

	test("preserves Included Basic funding selection during its upgrade", () => {
		const selection = selectPlanChangeFundingSource(
			{
				target_plan_slug: "compute_performance",
				target_billing_term_months: 1,
				funding_source: "stripe",
			},
			"wallet",
			"compute_basic",
			1,
			true,
		);
		expect(selection).toEqual({
			target_plan_slug: "compute_performance",
			target_billing_term_months: 1,
			funding_source: "wallet",
		});
		expect(planChangeNeedsWalletBalance(selection, "compute_basic", 1)).toBe(true);
	});

	test("recognizes a rail-only Wallet to Card selection", () => {
		const selection = {
			target_plan_slug: "compute_performance",
			target_billing_term_months: 12,
			funding_source: "stripe",
		} as const;
		expect(isWalletToCardSwitchSelection(selection, "compute_performance", 12, "wallet")).toBe(
			true,
		);
		expect(
			isWalletToCardSwitchSelection(
				{ ...selection, target_billing_term_months: 1 },
				"compute_performance",
				12,
				"wallet",
			),
		).toBe(false);
	});

	test("accepts only the exact zero-due future-renewal rail switch contract", () => {
		expect(
			isValidFundingSourceSwitchQuote(
				fundingSourceSwitchQuote,
				fundingSourceSwitchSelection,
				"compute_performance",
				12,
				"stripe",
			),
		).toBe(true);

		for (const quote of [
			{ ...fundingSourceSwitchQuote, amount_cents: 1 },
			{ ...fundingSourceSwitchQuote, billing_effect: "immediate_proration" as const },
			{ ...fundingSourceSwitchQuote, target_billing_term_months: 1 as const },
		]) {
			expect(
				isValidFundingSourceSwitchQuote(
					quote,
					fundingSourceSwitchSelection,
					"compute_performance",
					12,
					"stripe",
				),
			).toBe(false);
		}
	});

	test("keeps ordinary paid quotes on the selected offer and current payment source", () => {
		const selection = {
			target_plan_slug: "compute_performance",
			target_billing_term_months: 12,
			funding_source: "stripe",
		} as const;
		const quote = {
			...fundingSourceSwitchQuote,
			current_plan_slug: "compute_basic",
			target_plan_slug: "compute_performance",
			current_billing_term_months: 1,
			target_billing_term_months: 12,
			change_kind: "immediate_upgrade",
			billing_effect: "immediate_proration",
			funding_source: "stripe",
			amount_cents: 2_000,
		} as const;

		expect(isValidPaidPlanChangeQuote(quote, selection, "compute_basic", 1, "stripe")).toBe(true);
		expect(
			isValidPaidPlanChangeQuote(
				{ ...quote, funding_source: "wallet" },
				selection,
				"compute_basic",
				1,
				"stripe",
			),
		).toBe(false);
		expect(
			isValidPaidPlanChangeQuote(
				{ ...quote, target_billing_term_months: 1 },
				selection,
				"compute_basic",
				1,
				"stripe",
			),
		).toBe(false);
		expect(
			isValidPaidPlanChangeQuote(
				{ ...quote, billing_effect: "period_end" },
				selection,
				"compute_basic",
				1,
				"stripe",
			),
		).toBe(false);
	});

	test("offers payment-method recovery for the quote-time stable token only", () => {
		const walletToCard = {
			...fundingSourceSwitchSelection,
			funding_source: "stripe",
		} as const;
		expect(
			shouldRecoverWalletToCardSwitch(
				new BillingApiError(409, "payment_method_required"),
				walletToCard,
				"compute_performance",
				12,
				"wallet",
			),
		).toBe(true);
		expect(
			shouldRecoverWalletToCardSwitch(
				new BillingApiError(409, "payment_method_required"),
				{ ...walletToCard, target_billing_term_months: 1 },
				"compute_performance",
				12,
				"wallet",
			),
		).toBe(false);
		expect(
			shouldRecoverWalletToCardSwitch(
				new BillingApiError(409, "operation_aborted"),
				walletToCard,
				"compute_performance",
				12,
				"wallet",
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
				hasSubscriptionTarget: true,
			}),
		).toBe("Subscription changes are temporarily unavailable.");
	});

	test("requires pending cancellation to be resumed first", () => {
		expect(
			planChangeUnavailableReason({
				canCreateCloudAgents: true,
				cancelAtPeriodEnd: true,
				status: "active",
				hasSubscriptionTarget: true,
			}),
		).toBe("Resume this subscription before changing its plan, billing term, or payment source.");
	});

	test("allows active and past-due subscriptions with a server id", () => {
		expect(
			planChangeUnavailableReason({
				canCreateCloudAgents: true,
				cancelAtPeriodEnd: false,
				status: "active",
				hasSubscriptionTarget: true,
			}),
		).toBeNull();
		expect(
			planChangeUnavailableReason({
				canCreateCloudAgents: true,
				cancelAtPeriodEnd: false,
				status: "past_due",
				hasSubscriptionTarget: true,
			}),
		).toBeNull();
		expect(
			planChangeUnavailableReason({
				canCreateCloudAgents: true,
				cancelAtPeriodEnd: false,
				status: "trialing",
				hasSubscriptionTarget: true,
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
				"Clawdi can’t start this upgrade because this agent’s no-cost subscription is not active. You were not charged, and there’s nothing you need to fix. Check again later.",
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
