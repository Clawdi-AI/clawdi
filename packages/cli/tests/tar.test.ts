/**
 * `tarSkillDir` exclude-list invariants. The filter has caused regressions
 * twice — once tarring 100MB of node_modules into every skill (Cloudflare
 * 413), and once silently dropping a skill literally named `dist` because
 * the exclude check ran on the root segment too. These tests pin both.
 */

import { describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { computeSkillFolderHash } from "../src/lib/skills-lock";
import {
	computeSkillArchiveHash,
	extractTarGz,
	replaceSkillArchiveTarGz,
	SKILL_ARCHIVE_EXTRACTION_LIMITS,
	tarSingleFile,
	tarSkillDir,
} from "../src/lib/tar";

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

async function createTarGz(cwd: string, paths: string[]): Promise<Buffer> {
	const chunks: Buffer[] = [];
	await tar
		.create({ gzip: true, cwd }, paths)
		.on("data", (chunk: Buffer) => chunks.push(chunk))
		.promise();
	return Buffer.concat(chunks);
}

function createSpecialEntryTarGz(type: "FIFO" | "CharacterDevice" | "BlockDevice"): Buffer {
	const header = new tar.Header({
		path: "special",
		type,
		mode: 0o600,
		uid: 0,
		gid: 0,
		size: 0,
		mtime: new Date(0),
	});
	const headerBlock = Buffer.alloc(512);
	if (header.encode(headerBlock)) throw new Error("crafted tar header unexpectedly needs PAX");
	return gzipSync(Buffer.concat([headerBlock, Buffer.alloc(1_024)]));
}

describe("extractTarGz resource limits", () => {
	it("extracts a valid nested Hermes archive within every limit", async () => {
		const { path, cleanup } = buildSkill({
			"category/foo/SKILL.md": "# nested",
			"category/foo/references/notes.md": "safe",
		});
		const destination = mkdtempSync(join(tmpdir(), "clawdi-tar-extract-test-"));
		try {
			const bytes = await createTarGz(path, ["category/foo"]);
			await extractTarGz(destination, bytes);
			expect(readFileSync(join(destination, "category/foo/SKILL.md"), "utf8")).toBe("# nested");
			expect(readFileSync(join(destination, "category/foo/references/notes.md"), "utf8")).toBe(
				"safe",
			);
		} finally {
			cleanup();
			rmSync(destination, { recursive: true, force: true });
		}
	});

	it("rejects an archive over the entry-count ceiling", async () => {
		const source = mkdtempSync(join(tmpdir(), "clawdi-tar-count-source-"));
		const destination = mkdtempSync(join(tmpdir(), "clawdi-tar-count-target-"));
		try {
			const archiveRoot = join(source, "many");
			mkdirSync(archiveRoot, { recursive: true });
			for (let index = 0; index < SKILL_ARCHIVE_EXTRACTION_LIMITS.entryCount; index += 1) {
				writeFileSync(join(archiveRoot, `${index.toString().padStart(4, "0")}.txt`), "");
			}
			const bytes = await createTarGz(source, ["many"]);
			await expect(extractTarGz(destination, bytes)).rejects.toThrow(
				`exceeds ${SKILL_ARCHIVE_EXTRACTION_LIMITS.entryCount} entries`,
			);
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(destination, { recursive: true, force: true });
		}
	});

	it("rejects an oversized entry before writing its payload", async () => {
		const source = mkdtempSync(join(tmpdir(), "clawdi-tar-entry-source-"));
		const destination = mkdtempSync(join(tmpdir(), "clawdi-tar-entry-target-"));
		try {
			mkdirSync(join(source, "large"), { recursive: true });
			writeFileSync(
				join(source, "large/payload.bin"),
				Buffer.alloc(SKILL_ARCHIVE_EXTRACTION_LIMITS.entryBytes + 1),
			);
			const bytes = await createTarGz(source, ["large"]);
			await expect(extractTarGz(destination, bytes)).rejects.toThrow(
				`entry exceeds ${SKILL_ARCHIVE_EXTRACTION_LIMITS.entryBytes} bytes`,
			);
			expect(existsSync(join(destination, "large/payload.bin"))).toBe(false);
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(destination, { recursive: true, force: true });
		}
	});

	it("bounds cumulative writes from a highly-compressible archive", async () => {
		const source = mkdtempSync(join(tmpdir(), "clawdi-tar-total-source-"));
		const destination = mkdtempSync(join(tmpdir(), "clawdi-tar-total-target-"));
		try {
			const archiveRoot = join(source, "large");
			mkdirSync(archiveRoot, { recursive: true });
			const firstEntry = Buffer.alloc(SKILL_ARCHIVE_EXTRACTION_LIMITS.entryBytes);
			randomBytes(128 * 1024).copy(firstEntry);
			writeFileSync(join(archiveRoot, "a.bin"), firstEntry);
			writeFileSync(
				join(archiveRoot, "b.bin"),
				Buffer.alloc(SKILL_ARCHIVE_EXTRACTION_LIMITS.entryBytes),
			);
			writeFileSync(join(archiveRoot, "c.bin"), Buffer.alloc(1));
			const bytes = await createTarGz(source, ["large"]);
			// This is intentionally bomb-shaped: tens of MiB of zeros should
			// compress to a tiny input while still being bounded on expansion.
			expect(bytes.length).toBeLessThan(SKILL_ARCHIVE_EXTRACTION_LIMITS.entryBytes);
			await expect(extractTarGz(destination, bytes)).rejects.toThrow(
				`exceeds ${SKILL_ARCHIVE_EXTRACTION_LIMITS.totalEntryBytes} total entry bytes`,
			);
			expect(existsSync(join(destination, "large/c.bin"))).toBe(false);
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(destination, { recursive: true, force: true });
		}
	});

	it("stops malformed gzip expansion before feeding an unbounded tar stream", async () => {
		const destination = mkdtempSync(join(tmpdir(), "clawdi-tar-expanded-target-"));
		try {
			const bomb = gzipSync(Buffer.alloc(SKILL_ARCHIVE_EXTRACTION_LIMITS.expandedTarBytes + 1));
			await expect(extractTarGz(destination, bomb)).rejects.toThrow(
				`exceeds ${SKILL_ARCHIVE_EXTRACTION_LIMITS.expandedTarBytes} expanded tar bytes`,
			);
			expect(readdirSync(destination)).toEqual([]);
		} finally {
			rmSync(destination, { recursive: true, force: true });
		}
	});

	it("rejects special filesystem entries before writing to the destination", async () => {
		for (const type of ["FIFO", "CharacterDevice", "BlockDevice"] as const) {
			const destination = mkdtempSync(join(tmpdir(), "clawdi-tar-special-target-"));
			try {
				await expect(extractTarGz(destination, createSpecialEntryTarGz(type))).rejects.toThrow(
					"unsupported entry type",
				);
				expect(readdirSync(destination)).toEqual([]);
			} finally {
				rmSync(destination, { recursive: true, force: true });
			}
		}
	});
});

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

	it("rejects unsafe shared skill keys before extracting to disk", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-shared-extract-test-"));
		try {
			const bytes = await tarSingleFile("safe-skill", "# safe");
			const skillsRoot = join(root, "skills");
			await expect(
				replaceSkillArchiveTarGz("../escape", skillsRoot, join(skillsRoot, "target"), bytes),
			).rejects.toThrow("Invalid skill_key");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects symlink entries from imported shared skill archives", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-shared-extract-test-"));
		try {
			mkdirSync(join(root, "safe-skill"), { recursive: true });
			writeFileSync(join(root, "safe-skill", "SKILL.md"), "# safe");
			symlinkSync("/etc/hosts", join(root, "safe-skill", "leak"));

			const chunks: Buffer[] = [];
			await tar
				.create({ gzip: true, cwd: root }, ["safe-skill"])
				.on("data", (chunk: Buffer) => chunks.push(chunk))
				.promise();

			const skillsRoot = join(root, "skills");
			const target = join(skillsRoot, "target");
			await expect(
				replaceSkillArchiveTarGz("safe-skill", skillsRoot, target, Buffer.concat(chunks)),
			).rejects.toThrow("unsupported entry type");
			expect(existsSync(target)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("atomically replaces a nested Hermes skill from staging outside the watched root", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-skill-replace-test-"));
		const skillsRoot = join(root, "skills");
		const target = join(skillsRoot, "category", "foo");
		try {
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "SKILL.md"), "# old");

			const malformedRoot = join(root, "malformed");
			mkdirSync(join(malformedRoot, "category"), { recursive: true });
			writeFileSync(join(malformedRoot, "category", "foo"), "not a directory");
			const chunks: Buffer[] = [];
			await tar
				.create({ gzip: true, cwd: malformedRoot }, ["category/foo"])
				.on("data", (chunk: Buffer) => chunks.push(chunk))
				.promise();
			await expect(
				replaceSkillArchiveTarGz("category/foo", skillsRoot, target, Buffer.concat(chunks)),
			).rejects.toThrow("expected 'category/foo/' root entry");
			expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toBe("# old");

			const replacement = await tarSingleFile("category/foo", "# new");
			await replaceSkillArchiveTarGz("category/foo", skillsRoot, target, replacement);
			expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toBe("# new");
			expect(readdirSync(root).filter((entry) => entry.startsWith(".skills-stage-"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
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
			const skillDir = join(root, "autoplan");
			const bytes = await tarSkillDir(skillDir);
			const entries = await listEntries(bytes);
			expect(entries).toContain("autoplan/SKILL.md");
			const firstHash = await computeSkillFolderHash(skillDir, undefined, "autoplan");
			expect(await computeSkillArchiveHash(bytes, "autoplan")).toBe(firstHash);

			writeFileSync(join(root, "gstack", "autoplan", "SKILL.md"), "# changed target\n");
			const changedHash = await computeSkillFolderHash(skillDir, undefined, "autoplan");
			expect(changedHash).not.toBe(firstHash);
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
			expect(await computeSkillArchiveHash(bytes, "category/foo")).toBe(
				await computeSkillFolderHash(join(root, "category", "foo"), undefined, "category/foo"),
			);
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
			await expect(
				computeSkillFolderHash(join(root, "category", "foo"), undefined, "category/foo"),
			).rejects.toThrow(/pointing outside the agent's skills directory/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an in-trust directory symlink cycle before archiving or hashing", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-tar-cycle-test-"));
		try {
			const skillDir = join(root, "cycle");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "SKILL.md"), "# cycle\n");
			symlinkSync(skillDir, join(skillDir, "loop"));
			await expect(tarSkillDir(skillDir)).rejects.toThrow(/cyclic/);
			await expect(computeSkillFolderHash(skillDir, undefined, "cycle")).rejects.toThrow(/cyclic/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps chmod-only changes outside the published path-and-bytes hash", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-tar-mode-test-"));
		try {
			const skillDir = join(root, "mode-only");
			mkdirSync(skillDir, { recursive: true });
			const skillFile = join(skillDir, "SKILL.md");
			writeFileSync(skillFile, "# stable bytes\n");
			const before = await computeSkillFolderHash(skillDir, undefined, "mode-only");
			chmodSync(skillFile, 0o700);
			expect(await computeSkillFolderHash(skillDir, undefined, "mode-only")).toBe(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("orders projected paths by Python-compatible codepoint order", async () => {
		const { path, cleanup } = buildSkill({
			"ordered/a.md": "lower",
			"ordered/Z.md": "upper",
			"ordered/SKILL.md": "skill",
		});
		try {
			const expected = createHash("sha256");
			for (const [relativePath, content] of [
				["SKILL.md", "skill"],
				["Z.md", "upper"],
				["a.md", "lower"],
			] as const) {
				expected.update(relativePath);
				expected.update(content);
			}
			const bytes = await tarSkillDir(join(path, "ordered"));
			expect(await computeSkillArchiveHash(bytes, "ordered")).toBe(expected.digest("hex"));
		} finally {
			cleanup();
		}
	});

	it("matches the Python hash for astral and BMP paths in the same archive", async () => {
		const encoded = readFileSync(
			new URL("../../../test-fixtures/skill-hash/unicode-tree.tar.gz.b64", import.meta.url),
			"utf8",
		).trim();
		const archive = Buffer.from(encoded, "base64");
		expect(await computeSkillArchiveHash(archive, "unicode")).toBe(
			"18e78f6921e3d0fe6443fa12b74921e9b4bb5bead518ca9b3af638a2ab1eda10",
		);
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

	it("rechecks ownership at the activation boundary and restores the previous target", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-tar-test-"));
		try {
			const skillsRoot = join(root, "skills");
			const target = join(skillsRoot, "example");
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "SKILL.md"), "old\n");
			const archive = await tarSingleFile("example", "new\n");
			await expect(
				replaceSkillArchiveTarGz("example", skillsRoot, target, archive, () => {
					throw new Error("reservation appeared");
				}),
			).rejects.toThrow("reservation appeared");
			expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("old\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
