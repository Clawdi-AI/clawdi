import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDirectoryWithinTrustedRoot } from "./trusted-directory";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

interface PrivateFileWriteOptions {
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
	const dir = dirname(path);
	if (options.trustedRoot) {
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
		renameSync(tmp, path);
		chmodBestEffort(path, mode);
		if (options.durable) fsyncPath(dir);
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
