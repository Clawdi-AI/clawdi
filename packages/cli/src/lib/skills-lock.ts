import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
	version: 1;
	// Key is `skill_key` (skills are user-scoped, no agent partition needed —
	// a skill with a given key is conceptually the same skill regardless of
	// which agent's home it lives in).
	skills: Record<string, { hash: string }>;
}

const LOCK_FILE = "skills-lock.json";
const CURRENT_VERSION = 1;

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
	files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

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
 * file is missing, corrupt, or written by a future version. The next
 * push re-confirms with the server and re-warms the cache — safe.
 */
export function readSkillsLock(): SkillsLock {
	const path = join(getClawdiDir(), LOCK_FILE);
	if (!existsSync(path)) return emptyLock();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as SkillsLock;
		if (parsed.version !== CURRENT_VERSION || !parsed.skills) return emptyLock();
		return parsed;
	} catch {
		console.log(chalk.yellow(`⚠ ~/.clawdi/${LOCK_FILE} is corrupted; resetting.`));
		return emptyLock();
	}
}

export function writeSkillsLock(lock: SkillsLock): void {
	const path = join(getClawdiDir(), LOCK_FILE);
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
