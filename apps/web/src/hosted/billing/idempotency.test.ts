import { describe, expect, test } from "bun:test";
import { newIdempotencyKey } from "./idempotency";

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
