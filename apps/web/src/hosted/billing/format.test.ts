import { describe, expect, test } from "bun:test";
import { formatExactCredits } from "@/hosted/billing/format";

describe("formatExactCredits", () => {
	test("groups decimal-string credits without rounding the quoted amount", () => {
		expect(formatExactCredits("0123456.7800")).toBe("123,456.78 credits");
		expect(formatExactCredits("0.125")).toBe("0.125 credits");
		expect(formatExactCredits("-2500")).toBe("-2,500 credits");
	});

	test("normalizes zero and fails closed for non-decimal input", () => {
		expect(formatExactCredits("-0.000")).toBe("0 credits");
		expect(formatExactCredits("1e6")).toBe("— credits");
	});
});
