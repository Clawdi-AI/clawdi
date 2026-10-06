import { describe, expect, test } from "bun:test";
import { nativeTransportSummary } from "./channel-health-tab";

describe("nativeTransportSummary", () => {
	test("maps internal transport fields to user-facing labels", () => {
		expect(
			nativeTransportSummary({
				available: false,
				mode: "none",
				reason: "shared-bot-transport-unavailable",
				supportsOutboundMessages: false,
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
