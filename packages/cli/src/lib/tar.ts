import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as tar from "tar";

/**
 * Directories that should never end up inside an uploaded skill tarball.
 * Skills are agent instructions + small helper files — `node_modules/` and
 * build artifacts blow past the upstream 100MB cap and aren't useful to the
 * recipient anyway. Mirrors `SKIP_DIRS` from `adapters/paths.ts` (kept
 * duplicated to avoid an adapter→tar import edge) and extends it with
 * ecosystem dirs that the adapters' enumeration doesn't otherwise filter.
 *
 * Exported because `lib/skills-lock.ts`'s file-tree hash function MUST
 * filter the same set — what we hash has to equal what we'd tar, otherwise
 * the cache could "match" while the actual archive contains different
 * bytes. See lib/skills-lock.ts for the hash-side use. The Python side
 * (`backend/app/routes/skills.py:_SKILL_HASH_EXCLUDE`) mirrors this list
 * with a comment pointing back here; if you add a directory, add it in
 * both places.
 */
export const SKILL_TAR_EXCLUDE = new Set([
	"node_modules",
	".git",
	".turbo",
	".next",
	".cache",
	"dist",
	"build",
	"out",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	"coverage",
]);

/**
 * Extract a gzipped tar archive into `cwd`.
 *
 * Use this instead of `tar.extract({...}).end(bytes)` — `.end()` returns the
 * stream (not a promise), so `await tar.extract(...).end(bytes)` resolves
 * before extraction actually completes, leaving callers in a race with the
 * filesystem. This helper listens for `finish` so the promise resolves only
 * after every entry has been written to disk.
 */
export function extractTarGz(cwd: string, bytes: Buffer): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const stream = tar.extract({
			cwd,
			gzip: true,
			filter: (path) => !path.includes("..") && !path.startsWith("/"),
		});
		stream.on("finish", () => resolvePromise());
		stream.on("error", reject);
		stream.end(bytes);
	});
}

/**
 * Walk `dirPath` looking for symlinks whose resolved target falls
 * outside the trusted area. Returns the list of offending source
 * paths; an empty array means every symlink stays inside.
 *
 * `tar.create({follow: true})` inlines symlink targets into the
 * archive. Without this scan, a skill containing
 * `mySkill/secrets -> /etc/passwd` would happily upload the
 * pointed-at file as a regular tar entry. We need to allow
 * symlinks but bound them to a trust zone.
 *
 * `trustRoot` defaults to the skill's PARENT directory (the agent's
 * skills folder), not the skill directory itself. gstack-style
 * skills use sibling symlinks like
 * `~/.claude/skills/autoplan/SKILL.md → ~/.claude/skills/gstack/autoplan/SKILL.md`
 * — both ends are under the user's own skills tree, so the bound
 * is at the parent. A symlink pointing to `/etc/passwd` or
 * anywhere outside `~/.claude/skills/` is still rejected.
 */
async function findEscapingSymlinks(
	dirPath: string,
	trustRoot?: string | string[],
): Promise<string[]> {
	const skillRoot = await realpath(dirPath);
	// Multiple trust roots supported so a staged copy (`clawdi
	// skill add` of a sanitized name) can simultaneously trust
	// the original source tree (where absolute symlinks point)
	// AND the tmpdir staging the copy was placed in (where
	// preserved relative symlinks resolve). Single-string passes
	// are normalised to a one-element array; the legacy default
	// (skill's parent dir) still applies when `trustRoot` is
	// absent.
	const candidates = Array.isArray(trustRoot)
		? trustRoot
		: trustRoot !== undefined
			? [trustRoot]
			: [dirname(skillRoot)];
	const trustRootsResolved = await Promise.all(candidates.map((r) => realpath(r).catch(() => r)));
	const isInsideTrust = (target: string): boolean => {
		for (const root of trustRootsResolved) {
			if (target === root || target.startsWith(`${root}/`)) return true;
		}
		return false;
	};
	const escaping: string[] = [];

	// Track symlink targets we've already descended into so a cycle
	// (`a -> b`, `b -> a`, both inside the trust root) doesn't make
	// the walk hang. realpath-resolved keys collapse cycles to the
	// same canonical path.
	const visited = new Set<string>();
	const walk = async (current: string): Promise<void> => {
		const entries = await readdir(current, { withFileTypes: true });
		for (const ent of entries) {
			const fullPath = join(current, ent.name);
			if (ent.isSymbolicLink()) {
				try {
					const target = await realpath(fullPath);
					if (!isInsideTrust(target)) {
						escaping.push(fullPath);
						continue;
					}
					// Symlink stays inside the trust root, but tar
					// uses `follow: true` and will dereference any
					// further symlinks INSIDE that target. A
					// `skill/shared -> ../shared` symlink is fine on
					// its own; if `../shared/leak -> /etc/hosts`
					// then we must reject it because the published
					// tarball would otherwise carry /etc/hosts.
					// Recurse into the resolved target so the same
					// escape check fires for nested links. Skip if
					// the resolved target isn't a directory (a
					// symlink to a single file is fully covered by
					// the in-trust check above).
					if (visited.has(target)) continue;
					visited.add(target);
					try {
						const targetStats = await lstat(target);
						if (targetStats.isDirectory()) await walk(target);
					} catch {
						// Target vanished between realpath and
						// lstat; nothing to recurse into.
					}
				} catch {
					// Broken symlink — refuse to archive it; the
					// uploaded blob would be empty / surprising.
					escaping.push(fullPath);
				}
				continue;
			}
			if (ent.isDirectory()) {
				if (SKILL_TAR_EXCLUDE.has(ent.name)) continue;
				try {
					const stats = await lstat(fullPath);
					if (stats.isDirectory()) await walk(fullPath);
				} catch {
					// Directory disappeared between readdir and lstat;
					// skip silently.
				}
			}
		}
	};

	await walk(dirPath);
	return escaping;
}

