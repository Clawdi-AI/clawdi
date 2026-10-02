import { expect, test } from "bun:test";
import {
	exactUsd,
	nextBillingCursor,
	subscriptionPrice,
	uniqueBillingItems,
	validSubscriptionId,
} from "./helpers";

test("USD display never rounds server credits or disguises invalid balances as zero", () => {
	expect(exactUsd("12345678901234567890.12345678")).toBe("USD 12345678901234567890.12345678");
	expect(exactUsd("-0.00000001")).toBe("USD -0.00000001");
	for (const value of [undefined, null, "", "NaN", "1e6", " 10", "USD 1"])
		expect(exactUsd(value)).toBeNull();
	expect(subscriptionPrice({ price_cents: 0, currency: "usd" })).not.toBeNull();
	expect(
		subscriptionPrice({ price_cents: Number.MAX_SAFE_INTEGER + 1, currency: "usd" }),
	).toBeNull();
	expect(subscriptionPrice({ price_cents: 100, currency: "not-currency" })).toBeNull();
});

test("cursor pages stop at the end or a loop without rewriting opaque cursors", () => {
	const first = { has_more: true, next_cursor: "a &+/?" };
	expect(nextBillingCursor(first, [first])).toBe("a &+/?");
	expect(
		nextBillingCursor(first, [first, { has_more: true, next_cursor: "b" }, first]),
	).toBeUndefined();
	expect(nextBillingCursor({ has_more: false, next_cursor: "b" }, [])).toBeUndefined();
	expect(nextBillingCursor({ has_more: true, next_cursor: null }, [])).toBeUndefined();
	expect(
		uniqueBillingItems(
			[
				{ id: "a", value: 1 },
				{ id: "a", value: 2 },
			],
			(item) => item.id,
		),
	).toEqual([{ id: "a", value: 2 }]);
});

test("invalid subscription deep links never become inventory lookups", () => {
	expect(validSubscriptionId("csub_K8fJ3pQm")).toBe(true);
	for (const value of [undefined, "", "../csub_x", "csub_a/b", "csub_a?x", "csub_ "])
		expect(validSubscriptionId(value)).toBe(false);
});
