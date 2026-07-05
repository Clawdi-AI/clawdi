import { describe, expect, test } from "bun:test";
import { discordPublicKeyError } from "./connect-bot-dialog.logic";

describe("discordPublicKeyError", () => {
	test("allows blank optional public keys", () => {
		expect(discordPublicKeyError("")).toBeNull();
		expect(discordPublicKeyError("   ")).toBeNull();
	});

	test("requires a 32-byte hex string when provided", () => {
		expect(discordPublicKeyError("a".repeat(63))).toBe("Enter a 64-character hex public key.");
		expect(discordPublicKeyError("a".repeat(65))).toBe("Enter a 64-character hex public key.");
		expect(discordPublicKeyError(`${"a".repeat(63)}g`)).toBe(
			"Enter a 64-character hex public key.",
		);
		expect(discordPublicKeyError("A".repeat(64))).toBeNull();
	});
});
