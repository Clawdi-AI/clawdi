import { describe, expect, test } from "bun:test";
import {
	acknowledgeRotatedToken,
	hasAtRiskRotatedToken,
	nativeTransportSummary,
	pairCodeRequiresExplicitAgent,
	rotatedTokenDisplayState,
} from "./channel-detail-page.logic";

describe("pairCodeRequiresExplicitAgent", () => {
	test("only permits the implicit linked-agent default for exactly one link", () => {
		expect(pairCodeRequiresExplicitAgent(0)).toBe(true);
		expect(pairCodeRequiresExplicitAgent(1)).toBe(false);
		expect(pairCodeRequiresExplicitAgent(2)).toBe(true);
	});
});

describe("rotated token display state", () => {
	test("keeps a returned token at risk until the user acknowledges it", () => {
		const state = rotatedTokenDisplayState("one-time-secret");

		expect(state).toEqual({
			status: "available",
			token: "one-time-secret",
			acknowledged: false,
		});
		expect(hasAtRiskRotatedToken({ link: state }, false)).toBe(true);
		expect(hasAtRiskRotatedToken({ link: acknowledgeRotatedToken(state) }, false)).toBe(false);
	});

	test("treats an absent response token as unrecoverable and guards pending rotations", () => {
		expect(rotatedTokenDisplayState(null)).toEqual({ status: "unrecoverable" });
		expect(rotatedTokenDisplayState("   ")).toEqual({ status: "unrecoverable" });
		expect(hasAtRiskRotatedToken({}, true)).toBe(true);
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
