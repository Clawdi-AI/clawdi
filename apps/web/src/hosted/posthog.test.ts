import { describe, expect, test } from "bun:test";
import { isHostedPostHogEnabled, normalizePostHogToken } from "@/hosted/posthog";

describe("normalizePostHogToken", () => {
	test("returns null for undefined", () => {
		expect(normalizePostHogToken(undefined)).toBeNull();
	});

	test("returns null for blank strings", () => {
		expect(normalizePostHogToken("")).toBeNull();
		expect(normalizePostHogToken("   ")).toBeNull();
	});

	test("trims and returns non-empty tokens", () => {
		expect(normalizePostHogToken("  phc_test_123  ")).toBe("phc_test_123");
	});
});

describe("isHostedPostHogEnabled", () => {
	test("is false in OSS builds even with a token", () => {
		expect(isHostedPostHogEnabled({ isHosted: false, token: "phc_test_123" })).toBe(false);
	});

	test("is false in hosted builds when token is missing", () => {
		expect(isHostedPostHogEnabled({ isHosted: true, token: undefined })).toBe(false);
	});

	test("is true only when hosted and token is non-empty", () => {
		expect(isHostedPostHogEnabled({ isHosted: true, token: "phc_test_123" })).toBe(true);
		expect(isHostedPostHogEnabled({ isHosted: true, token: "  phc_test_123  " })).toBe(true);
	});
});
