import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	DISCORD_PAIR_ERROR_NORMALIZER,
	TELEGRAM_PAIR_ERROR_NORMALIZER,
	WHATSAPP_PAIR_ERROR_NORMALIZER,
} from "@/hosted/v2/channels/channel-pairing-errors";
import { ApiError } from "@/lib/api-errors";

const source = (name: string) =>
	readFileSync(new URL(`./${name}-pair-dialog.tsx`, import.meta.url), "utf8");

describe("channel pairing request lifecycle", () => {
	test("invalidates an in-flight request synchronously before controlled close", () => {
		for (const provider of ["telegram", "discord"]) {
			const dialog = source(provider);
			const closeStart = dialog.indexOf("const requestOpenChange");
			const completion = dialog.indexOf("onOpenChangeComplete");
			expect(closeStart).toBeGreaterThanOrEqual(0);
			expect(completion).toBeGreaterThan(closeStart);
			expect(dialog.slice(closeStart, completion)).toContain(
				"if (!nextOpen) invalidatePendingSession();",
			);
			expect(dialog).toContain("sessionRef.current += 1");
			expect(dialog).toContain("lockedSessionRef.current = null");
			expect(dialog).toContain("onOpenChange: requestOpenChange");
			expect(dialog).toContain("onOpenChangeComplete");
		}
	});

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
