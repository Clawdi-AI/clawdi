import { describe, expect, test } from "bun:test";
import { safeExternalNavigationUrl } from "@/lib/external-navigation";

describe("external navigation policy", () => {
	test("accepts HTTP(S) service targets and same-document relative targets", () => {
		expect(safeExternalNavigationUrl("https://checkout.stripe.test/session")).toBe(
			"https://checkout.stripe.test/session",
		);
		expect(safeExternalNavigationUrl("/portal", "http://127.0.0.1:3100/settings")).toBe(
			"http://127.0.0.1:3100/portal",
		);
	});

	test("rejects executable schemes, credentials, malformed values, and blanks", () => {
		for (const target of [
			"javascript:alert(1)",
			"data:text/html,boom",
			"file:///etc/passwd",
			"https://user:secret@example.com",
			"not an absolute url",
			"",
		]) {
			expect(safeExternalNavigationUrl(target)).toBeNull();
		}
	});
});
