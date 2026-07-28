import { afterEach, describe, expect, test } from "bun:test";
import { safeBrowserNavigationUrl, safeExternalNavigationUrl } from "@/lib/external-navigation";

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
	if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
	else Reflect.deleteProperty(globalThis, "window");
});

describe("external navigation policy", () => {
	test("accepts HTTPS, loopback HTTP, and static same-origin relative references", () => {
		expect(safeExternalNavigationUrl("https://checkout.stripe.test/session")).toBe(
			"https://checkout.stripe.test/session",
		);
		expect(safeExternalNavigationUrl("/receipts/r_1?download=1#total")).toBe(
			"/receipts/r_1?download=1#total",
		);
		expect(safeExternalNavigationUrl("/portal", "http://127.0.0.1:3100/settings")).toBe(
			"http://127.0.0.1:3100/portal",
		);
		for (const target of [
			"receipt.pdf",
			"./receipts/r_1",
			"../invoices/i_1",
			"?download=1",
			"#total",
		]) {
			expect(safeExternalNavigationUrl(target)).toBe(target);
		}
	});

	test("resolves same-origin relative targets at the browser boundary", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { location: { href: "http://localhost:3100/settings?tab=billing" } },
		});

		expect(safeBrowserNavigationUrl("/receipts/r_1")).toBe("http://localhost:3100/receipts/r_1");
		expect(safeBrowserNavigationUrl("./portal")).toBe("http://localhost:3100/portal");
		expect(safeBrowserNavigationUrl("receipt.pdf")).toBe("http://localhost:3100/receipt.pdf");
		expect(safeBrowserNavigationUrl("../invoice")).toBe("http://localhost:3100/invoice");
		expect(safeBrowserNavigationUrl("?download=1")).toBe(
			"http://localhost:3100/settings?download=1",
		);
		expect(safeBrowserNavigationUrl("#total")).toBe(
			"http://localhost:3100/settings?tab=billing#total",
		);

		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { location: { href: "http://clawdi.internal/settings" } },
		});
		expect(safeBrowserNavigationUrl("../invoice")).toBe("http://clawdi.internal/invoice");
		expect(safeBrowserNavigationUrl("http://clawdi.internal/invoice")).toBeNull();
	});

	test("rejects executable schemes, credentials, malformed values, and blanks", () => {
		for (const target of [
			"javascript:alert(1)",
			"data:text/html,boom",
			"file:///etc/passwd",
			"http://billing.example.com/insecure",
			"https:////evil.example/receipt",
			"https://user:secret@example.com",
			"//evil.example/receipt",
			"/\\evil.example/receipt",
			"..\\evil.example/receipt",
			"\nhttps://billing.example.com/receipt",
			"/receipt\u0085",
			"",
		]) {
			expect(safeExternalNavigationUrl(target)).toBeNull();
		}
	});
});
