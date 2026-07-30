import { describe, expect, it } from "bun:test";
import { parseRetryAfter } from "./retry-after";

describe("parseRetryAfter", () => {
	it("parses delta-seconds", () => {
		expect(parseRetryAfter("42")).toBe(42_000);
	});

	it("parses HTTP-date relative to the supplied clock", () => {
		const now = Date.parse("Wed, 21 Oct 2015 07:27:00 GMT");
		expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", { now })).toBe(60_000);
	});

	it("rejects expired and malformed values", () => {
		const now = Date.parse("Wed, 21 Oct 2015 07:29:00 GMT");
		expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", { now })).toBeNull();
		expect(parseRetryAfter("1.5")).toBeNull();
		expect(parseRetryAfter("later")).toBeNull();
	});

	it("clamps excessive and overflowing delays", () => {
		expect(parseRetryAfter("999999999999999999999")).toBe(300_000);
		expect(parseRetryAfter("600")).toBe(300_000);
	});
});
