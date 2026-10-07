import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildAppColors, colorsPath } from "../../scripts/app-icons";
import { readSharedTheme } from "../../scripts/theme";

test("launch surface colors are generated from the current shared Web tokens", () => {
	expect(JSON.parse(readFileSync(colorsPath, "utf8"))).toMatchObject(
		buildAppColors(readSharedTheme()),
	);
});
