import { describe, expect, test } from "bun:test";
import {
	fallbackTimezones,
	isValidTimezone,
	mergeTimezoneOptions,
	supportedTimezones,
} from "@/hosted/billing/deploy/language-timezone-controls";

describe("timezone options", () => {
	test("uses validated, sorted, deduplicated runtime IANA data and always includes UTC", () => {
		expect(
			supportedTimezones(
				[],
				["Europe/London", "Invalid/Timezone", "America/New_York", "Europe/London"],
			),
		).toEqual(["America/New_York", "Europe/London", "UTC"]);
	});

	test("uses a small standards-valid fallback without supportedValuesOf", () => {
		const fallback = fallbackTimezones();
		expect(fallback).toContain("UTC");
		expect(fallback).toContain("America/New_York");
		expect(fallback).toContain("Asia/Tokyo");
		expect(fallback.length).toBeLessThan(25);
		expect(fallback).toEqual([...fallback].sort());
		expect(fallback.every(isValidTimezone)).toBe(true);
	});

	test("preserves valid current values omitted from runtime enumeration", () => {
		expect(mergeTimezoneOptions(["UTC"], ["Etc/UTC", "Not/AZone"])).toEqual(["Etc/UTC", "UTC"]);
	});
});
