import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	assertDirectoryIdentity,
	ensureDirectoryWithinTrustedRoot,
	openTrustedDirectory,
	sameFileIdentity,
} from "./trusted-directory";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

export interface PrivateFileWriteOptions {
	/** Already pinned parent; staging and rename stay relative to this descriptor. */
	directoryFd?: number;
	beforeRename?: () => void;
	mode?: number;
	/**
	 * Mode for directories created by this write only. Pre-existing
	 * directories are never chmodded: platform roots own their mode via
	 * systemd directory directives, and user directories are not ours to
	 * re-assert.
	 */
	dirMode?: number;
	durable?: boolean;
	trustedRoot?: string;
}

export function writePrivateFileAtomic(
	path: string,
	content: string | Uint8Array,
	options: PrivateFileWriteOptions = {},
): void {
	const mode = options.mode ?? PRIVATE_FILE_MODE;
	const namedDirectory = dirname(path);
	const dir =
		options.directoryFd === undefined ? namedDirectory : `/proc/self/fd/${options.directoryFd}`;
	if (options.directoryFd !== undefined) {
		assertDirectoryIdentity(namedDirectory, options.directoryFd);
	} else if (options.trustedRoot) {
		// Creation-time modes for subdirectories are applied by
		// ensureDirectoryWithinTrustedRoot; a pre-existing trusted root is
		// never chmodded by a child-file writer.
		ensureDirectoryWithinTrustedRoot(options.trustedRoot, dir, {
			...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
		});
	} else {
		const existed = existsSync(dir);
		mkdirSync(dir, {
			recursive: true,
			...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
		});
		// mkdir modes are filtered by umask, so re-assert the exact mode on
		// directories this write created; pre-existing directories are not
		// touched.
		if (!existed && options.dirMode !== undefined) chmodBestEffort(dir, options.dirMode);
	}
	const tmp = join(
		dir,
		`.${basename(path)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	try {
		writeFileSync(tmp, content, { mode });
		chmodBestEffort(tmp, mode);
		if (options.durable) fsyncPath(tmp);
		if (options.directoryFd !== undefined)
			assertDirectoryIdentity(namedDirectory, options.directoryFd);
		options.beforeRename?.();
		const destination = options.directoryFd === undefined ? path : join(dir, basename(path));
		renameSync(tmp, destination);
		chmodBestEffort(destination, mode);
		// Windows flushes the file above but does not permit fsync on a
		// directory handle. POSIX needs the directory flush to persist rename.
		if (options.durable && process.platform !== "win32") fsyncPath(dir);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

function fsyncPath(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

export function chmodBestEffort(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Best effort on platforms without POSIX modes.
	}
}

export interface PrivateFileEvidence {
	readonly content: Buffer;
	readonly directoryFd: number;
	assertCurrent(): void;
	close(): void;
}

function sameEvidence(left: Stats, right: Stats): boolean {
	return (
		sameFileIdentity(left, right) &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function readBounded(fd: number, maxBytes: number): Buffer {
	const content = Buffer.allocUnsafe(maxBytes + 1);
	let length = 0;
	while (length < content.length) {
		const count = readSync(fd, content, length, content.length - length, length);
		if (count === 0) break;
		length += count;
	}
	if (length > maxBytes) throw new Error("Private file exceeds its size bound");
	return content.subarray(0, length);
}

/** Retain both inode and directory identity until the caller's compare-and-swap finishes. */
export function readPrivateFileEvidence(
	path: string,
	options: { uid: number; gid: number; modes: readonly number[]; maxBytes: number },
): PrivateFileEvidence {
	const directory = dirname(path);
	const directoryFd = openTrustedDirectory(directory);
	let fd: number | undefined;
	const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
	try {
		const directoryStat = fstatSync(directoryFd);
		const pinnedPath = `/proc/self/fd/${directoryFd}/${basename(path)}`;
		fd = openSync(pinnedPath, flags);
		const fileFd = fd;
		const stat = fstatSync(fileFd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== options.uid ||
			stat.gid !== options.gid ||
			!options.modes.includes(stat.mode & 0o7777) ||
			stat.size > options.maxBytes
		)
			throw new Error("Private file ownership, mode or type is invalid");
		const content = readBounded(fileFd, options.maxBytes);
		const assertCurrent = () => {
			assertDirectoryIdentity(directory, directoryFd, directoryStat);
			const namedFd = openSync(pinnedPath, flags);
			try {
				if (
					!sameEvidence(stat, fstatSync(fileFd)) ||
					!sameEvidence(stat, fstatSync(namedFd)) ||
					!readBounded(namedFd, options.maxBytes).equals(content) ||
					!sameEvidence(stat, fstatSync(namedFd))
				)
					throw new Error("Private file identity or contents changed");
			} finally {
				closeSync(namedFd);
			}
			assertDirectoryIdentity(directory, directoryFd, directoryStat);
		};
		assertCurrent();
		return {
			content,
			directoryFd,
			assertCurrent,
			close() {
				closeSync(fileFd);
				closeSync(directoryFd);
			},
		};
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		closeSync(directoryFd);
		throw error;
	}
}
