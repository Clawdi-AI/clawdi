import { describe, expect, test } from "bun:test";
import { resolveChatwootIdentity } from "./chatwoot";

describe("Chatwoot identity", () => {
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
});
