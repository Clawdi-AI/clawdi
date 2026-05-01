import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import chalk from "chalk";
import { getClawdiDir } from "./config";
import { SKILL_TAR_EXCLUDE } from "./tar";

/**
 * Per-skill content-hash cache used by `clawdi push --modules skills` to
 * decide which skills are already in sync with the cloud. Mirrors the
 * Vercel skills CLI's `skills-lock.json` pattern (see
 * `/Users/paco/workspace/skills/src/local-lock.ts`) and shares the same
 * file-tree hashing algorithm so server and client agree on what's
 * "the same skill."
 *
 * Lives at `~/.clawdi/skills-lock.json` — single file, version-stamped,
 * corrupt-tolerant. Authoritative state is the cloud; this cache is just
 * an optimization. Deleting it forces the next push to re-confirm every
 * skill against the server, which is safe.
 */
export interface SkillsLock {
	version: 2;
	// Key is `${agentType}:${skill_key}` — phase-2 scopes mean the same
	// `skill_key` can live in different agents' scopes independently. A
	// pre-fix flat-keyed cache would let multi-agent push think agent B
	// already shipped `foo` because agent A did, and skip the upload —
	// B's scope would silently never receive `foo`. Use `skillCacheKey()`
	// to compose, never raw skill_key.
	skills: Record<string, { hash: string }>;
}

const LOCK_FILE = "skills-lock.json";
const CURRENT_VERSION = 2;

/** Compose the partitioned cache key. Mirrors `cacheKey()` in
 * sessions-lock so the two locks stay shape-aligned. */
export function skillCacheKey(agentType: string, skillKey: string): string {
	return `${agentType}:${skillKey}`;
}

/**
 * SHA-256 over the file tree of a skill directory. Walks every file
 * (skipping excluded dirs), sorts by relative path, then hashes
 * `path + content` per file into a single digest.
 *
 * Direct port of Vercel's `computeSkillFolderHash`
 * (`/Users/paco/workspace/skills/src/local-lock.ts:100-115`). The
 * exclude set is wider than Vercel's (which only skips `.git` and
 * `node_modules`) — see `tar.ts:SKILL_TAR_EXCLUDE` for why. Server-side
 * mirror lives at `backend/app/routes/skills.py:_compute_file_tree_hash`.
 *
 * Cheap: no tar build needed. Deterministic: same input directory
 * always produces the same hash regardless of mtimes or build order.
 */
export async function computeSkillFolderHash(skillDir: string): Promise<string> {
	const files: Array<{ relativePath: string; content: Buffer }> = [];
	await collectFiles(skillDir, skillDir, files);
	// Codepoint sort, NOT localeCompare — Python's default `list.sort()` is
	// codepoint-based, so the server-side mirror in
	// `backend/app/routes/skills.py:_compute_file_tree_hash` would diverge
	// (e.g. "SKILL.md" vs "reference/notes.md" reorders by case under
	// localeCompare). Both sides MUST sort identically or hashes drift.
	files.sort((a, b) =>
		a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
	);

	const hash = createHash("sha256");
	for (const f of files) {
		hash.update(f.relativePath);
		hash.update(f.content);
	}
	return hash.digest("hex");
}

async function collectFiles(
	base: string,
	dir: string,
	out: Array<{ relativePath: string; content: Buffer }>,
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (SKILL_TAR_EXCLUDE.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectFiles(base, full, out);
		} else if (entry.isFile()) {
			out.push({
				// Normalize separators to POSIX so hashes are stable across
				// platforms (Windows would otherwise diverge from Unix).
				relativePath: relative(base, full).split("\\").join("/"),
				content: await readFile(full),
			});
		}
	}
}

/**
 * Read `~/.clawdi/skills-lock.json`. Returns an empty cache when the
 * file is missing, corrupt, or written by a future version.
 *
 * Backwards compat: v1 lock files used flat `skill_key` keys (no
 * agent partition). Bumping the version dropped them outright,
 * which is fine for a pure cache but the daemon's boot conflict
 * resolution depends on `lastShipped` to disambiguate cloud-edits-
 * while-offline (PULL) from local-edits-while-offline (PUSH).
 * Losing the baseline on upgrade misclassified divergence and
 * could resurrect deleted cloud skills or clobber local edits.
 *
 * Migration: keep v1 entries in the returned object so callers can
 * use them as best-effort baselines. The daemon (sync-engine.ts)
 * checks for both `${agentType}:${skill_key}` (v2) and bare
 * `${skill_key}` (v1 fallback) when hydrating. v1 entries persist
 * until the daemon writes a v2 entry over them on next push/pull.
 */
export function readSkillsLock(): SkillsLock {
	const path = join(getClawdiDir(), LOCK_FILE);
	if (!existsSync(path)) return emptyLock();
	try {
		// Use a permissive shape for parse; the on-disk file may
		// be v1 (which the SkillsLock type intentionally no longer
		// permits) or a future version we should refuse.
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			version?: number;
			skills?: Record<string, { hash: string }>;
		};
		if (!parsed.skills || typeof parsed.skills !== "object") return emptyLock();
		// Accept v1 (flat keys) and v2 (agentType:skill_key keys).
		// Anything else is either future or corrupt — drop.
		if (parsed.version !== 1 && parsed.version !== CURRENT_VERSION) return emptyLock();
		// Normalize the returned shape to v2; the daemon's loader
		// inspects each key's format and treats colon-bearing keys
		// as v2 partitioned and bare keys as v1 fallback.
		return { version: CURRENT_VERSION, skills: parsed.skills };
	} catch {
		console.log(chalk.yellow(`⚠ ~/.clawdi/${LOCK_FILE} is corrupted; resetting.`));
		return emptyLock();
	}
}

export function writeSkillsLock(lock: SkillsLock): void {
	const dir = getClawdiDir();
	// Same fresh-HOME path as sessions-lock: env-only auth in a
	// container without a prior `clawdi auth login` won't have
	// `~/.clawdi/` yet. mkdir -p before write so the first
	// successful skill push doesn't ENOENT into a queue retry loop.
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, LOCK_FILE);
	// Sort keys for deterministic output — keeps `git diff` readable when
	// users commit the file alongside their dotfiles, and stabilizes test
	// snapshots.
	const sortedSkills: Record<string, { hash: string }> = {};
	for (const key of Object.keys(lock.skills).sort()) {
		const entry = lock.skills[key];
		if (entry) sortedSkills[key] = entry;
	}
	const sorted: SkillsLock = { version: lock.version, skills: sortedSkills };
	writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
}

function emptyLock(): SkillsLock {
	return { version: CURRENT_VERSION, skills: {} };
}
