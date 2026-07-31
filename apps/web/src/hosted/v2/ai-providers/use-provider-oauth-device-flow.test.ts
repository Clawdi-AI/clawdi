import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isCurrentOAuthGeneration } from "./use-provider-oauth-device-flow";

describe("provider OAuth device flow lifecycle", () => {
	test("ignores a ready response from a cancelled or replaced poll generation", () => {
		expect(
			isCurrentOAuthGeneration({
				stopped: false,
				completed: true,
				generation: 1,
				currentGeneration: 1,
			}),
		).toBe(false);
		expect(
			isCurrentOAuthGeneration({
				stopped: false,
				completed: false,
				generation: 1,
				currentGeneration: 2,
			}),
		).toBe(false);
		expect(
			isCurrentOAuthGeneration({
				stopped: false,
				completed: false,
				generation: 2,
				currentGeneration: 2,
			}),
		).toBe(true);
	});

	test("ignores an expiry callback from the replaced session generation", () => {
		expect(
			isCurrentOAuthGeneration({
				stopped: false,
				completed: false,
				generation: 4,
				currentGeneration: 5,
			}),
		).toBe(false);
	});

	test("allows an explicit new code while the current session is polling", () => {
		const source = readFileSync(new URL("./provider-oauth-flow.tsx", import.meta.url), "utf8");
		expect(source).toContain("onClick={onRestart} disabled={starting}");
		expect(source).not.toContain("disabled={starting || polling}");
	});
});
