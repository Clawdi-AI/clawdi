import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const cardSource = readFileSync(new URL("./x402-card.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./wallet-page.tsx", import.meta.url), "utf8");

describe("x402 wallet availability", () => {
	test("keeps the card visible and labels the unavailable state", () => {
		expect(pageSource).toContain("<X402Card enabled={w.x402_enabled === true} />");
		expect(cardSource).toContain("Coming soon");
		expect(cardSource).toContain("Linked agent wallet");
		expect(cardSource).not.toContain("deposit address");
	});
});
