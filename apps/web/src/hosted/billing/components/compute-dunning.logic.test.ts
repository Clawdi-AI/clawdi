import { describe, expect, test } from "bun:test";
import type { ComputePlanSlug, HostedDeployment } from "@/hosted/billing/contracts";
import { computeDunningState, computeDunningTileStatus } from "./compute-dunning.logic";

function deployment(
	computeSubscription: HostedDeployment["compute_subscription"],
	computePlanSlug?: ComputePlanSlug,
): Pick<HostedDeployment, "compute_subscription" | "config_info"> {
	return {
		compute_subscription: computeSubscription,
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
	};
}

function subscription(
	overrides: Partial<NonNullable<HostedDeployment["compute_subscription"]>> = {},
): NonNullable<HostedDeployment["compute_subscription"]> {
	return {
		status: "active",
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
