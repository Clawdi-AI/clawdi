/**
 * `formatModelLabel` regressed twice already — first with hardcoded regex
 * for `claude-{family}-{major}-{minor}` (broke older `claude-3-5-sonnet-…`
 * shape), then with too-narrow GPT/o-series matchers. These tests pin the
 * expected output for every real-world id we've seen in production, so
 * future tweaks don't quietly drop a family.
 */

import { describe, expect, it } from "bun:test";
import { formatDuration, formatModelLabel } from "./format";

describe("formatModelLabel", () => {
	it.each([
		["claude-opus-4-7", "Opus 4.7"],
		["claude-sonnet-4-6", "Sonnet 4.6"],
		["claude-haiku-4-5", "Haiku 4.5"],
		// trailing date is dropped (single-segment YYYYMMDD)
		["claude-haiku-4-5-20251001", "Haiku 4.5"],
		// single major version with date suffix
		["claude-opus-4-20250514", "Opus 4"],
		// older shape: numbers come BEFORE the family in 3.5/3.7
		["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
		["claude-3-7-sonnet-20250219", "Sonnet 3.7"],
		// GPT family
		["gpt-5.4", "GPT 5.4"],
		["gpt-5.4-codex", "GPT 5.4 Codex"],
		["gpt-5.3-codex-preview", "GPT 5.3 Codex Preview"],
		// 4o + dated suffix (YYYY-MM-DD form)
		["gpt-4o", "GPT 4o"],
		["gpt-4o-2024-08-06", "GPT 4o"],
		// OpenAI o-series
		["o3", "O3"],
		["o3-mini", "O3 Mini"],
		["o4-mini", "O4 Mini"],
		// Unknown family — pass through unchanged
		["llama-3.1-70b", "llama-3.1-70b"],
		["mistral-large", "mistral-large"],
	])("%s → %s", (input, expected) => {
		expect(formatModelLabel(input)).toBe(expected);
	});

	it("returns empty string for null/undefined/empty", () => {
		expect(formatModelLabel(null)).toBe("");
		expect(formatModelLabel(undefined)).toBe("");
		expect(formatModelLabel("")).toBe("");
		expect(formatModelLabel("   ")).toBe("");
	});

	it("preserves the original casing on unknown shapes", () => {
		// Pass-through must not lowercase — the user's API id is what they
		// recognize. Only normalized known families get title-cased.
		expect(formatModelLabel("UnknownModel-X1")).toBe("UnknownModel-X1");
	});
});

describe("formatDuration", () => {
	it.each([
		[null, "—"],
		[undefined, "—"],
		[0, "—"], // 0 → no useful info, matches null treatment
		[1, "1s"],
		[59, "59s"],
		[60, "1m"],
		[180, "3m"],
		[3599, "59m"],
		[3600, "1h 0m"],
		[3660, "1h 1m"],
		[7200, "2h 0m"],
	])("%s → %s", (input, expected) => {
		expect(formatDuration(input)).toBe(expected);
	});
});
