/**
 * `tarSkillDir` exclude-list invariants. The filter has caused regressions
 * twice — once tarring 100MB of node_modules into every skill (Cloudflare
 * 413), and once silently dropping a skill literally named `dist` because
 * the exclude check ran on the root segment too. These tests pin both.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { tarSkillDir } from "../src/lib/tar";

function buildSkill(layout: Record<string, string>): { path: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "clawdi-tar-test-"));
	for (const [rel, content] of Object.entries(layout)) {
		const full = join(root, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return { path: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function listEntries(bytes: Buffer): Promise<string[]> {
	const entries: string[] = [];
	await new Promise<void>((resolve, reject) => {
		const stream = tar.list({ gzip: true });
		stream.on("entry", (e) => entries.push(e.path));
		stream.on("end", () => resolve());
		stream.on("error", reject);
		stream.end(bytes);
	});
	return entries;
}

describe("tarSkillDir filter", () => {
	it("excludes node_modules / .git / dist / __pycache__ at any depth inside the skill", async () => {
		const { path, cleanup } = buildSkill({
			"my-skill/SKILL.md": "# real",
			"my-skill/node_modules/lodash/index.js": "fake bundle",
			"my-skill/.git/HEAD": "ref",
			"my-skill/dist/build.js": "compiled",
			"my-skill/__pycache__/x.pyc": "bytecode",
			"my-skill/src/util.ts": "real code",
		});
		try {
			const bytes = await tarSkillDir(join(path, "my-skill"));
			const entries = (await listEntries(bytes)).join("|");
			expect(entries).toContain("my-skill/SKILL.md");
			expect(entries).toContain("my-skill/src/util.ts");
			expect(entries).not.toContain("node_modules");
			expect(entries).not.toContain(".git/");
			expect(entries).not.toContain("dist/");
			expect(entries).not.toContain("__pycache__");
		} finally {
			cleanup();
		}
	});

	it("does NOT exclude a skill whose root directory happens to be named `dist`", async () => {
		// A skill literally named `dist` would silently produce an empty
		// tarball if the filter matched the root segment too. The fix is
		// to skip the first segment of the relative path.
		const { path, cleanup } = buildSkill({
			"dist/SKILL.md": "# wrongly-named but real skill",
			"dist/handler.ts": "code",
		});
		try {
			const bytes = await tarSkillDir(join(path, "dist"));
			const entries = await listEntries(bytes);
			expect(entries).toContain("dist/SKILL.md");
			expect(entries).toContain("dist/handler.ts");
		} finally {
			cleanup();
		}
	});
});
