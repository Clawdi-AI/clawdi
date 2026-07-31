import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sanitizeCodexCallbackHistoryUrl } from "./codex-oauth";

const source = readFileSync(new URL("./codex-oauth-callback.tsx", import.meta.url), "utf8");

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

	test("cleans authorization query before relaying and never persists it", () => {
		const cleanup = source.indexOf("window.history.replaceState");
		const broadcast = source.indexOf("channel.postMessage");
		const opener = source.indexOf("window.opener?.postMessage");

		expect(cleanup).toBeGreaterThan(-1);
		expect(cleanup).toBeLessThan(broadcast);
		expect(cleanup).toBeLessThan(opener);
		expect(source).not.toContain("localStorage");
		expect(source).not.toContain("sessionStorage");
	});
});
