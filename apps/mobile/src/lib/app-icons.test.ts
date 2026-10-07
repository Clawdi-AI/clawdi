import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildAppColors, colorsPath, oklchToHex } from "../../scripts/app-icons";
import { readSharedTheme } from "../../scripts/theme";

test("launch surface colors are generated from the current shared Web tokens", () => {
	expect(JSON.parse(readFileSync(colorsPath, "utf8"))).toMatchObject(
		buildAppColors(readSharedTheme()),
	);
});

test("oklch conversion matches the CSS Color 4 sRGB primaries", () => {
	expect(oklchToHex("oklch(0.6279553606145516 0.2576833077361 29.2338851923426)")).toBe("#ff0000");
	expect(oklchToHex("oklch(1 0 0)")).toBe("#ffffff");
});
