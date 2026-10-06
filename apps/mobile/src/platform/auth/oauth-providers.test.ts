import { expect, test } from "bun:test";
import { socialSignInOptions } from "@/platform/auth/oauth-providers";

test("iOS adds native Sign in with Apple whenever any social provider is offered", () => {
	expect(socialSignInOptions(["google", "github"], "ios")).toEqual({
		nativeApple: true,
		oauth: ["google", "github"],
	});
	expect(socialSignInOptions(["apple", "google"], "ios")).toEqual({
		nativeApple: true,
		oauth: ["google"],
	});
	expect(socialSignInOptions(["apple"], "ios")).toEqual({ nativeApple: true, oauth: [] });
	expect(socialSignInOptions([], "ios")).toEqual({ nativeApple: false, oauth: [] });
});

test("Android keeps the configured browser OAuth providers", () => {
	expect(socialSignInOptions(["apple", "google"], "android")).toEqual({
		nativeApple: false,
		oauth: ["apple", "google"],
	});
	expect(socialSignInOptions([], "android")).toEqual({ nativeApple: false, oauth: [] });
});
