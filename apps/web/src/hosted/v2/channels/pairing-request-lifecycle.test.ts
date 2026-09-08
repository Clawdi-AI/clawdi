import { describe, expect, test } from "bun:test";
import {
	DISCORD_PAIR_ERROR_NORMALIZER,
	TELEGRAM_PAIR_ERROR_NORMALIZER,
	WHATSAPP_PAIR_ERROR_NORMALIZER,
} from "@/hosted/v2/channels/channel-pairing-errors";
import { ApiError } from "@/lib/api-errors";

describe("channel pairing request lifecycle", () => {
	test("hides provider and runtime diagnostics", () => {
		const raw = "upstream body exposed Authorization: Bot secret-token";
		expect(TELEGRAM_PAIR_ERROR_NORMALIZER.normalizeError(new ApiError(503, raw))).toBe(
			"Telegram pairing is temporarily unavailable. Try again.",
		);
		expect(TELEGRAM_PAIR_ERROR_NORMALIZER.normalizeError(new Error(raw))).toBe(
			"Telegram pairing is temporarily unavailable. Try again.",
		);
		expect(DISCORD_PAIR_ERROR_NORMALIZER.normalizeError(new ApiError(400, raw))).toBe(
			"Discord pairing is temporarily unavailable. Try again.",
		);
		expect(DISCORD_PAIR_ERROR_NORMALIZER.normalizeError(new Error(raw))).toBe(
			"Discord pairing is temporarily unavailable. Try again.",
		);
		expect(WHATSAPP_PAIR_ERROR_NORMALIZER.normalizeError(new ApiError(503, raw))).toBe(
			"WhatsApp pairing is temporarily unavailable. Try again.",
		);
	});
});
