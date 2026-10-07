import { describe, expect, test } from "bun:test";
import { resolveHostedAuthIdentityAction } from "@/hosted/analytics-identity.logic";

describe("resolveHostedAuthIdentityAction", () => {
	test("identifies when signed in with a new user id", () => {
		const result = resolveHostedAuthIdentityAction({
			isSignedIn: true,
			userId: "user_123",
			lastIdentifiedUserId: null,
		});

		expect(result).toEqual({
			action: { type: "identify", userId: "user_123" },
			nextIdentifiedUserId: "user_123",
		});
	});

	test("does not re-identify the same user id", () => {
		const result = resolveHostedAuthIdentityAction({
			isSignedIn: true,
			userId: "user_123",
			lastIdentifiedUserId: "user_123",
		});

		expect(result).toEqual({
			action: { type: "none" },
			nextIdentifiedUserId: "user_123",
		});
	});

	test("resets when user signs out after being identified", () => {
		const result = resolveHostedAuthIdentityAction({
			isSignedIn: false,
			userId: null,
			lastIdentifiedUserId: "user_123",
		});

		expect(result).toEqual({
			action: { type: "reset" },
			nextIdentifiedUserId: null,
		});
	});

	test("does nothing while signed out with no identified user", () => {
		const result = resolveHostedAuthIdentityAction({
			isSignedIn: false,
			userId: null,
			lastIdentifiedUserId: null,
		});

		expect(result).toEqual({
			action: { type: "none" },
			nextIdentifiedUserId: null,
		});
	});
});
