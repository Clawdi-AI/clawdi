import { describe, expect, it } from "bun:test";
import { compareSemver, isValidSemver } from "./semver";

describe("compareSemver", () => {
	it.each([
		["1.0.0-beta.9", "1.0.0-beta.10"],
		["1.0.0-rc.2", "1.0.0-rc.10"],
	])("orders %s before %s", (current, next) => {
		expect(compareSemver(current, next)).toBe(-1);
		expect(compareSemver(next, current)).toBe(1);
	});

	it("compares numeric identifiers without Number precision loss", () => {
		expect(
			compareSemver(
				"9007199254740992.0.0-rc.9007199254740992",
				"9007199254740993.0.0-rc.9007199254740993",
			),
		).toBe(-1);
	});
});

describe("isValidSemver", () => {
	it("rejects numeric prerelease identifiers with leading zeroes", () => {
		expect(isValidSemver("1.0.0-rc.01")).toBe(false);
	});
});
