import { describe, expect, it } from "bun:test";
import { computeManagedBundleHash } from "./managed-bundle-hash";

describe("computeManagedBundleHash", () => {
	it("uses a deterministic framed digest", () => {
		expect(
			computeManagedBundleHash([
				{ relativePath: "references/notes.md", mode: 0o644, content: Buffer.from([0, 1, 255]) },
				{ relativePath: "SKILL.md", mode: 0o640, content: Buffer.from("skill\n") },
			]),
		).toBe("e207f39d682f6678e6c6b1868453150e97333a463668936fd8f2bc6444b66d91");
	});

	it("frames paths and contents so concatenation boundaries cannot collide", () => {
		const left = computeManagedBundleHash([
			{ relativePath: "a", mode: 0o644, content: Buffer.from("bc") },
		]);
		const right = computeManagedBundleHash([
			{ relativePath: "ab", mode: 0o644, content: Buffer.from("c") },
		]);
		expect(left).not.toBe(right);
	});

	it("includes regular-file permission bits", () => {
		const script = { relativePath: "scripts/run.sh", content: Buffer.from("#!/bin/sh\nexit 0\n") };
		const regular = computeManagedBundleHash([{ ...script, mode: 0o644 }]);
		const executable = computeManagedBundleHash([{ ...script, mode: 0o755 }]);
		expect(executable).not.toBe(regular);
	});
});
