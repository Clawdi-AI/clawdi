import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import posthog from "posthog-js";
import {
	identifyHostedUser,
	initHostedPostHog,
	isHostedPostHogEnabled,
	normalizePostHogToken,
	resetHostedPostHog,
	safeEventProperties,
	trackEvent,
} from "@/hosted/posthog";

type MutablePostHog = {
	identify?: (distinctId: string, properties?: Record<string, unknown>) => void;
	reset?: () => void;
};

const sdk = posthog as MutablePostHog;
const originalIdentify = sdk.identify;
const originalReset = sdk.reset;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLoaded = Object.getOwnPropertyDescriptor(posthog, "__loaded");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const productionLocation = { protocol: "https:", hostname: "cloud.clawdi.ai", pathname: "/agents" };

beforeEach(() => {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { location: { ...productionLocation } },
	});
});

afterEach(() => {
	sdk.identify = originalIdentify;
	sdk.reset = originalReset;
	mock.restore();
	if (originalLoaded) Object.defineProperty(posthog, "__loaded", originalLoaded);
	else Reflect.deleteProperty(posthog, "__loaded");
	for (const [key, descriptor] of [
		["window", originalWindow],
		["navigator", originalNavigator],
		["document", originalDocument],
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

	test("all SDK entry points reject local, preview and non-production hosts", () => {
		const init = spyOn(posthog, "init").mockImplementation(() => posthog);
		const identify = spyOn(posthog, "identify").mockImplementation(() => {});
		const reset = spyOn(posthog, "reset").mockImplementation(() => {});
		const capture = spyOn(posthog, "capture").mockImplementation(() => undefined);
		const options = { isHosted: true, token: "phc_fixture" };
		for (const hostname of [
			"localhost",
			"127.0.0.1",
			"[::1]",
			"preview.clawdi.ai",
			"cloud-preview.clawdi.ai",
			"preview.vercel.app",
			"cloud.clawdi.ai.example.test",
		]) {
			window.location.hostname = hostname;
			expect(isHostedPostHogEnabled(options)).toBe(false);
			expect(initHostedPostHog(options)).toBe(false);
			expect(identifyHostedUser("user_fixture", options)).toBe(false);
			expect(resetHostedPostHog(options)).toBe(false);
			expect(trackEvent({ name: "agent_setup_opened", properties: {} }, options)).toBe(false);
		}
		window.location.hostname = productionLocation.hostname;
		window.location.protocol = "http:";
		expect(isHostedPostHogEnabled(options)).toBe(false);
		Reflect.deleteProperty(globalThis, "window");
		expect(isHostedPostHogEnabled(options)).toBe(false);
		expect(init).not.toHaveBeenCalled();
		expect(identify).not.toHaveBeenCalled();
		expect(reset).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
	});

	test("unset tokens disable init, identify, reset and capture on production", () => {
		const init = spyOn(posthog, "init").mockImplementation(() => posthog);
		const identify = spyOn(posthog, "identify").mockImplementation(() => {});
		const reset = spyOn(posthog, "reset").mockImplementation(() => {});
		const capture = spyOn(posthog, "capture").mockImplementation(() => undefined);
		for (const token of [undefined, "", "   "]) {
			const options = { isHosted: true, token };
			expect(initHostedPostHog(options)).toBe(false);
			expect(identifyHostedUser("user_fixture", options)).toBe(false);
			expect(resetHostedPostHog(options)).toBe(false);
			expect(trackEvent({ name: "agent_setup_opened", properties: {} }, options)).toBe(false);
		}
		expect(init).not.toHaveBeenCalled();
		expect(identify).not.toHaveBeenCalled();
		expect(reset).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
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
});

describe("product analytics events", () => {
	test("SDK pageviews own view capture, with bounded auth acquisition and no private URLs", () => {
		const location = {
			...productionLocation,
			pathname: "/sign-up",
			search: "?utm_source=github&utm_medium=referral&utm_campaign=launch",
		};
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { location, localStorage: { removeItem: () => {} } },
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: { referrer: "https://google.com/private?token=private" },
		});
		Object.defineProperty(posthog, "__loaded", {
			configurable: true,
			writable: true,
			value: false,
		});
		const init = spyOn(posthog, "init").mockImplementation(() => posthog);
		expect(initHostedPostHog({ isHosted: true, token: "test-key" })).toBe(true);
		const options = init.mock.calls[0]?.[1];
		expect(options).toMatchObject({
			capture_pageview: "history_change",
			capture_pageleave: false,
			autocapture: false,
			person_profiles: "identified_only",
			disable_session_recording: true,
		});
		const beforeSend = options?.before_send;
		if (typeof beforeSend !== "function") throw new Error("Missing SDK boundary");
		const payload = {
			uuid: "fixture",
			event: "$pageview",
			properties: {
				$host: "cloud.example.test",
				$current_url: "https://cloud.example.test/sign-up?token=private",
				$pathname: "/private/path",
			},
		};
		expect(beforeSend(payload)?.properties).toEqual({
			$host: "cloud.example.test",
			feature: "sign_up",
			source: "web",
			schema_version: 1,
			acquisition_source: "github",
			utm_source: "github",
			utm_medium: "referral",
			utm_campaign: "launch",
			referrer: "google",
		});
		location.pathname = "/sign-in/continue";
		expect(beforeSend(payload)?.properties.feature).toBe("sign_in");
		location.pathname = "/deploy";
		expect(beforeSend(payload)?.properties.feature).toBe("deploy");
		location.pathname = "/vault-request";
		expect(beforeSend(payload)).toBeNull();
		location.pathname = "/agents";
		location.hostname = "localhost";
		expect(beforeSend(payload)).toBeNull();
	});
	test("the host property never forwards URL credentials, paths or query strings", () => {
		for (const host of [
			"private@example.test",
			"example.test/private",
			"example.test?token=private",
			"https://example.test",
		]) {
			expect(safeEventProperties({ $host: host }, "$pageview", "/agents")).toEqual({
				feature: "agents",
			});
		}
	});
	test("SDK capture honors consent and keeps the existing identity", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { location: { ...productionLocation } },
		});
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { doNotTrack: "0" },
		});
		const capture = spyOn(posthog, "capture").mockImplementation(() => undefined);
		const optedOut = spyOn(posthog, "has_opted_out_capturing").mockReturnValue(false);
		const options = { isHosted: true, token: "phc_test" };
		const event = { name: "agent_setup_opened", properties: {} } as const;
		expect(trackEvent(event, options)).toBe(true);
		expect(capture).toHaveBeenCalledWith("agent_setup_opened", {
			source: "web",
			schema_version: 1,
		});
		optedOut.mockReturnValue(true);
		expect(trackEvent(event, options)).toBe(false);
		optedOut.mockReturnValue(false);
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { doNotTrack: "1" },
		});
		expect(trackEvent(event, options)).toBe(false);
		expect(trackEvent(event, { isHosted: false, token: "phc_test" })).toBe(false);
		expect(capture).toHaveBeenCalledTimes(1);
	});
	test("final SDK properties retain alias/session identity and remove automatic PII", () => {
		expect(
			safeEventProperties(
				{
					distinct_id: "user_opaque",
					$anon_distinct_id: "anon_opaque",
					$session_id: "session_opaque",
					$process_person_profile: false,
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
			$process_person_profile: false,
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
