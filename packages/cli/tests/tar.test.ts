/**
 * `tarSkillDir` exclude-list invariants. The filter has caused regressions
 * twice — once tarring 100MB of node_modules into every skill (Cloudflare
 * 413), and once silently dropping a skill literally named `dist` because
 * the exclude check ran on the root segment too. These tests pin both.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

	it("preserves nested skill_key in archive entries (Hermes round-trip)", async () => {
		// Round-37 P2 regression: a Hermes nested skill at
		// `<root>/category/foo/SKILL.md` MUST archive entries
		// under `category/foo/...`, not just `foo/...`. Pre-fix
		// the basename(dirPath) = "foo" so the cloud row
		// (skill_key=`category/foo`) and the archive bytes
		// (`foo/...`) disagreed; a later download/extract at the
		// skills root recreated `foo/` instead of
		// `category/foo/` and the skill couldn't be restored on
		// other machines.
		const { path, cleanup } = buildSkill({
			"category/foo/SKILL.md": "# nested skill",
			"category/foo/handler.ts": "code",
			"category/foo/references/notes.md": "deep",
		});
		try {
			const bytes = await tarSkillDir(join(path, "category", "foo"), undefined, "category/foo");
			const entries = await listEntries(bytes);
			expect(entries).toContain("category/foo/SKILL.md");
			expect(entries).toContain("category/foo/handler.ts");
			expect(entries).toContain("category/foo/references/notes.md");
			// And critically: NOT `foo/...` at the top level.
			for (const e of entries) {
				expect(e.startsWith("category/foo/")).toBe(true);
			}
		} finally {
			cleanup();
		}
	});

	it("excludes inside a Hermes-nested skill the same way it does at top level", async () => {
		// The exclude-segment skip-count must follow the
		// skill_key's component count, not assume "1 segment".
		// Otherwise a `node_modules` directly under
		// `category/foo/` would slip through.
		const { path, cleanup } = buildSkill({
			"category/foo/SKILL.md": "# nested",
			"category/foo/node_modules/x/index.js": "should be excluded",
			"category/foo/src/util.ts": "real",
		});
		try {
			const bytes = await tarSkillDir(join(path, "category", "foo"), undefined, "category/foo");
			const entries = (await listEntries(bytes)).join("|");
			expect(entries).toContain("category/foo/SKILL.md");
			expect(entries).toContain("category/foo/src/util.ts");
			expect(entries).not.toContain("node_modules");
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

	it("allows sibling symlinks under the same skills directory (gstack pattern)", async () => {
		// gstack-style skills publish via sibling symlinks:
		//   ~/.claude/skills/autoplan/SKILL.md -> ~/.claude/skills/gstack/autoplan/SKILL.md
		// Both ends are under the user's own skills tree; the agent's skills
		// directory (the parent of the skill being archived) is the right
		// trust root.
		const root = mkdtempSync(join(tmpdir(), "clawdi-tar-test-"));
		try {
			mkdirSync(join(root, "gstack", "autoplan"), { recursive: true });
			writeFileSync(
				join(root, "gstack", "autoplan", "SKILL.md"),
				"# autoplan source-of-truth content",
			);
			mkdirSync(join(root, "autoplan"), { recursive: true });
			symlinkSync(join(root, "gstack", "autoplan", "SKILL.md"), join(root, "autoplan", "SKILL.md"));
			const bytes = await tarSkillDir(join(root, "autoplan"));
			const entries = await listEntries(bytes);
			expect(entries).toContain("autoplan/SKILL.md");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("trusts the agent skills root for nested Hermes keys (sibling-category symlink)", async () => {
		// Round-39 P2 regression: when archiving a Hermes nested
		// skill `category/foo`, the trust root must be the
		// agent's actual skills root (`<root>`), NOT the immediate
		// parent of the nested skill (`<root>/category`). A
		// gstack-style sibling symlink that points to another
		// category — `<root>/category/foo/shared ->
		// <root>/anotherCategory/shared` — is legitimate, but the
		// pre-fix default trust root rejected it as escaping
		// because `<root>/anotherCategory` lives outside
		// `<root>/category`.
		const root = mkdtempSync(join(tmpdir(), "clawdi-tar-test-"));
		try {
			// Real content in another category.
			mkdirSync(join(root, "anotherCategory", "shared"), { recursive: true });
			writeFileSync(join(root, "anotherCategory", "shared", "ref.md"), "shared content");
			// Nested skill under `category/foo` with a sibling-category symlink.
			mkdirSync(join(root, "category", "foo"), { recursive: true });
			writeFileSync(join(root, "category", "foo", "SKILL.md"), "# nested");
			symlinkSync(join(root, "anotherCategory", "shared"), join(root, "category", "foo", "shared"));
			const bytes = await tarSkillDir(join(root, "category", "foo"), undefined, "category/foo");
			const entries = await listEntries(bytes);
			expect(entries).toContain("category/foo/SKILL.md");
			// The symlinked-in shared/ref.md follows through (tar's
			// `follow: true`) — its presence proves we accepted the
			// sibling-category symlink rather than throwing.
			expect(entries.some((e) => e.endsWith("ref.md"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects nested-skill symlinks that escape the agent skills root", async () => {
		// Defense-in-depth: even with the wider trust root used
		// for nested keys, a symlink to /etc/passwd must still
		// fail. Without this assertion, expanding the trust root
		// from "skill parent" to "skills root" could be misread
		// as "no bound at all".
		const root = mkdtempSync(join(tmpdir(), "clawdi-tar-test-"));
		try {
			mkdirSync(join(root, "category", "foo"), { recursive: true });
			writeFileSync(join(root, "category", "foo", "SKILL.md"), "# nested");
			symlinkSync("/etc/hosts", join(root, "category", "foo", "leak"));
			await expect(
				tarSkillDir(join(root, "category", "foo"), undefined, "category/foo"),
			).rejects.toThrow(/pointing outside the agent's skills directory/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects nested escapes through an in-trust symlinked directory", async () => {
		// `skill/shared -> ../shared` is in-trust (the original
		// gstack pattern), but `../shared/leak -> /etc/hosts`
		// dereferences out of trust. tar.create with `follow: true`
		// would otherwise pick that up and bake /etc/hosts into the
		// uploaded archive. The walker must recurse into the target
		// of any in-trust directory symlink and reject any escape it
		// finds nested inside.
		const root = mkdtempSync(join(tmpdir(), "clawdi-tar-test-"));
		try {
			mkdirSync(join(root, "shared"), { recursive: true });
			// Nested escape: a symlink inside the in-trust dir that
			// points at /etc/hosts.
			symlinkSync("/etc/hosts", join(root, "shared", "leak"));

			mkdirSync(join(root, "skill"), { recursive: true });
			writeFileSync(join(root, "skill", "SKILL.md"), "# decoy");
			// In-trust symlink to the sibling shared dir.
			symlinkSync(join(root, "shared"), join(root, "skill", "shared"));

			await expect(tarSkillDir(join(root, "skill"))).rejects.toThrow(
				/pointing outside the agent's skills directory/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects symlinks pointing outside the skills tree", async () => {
		// A symlink to /etc/passwd (or anything outside the parent skills
		// dir) is the original attack we're guarding against. The widened
		// trust root must NOT make that legal.
		const root = mkdtempSync(join(tmpdir(), "clawdi-tar-test-"));
		try {
			mkdirSync(join(root, "evil"), { recursive: true });
			writeFileSync(join(root, "evil", "SKILL.md"), "# decoy");
			// Use /etc/hosts (always present, world-readable) as the
			// out-of-tree target. /etc/passwd is symbolic for the attack
			// but hosts works on every platform we run tests on.
			symlinkSync("/etc/hosts", join(root, "evil", "leak"));
			await expect(tarSkillDir(join(root, "evil"))).rejects.toThrow(
				/pointing outside the agent's skills directory/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
