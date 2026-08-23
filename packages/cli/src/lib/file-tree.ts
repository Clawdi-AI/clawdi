import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RegularFileTreeEntry {
	path: string;
	mode: 0o100644 | 0o100755;
	bytes: Buffer;
}

export interface RegularFileTreeLimits {
	entries: number;
	files: number;
	fileBytes: number;
	totalBytes: number;
}

export function collectRegularFileTree(
	root: string,
	options: {
		limits: RegularFileTreeLimits;
		exclude?: (path: string) => boolean;
		validatePath?: (path: string) => void;
		collisionKey?: (path: string) => string;
		collisionError?: string;
		resourceLabel?: string;
	},
): RegularFileTreeEntry[] {
	const label = options.resourceLabel ?? "file tree";
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`${label} root is not a trusted directory`);
	}
	const tree: RegularFileTreeEntry[] = [];
	const collisionKeys = new Set<string>();
	let entries = 0;
	let totalBytes = 0;
	const visit = (directory: string, prefix: string): void => {
		for (const name of readdirSync(directory).sort((left, right) =>
			Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
		)) {
			const relative = prefix ? `${prefix}/${name}` : name;
			if (options.exclude?.(relative)) continue;
			options.validatePath?.(relative);
			const collisionKey = options.collisionKey?.(relative);
			if (collisionKey !== undefined) {
				if (collisionKeys.has(collisionKey)) {
					throw new Error(options.collisionError ?? `${label} contains a path collision`);
				}
				collisionKeys.add(collisionKey);
			}
			entries += 1;
			if (entries > options.limits.entries) {
				throw new Error(`${label} exceeds ${options.limits.entries} entries`);
			}
			const path = join(directory, name);
			const stat = lstatSync(path);
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				visit(path, relative);
				continue;
			}
			if (!stat.isFile() || stat.isSymbolicLink()) {
				throw new Error(`${label} contains a non-regular entry`);
			}
			if (tree.length >= options.limits.files) {
				throw new Error(`${label} exceeds ${options.limits.files} files`);
			}
			if (stat.size > options.limits.fileBytes) {
				throw new Error(`${label} file exceeds ${options.limits.fileBytes} bytes`);
			}
			totalBytes += stat.size;
			if (totalBytes > options.limits.totalBytes) {
				throw new Error(`${label} exceeds ${options.limits.totalBytes} total file bytes`);
			}
			const bytes = readFileSync(path);
			if (bytes.length !== stat.size) throw new Error(`${label} changed while reading`);
			tree.push({
				path: relative,
				mode: (stat.mode & 0o111) !== 0 ? 0o100755 : 0o100644,
				bytes,
			});
		}
	};
	visit(root, "");
	return tree;
}

export function sha256TreeDigest(tree: readonly RegularFileTreeEntry[]): string {
	const digest = createHash("sha256");
	for (const file of [...tree].sort((left, right) =>
		Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
	)) {
		const contentDigest = createHash("sha256").update(file.bytes).digest("hex");
		digest.update(
			`${file.mode.toString(8)}\0${file.path}\0${file.bytes.length}\0${contentDigest}\n`,
			"utf8",
		);
	}
	return `sha256-tree-v1:${digest.digest("hex")}`;
}
