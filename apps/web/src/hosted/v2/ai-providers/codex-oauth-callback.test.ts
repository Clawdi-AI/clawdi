import { describe, expect, test } from "bun:test";
import { sanitizeCodexCallbackHistoryUrl } from "./codex-oauth";

describe("legacy Codex OAuth callback relay", () => {
	test("removes only OAuth callback parameters from query and fragment", () => {
		expect(
			sanitizeCodexCallbackHistoryUrl(
				"https://app.example.test/oauth/codex/callback?code=secret&state=nonce&tab=provider#provider_oauth=1&error=denied&panel=details",
			),
		).toBe("/oauth/codex/callback?tab=provider#panel=details");
		expect(
			sanitizeCodexCallbackHistoryUrl(
				"https://app.example.test/oauth/codex/callback?keep=1#account-settings",
			),
		).toBe("/oauth/codex/callback?keep=1#account-settings");
	});
});
