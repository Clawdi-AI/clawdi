import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildMobileTheme, outputPath, readSharedTheme } from "./theme";

test("mobile theme is generated from the current shared Web tokens", () => {
	expect(readFileSync(outputPath, "utf8")).toBe(buildMobileTheme(readSharedTheme()));
});
