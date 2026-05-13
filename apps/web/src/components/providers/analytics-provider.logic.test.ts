import { describe, expect, test } from "bun:test";
import {
	buildHostedPersonProperties,
	resolveHostedAuthIdentityAction,
} from "@/components/providers/analytics-provider.logic";

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

describe("buildHostedPersonProperties", () => {
	test("returns null until full user record is loaded", () => {
		const result = buildHostedPersonProperties({
			isSignedIn: true,
			userId: "user_123",
			user: null,
		});

		expect(result).toBeNull();
	});

	test("builds enrichment payload from Clerk user", () => {
		const result = buildHostedPersonProperties({
			isSignedIn: true,
			userId: "user_123",
			user: {
				fullName: "Ada Lovelace",
				primaryEmailAddress: { emailAddress: "ada@example.com" },
			},
		});

		expect(result).toEqual({
			clerk_id: "user_123",
			email: "ada@example.com",
			name: "Ada Lovelace",
		});
	});

	test("includes clerk_id even when name/email are missing", () => {
		const result = buildHostedPersonProperties({
			isSignedIn: true,
			userId: "user_123",
			user: {
				fullName: null,
				primaryEmailAddress: null,
			},
		});

		expect(result).toEqual({
			clerk_id: "user_123",
			email: undefined,
			name: undefined,
		});
	});
});
