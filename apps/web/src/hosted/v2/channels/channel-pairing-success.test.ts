import { describe, expect, test } from "bun:test";
import { pairingCountIncreased, pairingSuccessDescription } from "./channel-pairing-success";

describe("pairing success detection", () => {
	test("requires an aggregate count increase from the current session baseline", () => {
		expect(pairingCountIncreased(3, 2)).toBe(true);
		expect(pairingCountIncreased(2, 2)).toBe(false);
		expect(pairingCountIncreased(1, 2)).toBe(false);
	});

	test("describes provider success without requiring a binding-list poll", () => {
		expect(pairingSuccessDescription("telegram")).toBe("Telegram chat is ready.");
		expect(pairingSuccessDescription("discord")).toBe("Discord chat is ready.");
		expect(pairingSuccessDescription("whatsapp")).toBe("WhatsApp chat is ready.");
	});
});
