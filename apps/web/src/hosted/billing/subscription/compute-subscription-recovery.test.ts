import { describe, expect, test } from "bun:test";
import { computeSubscriptionRecoveryPresentation } from "./compute-subscription-recovery";

const active = { label: "Active", tone: "success" } as const;

describe("computeSubscriptionRecoveryPresentation", () => {
	test("ended subscriptions override stale payment retries without needing a recovery action", () => {
		const canceled = { label: "Canceled", tone: "neutral" } as const;
		expect(
			computeSubscriptionRecoveryPresentation(
				{
					status: "canceled",
					payment_state: "past_due",
					recovery_action: "top_up",
					latest_failed_invoice_hosted_url: null,
					next_payment_attempt_at: "2026-09-12T00:00:00Z",
				},
				canceled,
			),
		).toEqual({
			status: canceled,
			hasPaymentIssue: true,
			recoveryTarget: { kind: "start_new", action: "start_new" },
			schedule: null,
		});
	});

	test("prioritizes authoritative payment state over coarse lifecycle status", () => {
		expect(
			computeSubscriptionRecoveryPresentation(
				{
					payment_state: "requires_action",
					recovery_action: "fix_payment",
					latest_failed_invoice_hosted_url: "https://billing.example/invoice/open",
					next_payment_attempt_at: null,
				},
				{ label: "Past due", tone: "destructive" },
			),
		).toEqual({
			status: { label: "Payment action required", tone: "warning" },
			hasPaymentIssue: true,
			recoveryTarget: {
				kind: "invoice",
				action: "fix_payment",
				url: "https://billing.example/invoice/open",
			},
			schedule: { verb: null, at: null, fallback: "Payment needs attention" },
		});
	});

	test("projects wallet, card, terminal, and healthy actions", () => {
		expect(
			computeSubscriptionRecoveryPresentation(
				{
					payment_state: "past_due",
					recovery_action: "top_up",
					latest_failed_invoice_hosted_url: null,
					next_payment_attempt_at: "2026-08-20T00:00:00Z",
				},
				active,
			),
		).toMatchObject({
			recoveryTarget: { kind: "top_up", action: "top_up" },
			schedule: { verb: "Retries", at: "2026-08-20T00:00:00Z", fallback: null },
		});
		expect(
			computeSubscriptionRecoveryPresentation(
				{
					payment_state: "past_due",
					recovery_action: "fix_payment",
					latest_failed_invoice_hosted_url: null,
					next_payment_attempt_at: null,
				},
				active,
			).recoveryTarget,
		).toEqual({ kind: "fix_payment", action: "fix_payment" });
		expect(
			computeSubscriptionRecoveryPresentation(
				{
					payment_state: "unpaid",
					recovery_action: "start_new",
					latest_failed_invoice_hosted_url: null,
					next_payment_attempt_at: null,
				},
				active,
			),
		).toEqual({
			status: { label: "Unpaid", tone: "destructive" },
			hasPaymentIssue: true,
			recoveryTarget: { kind: "start_new", action: "start_new" },
			schedule: null,
		});
		expect(
			computeSubscriptionRecoveryPresentation(
				{
					payment_state: "ok",
					recovery_action: null,
					latest_failed_invoice_hosted_url: null,
					next_payment_attempt_at: null,
				},
				active,
			),
		).toEqual({
			status: active,
			hasPaymentIssue: false,
			recoveryTarget: null,
			schedule: null,
		});
	});
});
