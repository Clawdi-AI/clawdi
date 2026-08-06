import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function assertTrustedDirectory(path: string, label = "trusted directory"): void {
	let node: ReturnType<typeof lstatSync>;
	try {
		node = lstatSync(path);
	} catch (error) {
		if (isMissing(error)) throw new Error(`${label} is missing: ${path}`);
		throw error;
	}
	if (!node.isDirectory() || node.isSymbolicLink()) {
		throw new Error(`${label} is not a real directory: ${path}`);
	}
}

export function ensureDirectoryWithinTrustedRoot(
	root: string,
	path: string,
	options: { mode?: number } = {},
): void {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	const childPath = relative(resolvedRoot, resolvedPath);
	if (childPath.startsWith("..") || isAbsolute(childPath)) {
		throw new Error(`directory is outside trusted root ${root}: ${path}`);
	}
	assertTrustedDirectory(resolvedRoot);
	if (!childPath) return;

	let current = resolvedRoot;
	for (const segment of childPath.split("/")) {
		current = join(current, segment);
		try {
			const node = lstatSync(current);
			if (!node.isDirectory() || node.isSymbolicLink()) {
				throw new Error(`trusted directory path contains a non-directory: ${current}`);
			}
		} catch (error) {
			if (!isMissing(error)) throw error;
			mkdirSync(current, options.mode === undefined ? undefined : { mode: options.mode });
			if (options.mode !== undefined) chmodSync(current, options.mode);
		}
	}
}
