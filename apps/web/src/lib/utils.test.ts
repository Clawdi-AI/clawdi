import { describe, expect, test } from "bun:test";
import { cn, formatNumber, formatSessionSummary, relativeTime } from "./utils";

describe("cn", () => {
	test("merges class names", () => {
		expect(cn("foo", "bar")).toBe("foo bar");
	});

	test("dedupes conflicting tailwind classes (last wins)", () => {
		expect(cn("px-2", "px-4")).toBe("px-4");
	});

	test("drops falsy values", () => {
		expect(cn("foo", null, undefined, false && "bar", "baz")).toBe("foo baz");
	});
});

describe("relativeTime", () => {
	test('returns "just now" for recent timestamps', () => {
		const now = new Date().toISOString();
		expect(relativeTime(now)).toBe("just now");
	});

	test("returns minute-granularity for sub-hour diffs", () => {
		const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		expect(relativeTime(fiveMinAgo)).toBe("5m ago");
	});

	test("returns hour-granularity for sub-day diffs", () => {
		const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
		expect(relativeTime(threeHoursAgo)).toBe("3h ago");
	});

	test("returns day-granularity under 30 days", () => {
		const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		expect(relativeTime(fiveDaysAgo)).toBe("5d ago");
	});
});

describe("formatNumber", () => {
	test("formats thousands with k suffix", () => {
		expect(formatNumber(1500)).toBe("1.5k");
	});

	test("formats millions with M suffix", () => {
		expect(formatNumber(2_500_000)).toBe("2.5M");
	});

	test("leaves small numbers as plain strings", () => {
		expect(formatNumber(42)).toBe("42");
	});
});

describe("formatSessionSummary", () => {
	test("returns empty string for nullish input", () => {
		expect(formatSessionSummary(null)).toBe("");
		expect(formatSessionSummary(undefined)).toBe("");
		expect(formatSessionSummary("")).toBe("");
	});

	test("passes through plain text summaries unchanged", () => {
		expect(formatSessionSummary("Fixed the login bug")).toBe("Fixed the login bug");
	});

	test("extracts slash-command summary from Claude Code XML tags", () => {
		const raw =
			"<command-message>run tests</command-message>" +
			"<command-name>/test</command-name>" +
			"<command-args>backend</command-args>";
		expect(formatSessionSummary(raw)).toBe("/test backend");
	});
});
