import { type Dirent, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionScanRequest } from "./base";
import { isPathWithinRoots } from "./paths";

/** An empty, non-JSONL, or out-of-root request requires a complete inventory. */
export function jsonlPathsWithin(
	request: SessionScanRequest,
	roots: readonly string[],
): string[] | null {
	if (request.kind !== "paths" || request.paths.length === 0) return null;
	const paths = request.paths.map((path) => resolve(path));
	return paths.every((path) => path.endsWith(".jsonl") && isPathWithinRoots(path, roots))
		? paths
		: null;
}

/** Preserve directory encounter order; callers retain their inventory ordering and visibility. */
export function listJsonlFiles(root: string, options: { skipHidden?: boolean } = {}): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (options.skipHidden && entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	};
	walk(root);
	return files;
}
