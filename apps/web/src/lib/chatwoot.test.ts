import { describe, expect, test } from "bun:test";
import { shouldHideChatwoot } from "@/lib/chatwoot";

describe("Chatwoot placement", () => {
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
