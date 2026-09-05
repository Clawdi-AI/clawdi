import { describe, expect, test } from "bun:test";
import type {
	ComputePlanSlug,
	HostedComputeSubscription,
	HostedDeploymentStatus,
	HostedFundingFact,
} from "@/hosted/billing/contracts";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	computeDunningState,
	computeSubscriptionRequiredToStart,
	fallbackReasonSentence,
} from "./compute-dunning.logic";

function deployment({
	computeSubscription = null,
	currentPlanSlug = "compute_basic",
	factKind,
	fundingSource = "stripe",
	reason = "payment_failure",
	priorPlanSlug = "compute_performance",
	status = "running",
}: {
	computeSubscription?: HostedComputeSubscription | null;
	currentPlanSlug?: ComputePlanSlug;
	factKind?: HostedFundingFact["fact_kind"];
	fundingSource?: NonNullable<HostedFundingFact["funding_source"]>;
	reason?: NonNullable<HostedFundingFact["reason"]>;
	priorPlanSlug?: ComputePlanSlug;
	status?: HostedDeploymentStatus["summary_state"] | null;
} = {}) {
	return hostedDeploymentFixture({
		status,
		currentPlanSlug,
		computeSubscription,
		recoveryAction: factKind === "funding_revoked" ? "start_new" : null,
		fundingFact: factKind
			? {
					fact_kind: factKind,
					commercial_revision: 2,
					compute_plan_slug: factKind === "funding_ready" ? currentPlanSlug : null,
					funding_source: factKind === "funding_revoked" ? fundingSource : null,
					reason: factKind === "funding_revoked" ? reason : null,
					prior_plan_slug: factKind === "funding_revoked" ? priorPlanSlug : null,
					occurred_at: "2026-07-18T12:00:00Z",
					emitted_at: "2026-07-18T12:05:00Z",
				}
			: null,
	});
}

function subscription(
	overrides: Partial<HostedComputeSubscription> = {},
): HostedComputeSubscription {
	return {
		status: "active",
		funding_source: "stripe",
		payment_state: "ok",
		billing_term_months: 1,
		price_cents: 1_900,
		currency: "usd",
		cancel_at_period_end: false,
		current_period_end: "2026-08-01T00:00:00Z",
		cancel_at: null,
		canceled_at: null,
		latest_failed_invoice_id: null,
		latest_failed_invoice_hosted_url: null,
		...overrides,
	};
}

function includedSubscription(): HostedComputeSubscription {
	return subscription({
		subscription_id: 7,
		funding_source: null,
		price_cents: 0,
	});
}

