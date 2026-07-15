import { describe, expect, test } from "bun:test";
import type { ComputePlanSlug, HostedDeployment } from "@/hosted/billing/contracts";
import {
	collectionFailureMessage,
	computeDunningState,
	computeDunningTileStatus,
	dunningDeadlineCountdown,
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

	test("branches on the recovery hint for wallet grace and never uses Stripe recovery", () => {
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
			ctaTarget: "wallet",
			serviceRiskAt: "2026-07-18T12:00:00Z",
			failureCode: "insufficient_balance",
		});
		expect(state?.description).toContain("72-hour grace period");
		expect(state?.description).not.toContain("Stripe");
	});

	test("explains wallet terminal fallback", () => {
		const state = computeDunningState(
			deployment(
				subscription({
					status: "unpaid",
					funding_source: "wallet",
					payment_state: "unpaid",
					recovery_action: "top_up",
				}),
			),
		);
		expect(state?.description).toContain("fell back to included Basic");
		expect(state?.description).toContain("otherwise it stopped");
		expect(state?.ctaTarget).toBe("wallet");
	});

	test("renders the persisted wallet fallback trace after the subscription detaches", () => {
		const fallback = {
			type: "compute_subscription_fallback" as const,
			funding_source: "wallet" as const,
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
			ctaTarget: "wallet",
			subscriptionId: 42,
			fallbackOccurredAt: "2026-07-18T12:00:00Z",
			fallbackPlanLabel: "Performance compute",
		});
		expect(running?.description).toContain("now using included Basic");

		const stopped = computeDunningState(
			deployment(null, "compute_basic", {
				last_funding_event: fallback,
				status: "stopped",
			}),
		);
		expect(stopped?.description).toContain("included Basic slot was occupied");
	});

	test("ignores an old fallback trace after wallet recovery", () => {
		expect(
			computeDunningState(
				deployment(subscription({ funding_source: "wallet" }), "compute_performance", {
					last_funding_event: {
						type: "compute_subscription_fallback",
						funding_source: "wallet",
						occurred_at: "2026-07-18T12:00:00Z",
						prior_plan_slug: "compute_performance",
						subscription_id: 42,
					},
				}),
			),
		).toBeNull();
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

		expect(state?.paymentState).toBe("requires_action");
		expect(state?.ctaTarget).toBe("invoice");
		expect(state?.invoiceUrl).toBe("https://invoice.stripe.test/action");
		expect(state?.tileLabel).toBe("Payment action required");
	});

	test("uses Basic naming for paid Basic payment remediation", () => {
		const state = computeDunningState(
			deployment(
				subscription({ status: "past_due", payment_state: "requires_action" }),
				"compute_basic",
			),
		);

		expect(state?.description).toContain("keep Basic compute active");
		expect(state?.tileTitle).toContain("keep Basic compute active");
	});

	test("uses portal remediation for retryable past-due subscriptions", () => {
		const state = computeDunningState(
			deployment(
				subscription({
					status: "past_due",
					payment_state: "past_due",
					next_payment_attempt_at: "2026-07-11T12:00:00Z",
				}),
			),
		);

		expect(state?.ctaTarget).toBe("portal");
		expect(state?.nextPaymentAttemptAt).toBe("2026-07-11T12:00:00Z");
		expect(state?.serviceRiskAt).toBe("2026-07-11T12:00:00Z");
		expect(
			computeDunningTileStatus(deployment(subscription({ payment_state: "past_due" }))),
		).toEqual({
			label: "Payment past due",
			title: "Update the payment method before retries are exhausted.",
			textClass: "text-warning-muted-foreground",
		});
	});

	test("marks unpaid subscriptions as destructive", () => {
		const state = computeDunningState(
			deployment(subscription({ status: "unpaid", payment_state: "unpaid" })),
		);

		expect(state?.paymentState).toBe("unpaid");
		expect(state?.tileTextClass).toBe("text-destructive");
		expect(state?.ctaTarget).toBe("portal");
	});
});

describe("dunningDeadlineCountdown", () => {
	test("formats remaining grace time and the expired state", () => {
		const now = Date.parse("2026-07-15T12:00:00Z");
		expect(dunningDeadlineCountdown("2026-07-18T14:00:00Z", now)).toBe("3d 2h remaining");
		expect(dunningDeadlineCountdown("2026-07-15T11:59:00Z", now)).toBe("Grace period ended");
	});
});

describe("collectionFailureMessage", () => {
	test("maps known recovery states without exposing internal upstream codes", () => {
		expect(collectionFailureMessage("insufficient_balance")).toBe(
			"The wallet balance was too low.",
		);
		expect(collectionFailureMessage("internal_bridge_timeout")).toBeNull();
	});
});
