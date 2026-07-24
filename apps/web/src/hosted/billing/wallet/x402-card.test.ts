import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const cardSource = readFileSync(new URL("./x402-card.tsx", import.meta.url), "utf8");

describe("x402 deposit safety", () => {
	test("hides an address when the response cannot confirm network and token", () => {
		expect(cardSource).toContain("Contact support for deposit details");
		expect(cardSource).toContain("wrong network");
		expect(cardSource).toContain("wrong token");
		expect(cardSource).toContain('href="mailto:support@clawdi.ai"');
		expect(cardSource).not.toContain("Copy deposit address");
	});
});
