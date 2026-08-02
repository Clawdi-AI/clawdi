import { describe, expect, test } from "bun:test";
import { pairingCountIncreased, pairingSuccessDescription } from "./channel-pairing-success";

describe("pairing success detection", () => {
	test("requires an aggregate count increase from the current session baseline", () => {
		expect(pairingCountIncreased(3, 2)).toBe(true);
		expect(pairingCountIncreased(2, 2)).toBe(false);
		expect(pairingCountIncreased(1, 2)).toBe(false);
	});

	test("a reopened session snapshots its newer count instead of reusing the old baseline", () => {
		const firstSessionBaseline = 1;
		expect(pairingCountIncreased(2, firstSessionBaseline)).toBe(true);

		const reopenedSessionBaseline = 2;
		expect(pairingCountIncreased(2, reopenedSessionBaseline)).toBe(false);
		expect(pairingCountIncreased(3, reopenedSessionBaseline)).toBe(true);
	});

	test("describes Telegram and Discord success without requiring a binding-list poll", () => {
		expect(pairingSuccessDescription("telegram")).toBe("Telegram chat is ready.");
		expect(pairingSuccessDescription("discord")).toBe("Discord chat is ready.");
	});
});
