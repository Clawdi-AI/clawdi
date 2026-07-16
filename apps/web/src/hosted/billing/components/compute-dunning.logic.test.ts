import { describe, expect, test } from "bun:test";
import type { ComputePlanSlug, HostedDeployment } from "@/hosted/billing/contracts";
import {
	computeDunningState,
	computeDunningTileStatus,
	fallbackReasonSentence,
} from "./compute-dunning.logic";

function deployment(
	computeSubscription: HostedDeployment["compute_subscription"],
	computePlanSlug?: ComputePlanSlug,
	overrides: Partial<Pick<HostedDeployment, "last_funding_event" | "status">> = {},
): Pick<
	HostedDeployment,
	"compute_subscription" | "config_info" | "last_funding_event" | "status"
> {
	return {
		compute_subscription: computeSubscription,
		last_funding_event: null,
		status: "running",
		config_info: computePlanSlug
			? {
					compute_plan_slug: computePlanSlug,
					mux_enabled: false,
					telegram_mux_enabled: false,
					discord_mux_enabled: false,
					whatsapp_mux_enabled: false,
					imessage_mux_enabled: false,
					kobb_available: false,
					ai_provider_auth_kind: "managed",
					runtime: "hermes",
				}
			: null,
		...overrides,
	};
}

function subscription(
	overrides: Partial<NonNullable<HostedDeployment["compute_subscription"]>> = {},
): NonNullable<HostedDeployment["compute_subscription"]> {
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
		next_payment_attempt_at: null,
		...overrides,
	};
}

describe("computeDunningState", () => {
	test("returns null for healthy subscriptions", () => {
		expect(computeDunningState(deployment(null))).toBeNull();
		expect(computeDunningState(deployment(subscription()))).toBeNull();
	});

	test("routes wallet past due to top-up without a local retry ladder", () => {
		const state = computeDunningState(
			deployment(
				subscription({
					status: "past_due",
					funding_source: "wallet",
					payment_state: "past_due",
					recovery_action: "top_up",
					dunning_deadline_at: "2026-07-18T12:00:00Z",
					last_collection_failure_code: "insufficient_balance",
				}),
				"compute_performance",
			),
		);

		expect(state).toMatchObject({
			fundingSource: "wallet",
			recoveryAction: "top_up",
			ctaTarget: "top_up",
		});
		expect(state?.description).toContain("update automatically");
		expect(state?.description).not.toMatch(/grace|retry/i);
		expect(state).not.toHaveProperty("serviceRiskAt");
		expect(state).not.toHaveProperty("failureCode");
	});

	test("routes card past due to payment remediation", () => {
		const state = computeDunningState(
			deployment(subscription({ status: "past_due", payment_state: "past_due" })),
		);
		expect(state).toMatchObject({
			fundingSource: "stripe",
			recoveryAction: "fix_payment",
			ctaTarget: "fix_payment",
		});
		expect(
			computeDunningTileStatus(deployment(subscription({ payment_state: "past_due" }))),
		).toEqual({
			label: "Payment past due",
			title: "Fix the card payment method for the open invoice.",
			textClass: "text-warning-muted-foreground",
		});
	});

	test("routes action-required subscriptions to the hosted invoice when present", () => {
		const state = computeDunningState(
			deployment(
				subscription({
					status: "past_due",
					payment_state: "requires_action",
					latest_failed_invoice_hosted_url: "https://invoice.stripe.test/action",
				}),
			),
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
			deployment(
				subscription({
					status: "past_due",
					payment_state: "requires_action",
					pending_plan_slug: "compute_basic",
				}),
				"compute_performance",
			),
		);
		expect(state?.description).toContain("keep Basic compute active");
		expect(state?.recoveryPlanSlug).toBe("compute_basic");
	});

	test("presents every terminal rail as a new subscription", () => {
		for (const fundingSource of ["stripe", "wallet"] as const) {
			const state = computeDunningState(
				deployment(
					subscription({
						status: "unpaid",
						funding_source: fundingSource,
						payment_state: "unpaid",
					}),
					"compute_basic",
				),
			);
			expect(state).toMatchObject({
				fundingSource,
				recoveryAction: "start_new",
				ctaTarget: "start_new",
				tileTextClass: "text-destructive",
			});
			expect(state?.description).toContain("Start a new subscription");
			expect(state?.description).not.toMatch(/reactivate|retry previous/i);
		}
	});

	test("uses the persisted fallback deployment for terminal recovery copy", () => {
		const fallback = {
			type: "compute_subscription_fallback" as const,
			funding_source: "wallet" as const,
			reason: "payment_failure" as const,
			occurred_at: "2026-07-18T12:00:00Z",
			prior_plan_slug: "compute_performance",
			subscription_id: 42,
		};
		const running = computeDunningState(
			deployment(null, "compute_basic", { last_funding_event: fallback }),
		);
		expect(running).toMatchObject({
			paymentState: "unpaid",
			fundingSource: "wallet",
			recoveryAction: "start_new",
			ctaTarget: "start_new",
			fallbackOccurredAt: "2026-07-18T12:00:00Z",
			fallbackPlanLabel: "Performance compute",
			recoveryPlanSlug: "compute_performance",
		});
		expect(running?.description).toContain("now using included Basic");

		const stopped = computeDunningState(
			deployment(null, "compute_basic", {
				last_funding_event: fallback,
				status: "stopped",
			}),
		);
		expect(stopped?.description).toContain("No included Basic slot was available");
	});

	test("ignores an old fallback trace after recovery", () => {
		expect(
			computeDunningState(
				deployment(subscription({ funding_source: "wallet" }), "compute_performance", {
					last_funding_event: {
						type: "compute_subscription_fallback",
						funding_source: "wallet",
						reason: "payment_failure",
						occurred_at: "2026-07-18T12:00:00Z",
						prior_plan_slug: "compute_performance",
						subscription_id: 42,
					},
				}),
			),
		).toBeNull();
	});

	test("keeps non-payment fallback presentation reason-specific", () => {
		const cases = [
			{
				fallbackReason: "canceled" as const,
				ctaTarget: "none",
				title: "Compute subscription ended",
			},
			{
				fallbackReason: "refunded" as const,
				ctaTarget: "billing_history",
				title: "Compute payment refunded",
			},
			{
				fallbackReason: "disputed" as const,
				ctaTarget: "support",
				title: "Compute payment disputed",
			},
			{
				fallbackReason: "admin_forced" as const,
				ctaTarget: "support",
				title: "Compute funding changed",
			},
		];

		for (const expected of cases) {
			const state = computeDunningState(
				deployment(null, "compute_basic", {
					last_funding_event: {
						type: "compute_subscription_fallback",
						funding_source: "wallet",
						reason: expected.fallbackReason,
						occurred_at: "2026-07-18T12:00:00Z",
						prior_plan_slug: "compute_performance",
						subscription_id: 42,
					},
				}),
			);
			expect(state).toMatchObject(expected);
			expect(state?.recoveryAction).toBeNull();
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
			"Review Billing history",
		);
		expect(fallbackReasonSentence("disputed", "Performance compute", "Jul 18")).toContain(
			"contact support",
		);
		expect(fallbackReasonSentence("admin_forced", "Performance compute", "Jul 18")).toContain(
			"changed by an administrator",
		);
	});
});
