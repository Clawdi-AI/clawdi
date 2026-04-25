import { basename, resolve } from "node:path";
import * as tar from "tar";

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
 * Create a tar.gz buffer from a skill directory.
 *
 * `follow: true` dereferences symlinks at archive time. gstack-style skills
 * use symlinks heavily (e.g. `autoplan/SKILL.md` → a shared template) and the
 * backend rejects archives containing symlink entries for security. Following
 * inlines the real file content, which is what the user actually wants
 * uploaded anyway.
 */
export async function tarSkillDir(dirPath: string): Promise<Buffer> {
	const parentDir = resolve(dirPath, "..");
	const dirName = basename(dirPath);

	const chunks: Buffer[] = [];
	await tar
		.create({ gzip: true, cwd: parentDir, follow: true }, [dirName])
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
