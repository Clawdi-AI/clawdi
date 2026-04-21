import { basename, resolve } from "node:path";
import * as tar from "tar";

/**
 * Create a tar.gz buffer from a skill directory.
 */
export async function tarSkillDir(dirPath: string): Promise<Buffer> {
	const parentDir = resolve(dirPath, "..");
	const dirName = basename(dirPath);

	const chunks: Buffer[] = [];
	await tar
		.create(
			{
				gzip: true,
				cwd: parentDir,
				// Resolve symlinks at archive time so plugin-installed skills (which
				// use a symlink into a shared bundle) ship their real contents, and
				// the server's "no symlinks in tarball" rule is upheld without
				// rejecting the whole skill.
				follow: true,
				filter: (path) => {
					const parts = path.split("/");
					return !parts.includes("node_modules") && !parts.includes(".git");
				},
			},
			[dirName],
		)
		.on("data", (chunk: Buffer) => chunks.push(chunk))
		.promise();
	return Buffer.concat(chunks);
}

/**
 * Create a tar.gz buffer wrapping a single file as {key}/SKILL.md.
 */
export async function tarSingleFile(
	skillKey: string,
	content: string,
): Promise<Buffer> {
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
