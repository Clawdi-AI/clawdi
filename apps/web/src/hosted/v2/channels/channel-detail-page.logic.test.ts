import { describe, expect, test } from "bun:test";
import {
	nativeTransportSummary,
	pairCodeExpiryLabel,
	pairCodeRequiresExplicitAgent,
	telegramPairDeepLink,
} from "./channel-detail-page.logic";

describe("pairCodeRequiresExplicitAgent", () => {
	test("only permits the implicit linked-agent default for exactly one link", () => {
		expect(pairCodeRequiresExplicitAgent(0)).toBe(true);
		expect(pairCodeRequiresExplicitAgent(1)).toBe(false);
		expect(pairCodeRequiresExplicitAgent(2)).toBe(true);
	});
});

describe("telegramPairDeepLink", () => {
	test("accepts only the server-provided bot start link for this code", () => {
		expect(
			telegramPairDeepLink({
				deepLink: "https://t.me/ClawdiBot?start=PAIR123",
				qrPayload: "https://t.me/ClawdiBot?start=PAIR123",
				botUsername: "ClawdiBot",
				code: "PAIR123",
			}),
		).toBe("https://t.me/ClawdiBot?start=PAIR123");
		expect(
			telegramPairDeepLink({
				deepLink: "https://t.me/ClawdiBot?start=PAIR123",
				qrPayload: "https://t.me/ClawdiBot?start=PAIR123",
				botUsername: null,
				code: "PAIR123",
			}),
		).toBe("https://t.me/ClawdiBot?start=PAIR123");
	});

	test("fails closed for missing, malformed, mismatched, or expanded links", () => {
		const input = {
			botUsername: "ClawdiBot",
			code: "PAIR123",
			qrPayload: "https://t.me/ClawdiBot?start=PAIR123",
		};
		expect(telegramPairDeepLink({ ...input, deepLink: null })).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "https://t.me/ClawdiBot?start=PAIR123",
				qrPayload: null,
			}),
		).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "https://t.me/ClawdiBot?start=PAIR123",
				qrPayload: "https://t.me/ClawdiBot?start=DIFFERENT",
			}),
		).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "tg://resolve?domain=ClawdiBot",
				qrPayload: "tg://resolve?domain=ClawdiBot",
			}),
		).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "https://t.me/OtherBot?start=PAIR123",
				qrPayload: "https://t.me/OtherBot?start=PAIR123",
			}),
		).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "https://t.me/ClawdiBot?start=OTHER",
				qrPayload: "https://t.me/ClawdiBot?start=OTHER",
			}),
		).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "https://t.me/ClawdiBot?start=PAIR123&admin=true",
				qrPayload: "https://t.me/ClawdiBot?start=PAIR123&admin=true",
			}),
		).toBeNull();
	});
});

describe("pairCodeExpiryLabel", () => {
	test("shows a live countdown and closes the action at expiry", () => {
		const now = Date.parse("2026-07-30T12:00:00Z");
		expect(pairCodeExpiryLabel("2026-07-30T12:01:05Z", now)).toBe("Expires in 1m 5s");
		expect(pairCodeExpiryLabel("2026-07-30T12:00:00Z", now)).toBe("Expired — generate a new link");
		expect(pairCodeExpiryLabel("invalid", now)).toBe("Expired — generate a new link");
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
