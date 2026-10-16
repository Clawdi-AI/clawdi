import { describe, expect, test } from "bun:test";
import { connectorsActiveLabel, connectorsAvailableLabel } from "./library-copy";

describe("connector counts", () => {
	test("group thousands the same way for every count on the page", () => {
		expect(connectorsAvailableLabel(1408)).toBe("1,408 available");
		expect(connectorsAvailableLabel(12)).toBe("12 available");
		expect(connectorsActiveLabel(1200)).toBe("1,200 active");
	});
});
