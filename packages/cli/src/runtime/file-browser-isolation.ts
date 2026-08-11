import { lstatSync } from "node:fs";
import type { RuntimePaths } from "./paths";
import { runtimeUserGid, runtimeUserUid } from "./runtime-user-command";

export interface FileBrowserServiceIdentity {
	uid: number;
	gid: number;
}

export type FileBrowserServiceIsolation = (
	paths: RuntimePaths,
	sourceRoot: string,
) => FileBrowserServiceIdentity;

export function ensureFileBrowserServiceIsolation(
	paths: RuntimePaths,
	sourceRoot: string,
): FileBrowserServiceIdentity {
	if (sourceRoot !== paths.userHome || /\s/.test(sourceRoot)) {
		throw new Error("Files source root must be the canonical tenant home path");
	}
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	if (runtimeUser === "root" || runtimeUser === "0") {
		throw new Error("Files requires a non-root tenant runtime user");
	}
	const identity = {
		uid: runtimeUserUid(runtimeUser),
		gid: runtimeUserGid(runtimeUser),
	};
	const root = lstatSync(sourceRoot);
	if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== identity.uid) {
		throw new Error("Files source root must be owned by the tenant runtime user");
	}
	return identity;
}
