import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

interface PrivateFileWriteOptions {
	mode?: number;
	dirMode?: number;
}

export function writePrivateFileAtomic(
	path: string,
	content: string,
	options: PrivateFileWriteOptions = {},
): void {
	const mode = options.mode ?? PRIVATE_FILE_MODE;
	const dir = dirname(path);
	mkdirSync(dir, {
		recursive: true,
		...(options.dirMode !== undefined ? { mode: options.dirMode } : {}),
	});
	if (options.dirMode !== undefined) chmodBestEffort(dir, options.dirMode);
	const tmp = join(
		dir,
		`.${basename(path)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	try {
		writeFileSync(tmp, content, { mode });
		chmodBestEffort(tmp, mode);
		renameSync(tmp, path);
		chmodBestEffort(path, mode);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

export function chmodBestEffort(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Best effort on platforms without POSIX modes.
	}
}
