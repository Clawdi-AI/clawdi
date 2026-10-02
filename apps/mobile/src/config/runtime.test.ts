import { describe, expect, test } from "bun:test";
import { parseMobileRuntimeConfig } from "./runtime-config";

describe("mobile runtime configuration", () => {
	test("requires both the Cloud URL and Clerk publishable key", () => {
		expect(
			parseMobileRuntimeConfig({ cloudApiUrl: undefined, clerkPublishableKey: undefined }),
		).toEqual({ ok: false, reason: "missing" });
	});

	test("rejects credentials and malformed Clerk keys", () => {
		expect(
			parseMobileRuntimeConfig({
				cloudApiUrl: "https://api.example.test?query=forbidden",
				clerkPublishableKey: "pk_test_example",
			}),
		).toEqual({ ok: false, reason: "invalid" });
		expect(
			parseMobileRuntimeConfig({
				cloudApiUrl: "https://api.example.test",
				clerkPublishableKey: "sk_test_not_publishable",
			}),
		).toEqual({ ok: false, reason: "invalid" });
	});

	test("normalizes a valid public configuration", () => {
		expect(
			parseMobileRuntimeConfig({
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
});
