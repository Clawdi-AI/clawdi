import { describe, expect, test } from "bun:test";
import {
	BillingApiError,
	BillingNetworkError,
	billingQueryRetry,
	isAuthError,
	isForbiddenError,
	isInsufficientBalanceError,
	isNetworkError,
	isRetryableError,
	isServerError,
	normalizeBillingError,
} from "@/hosted/billing/errors";

describe("error classification", () => {
	test("401 is an auth error, not forbidden/server/retryable", () => {
		const e = new BillingApiError(401, "token expired");
		expect(isAuthError(e)).toBe(true);
		expect(isForbiddenError(e)).toBe(false);
		expect(isServerError(e)).toBe(false);
		expect(isRetryableError(e)).toBe(false);
	});

	test("403 is forbidden, not auth", () => {
		const e = new BillingApiError(403, "nope");
		expect(isForbiddenError(e)).toBe(true);
		expect(isAuthError(e)).toBe(false);
	});

	test("5xx and 429 are server errors and retryable", () => {
		for (const status of [500, 502, 503, 429]) {
			const e = new BillingApiError(status, "boom");
			expect(isServerError(e)).toBe(true);
			expect(isRetryableError(e)).toBe(true);
		}
	});

	test("4xx (other than 429) are not retryable", () => {
		for (const status of [400, 401, 403, 404, 409, 422]) {
			expect(isRetryableError(new BillingApiError(status, "x"))).toBe(false);
		}
	});

	test("network errors are retryable transport failures", () => {
		const offline = new BillingNetworkError("offline");
		const timeout = new BillingNetworkError("timeout");
		expect(isNetworkError(offline)).toBe(true);
		expect(isNetworkError(timeout)).toBe(true);
		expect(isRetryableError(offline)).toBe(true);
		expect(isRetryableError(timeout)).toBe(true);
	});

	test("non-billing errors classify as nothing", () => {
		const e = new Error("random");
		expect(isAuthError(e)).toBe(false);
		expect(isServerError(e)).toBe(false);
		expect(isNetworkError(e)).toBe(false);
		expect(isRetryableError(e)).toBe(false);
	});
});

describe("billingQueryRetry", () => {
	test("retries transient errors at most twice", () => {
		const e = new BillingNetworkError("offline");
		expect(billingQueryRetry(0, e)).toBe(true);
		expect(billingQueryRetry(1, e)).toBe(true);
		expect(billingQueryRetry(2, e)).toBe(false);
	});

	test("never retries deterministic 4xx", () => {
		expect(billingQueryRetry(0, new BillingApiError(403, "Clawdi v2 is not enabled"))).toBe(false);
		expect(billingQueryRetry(0, new BillingApiError(401, "expired"))).toBe(false);
	});
});

describe("normalizeBillingError", () => {
	test("network offline → connection guidance", () => {
		expect(normalizeBillingError(new BillingNetworkError("offline"))).toMatch(
			/couldn't reach the billing service/i,
		);
	});

	test("timeout → try-again guidance", () => {
		expect(normalizeBillingError(new BillingNetworkError("timeout"))).toMatch(
			/taking longer than usual/i,
		);
	});

	test("401 → session expired prompt", () => {
		expect(normalizeBillingError(new BillingApiError(401, "jwt expired"))).toMatch(
			/session has expired/i,
		);
	});

	test("5xx → transient service message, not the raw detail", () => {
		const msg = normalizeBillingError(new BillingApiError(503, "upstream connect error"));
		expect(msg).toMatch(/having trouble/i);
		expect(msg).not.toMatch(/upstream connect error/);
	});

	test("insufficient balance keeps the product narrative", () => {
		const e = new BillingApiError(403, "INSUFFICIENT_BALANCE");
		expect(isInsufficientBalanceError(e)).toBe(true);
		expect(normalizeBillingError(e)).toMatch(/balance is too low/i);
	});

	test("snake_case codes become readable, real sentences pass through", () => {
		expect(normalizeBillingError(new BillingApiError(400, "payment_method_required"))).toBe(
			"Payment Method Required",
		);
		expect(
			normalizeBillingError(new BillingApiError(400, "That code has already been used.")),
		).toBe("That code has already been used.");
	});

	test("unknown shapes get a safe message", () => {
		expect(normalizeBillingError(null)).toMatch(/something went wrong/i);
	});
});
