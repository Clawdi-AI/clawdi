import { describe, expect, test } from "bun:test";
import {
	IDEMPOTENCY_ATTEMPT_TTL_MS,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "./idempotency";

class MemoryStorage implements Storage {
	private readonly items = new Map<string, string>();

	get length(): number {
		return this.items.size;
	}

	clear(): void {
		this.items.clear();
	}

	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}

	key(index: number): string | null {
		return Array.from(this.items.keys())[index] ?? null;
	}

	removeItem(key: string): void {
		this.items.delete(key);
	}

	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}
}

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
			deploy_config: { language: "en", timezone: "America/Los_Angeles" },
		});
		const annual = idempotencyFingerprint({
			plan_slug: "compute_performance",
			billing_term_months: 12,
			deploy_config: { language: "en", timezone: "America/Los_Angeles" },
		});
		const first = idempotencyAttemptFor(null, "checkout", monthly, mint);
		const changed = idempotencyAttemptFor(first, "checkout", annual, mint);

		expect(changed.key).toBe("checkout-2");
		expect(changed).not.toBe(first);
	});

	test("reuses a persisted key for the same fingerprint across remounts", () => {
		const storage = new MemoryStorage();
		let counter = 0;
		const mint = (prefix: string) => `${prefix}-${++counter}`;

		const firstMount = idempotencyAttemptFor(null, "checkout", "same-attempt", mint, {
			storage,
			now: () => 1_000,
		});
		const secondMount = idempotencyAttemptFor(null, "checkout", "same-attempt", mint, {
			storage,
			now: () => 2_000,
		});

		expect(secondMount).toEqual(firstMount);
		expect(counter).toBe(1);
	});

	test("mints a new persisted key for a changed fingerprint", () => {
		const storage = new MemoryStorage();
		let counter = 0;
		const mint = (prefix: string) => `${prefix}-${++counter}`;

		const first = idempotencyAttemptFor(null, "checkout", "monthly", mint, {
			storage,
			now: () => 1_000,
		});
		const changed = idempotencyAttemptFor(first, "checkout", "annual", mint, {
			storage,
			now: () => 2_000,
		});

		expect(changed.key).toBe("checkout-2");
		expect(changed.key).not.toBe(first.key);
	});

	test("mints a new persisted key after the TTL expires", () => {
		const storage = new MemoryStorage();
		let counter = 0;
		const mint = (prefix: string) => `${prefix}-${++counter}`;

		const first = idempotencyAttemptFor(null, "checkout", "same-attempt", mint, {
			storage,
			now: () => 1_000,
		});
		const expired = idempotencyAttemptFor(first, "checkout", "same-attempt", mint, {
			storage,
			now: () => 1_000 + IDEMPOTENCY_ATTEMPT_TTL_MS + 1,
		});

		expect(expired.key).toBe("checkout-2");
		expect(expired.key).not.toBe(first.key);
	});

	test("is safe without browser storage", () => {
		let counter = 0;
		const mint = (prefix: string) => `${prefix}-${++counter}`;

		const first = idempotencyAttemptFor(null, "checkout", "same-attempt", mint, {
			storage: null,
		});
		const retry = idempotencyAttemptFor(first, "checkout", "same-attempt", mint, {
			storage: null,
		});

		expect(retry).toBe(first);
		expect(counter).toBe(1);
		expect(() => idempotencyAttemptFor(null, "checkout", "ssr-safe", mint)).not.toThrow();
	});
});
