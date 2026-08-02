import { describe, expect, test } from "bun:test";
import {
	whatsappOnboardingRequiresCleanup,
	whatsappOnboardingShouldPoll,
	whatsappPhoneNumberError,
	whatsappQrExpiryLabel,
	whatsappReadinessMessage,
} from "./whatsapp-device-onboarding.logic";

describe("WhatsApp device onboarding logic", () => {
	test("accepts only country-code digits for Baileys pairing codes", () => {
		expect(whatsappPhoneNumberError("14155550123")).toBeNull();
		for (const value of ["+14155550123", "1 415 555 0123", "04155550123", "123456"]) {
			expect(whatsappPhoneNumberError(value)).not.toBeNull();
		}
	});

	test("cleans up unfinished and error sessions without touching terminal sessions", () => {
		for (const state of ["generating", "ready", "scanned", "error"] as const) {
			expect(whatsappOnboardingRequiresCleanup(state)).toBeTrue();
		}
		for (const state of ["connected", "expired", "canceled"] as const) {
			expect(whatsappOnboardingRequiresCleanup(state)).toBeFalse();
		}
	});

	test("polls through scanned and waits for connected", () => {
		for (const state of ["generating", "ready", "scanned"] as const) {
			expect(whatsappOnboardingShouldPoll(state)).toBeTrue();
		}
		for (const state of ["connected", "expired", "canceled", "error"] as const) {
			expect(whatsappOnboardingShouldPoll(state)).toBeFalse();
		}
	});

	test("describes QR rotation and deployment gating without internals", () => {
		const now = Date.parse("2026-08-02T12:00:00Z");
		expect(whatsappQrExpiryLabel("2026-08-02T12:00:20Z", now)).toBe("QR refreshes in 20s");
		expect(whatsappQrExpiryLabel("2026-08-02T11:59:59Z", now)).toBe("Refreshing QR code…");
		expect(
			whatsappReadinessMessage(
				{
					available: false,
					manual_pairing_code_supported: false,
					reason: "managed_sidecar_required",
				},
				false,
			),
		).toContain("isn't compatible with this deployment");
	});
});
