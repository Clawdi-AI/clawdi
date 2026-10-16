import { expect, test } from "bun:test";
import { uniqueBillingItems } from "@/hosted/billing/format";

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
