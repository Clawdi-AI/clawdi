import { describe, expect, test } from "bun:test";
import {
	nativeTransportSummary,
	pairCodeExpiryLabel,
	telegramPairDeepLink,
} from "./channel-detail-page.logic";

describe("telegramPairDeepLink", () => {
	test("accepts only the server-provided bot start link for this code", () => {
		expect(
			telegramPairDeepLink({
				deepLink: "https://t.me/ClawdiBot?start=BCDFGHJKLM",
				qrPayload: "https://t.me/ClawdiBot?start=BCDFGHJKLM",
				botUsername: "ClawdiBot",
				code: "BCDFGHJKLM",
			}),
		).toBe("https://t.me/ClawdiBot?start=BCDFGHJKLM");
		expect(
			telegramPairDeepLink({
				deepLink: "https://t.me/ClawdiBot?start=BCDFGHJKLM",
				qrPayload: "https://t.me/ClawdiBot?start=BCDFGHJKLM",
				botUsername: null,
				code: "BCDFGHJKLM",
			}),
		).toBe("https://t.me/ClawdiBot?start=BCDFGHJKLM");
	});

	test("fails closed for missing, malformed, mismatched, or expanded links", () => {
		const input = {
			botUsername: "ClawdiBot",
			code: "BCDFGHJKLM",
			qrPayload: "https://t.me/ClawdiBot?start=BCDFGHJKLM",
		};
		expect(telegramPairDeepLink({ ...input, deepLink: null })).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "https://t.me/ClawdiBot?start=BCDFGHJKLM",
				qrPayload: null,
			}),
		).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "https://t.me/ClawdiBot?start=BCDFGHJKLM",
				qrPayload: "https://t.me/ClawdiBot?start=NPQRSTVWXY",
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
				deepLink: "https://t.me/OtherBot?start=BCDFGHJKLM",
				qrPayload: "https://t.me/OtherBot?start=BCDFGHJKLM",
			}),
		).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "https://t.me/ClawdiBot?start=QRSTVWXYZ2",
				qrPayload: "https://t.me/ClawdiBot?start=QRSTVWXYZ2",
			}),
		).toBeNull();
		expect(
			telegramPairDeepLink({
				...input,
				deepLink: "https://t.me/ClawdiBot?start=BCDFGHJKLM&admin=true",
				qrPayload: "https://t.me/ClawdiBot?start=BCDFGHJKLM&admin=true",
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
			}),
		).toEqual({
			status: "Unavailable",
			connection: "Unavailable",
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
