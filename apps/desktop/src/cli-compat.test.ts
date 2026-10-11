import { expect, test } from "bun:test";
import { meetsDesktopCliMinimum, nativeLauncherPath } from "./cli-compat";

test("native launchers use the shared install's stable paths", () => {
	expect(nativeLauncherPath("linux", "/home/user")).toBe("/home/user/.local/bin/clawdi");
	expect(nativeLauncherPath("darwin", "/Users/user")).toBe("/Users/user/.local/bin/clawdi");
	expect(nativeLauncherPath("win32", "C:\\Users\\user")).toBe(
		"C:\\Users\\user\\.local\\share\\clawdi\\current\\clawdi.exe",
	);
});

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
