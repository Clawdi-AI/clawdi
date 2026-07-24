import { describe, expect, test } from "bun:test";
import { formatCents, formatUsd, formatUsdExact } from "@/hosted/billing/format";

describe("USD formatting", () => {
	test("groups decimal-string USD without rounding the quoted amount", () => {
		expect(formatUsdExact("0123456.7800")).toBe("$123,456.78");
		expect(formatUsdExact("12.345678")).toBe("$12.345678");
		expect(formatUsdExact("-2500")).toBe("-$2,500.00");
	});

	test("keeps non-zero sub-cent values visible", () => {
		expect(formatUsdExact("0.000001")).toBe("<$0.01");
		expect(formatUsd(0.001)).toBe("<$0.01");
		expect(formatUsdExact("0.01")).toBe("$0.01");
	});

	test("normalizes zero and fails closed for non-decimal input", () => {
		expect(formatUsdExact("-0.000")).toBe("$0.00");
		expect(formatUsdExact("1e6")).toBe("—");
	});

	test("keeps Stripe cents at two decimal places", () => {
		expect(formatCents(1900)).toBe("$19.00");
	});
});