describe("computeDunningState", () => {
	test("returns null without an active billing problem", () => {
		expect(computeDunningState(deployment())).toBeNull();
		expect(computeDunningState(deployment({ computeSubscription: subscription() }))).toBeNull();
	});

	test("routes wallet past due to top-up without a local retry ladder", () => {
		const state = computeDunningState(
			deployment({
				computeSubscription: subscription({
					status: "past_due",
					funding_source: "wallet",
					payment_state: "past_due",
					recovery_action: "top_up",
				}),
				currentPlanSlug: "compute_performance",
			}),
		);

		expect(state).toMatchObject({
			fundingSource: "wallet",
			recoveryTarget: { kind: "top_up", action: "top_up" },
		});
		expect(state?.description).toContain("update automatically");
		expect(state?.description).not.toMatch(/grace|retry/i);
		expect(state).not.toHaveProperty("serviceRiskAt");
		expect(state).not.toHaveProperty("failureCode");
	});

	test("routes card past due to payment remediation", () => {
		const deploymentWithPastDueCard = deployment({
			computeSubscription: subscription({
				status: "past_due",
				payment_state: "past_due",
				recovery_action: "fix_payment",
			}),
			factKind: "funding_revoked",
		});
		expect(computeDunningState(deploymentWithPastDueCard)).toMatchObject({
			fundingSource: "stripe",
			recoveryTarget: { kind: "fix_payment", action: "fix_payment" },
		});
	});

	test("routes action-required subscriptions to the hosted invoice when present", () => {
		const state = computeDunningState(
			deployment({
				computeSubscription: subscription({
					status: "past_due",
					payment_state: "requires_action",
					recovery_action: "fix_payment",
					latest_failed_invoice_hosted_url: "https://invoice.stripe.test/action",
				}),
			}),
		);

		expect(state).toMatchObject({
			paymentState: "requires_action",
			recoveryTarget: {
				kind: "invoice",
				action: "fix_payment",
				url: "https://invoice.stripe.test/action",
			},
		});
	});

	test("uses the pending plan name for payment remediation", () => {
		const state = computeDunningState(
			deployment({
				computeSubscription: subscription({
					status: "past_due",
					payment_state: "requires_action",
					pending_plan_slug: "compute_basic",
					recovery_action: "fix_payment",
				}),
				currentPlanSlug: "compute_performance",
			}),
		);
		expect(state?.description).toContain("keep Basic compute active");
		expect(state?.recoveryPlanSlug).toBe("compute_basic");
	});

	test("presents backend-finalized recovery on both payment rails", () => {
		for (const fundingSource of ["stripe", "wallet"] as const) {
			const state = computeDunningState(
				deployment({
					computeSubscription: subscription({
						status: "unpaid",
						funding_source: fundingSource,
						payment_state: "unpaid",
						recovery_action: "start_new",
					}),
					currentPlanSlug: "compute_basic",
				}),
			);
			expect(state).toMatchObject({
				fundingSource,
				recoveryTarget: { kind: "start_new", action: "start_new" },
				tone: "destructive",
			});
			expect(state?.description).toContain("Choose a subscription");
		}
	});

	test("uses authoritative fallback provenance for detached recovery", () => {
		const running = computeDunningState(
			deployment({
				computeSubscription: includedSubscription(),
				factKind: "funding_revoked",
				fundingSource: "wallet",
				priorPlanSlug: "compute_performance",
			}),
		);
		expect(running).toMatchObject({
			paymentState: "unpaid",
			fundingSource: "wallet",
			recoveryTarget: { kind: "start_new", action: "start_new" },
			fallbackOccurredAt: "2026-07-18T12:00:00Z",
			fallbackPlanLabel: "Performance compute",
			fallbackReason: "payment_failure",
			recoveryPlanSlug: "compute_performance",
		});
		expect(running?.fallbackOccurredAt).not.toBe("2026-07-18T12:05:00Z");
		expect(running?.description).toContain("now using included Basic");

		const stopped = computeDunningState(
			deployment({
				computeSubscription: includedSubscription(),
				factKind: "funding_revoked",
				status: "stopped",
			}),
		);
		expect(stopped?.description).toContain("You can start it on included Basic");

		const unavailable = computeDunningState(
			deployment({
				computeSubscription: includedSubscription(),
				factKind: "funding_revoked",
				status: null,
			}),
		);
		expect(unavailable?.description).toContain("current status is unavailable");
		expect(unavailable?.description).not.toContain("is now using included Basic");
	});

	test("recovers revoked funding even without a subscription, but not an active replacement", () => {
		expect(
			computeDunningState(deployment({ factKind: "funding_revoked" }))?.recoveryTarget.kind,
		).toBe("start_new");
		expect(
			computeDunningState(
				deployment({
					computeSubscription: subscription({ funding_source: "wallet" }),
					currentPlanSlug: "compute_performance",
					factKind: "funding_revoked",
				}),
			),
		).toBeNull();
	});

	test("keeps non-payment fallback presentation reason-specific", () => {
		const cases = [
			{
				reason: "canceled" as const,
				tone: "neutral",
				secondaryTarget: null,
				title: "Compute subscription ended",
			},
			{
				reason: "refunded" as const,
				tone: "neutral",
				secondaryTarget: "transactions",
				title: "Compute payment refunded",
			},
			{
				reason: "disputed" as const,
				tone: "warning",
				secondaryTarget: "support",
				title: "Compute payment disputed",
			},
			{
				reason: "admin_forced" as const,
				tone: "neutral",
				secondaryTarget: "support",
				title: "Compute funding changed",
			},
		] as const;

		for (const { reason, ...expected } of cases) {
			const state = computeDunningState(
				deployment({
					computeSubscription: includedSubscription(),
					factKind: "funding_revoked",
					reason,
				}),
			);
			expect(state).toMatchObject({
				...expected,
				fallbackReason: reason,
				recoveryTarget: { kind: "start_new", action: "start_new" },
			});
		}
	});

	test("writes factual, reason-specific fallback sentences", () => {
		expect(fallbackReasonSentence("payment_failure", "Performance compute", "Jul 18")).toBe(
			"This agent fell back from Performance compute because payment failed on Jul 18.",
		);
		expect(fallbackReasonSentence("canceled", "Performance compute", "Jul 18")).toContain(
			"you canceled the subscription",
		);
		expect(fallbackReasonSentence("refunded", "Performance compute", "Jul 18")).toContain(
			"Review Transactions",
		);
		expect(fallbackReasonSentence("disputed", "Performance compute", "Jul 18")).toContain(
			"contact support",
		);
		expect(fallbackReasonSentence("admin_forced", "Performance compute", "Jul 18")).toContain(
			"changed by an administrator",
		);
	});
});

test("power controls use the backend start decision", () => {
	expect(computeSubscriptionRequiredToStart({ start_action: "subscribe" })).toBe(true);
	for (const start_action of [
		"start",
		"fix_payment",
		"top_up",
		"wait",
		"contact_support",
		"unavailable",
		null,
	] as const) {
		expect(computeSubscriptionRequiredToStart({ start_action })).toBe(false);
	}
});