/**
 * Create a tar.gz buffer from a skill directory.
 *
 * `follow: true` dereferences symlinks at archive time. gstack-style skills
 * use symlinks heavily (e.g. `autoplan/SKILL.md` → a shared template that
 * lives under a sibling directory in the same agent skills folder) and the
 * backend rejects archives containing symlink entries for security.
 * Following inlines the real file content, which is what the user actually
 * wants uploaded anyway.
 *
 * BEFORE following, walk the tree and refuse to archive if any symlink
 * resolves outside the trust zone. The default trust zone is the parent
 * skills directory — broad enough to allow gstack-style sibling symlinks
 * (autoplan → gstack/autoplan) but tight enough to still reject
 * `secrets → /etc/passwd` or anything else outside the agent's skills
 * tree. Pass `trustRoot` to override (e.g. for a test fixture rooted in
 * `/tmp`).
 */
export async function tarSkillDir(
	dirPath: string,
	trustRoot?: string | string[],
	skillKey?: string,
): Promise<Buffer> {
	// `skillKey` is the cloud-side identifier of the skill. For
	// flat layouts it equals `basename(dirPath)`; for Hermes
	// nested layouts it's `category/foo` etc. The archive's
	// directory entries MUST use the full key as the prefix so a
	// later download/extract at the skills root recreates the
	// correct on-disk path. Pre-fix the daemon archived only
	// `basename(dirPath)` (e.g. `foo/`) for a `category/foo`
	// upload — the cloud row was keyed `category/foo` but the
	// extracted bytes landed at the wrong path on every other
	// machine.
	const archivePath = skillKey ?? basename(dirPath);
	// Walk up so `cwd` is the directory under which the archive
	// path lives. For "foo" (flat) this is one level up
	// (parent of `<root>/foo`). For "category/foo" (nested) it's
	// two levels up — landing at `<rootDir>` itself.
	const components = archivePath.split("/").filter(Boolean);
	let cwd = dirPath;
	for (let i = 0; i < components.length; i++) {
		cwd = resolve(cwd, "..");
	}

	// Symlink trust root defaults to the SKILLS ROOT we just
	// derived (`cwd`), not the skill's immediate parent. For flat
	// keys these are the same directory; for nested Hermes keys
	// they differ — `dirname(<skills>/category/foo) == <skills>/category`,
	// so a legitimate sibling symlink under `<skills>/another-category`
	// would be incorrectly flagged as escaping by the default
	// `findEscapingSymlinks` fallback. Using the agent's actual
	// skills root preserves gstack-style cross-skill symlinks
	// while still rejecting `secrets -> /etc/passwd` and anything
	// outside the user's own skills tree.
	const escaping = await findEscapingSymlinks(dirPath, trustRoot ?? cwd);
	if (escaping.length > 0) {
		throw new Error(
			`Skill contains symlink(s) pointing outside the agent's skills directory; refusing to upload: ${escaping.join(", ")}`,
		);
	}

	const chunks: Buffer[] = [];
	await tar
		.create(
			{
				gzip: true,
				cwd,
				follow: true,
				// Strip `node_modules/`, `.git/`, build output, virtualenvs, etc.
				// The `tar` package passes both files and directories through this
				// filter; returning false for a directory excludes the whole subtree.
				// `path` is relative to `cwd` and uses POSIX separators. With a
				// nested skillKey like `category/foo`, the first N segments are the
				// key components themselves — skip ALL of them so a skill
				// legitimately named `dist`/`build`/`out` (or whose category dir
				// is) doesn't get packaged as an empty tarball.
				filter: (path) => {
					const segments = path.split("/").slice(components.length);
					return !segments.some((seg) => SKILL_TAR_EXCLUDE.has(seg));
				},
			},
			[archivePath],
		)
		.on("data", (chunk: Buffer) => chunks.push(chunk))
		.promise();
	return Buffer.concat(chunks);
}

/**
 * Create a tar.gz buffer wrapping a single file as {key}/SKILL.md.
 */
export async function tarSingleFile(skillKey: string, content: string): Promise<Buffer> {
	const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const tmpDir = mkdtempSync(join(tmpdir(), "clawdi-skill-"));
	const skillDir = join(tmpDir, skillKey);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), content);

	const chunks: Buffer[] = [];
	await tar
		.create({ gzip: true, cwd: tmpDir }, [skillKey])
		.on("data", (chunk: Buffer) => chunks.push(chunk))
		.promise();
	const result = Buffer.concat(chunks);

	rmSync(tmpDir, { recursive: true, force: true });
	return result;
}
