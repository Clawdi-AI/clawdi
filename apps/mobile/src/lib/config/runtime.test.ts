import { describe, expect, test } from "bun:test";
import { parseMobileRuntimeConfig } from "@/lib/config/runtime-config";

function parseDevelopmentConfig(
	values: Parameters<typeof parseMobileRuntimeConfig>[0],
	options: { requireClerk?: boolean } = {},
) {
	return parseMobileRuntimeConfig(values, { ...options, isDevelopment: true });
}

describe("mobile runtime configuration", () => {
	test("OAuth choices are explicit, SDK-named and never inferred from arbitrary configuration", () => {
		const base = {
			cloudApiUrl: "https://api.example.test",
			clerkPublishableKey: "pk_test_example",
		};
		expect(
			parseDevelopmentConfig({
				...base,
				clerkOauthProviders: "google, github,google,custom_team",
			}),
		).toEqual({
			ok: true,
			value: { ...base, clerkOauthProviders: ["google", "github", "custom_team"] },
		});
		for (const clerkOauthProviders of [
			"unknown",
			"google,",
			"__proto__",
			"custom_",
			"custom_../../secret",
			["google"],
			42,
		]) {
			expect(parseDevelopmentConfig({ ...base, clerkOauthProviders })).toEqual({
				ok: false,
				reason: "invalid",
			});
		}
	});
	test("requires both the Cloud URL and Clerk publishable key", () => {
		expect(
			parseDevelopmentConfig({ cloudApiUrl: undefined, clerkPublishableKey: undefined }),
		).toEqual({ ok: false, reason: "missing" });
	});

	test("only the explicit dev configuration may omit the Clerk key", () => {
		const values = {
			cloudApiUrl: "http://10.0.2.2:8787",
			clerkPublishableKey: undefined,
		};
		expect(parseDevelopmentConfig(values)).toEqual({ ok: false, reason: "missing" });
		expect(parseDevelopmentConfig(values, { requireClerk: false })).toEqual({
			ok: true,
			value: { cloudApiUrl: values.cloudApiUrl, clerkPublishableKey: "" },
		});
	});

	test("dev configuration still requires a safe Cloud URL and rejects malformed Clerk keys", () => {
		expect(
			parseDevelopmentConfig(
				{ cloudApiUrl: undefined, clerkPublishableKey: undefined },
				{ requireClerk: false },
			),
		).toEqual({ ok: false, reason: "missing" });
		for (const cloudApiUrl of [
			"http://user:password@10.0.2.2:8787",
			"http://10.0.2.2:8787?token=forbidden",
			"file:///fixture",
		]) {
			expect(
				parseDevelopmentConfig(
					{ cloudApiUrl, clerkPublishableKey: undefined },
					{ requireClerk: false },
				),
			).toEqual({ ok: false, reason: "invalid" });
		}
		expect(
			parseDevelopmentConfig(
				{ cloudApiUrl: "http://10.0.2.2:8787", clerkPublishableKey: "not_publishable" },
				{ requireClerk: false },
			),
		).toEqual({ ok: false, reason: "invalid" });
	});

	test("rejects credentials and malformed Clerk keys", () => {
		expect(
			parseDevelopmentConfig({
				cloudApiUrl: "https://api.example.test?query=forbidden",
				clerkPublishableKey: "pk_test_example",
			}),
		).toEqual({ ok: false, reason: "invalid" });
		expect(
			parseDevelopmentConfig({
				cloudApiUrl: "https://api.example.test",
				clerkPublishableKey: "sk_test_not_publishable",
			}),
		).toEqual({ ok: false, reason: "invalid" });
	});

	test("normalizes a valid public configuration", () => {
		expect(
			parseDevelopmentConfig({
				cloudApiUrl: " https://api.example.test/// ",
				clerkPublishableKey: " pk_test_abc-123 ",
			}),
		).toEqual({
			ok: true,
			value: {
				cloudApiUrl: "https://api.example.test",
				clerkPublishableKey: "pk_test_abc-123",
			},
		});
	});

	test("enables optional v2 compute without requiring legacy Hosted configuration", () => {
		expect(
			parseDevelopmentConfig({
				cloudApiUrl: "https://cloud.example.test",
				clerkPublishableKey: "pk_test_example",
				computeApiUrl: " https://compute.example.test/v2/// ",
			}),
		).toEqual({
			ok: true,
			value: {
				cloudApiUrl: "https://cloud.example.test",
				clerkPublishableKey: "pk_test_example",
				computeApiUrl: "https://compute.example.test",
			},
		});
	});

	test("rejects an explicitly configured unsafe compute endpoint", () => {
		for (const computeApiUrl of [
			"https://user:password@compute.example.test",
			"https://compute.example.test?token=forbidden",
			"file:///compute",
			42,
			{ url: "https://compute.example.test" },
		]) {
			expect(
				parseDevelopmentConfig({
					cloudApiUrl: "https://cloud.example.test",
					clerkPublishableKey: "pk_test_example",
					computeApiUrl,
				}),
			).toEqual({ ok: false, reason: "invalid" });
		}
	});
});

describe("release configuration", () => {
	const values = {
		cloudApiUrl: "https://cloud-api.clawdi.ai",
		computeApiUrl: "https://api.clawdi.ai/v2/",
		clerkPublishableKey: "pk_live_example",
	};
	test("requires compute for account deletion in every non-development build", () => {
		for (const computeApiUrl of [undefined, "", "   "]) {
			expect(parseMobileRuntimeConfig({ ...values, computeApiUrl })).toEqual({
				ok: false,
				reason: "missing",
			});
		}
	});
	test("rejects cleartext for either API in preview and production", () => {
		for (const channel of ["preview", "production"]) {
			for (const key of ["cloudApiUrl", "computeApiUrl"]) {
				expect(
					parseMobileRuntimeConfig({ ...values, [key]: "http://api.example.test" }, { channel }),
				).toEqual({ ok: false, reason: "invalid" });
			}
		}
	});
	test("requires a live Clerk key on the production channel", () => {
		expect(
			parseMobileRuntimeConfig(
				{ ...values, clerkPublishableKey: "pk_test_example" },
				{ channel: "production" },
			),
		).toEqual({ ok: false, reason: "invalid" });
		expect(
			parseMobileRuntimeConfig(
				{ ...values, clerkPublishableKey: "pk_test_example" },
				{ channel: "preview" },
			).ok,
		).toBe(true);
		expect(parseMobileRuntimeConfig(values, { channel: "production" })).toEqual({
			ok: true,
			value: { ...values, computeApiUrl: "https://api.clawdi.ai" },
		});
	});
	test("cannot relax authentication or enable fixture auth outside development", () => {
		expect(parseMobileRuntimeConfig(values, { requireClerk: false })).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(parseMobileRuntimeConfig(values, { devAuthBypass: true })).toEqual({
			ok: false,
			reason: "invalid",
		});
	});
});
