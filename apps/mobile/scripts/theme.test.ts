import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	buildMobileTheme,
	buildWebClassSafelist,
	outputPath,
	readSharedTheme,
	readWebClassSources,
	webClassesOutputPath,
} from "./theme";

test("mobile theme is generated from the current shared Web tokens", () => {
	expect(readFileSync(outputPath, "utf8")).toBe(buildMobileTheme(readSharedTheme()));
});

test("Web class safelist covers the current shared Web class strings", () => {
	expect(readFileSync(webClassesOutputPath, "utf8")).toBe(
		buildWebClassSafelist(readWebClassSources()),
	);
});
