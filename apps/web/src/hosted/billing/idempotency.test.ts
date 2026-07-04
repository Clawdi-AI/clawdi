import { describe, expect, test } from "bun:test";
import { idempotencyAttemptFor, idempotencyFingerprint, newIdempotencyKey } from "./idempotency";

describe("newIdempotencyKey", () => {
	test("carries the caller's prefix", () => {
		expect(newIdempotencyKey("topup")).toMatch(/^topup-/);
		expect(newIdempotencyKey("deploy")).toMatch(/^deploy-/);
	});

	test("mints a distinct key per call (so distinct attempts don't collide)", () => {
		const keys = new Set(Array.from({ length: 100 }, () => newIdempotencyKey("topup")));
		expect(keys.size).toBe(100);
	});

	test("is a non-trivial token, not just the bare prefix", () => {
		const key = newIdempotencyKey("topup");
		expect(key.length).toBeGreaterThan("topup-".length);
	});
});

describe("idempotencyFingerprint", () => {
	test("is stable for equivalent nested request bodies", () => {
		expect(
			idempotencyFingerprint({
				plan_slug: "compute_performance",
				deploy_config: { enable_hermes: true, enable_openclaw: true },
				billing_term_months: 12,
			}),
		).toBe(
			idempotencyFingerprint({
				billing_term_months: 12,
				deploy_config: { enable_openclaw: true, enable_hermes: true },
				plan_slug: "compute_performance",
			}),
		);
	});
});

describe("idempotencyAttemptFor", () => {
	test("reuses a key for the same logical attempt", () => {
		let counter = 0;
		const mint = (prefix: string) => `${prefix}-${++counter}`;
		const first = idempotencyAttemptFor(null, "checkout", "same-attempt", mint);
		const retry = idempotencyAttemptFor(first, "checkout", "same-attempt", mint);

		expect(retry).toBe(first);
		expect(retry.key).toBe("checkout-1");
		expect(counter).toBe(1);
	});

	test("mints a new key when plan, term, or deploy config changes", () => {
		let counter = 0;
		const mint = (prefix: string) => `${prefix}-${++counter}`;
		const monthly = idempotencyFingerprint({
			plan_slug: "compute_performance",
			billing_term_months: 1,
			deploy_config: { assistant_name: "Agent" },
		});
		const annual = idempotencyFingerprint({
			plan_slug: "compute_performance",
			billing_term_months: 12,
			deploy_config: { assistant_name: "Agent" },
		});
		const first = idempotencyAttemptFor(null, "checkout", monthly, mint);
		const changed = idempotencyAttemptFor(first, "checkout", annual, mint);

		expect(changed.key).toBe("checkout-2");
		expect(changed).not.toBe(first);
	});
});
