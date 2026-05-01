import { describe, expect, test } from "bun:test";
import {
	cn,
	formatAbsoluteTooltip,
	formatNumber,
	formatSessionSummary,
	recencyBucketFor,
	relativeTime,
} from "./utils";

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

	test("returns day-granularity under 7 days", () => {
		const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		expect(relativeTime(fiveDaysAgo)).toBe("5d ago");
	});

	test("switches to compact absolute at >=7 days (current year)", () => {
		const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
		const result = relativeTime(tenDaysAgo);
		// "May 1 14:30" or similar — month + day + 24h time, no year.
		// We don't assert exact format (locale-dependent) but verify
		// it's NOT the relative form.
		expect(result).not.toMatch(/ago$/);
		expect(result).not.toBe("just now");
	});

	test("returns em-dash for null/undefined/invalid", () => {
		expect(relativeTime(null)).toBe("—");
		expect(relativeTime(undefined)).toBe("—");
		expect(relativeTime("")).toBe("—");
		expect(relativeTime("not-a-date")).toBe("—");
	});
});

describe("formatAbsoluteTooltip", () => {
	test("returns a non-empty string for valid dates", () => {
		const result = formatAbsoluteTooltip(new Date().toISOString());
		expect(result.length).toBeGreaterThan(10);
	});

	test("returns em-dash for null/undefined/invalid", () => {
		expect(formatAbsoluteTooltip(null)).toBe("—");
		expect(formatAbsoluteTooltip(undefined)).toBe("—");
		expect(formatAbsoluteTooltip("")).toBe("—");
		expect(formatAbsoluteTooltip("garbage")).toBe("—");
	});
});

describe("recencyBucketFor", () => {
	const now = new Date("2026-05-01T12:00:00Z");

	test("today", () => {
		expect(recencyBucketFor("2026-05-01T09:00:00Z", now)).toEqual({
			key: "today",
			label: "Today",
		});
	});

	test("yesterday", () => {
		expect(recencyBucketFor("2026-04-30T15:00:00Z", now)).toEqual({
			key: "yesterday",
			label: "Yesterday",
		});
	});

	test("previous 7 days", () => {
		expect(recencyBucketFor("2026-04-28T10:00:00Z", now)).toEqual({
			key: "previous-7d",
			label: "Previous 7 days",
		});
	});

	test("previous 30 days", () => {
		expect(recencyBucketFor("2026-04-15T10:00:00Z", now)).toEqual({
			key: "previous-30d",
			label: "Previous 30 days",
		});
	});

	test("older same year groups by month", () => {
		const r = recencyBucketFor("2026-02-15T10:00:00Z", now);
		expect(r.key).toBe("2026-02");
		expect(r.label).toMatch(/Feb/);
	});

	test("cross-year groups by year", () => {
		const r = recencyBucketFor("2024-06-15T10:00:00Z", now);
		expect(r.key).toBe("2024");
		expect(r.label).toBe("2024");
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
