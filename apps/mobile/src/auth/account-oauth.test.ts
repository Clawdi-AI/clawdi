import { expect, test } from "bun:test";
import {
	accountOAuthAuthorizationUrl,
	accountOAuthNavigation,
	accountOAuthNonce,
	accountOAuthRedirect,
} from "./account-oauth";

const redirect = accountOAuthRedirect("a1234567-1234-1234-1234-123456789abc");
test("account callbacks bind to the issued attempt, address and one nonce", () => {
	expect(accountOAuthNonce(`${redirect}&rotating_token_nonce=opaque-token`, redirect)).toBe(
		"opaque-token",
	);
	for (const callback of [
		redirect,
		`${redirect}&rotating_token_nonce=`,
		`${redirect}&rotating_token_nonce=a&rotating_token_nonce=b`,
		`${redirect}&rotating_token_nonce=a&clawdi_attempt=other`,
		`${redirect}&rotating_token_nonce=a#error`,
		`${redirect}&rotating_token_nonce=a&error=denied`,
		`${redirect.replace("account-oauth", "other")}&rotating_token_nonce=a`,
		`${redirect.replace("clawdi:", "https:")}&rotating_token_nonce=a`,
		`${redirect.replace("a1234567", "b1234567")}&rotating_token_nonce=a`,
	])
		expect(() => accountOAuthNonce(callback, redirect)).toThrow();
});

test("authorization URLs cannot open credential-bearing or executable schemes", () => {
	expect(accountOAuthAuthorizationUrl(new URL("https://identity.example.test/authorize"))).toBe(
		"https://identity.example.test/authorize",
	);
	for (const value of [
		undefined,
		new URL("javascript:alert(1)"),
		new URL("http://identity.example.test"),
		new URL("https://user:password@identity.example.test"),
	])
		expect(() => accountOAuthAuthorizationUrl(value)).toThrow();
});

test("native callback navigation drops secrets without rewriting other deep links", () => {
	expect(accountOAuthNavigation(`${redirect}&rotating_token_nonce=secret`)).toBe(
		"/connected-accounts",
	);
	expect(accountOAuthNavigation("/account-oauth?rotating_token_nonce=secret")).toBe(
		"/connected-accounts",
	);
	expect(accountOAuthNavigation("clawdi://s/share-id")).toBe("clawdi://s/share-id");
});

test("login callbacks cannot substitute account linking or change a public Session return", () => {
	const attempt = "a1234567-1234-1234-1234-123456789abc";
	const login = accountOAuthRedirect(attempt, "sign-in", attempt);
	const signup = accountOAuthRedirect(attempt, "sign-up", attempt);
	expect(accountOAuthNavigation(`${login}&rotating_token_nonce=secret`)).toBe(
		`/(auth)/sign-in?publicShareId=${attempt}`,
	);
	expect(accountOAuthNavigation(`${signup}&rotating_token_nonce=secret`)).toBe(
		`/(auth)/sign-up?publicShareId=${attempt}`,
	);
	expect(accountOAuthNonce(`${login}&rotating_token_nonce=nonce`, login)).toBe("nonce");
	expect(() => accountOAuthNonce(`${redirect}&rotating_token_nonce=nonce`, login)).toThrow();
	expect(() => accountOAuthNonce(`${signup}&rotating_token_nonce=nonce`, login)).toThrow();
	expect(() =>
		accountOAuthNonce(
			`${login.replace(`publicShareId=${attempt}`, "publicShareId=b1234567-1234-1234-1234-123456789abc")}&rotating_token_nonce=nonce`,
			login,
		),
	).toThrow();
	expect(
		accountOAuthNavigation(
			"clawdi://sign-in-oauth?publicShareId=https://evil.test&rotating_token_nonce=secret",
		),
	).toBe("/(auth)/sign-in");
});
