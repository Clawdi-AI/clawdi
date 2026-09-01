import { describe, expect, test } from "bun:test";
import { hostedProductAccessKeys } from "@/hosted/access/product-access";

describe("hostedProductAccessKeys", () => {
	test("isolates the current profile cache by Clerk user ID", () => {
		expect(hostedProductAccessKeys.me("user_first")).toEqual([
			"hosted-product-access",
			"me",
			"user_first",
		]);
		expect(hostedProductAccessKeys.me("user_second")).not.toEqual(
			hostedProductAccessKeys.me("user_first"),
		);
	});
});
