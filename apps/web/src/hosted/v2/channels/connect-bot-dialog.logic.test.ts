import { describe, expect, test } from "bun:test";
import {
	discordApplicationIdError,
	discordBotTokenError,
	discordGuildIdError,
	discordPublicKeyError,
} from "./connect-bot-dialog.logic";

describe("discordBotTokenError", () => {
	test("allows an empty value so presence can be handled by the form gate", () => {
		expect(discordBotTokenError("")).toBeNull();
	});

	test("accepts a long URL-safe opaque credential", () => {
		expect(
			discordBotTokenError(`${"A".repeat(24)}.${"b".repeat(6)}.${"C_".repeat(20)}`),
		).toBeNull();
	});

	test("rejects arbitrary non-empty strings and whitespace", () => {
		expect(discordBotTokenError("fake-token")).toBe("Enter a valid Discord bot token.");
		expect(discordBotTokenError(` ${"A".repeat(24)}.${"b".repeat(6)}.${"c".repeat(24)}`)).toBe(
			"Enter a valid Discord bot token.",
		);
	});
});

describe("Discord snowflake fields", () => {
	test("validates required application IDs when present", () => {
		expect(discordApplicationIdError("")).toBeNull();
		expect(discordApplicationIdError("12345678901234567")).toBeNull();
		expect(discordApplicationIdError("1234-not-an-id")).toBe(
			"Enter a valid numeric application ID.",
		);
		expect(discordApplicationIdError("99999999999999999999")).toBe(
			"Enter a valid numeric application ID.",
		);
	});

	test("allows an empty optional guild ID but validates supplied values", () => {
		expect(discordGuildIdError("   ")).toBeNull();
		expect(discordGuildIdError("1234567890123456789")).toBeNull();
		expect(discordGuildIdError("1234567890123456")).toBe("Enter a valid numeric guild ID.");
	});
});

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
