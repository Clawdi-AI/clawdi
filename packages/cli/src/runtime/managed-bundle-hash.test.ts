import { describe, expect, it } from "bun:test";
import { computeManagedBundleHash } from "./managed-bundle-hash";

describe("computeManagedBundleHash", () => {
	it("uses a deterministic framed digest", () => {
		expect(
			computeManagedBundleHash([
				{ relativePath: "references/notes.md", mode: 0o644, content: Buffer.from([0, 1, 255]) },
				{ relativePath: "SKILL.md", mode: 0o640, content: Buffer.from("skill\n") },
			]),
		).toBe("712a256ec56b7e3c873882f76a8c8d4519d150f94bf7ae65060cbf1debe3f99d");
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

	it("uses Git-stable canonical modes for non-executable files", () => {
		const file = { relativePath: "SKILL.md", content: Buffer.from("skill\n") };
		expect(computeManagedBundleHash([{ ...file, mode: 0o644 }])).toBe(
			computeManagedBundleHash([{ ...file, mode: 0o664 }]),
		);
	});
});
