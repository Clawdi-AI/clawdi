import { describe, expect, test } from "bun:test";
import { nativeTransportSummary, pairCodeRequiresExplicitAgent } from "./channel-detail-page.logic";

describe("pairCodeRequiresExplicitAgent", () => {
	test("only permits the implicit linked-agent default for exactly one link", () => {
		expect(pairCodeRequiresExplicitAgent(0)).toBe(true);
		expect(pairCodeRequiresExplicitAgent(1)).toBe(false);
		expect(pairCodeRequiresExplicitAgent(2)).toBe(true);
	});
});

describe("nativeTransportSummary", () => {
	test("maps internal transport fields to user-facing labels", () => {
		expect(
			nativeTransportSummary({
				available: false,
				mode: "none",
				reason: "shared-bot-transport-unavailable",
				supportsOutboundMessages: false,
				supportsRawRelay: false,
			}),
		).toEqual({
			status: "Unavailable",
			connection: "Not connected",
			delivery: "Unavailable",
		});
	});

	test("does not surface unknown internal values", () => {
		expect(
			nativeTransportSummary({ mode: "future_internal_mode", reason: "private-enum" }),
		).toEqual({
			status: "Unknown",
			connection: "Details unavailable",
			delivery: "Unknown",
		});
	});
});
