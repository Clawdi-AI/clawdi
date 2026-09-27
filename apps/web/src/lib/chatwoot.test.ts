import { describe, expect, test } from "bun:test";
import { resolveChatwootIdentity, shouldHideChatwoot } from "@/lib/chatwoot";

describe("Chatwoot identity and placement", () => {
	test("uses the authenticated account id and primary email", () => {
		expect(
			resolveChatwootIdentity({
				id: " user_123 ",
				fullName: " Ada Lovelace ",
				primaryEmailAddress: { emailAddress: " ada@example.com " },
				imageUrl: "",
			}),
		).toEqual({ id: "user_123", name: "Ada Lovelace", email: "ada@example.com" });
	});

	test("shares Clerk's https image url as the avatar", () => {
		const user = {
			id: "user_123",
			fullName: "Ada Lovelace",
			primaryEmailAddress: { emailAddress: "ada@example.com" },
		};
		// Clerk's generated default avatar is shared too.
		const imageUrl = "https://img.clerk.com/default-avatar.png";
		expect(resolveChatwootIdentity({ ...user, imageUrl })?.avatarUrl).toBe(imageUrl);
		for (const unsafe of [
			"",
			"http://img.clerk.com/avatar.png",
			"data:image/png;base64,AA",
			"nope",
		]) {
			expect(resolveChatwootIdentity({ ...user, imageUrl: unsafe })?.avatarUrl).toBeUndefined();
		}
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
