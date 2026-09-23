import { describe, expect, test } from "bun:test";
import { resolveChatwootIdentity, shouldHideChatwoot } from "@/lib/chatwoot";

describe("Chatwoot identity and placement", () => {
	test("uses the authenticated account id and primary email", () => {
		expect(
			resolveChatwootIdentity({
				id: " user_123 ",
				fullName: " Ada Lovelace ",
				primaryEmailAddress: { emailAddress: " ada@example.com " },
			}),
		).toEqual({ id: "user_123", name: "Ada Lovelace", email: "ada@example.com" });
	});

	test("preserves the desktop live-tool route exclusions", () => {
		for (const pathname of [
			"/deploy",
			"/agents/agent-1/console",
			"/agents/agent-1/files",
			"/agents/agent-1/terminal",
			"/terminal/agent-1",
		]) {
			expect(shouldHideChatwoot(pathname)).toBe(true);
		}
		for (const pathname of ["/agents", "/agents/agent-1", "/settings", "/admin"]) {
			expect(shouldHideChatwoot(pathname)).toBe(false);
		}
	});
});
