import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listJsonlFiles } from "./session-files";

test("preserves adapter visibility rules and fails on a non-directory inventory", () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-session-files-"));
	try {
		mkdirSync(join(root, ".hidden"));
		writeFileSync(join(root, ".hidden", "session.jsonl"), "{}\n");
		writeFileSync(join(root, "session.jsonl"), "{}\n");
		expect(listJsonlFiles(root).sort()).toEqual([
			join(root, ".hidden", "session.jsonl"),
			join(root, "session.jsonl"),
		]);
		expect(listJsonlFiles(root, { skipHidden: true })).toEqual([join(root, "session.jsonl")]);
		expect(listJsonlFiles(join(root, "missing"))).toEqual([]);
		expect(() => listJsonlFiles(join(root, "session.jsonl"))).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
