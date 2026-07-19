import { describe, expect, test } from "bun:test";
import type {
	ComputePlanSlug,
	HostedComputeSubscription,
	HostedDeploymentStatus,
	HostedFundingFact,
} from "@/hosted/billing/contracts";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import { computeDunningState, computeDunningTileStatus } from "./compute-dunning.logic";

function deployment({
	computeSubscription = null,
	computePlanSlug,
	factKind,
	status = "running",
}: {
	computeSubscription?: HostedComputeSubscription | null;
	computePlanSlug?: ComputePlanSlug;
	factKind?: HostedFundingFact["fact_kind"];
	status?: HostedDeploymentStatus["summary_state"];
} = {}) {
	return hostedDeploymentFixture({
		status,
		computeSubscription,
		fundingFact: factKind
			? {
					fact_kind: factKind,
					commercial_revision: 2,
					compute_plan_slug: factKind === "funding_ready" ? computePlanSlug : null,
					emitted_at: "2026-07-18T12:00:00Z",
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
				computePlanSlug: "compute_performance",
				factKind: "funding_ready",
			}),
		);

		expect(state).toMatchObject({
			recoveryAction: "top_up",
			ctaTarget: "top_up",
		});
		expect(state?.description).toContain("update automatically");
		expect(state?.description).not.toMatch(/grace|retry/i);
		expect(state).not.toHaveProperty("serviceRiskAt");
		expect(state).not.toHaveProperty("failureCode");
	});

	test("routes card past due to payment remediation", () => {
		const deploymentWithPastDueCard = deployment({
			computeSubscription: subscription({ status: "past_due", payment_state: "past_due" }),
		});
		expect(computeDunningState(deploymentWithPastDueCard)).toMatchObject({
			recoveryAction: "fix_payment",
			ctaTarget: "fix_payment",
		});
		expect(computeDunningTileStatus(deploymentWithPastDueCard)).toEqual({
			label: "Payment past due",
			title: "Fix the card payment method for the open invoice.",
			textClass: "text-warning-muted-foreground",
		});
	});

	test("routes action-required subscriptions to the hosted invoice when present", () => {
		const state = computeDunningState(
			deployment({
				computeSubscription: subscription({
					status: "past_due",
					payment_state: "requires_action",
					latest_failed_invoice_hosted_url: "https://invoice.stripe.test/action",
				}),
			}),
		);

		expect(state).toMatchObject({
			paymentState: "requires_action",
			recoveryAction: "fix_payment",
			ctaTarget: "invoice",
			invoiceUrl: "https://invoice.stripe.test/action",
		});
	});

	test("uses the pending plan name for payment remediation", () => {
		const state = computeDunningState(
			deployment({
				computeSubscription: subscription({
					status: "past_due",
					payment_state: "requires_action",
					pending_plan_slug: "compute_basic",
				}),
				computePlanSlug: "compute_performance",
				factKind: "funding_ready",
			}),
		);
		expect(state?.description).toContain("keep Basic compute active");
		expect(state?.recoveryPlanSlug).toBe("compute_basic");
	});

	test("presents every terminal rail as a new subscription", () => {
		for (const fundingSource of ["stripe", "wallet"] as const) {
			const state = computeDunningState(
				deployment({
					computeSubscription: subscription({
						status: "unpaid",
						funding_source: fundingSource,
						payment_state: "unpaid",
					}),
					computePlanSlug: "compute_basic",
					factKind: "funding_ready",
				}),
			);
			expect(state).toMatchObject({
				recoveryAction: "start_new",
				ctaTarget: "start_new",
				tileTextClass: "text-destructive",
			});
			expect(state?.description).toContain("Start a new subscription");
		}
	});

	test("uses the latest funding_revoked fact for detached recovery", () => {
		const running = computeDunningState(
			deployment({
				factKind: "funding_revoked",
			}),
		);
		expect(running).toMatchObject({
			paymentState: "unpaid",
			recoveryAction: "start_new",
			ctaTarget: "start_new",
			fallbackOccurredAt: "2026-07-18T12:00:00Z",
			fallbackPlanLabel: "Paid compute",
			recoveryPlanSlug: null,
		});
		expect(running?.description).toContain("now using included Basic");

		const stopped = computeDunningState(
			deployment({
				factKind: "funding_revoked",
				status: "stopped",
			}),
		);
		expect(stopped?.description).toContain("No included Basic slot was available");
	});

	test("ignores funding_ready after recovery", () => {
		expect(
			computeDunningState(
				deployment({
					computeSubscription: subscription({ funding_source: "wallet" }),
					computePlanSlug: "compute_performance",
					factKind: "funding_ready",
				}),
			),
		).toBeNull();
	});
});
