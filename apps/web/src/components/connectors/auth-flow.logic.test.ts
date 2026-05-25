import { describe, expect, test } from "bun:test";
import { getConnectorAuthFlow } from "./auth-flow.logic";

describe("connector auth flow classification", () => {
	test.each([
		"oauth",
		"oauth1",
		"oauth2",
		"OAUTH2",
		"dcr_oauth",
		"composio_link",
	])("routes %s through the redirect flow", (authType) => {
		expect(getConnectorAuthFlow(authType)).toBe("redirect");
	});

	test.each([
		"api_key",
		"API_KEY",
		"bearer_token",
		"BEARER_TOKEN",
		"basic",
		"BASIC",
	])("routes %s through the credentials flow", (authType) => {
		expect(getConnectorAuthFlow(authType)).toBe("credentials");
	});

	test.each(["none", "no_auth", "NO_AUTH"])("routes %s through the no-auth flow", (authType) => {
		expect(getConnectorAuthFlow(authType)).toBe("no_auth");
	});

	test.each([
		undefined,
		null,
		"",
		"   ",
		"unknown",
		"session_token",
	])("rejects unsupported auth_type value %p instead of guessing", (authType) => {
		expect(getConnectorAuthFlow(authType)).toBeNull();
	});
});
