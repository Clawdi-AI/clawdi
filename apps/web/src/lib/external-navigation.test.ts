import { afterEach, describe, expect, test } from "bun:test";
import { safeBrowserNavigationUrl, safeExternalNavigationUrl } from "@/lib/external-navigation";

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
	if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
	else Reflect.deleteProperty(globalThis, "window");
});

describe("external navigation policy", () => {
	test("accepts HTTPS service targets, loopback HTTP, and static root-relative anchors", () => {
		expect(safeExternalNavigationUrl("https://checkout.stripe.test/session")).toBe(
			"https://checkout.stripe.test/session",
		);
		expect(safeExternalNavigationUrl("/receipts/r_1?download=1#total")).toBe(
			"/receipts/r_1?download=1#total",
		);
		expect(safeExternalNavigationUrl("/portal", "http://127.0.0.1:3100/settings")).toBe(
			"http://127.0.0.1:3100/portal",
		);
	});

	test("resolves same-origin relative targets at the browser boundary", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { location: { href: "http://localhost:3100/settings?tab=billing" } },
		});

		expect(safeBrowserNavigationUrl("/receipts/r_1")).toBe("http://localhost:3100/receipts/r_1");
		expect(safeBrowserNavigationUrl("./portal")).toBe("http://localhost:3100/portal");
	});

	test("rejects executable schemes, credentials, malformed values, and blanks", () => {
		for (const target of [
			"javascript:alert(1)",
			"data:text/html,boom",
			"file:///etc/passwd",
			"http://billing.example.com/insecure",
			"https://user:secret@example.com",
			"//evil.example/receipt",
			"/\\evil.example/receipt",
			"not an absolute url",
			"",
		]) {
			expect(safeExternalNavigationUrl(target)).toBeNull();
		}
	});
});
