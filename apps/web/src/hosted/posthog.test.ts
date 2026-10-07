import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import posthog from "posthog-js";
import {
	enrichHostedUser,
	identifyHostedUser,
	isHostedPostHogEnabled,
	normalizePostHogToken,
	resetHostedPostHog,
	safeEventProperties,
	trackEvent,
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
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
	sdk.identify = originalIdentify;
	sdk.reset = originalReset;
	sdk.setPersonProperties = originalSetPersonProperties;
	mock.restore();
	for (const [key, descriptor] of [
		["window", originalWindow],
		["navigator", originalNavigator],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
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

	test("enrichHostedUser sets only opaque identity", () => {
		const setPersonProperties = mock(() => {});
		sdk.setPersonProperties = setPersonProperties;

		const called = enrichHostedUser(
			{
				clerk_id: "user_123",
			},
			{ isHosted: true, token: "phc_test_123" },
		);

		expect(called).toBe(true);
		expect(setPersonProperties).toHaveBeenCalledTimes(1);
		expect(setPersonProperties).toHaveBeenCalledWith({
			clerk_id: "user_123",
		});
	});
});

describe("product analytics events", () => {
	test("SDK capture honors consent and keeps the existing identity", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { location: { pathname: "/agents" } },
		});
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { doNotTrack: "0" },
		});
		const capture = spyOn(posthog, "capture").mockImplementation(() => undefined);
		const optedOut = spyOn(posthog, "has_opted_out_capturing").mockReturnValue(false);
		const options = { isHosted: true, token: "phc_test" };
		const event = { name: "product_viewed", properties: { feature: "agents" } } as const;
		expect(trackEvent(event, "desktop", options)).toBe(true);
		expect(capture).toHaveBeenCalledWith("product_viewed", {
			feature: "agents",
			source: "desktop",
			schema_version: 1,
		});
		optedOut.mockReturnValue(true);
		expect(trackEvent(event, "web", options)).toBe(false);
		optedOut.mockReturnValue(false);
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { doNotTrack: "1" },
		});
		expect(trackEvent(event, "web", options)).toBe(false);
		expect(trackEvent(event, "web", { isHosted: false, token: "phc_test" })).toBe(false);
		expect(capture).toHaveBeenCalledTimes(1);
	});
	test("final SDK properties retain alias/session identity and remove automatic PII", () => {
		expect(
			safeEventProperties(
				{
					distinct_id: "user_opaque",
					$anon_distinct_id: "anon_opaque",
					$session_id: "session_opaque",
					$current_url: "https://private.test/secret",
					$referrer: "https://private.test",
					$ip: "127.0.0.1",
					$set: { clerk_id: "user_opaque", email: "private@example.test", name: "Private" },
					$set_once: { $initial_current_url: "secret" },
					message: "PRIVATE MESSAGE",
				},
				"$pageview",
				"/agents/opaque/files",
			),
		).toEqual({
			distinct_id: "user_opaque",
			$anon_distinct_id: "anon_opaque",
			$session_id: "session_opaque",
			feature: "files",
			$set: { clerk_id: "user_opaque" },
		});
	});
	test("bounded UTM categories never forward private input", async () => {
		const { acquisitionProperties } = await import("./posthog");
		expect(
			acquisitionProperties(
				"?utm_source=github&utm_medium=referral&utm_campaign=launch",
				"https://google.com/search?q=private",
			),
		).toEqual({
			acquisition_source: "github",
			utm_source: "github",
			utm_medium: "referral",
			utm_campaign: "launch",
			referrer: "google",
		});
		const properties = acquisitionProperties(
			"?utm_source=private@example.test&utm_campaign=secret",
			"https://private.test/path?token=secret",
		);
		expect(
			safeEventProperties(
				{
					utm_source: "private@example.test",
					utm_campaign: "SECRET",
					referrer: "https://private.test/secret",
					feature: "/private/path",
				},
				"$pageview",
				"/agents",
			),
		).toEqual({ utm_source: "other", utm_campaign: "other", referrer: "other", feature: "agents" });
		expect(JSON.stringify(properties)).not.toContain("private");
		expect(JSON.stringify(properties)).not.toContain("secret");
	});
	test("route categories cover nested features without sending paths", async () => {
		const { featureForPath } = await import("./posthog");
		expect(featureForPath("/agents/opaque/skills")).toBe("skills");
		expect(featureForPath("/agents/opaque/files")).toBe("files");
		expect(featureForPath("/")).toBe("overview");
		expect(featureForPath("/vault-request")).toBeNull();
		expect(featureForPath("/share/secret")).toBeNull();
	});
});
