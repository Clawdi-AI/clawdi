import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RawSkill } from "../adapters/base";

export interface ScanOptions {
	/** Skip entries whose name starts with `.` (e.g. Codex's `.system/`). */
	skipDotDirs?: boolean;
}

/**
 * Scan a directory one level deep for skill bundles.
 *
 * A direct child is treated as a skill if:
 *   - it's a directory (or a symlink resolving to one — plugin-installed
 *     skills are symlinks into a shared bundle), and
 *   - it contains a SKILL.md.
 *
 * Missing directories, broken symlinks, and non-skill children are silently
 * skipped. Safe to call with a path that doesn't exist.
 */
export function scanFlatSkillsDir(dir: string, opts: ScanOptions = {}): RawSkill[] {
	if (!existsSync(dir)) return [];
	const out: RawSkill[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (opts.skipDotDirs && entry.name.startsWith(".")) continue;
		const dirPath = join(dir, entry.name);
		let isDir = entry.isDirectory();
		if (!isDir && entry.isSymbolicLink()) {
			try {
				isDir = statSync(dirPath).isDirectory();
			} catch {
				isDir = false;
			}
		}
		if (!isDir) continue;
		const skillMd = join(dirPath, "SKILL.md");
		if (!existsSync(skillMd)) continue;
		const content = readFileSync(skillMd, "utf-8");
		const fileCount = readdirSync(dirPath, { recursive: true }).length;
		out.push({
			skillKey: entry.name,
			name: entry.name,
			content,
			filePath: skillMd,
			directoryPath: dirPath,
			isDirectory: fileCount > 1,
		});
	}
	return out;
}

/**
 * Merge skill lists, keeping the first occurrence of each skillKey. Used to
 * combine a default adapter directory with user-configured extra paths
 * without uploading duplicates when a skill is reachable from both.
 */
export function dedupeByKey(skills: RawSkill[]): RawSkill[] {
	const seen = new Set<string>();
	const out: RawSkill[] = [];
	for (const s of skills) {
		if (seen.has(s.skillKey)) continue;
		seen.add(s.skillKey);
		out.push(s);
	}
	return out;
}
