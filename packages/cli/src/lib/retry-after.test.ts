import { describe, expect, it } from "bun:test";
import { MAX_SAFE_RETRY_AFTER_MS, parseRetryAfter } from "./retry-after";

describe("parseRetryAfter", () => {
	it("parses non-negative delta-seconds, including zero", () => {
		expect(parseRetryAfter("42")).toBe(42_000);
		expect(parseRetryAfter("0")).toBe(0);
	});

	it.each([
		"Sun, 06 Nov 1994 08:49:37 GMT",
		"Sunday, 06-Nov-94 08:49:37 GMT",
		"Sun Nov  6 08:49:37 1994",
	])("parses the standard HTTP-date form %s", (value) => {
		const now = Date.parse("Sun, 06 Nov 1994 08:48:37 GMT");
		expect(parseRetryAfter(value, { now })).toBe(60_000);
	});

	it("treats current and expired HTTP-date values as zero delay", () => {
		const now = Date.parse("Wed, 21 Oct 2015 07:29:00 GMT");
		expect(parseRetryAfter("Wed, 21 Oct 2015 07:29:00 GMT", { now })).toBe(0);
		expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", { now })).toBe(0);
	});

	it("rejects malformed and non-HTTP date values", () => {
		expect(parseRetryAfter("1.5")).toBeNull();
		expect(parseRetryAfter("later")).toBeNull();
		expect(parseRetryAfter("2015-10-21T07:28:00Z")).toBeNull();
	});

	it("has no hidden five-minute policy", () => {
		expect(parseRetryAfter("600")).toBe(600_000);
	});

	it("safely saturates arbitrarily large digit strings at an explicit bound", () => {
		const hugeDelta = "9".repeat(10_000);
		expect(parseRetryAfter(hugeDelta)).toBe(MAX_SAFE_RETRY_AFTER_MS);
		expect(parseRetryAfter(hugeDelta, { maxMs: 300_000 })).toBe(300_000);
	});
});
