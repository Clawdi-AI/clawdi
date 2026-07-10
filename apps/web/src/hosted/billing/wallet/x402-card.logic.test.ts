import { describe, expect, test } from "bun:test";
import { shouldShowX402Card } from "@/hosted/billing/wallet/x402-card.logic";

describe("shouldShowX402Card", () => {
	test("hides x402 while the wallet snapshot says the backend routes are disabled", () => {
		expect(shouldShowX402Card({ x402_enabled: false })).toBe(false);
		expect(shouldShowX402Card(undefined)).toBe(false);
	});

	test("shows x402 when the wallet snapshot says the backend routes are enabled", () => {
		expect(shouldShowX402Card({ x402_enabled: true })).toBe(true);
	});
});
