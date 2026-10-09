import { describe, expect, test } from "bun:test";
import {
	fallbackTimezones,
	hostedDeployLanguageFromLocales,
	isValidTimezone,
	mergeTimezoneOptions,
	supportedTimezones,
} from "./deploy-locale";

describe("timezone options", () => {
	test("uses validated, sorted, deduplicated runtime IANA data and always includes UTC", () => {
		expect(
			supportedTimezones(
				[],
				["Europe/London", "Invalid/Timezone", "America/New_York", "Europe/London"],
			),
		).toEqual(["America/New_York", "Europe/London", "UTC"]);
	});

	test("uses a standards-valid fallback without supportedValuesOf", () => {
		const fallback = fallbackTimezones();
		expect(fallback).toContain("UTC");
		expect(fallback).toContain("America/New_York");
		expect(fallback).toContain("Asia/Tokyo");
		expect(fallback).toEqual([...fallback].sort());
		expect(fallback.every(isValidTimezone)).toBe(true);
	});

	test("preserves valid current values omitted from runtime enumeration", () => {
		expect(mergeTimezoneOptions(["UTC"], ["Etc/UTC", "Not/AZone"])).toEqual(["Etc/UTC", "UTC"]);
	});
});

describe("hostedDeployLanguageFromLocales", () => {
	test("matches exact codes, then base languages, in preference order", () => {
		expect(hostedDeployLanguageFromLocales(["zh-TW"])).toBe("zh-TW");
		expect(hostedDeployLanguageFromLocales(["en-US"])).toBe("en");
		expect(hostedDeployLanguageFromLocales(["xx-YY", "fr-FR"])).toBe("fr");
	});

	test("returns unset when nothing is supported", () => {
		expect(hostedDeployLanguageFromLocales(["xx-YY", ""])).toBe("");
	});
});
