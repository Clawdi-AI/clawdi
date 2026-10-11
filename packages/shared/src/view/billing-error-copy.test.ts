import { describe, expect, test } from "bun:test";
import { BILLING_ERROR_CODE_COPY, billingErrorCopy } from "./billing-error-copy";
import { deploySubmissionRecoveryCopy } from "./deploy-submission-error";

const rejected = (code: string | null, detail = "Request failed", status = 409) =>
	billingErrorCopy({ kind: "response", status, code, detail });

describe("billingErrorCopy", () => {
	test("known codes read as their public recovery", () => {
		expect(rejected("funding_authority_inconsistent")).toBe(
			"Billing for this subscription needs review. Contact support before making changes.",
		);
		expect(rejected("open_refund_debt")).toBe(
			"Top up your wallet to continue. New funds will first settle the outstanding balance.",
		);
		expect(rejected("checkout_target_reserved")).toContain("A checkout is already open");
	});

	test("unknown codes and bare tokens never leak internals", () => {
		expect(rejected("bridge_internal_17")).toBe(
			"The billing request couldn't be completed. Refresh and try again.",
		);
		expect(rejected("constructor")).toBe(
			"The billing request couldn't be completed. Refresh and try again.",
		);
		expect(rejected(null, "bridge_internal_17", 400)).not.toContain("bridge_internal_17");
		expect(rejected(null, "That code has already been used.", 400)).toBe(
			"The billing request couldn't be completed. Review the details and try again.",
		);
	});

	test("a missing payment method asks for one only from the bare detail", () => {
		expect(rejected(null, "payment_method_required", 402)).toBe(
			"Add a payment method and try again.",
		);
	});

	test("balance exhaustion reads as a top-up on 402 and 403 only", () => {
		for (const status of [402, 403])
			expect(rejected("insufficient_wallet_balance", "", status)).toContain(
				"Your wallet balance is too low",
			);
		expect(rejected("insufficient_wallet_balance", "", 409)).toBe(
			"The billing request couldn't be completed. Refresh and try again.",
		);
	});

	test("auth, server, transport and unknown failures get safe copy", () => {
		expect(rejected("open_refund_debt", "", 401)).toBe(
			"Your session expired. Sign in again to continue.",
		);
		for (const status of [500, 503, 429])
			expect(rejected("open_refund_debt", "upstream", status)).toBe(
				"The billing request couldn’t be completed right now. Try again in a moment.",
			);
		expect(billingErrorCopy({ kind: "offline" })).toContain("billing service");
		expect(billingErrorCopy({ kind: "timeout" })).toContain("taking longer than usual");
		expect(billingErrorCopy({ kind: "error" })).toBe(
			"The billing request couldn't be completed. Try again.",
		);
		expect(billingErrorCopy({ kind: "unknown" })).toBe("Couldn't complete the request. Try again.");
	});

	test("the Deploy CTA reads refund debt with the same sentence", () => {
		expect(deploySubmissionRecoveryCopy({ code: "open_refund_debt" })).toBe(
			BILLING_ERROR_CODE_COPY.open_refund_debt,
		);
	});
});
