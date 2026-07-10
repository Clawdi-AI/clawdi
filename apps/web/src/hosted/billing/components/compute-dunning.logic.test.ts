import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { computeDunningState, computeDunningTileStatus } from "./compute-dunning.logic";

function deployment(
	computeSubscription: HostedDeployment["compute_subscription"],
): Pick<HostedDeployment, "compute_subscription"> {
	return { compute_subscription: computeSubscription };
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
