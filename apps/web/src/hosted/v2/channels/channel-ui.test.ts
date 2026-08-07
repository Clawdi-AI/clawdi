import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const uiSource = readFileSync(new URL("./channel-ui.tsx", import.meta.url), "utf8");

describe("CopyInline", () => {
	test("copies compact non-secret identifiers without a reveal state", () => {
		expect(uiSource).toContain("export function CopyInline");
		expect(uiSource).toContain("onClick={() => void copy(value)}");
		expect(uiSource).toContain('aria-live="polite"');
		expect(uiSource).not.toContain("TokenReveal");
	});
});
