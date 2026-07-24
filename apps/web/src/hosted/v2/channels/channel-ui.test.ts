import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const uiSource = readFileSync(new URL("./channel-ui.tsx", import.meta.url), "utf8");

describe("TokenReveal", () => {
	test("masks values by default while retaining reveal and copy controls", () => {
		expect(uiSource).toContain('{revealed ? value : "••••••••••••"}');
		expect(uiSource).toMatch(/aria-label=.*revealed.*Hide.*Show.*label/);
		expect(uiSource).toContain("onClick={() => copy(value)}");
	});
});
