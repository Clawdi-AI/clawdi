import { describe, expect, it } from "bun:test";
import { getCliVersion } from "../src/lib/version";

describe("getCliVersion", () => {
	it("returns the version string from package.json", () => {
		const v = getCliVersion();
		// At minimum, not the failure fallback
		expect(v).not.toBe("0.0.0");
		// Shape like "x.y.z" or semver-ish
		expect(v).toMatch(/^\d+\.\d+\.\d+/);
	});
});
