import { expect, test } from "bun:test";
import { uniqueBillingItems, validSubscriptionId } from "@/hosted/billing/format";

test("repeated billing rows keep the latest copy", () => {
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
