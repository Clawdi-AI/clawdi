import { describe, expect, test } from "bun:test";
import { codexOAuthStateMatches, parseCodexCallback } from "@/hosted/v2/ai-providers/codex-oauth";

describe("Codex OAuth callback validation", () => {
	test("accepts only an exact, non-empty state match", () => {
		expect(
			codexOAuthStateMatches("expected-state", {
				code: "authorization-code",
				state: "expected-state",
			}),
		).toBe(true);
		expect(
			codexOAuthStateMatches("expected-state", {
				code: "authorization-code",
				state: "attacker-state",
			}),
		).toBe(false);
		expect(
			codexOAuthStateMatches("expected-state", { code: "authorization-code", state: "" }),
		).toBe(false);
	});

	test("requires both code and state when parsing a successful callback", () => {
		expect(parseCodexCallback("?code=authorization-code&state=expected-state")).toEqual({
			code: "authorization-code",
			state: "expected-state",
		});
		expect(parseCodexCallback("?code=authorization-code")).toBeNull();
		expect(parseCodexCallback("?state=expected-state")).toBeNull();
	});
});
