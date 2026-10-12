import { expect, test } from "bun:test";
import { meetsDesktopCliMinimum } from "./cli-compat";

test.each([
	["0.16.7", false],
	["0.16.8-rc.1", false],
	["0.16.8", true],
	["0.16.8+signed", true],
	["0.16.9", true],
	["0.17.0", true],
	["1.0.0", true],
	["invalid", false],
])("Desktop CLI minimum: %s → %s", (version, expected) => {
	expect(meetsDesktopCliMinimum(version)).toBe(expected);
});
