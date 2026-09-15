import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	type Stats,
} from "node:fs";
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

/** Pin a directory through no-follow ancestor traversal, using the current filesystem identity. */
export function openTrustedDirectory(path: string): number {
	if (!isAbsolute(path) || resolve(path) !== path)
		throw new Error("Directory path must be canonical and absolute");
	let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		for (const part of path.split("/").filter(Boolean)) {
			const next = openSync(
				`/proc/self/fd/${fd}/${part}`,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			closeSync(fd);
			fd = next;
			const stat = fstatSync(fd);
			if (
				(stat.uid !== 0 && stat.uid !== process.geteuid?.()) ||
				((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
			) {
				throw new Error("Directory has untrusted ownership or permissions");
			}
		}
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

export function sameFileIdentity(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode
	);
}

/** Rewalk the named path so replacing an ancestor or parent cannot redirect a pinned operation. */
export function assertDirectoryIdentity(
	path: string,
	fd: number,
	expected: Stats = fstatSync(fd),
): void {
	const current = openTrustedDirectory(path);
	try {
		if (
			!sameFileIdentity(expected, fstatSync(fd)) ||
			!sameFileIdentity(expected, fstatSync(current))
		)
			throw new Error("Directory identity changed");
	} finally {
		closeSync(current);
	}
}
