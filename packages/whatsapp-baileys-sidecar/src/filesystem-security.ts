import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export function assertOwnedDirectory(path: string, mode: number, label: string): void {
	if (resolve(path) !== path) {
		throw new Error(`${label} must be an absolute normalized path`);
	}
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
		throw new Error(`${label} must be a real directory without symlink components`);
	}
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (uid === undefined || gid === undefined || stat.uid !== uid || stat.gid !== gid) {
		throw new Error(`${label} must be owned by the sidecar uid and gid`);
	}
	if ((stat.mode & 0o777) !== mode) {
		throw new Error(`${label} must have mode ${mode.toString(8)}`);
	}
}
