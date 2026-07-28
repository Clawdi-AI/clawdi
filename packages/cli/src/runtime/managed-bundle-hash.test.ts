import { describe, expect, it } from "bun:test";
import { computeManagedBundleHash } from "./managed-bundle-hash";

describe("computeManagedBundleHash", () => {
	it("uses a deterministic framed digest", () => {
		expect(
			computeManagedBundleHash([
				{ relativePath: "references/notes.md", content: Buffer.from([0, 1, 255]) },
				{ relativePath: "SKILL.md", content: Buffer.from("skill\n") },
			]),
		).toBe("cd3c4b8f928dc685eb77f4d8452360d038bad77515e2021a375371869eaf8884");
	});

	it("frames paths and contents so concatenation boundaries cannot collide", () => {
		const left = computeManagedBundleHash([{ relativePath: "a", content: Buffer.from("bc") }]);
		const right = computeManagedBundleHash([{ relativePath: "ab", content: Buffer.from("c") }]);
		expect(left).not.toBe(right);
	});
});
