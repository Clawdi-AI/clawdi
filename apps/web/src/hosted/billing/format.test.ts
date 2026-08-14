import { describe, expect, test } from "bun:test";
import {
	addDecimals,
	canonicalDecimal,
	compareDecimals,
	decimalRatioPercent,
	formatCents,
	formatUsd,
	formatUsdExact,
	negativeDecimalMagnitude,
	persistedUsdToCents,
	subtractDecimals,
	wholeDollarTopUpCents,
} from "@/hosted/billing/format";

describe("USD formatting", () => {
	test("formats normal numeric USD with exactly two decimal places", () => {
		expect(formatUsd(29.4825458)).toBe("$29.48");
		expect(formatUsd(12)).toBe("$12.00");
	});

	test("rounds and groups exact decimal-string USD to cents", () => {
		expect(formatUsdExact("0123456.7800")).toBe("$123,456.78");
		expect(formatUsdExact("12.344")).toBe("$12.34");
		expect(formatUsdExact("12.345678")).toBe("$12.35");
		expect(formatUsdExact("999.999")).toBe("$1,000.00");
		expect(formatUsdExact("9007199254740993.995")).toBe("$9,007,199,254,740,994.00");
		expect(formatUsdExact(" +0000012.4 ")).toBe("$12.40");
		expect(formatUsdExact("-2500")).toBe("-$2,500.00");
		expect(formatUsdExact("-12.345")).toBe("-$12.35");
	});

	test("keeps non-zero sub-cent values visible", () => {
		expect(formatUsdExact("0.000001")).toBe("<$0.01");
		expect(formatUsdExact("0.009999")).toBe("<$0.01");
		expect(formatUsdExact("-0.000001")).toBe("-<$0.01");
		expect(formatUsd(0.001)).toBe("<$0.01");
		expect(formatUsd(-0.001)).toBe("-<$0.01");
		expect(formatUsdExact("0.01")).toBe("$0.01");
	});

	test("normalizes zero and fails closed for non-decimal input", () => {
		expect(formatUsdExact("-0.000")).toBe("$0.00");
		expect(formatUsdExact("1e6")).toBe("—");
	});

	test("keeps Stripe cents at two decimal places", () => {
		expect(formatCents(1900)).toBe("$19.00");
		expect(persistedUsdToCents("5.000000000000000000")).toBe(500);
		expect(persistedUsdToCents("5.001000000000000000")).toBeNull();
		expect(persistedUsdToCents("90071992547409.91")).toBe(9_007_199_254_740_991);
		expect(persistedUsdToCents("90071992547409.92")).toBeNull();
	});

	test("does exact fixed-point money arithmetic without Number coercion", () => {
		expect(canonicalDecimal("0009007199254740993.99500")).toBe("9007199254740993.995");
		expect(canonicalDecimal(Number.POSITIVE_INFINITY)).toBeNull();
		expect(compareDecimals("9007199254740993.01", "9007199254740993")).toBe(1);
		expect(subtractDecimals("25", "19.000125")).toBe("5.999875");
		expect(addDecimals("9007199254740993.01", "0.99")).toBe("9007199254740994");
		expect(negativeDecimalMagnitude("-1.250500")).toBe("1.2505");
		expect(decimalRatioPercent("1", "3")).toBe(33.33);
		expect(decimalRatioPercent("Infinity", "3")).toBe(0);
		expect(wholeDollarTopUpCents("25.000000000000000001", 1_000, 200_000)).toBe(2_600);
	});
});
