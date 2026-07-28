import { describe, expect, test } from "bun:test";
import { safeDecodeURIComponent } from "@/lib/url";

describe("safeDecodeURIComponent", () => {
	test("decodes valid URL components", () => {
		expect(safeDecodeURIComponent("agent%20name")).toBe("agent name");
		expect(safeDecodeURIComponent("%E2%9C%93")).toBe("✓");
	});

	test("preserves malformed percent encodings instead of throwing", () => {
		for (const value of ["%", "%2", "%ZZ", "%E0%A4%A"]) {
			expect(() => safeDecodeURIComponent(value)).not.toThrow();
			expect(safeDecodeURIComponent(value)).toBe(value);
		}
	});
});
