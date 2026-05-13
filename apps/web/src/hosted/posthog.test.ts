import { afterEach, describe, expect, mock, test } from "bun:test";
import posthog from "posthog-js";
import {
	enrichHostedUser,
	identifyHostedUser,
	isHostedPostHogEnabled,
	normalizePostHogToken,
	resetHostedPostHog,
} from "@/hosted/posthog";

type MutablePostHog = {
	identify?: (distinctId: string, properties?: Record<string, unknown>) => void;
	reset?: () => void;
	setPersonProperties?: (properties: Record<string, unknown>) => void;
};

const sdk = posthog as MutablePostHog;
const originalIdentify = sdk.identify;
const originalReset = sdk.reset;
const originalSetPersonProperties = sdk.setPersonProperties;

afterEach(() => {
	sdk.identify = originalIdentify;
	sdk.reset = originalReset;
	sdk.setPersonProperties = originalSetPersonProperties;
});

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

describe("hosted identity helpers", () => {
	test("identifyHostedUser identifies with clerk_id when hosted posthog is enabled", () => {
		const identify = mock(() => {});
		sdk.identify = identify;

		const called = identifyHostedUser("user_123", { isHosted: true, token: "phc_test_123" });

		expect(called).toBe(true);
		expect(identify).toHaveBeenCalledTimes(1);
		expect(identify).toHaveBeenCalledWith("user_123", { clerk_id: "user_123" });
	});

	test("identifyHostedUser is a no-op when posthog is disabled", () => {
		const identify = mock(() => {});
		sdk.identify = identify;

		const called = identifyHostedUser("user_123", { isHosted: false, token: "phc_test_123" });

		expect(called).toBe(false);
		expect(identify).not.toHaveBeenCalled();
	});

	test("resetHostedPostHog resets on sign-out when enabled", () => {
		const reset = mock(() => {});
		sdk.reset = reset;

		const called = resetHostedPostHog({ isHosted: true, token: "phc_test_123" });

		expect(called).toBe(true);
		expect(reset).toHaveBeenCalledTimes(1);
	});

	test("enrichHostedUser sets person properties with email/name/clerk_id", () => {
		const setPersonProperties = mock(() => {});
		sdk.setPersonProperties = setPersonProperties;

		const called = enrichHostedUser(
			{
				clerk_id: "user_123",
				email: "ada@example.com",
				name: "Ada Lovelace",
			},
			{ isHosted: true, token: "phc_test_123" },
		);

		expect(called).toBe(true);
		expect(setPersonProperties).toHaveBeenCalledTimes(1);
		expect(setPersonProperties).toHaveBeenCalledWith({
			clerk_id: "user_123",
			email: "ada@example.com",
			name: "Ada Lovelace",
		});
	});
});
