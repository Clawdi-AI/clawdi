import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimePaths } from "./paths";

export const RUNTIME_AUTH_TOKEN_ENV = "CLAWDI_AUTH_TOKEN";

export function legacyRuntimeAuthTokenPath(paths: RuntimePaths): string {
	return join(paths.runRoot, "sync", "auth-token");
}

export function readRuntimeAuthToken(paths: RuntimePaths): string | null {
	try {
		const token = readFileSync(paths.daemonAuthToken, "utf-8").trim();
		return token || null;
	} catch {
		return null;
	}
}

export function writeRuntimeAuthToken(paths: RuntimePaths, token: string): string {
	const normalized = token.trim();
	if (!normalized) {
		throw new Error("runtime auth token must not be empty");
	}
	rmSync(legacyRuntimeAuthTokenPath(paths), { force: true });
	writePrivateFileAtomic(paths.daemonAuthToken, `${normalized}\n`, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
	return paths.daemonAuthToken;
}

export function ensureRuntimeAuthTokenFile(paths: RuntimePaths): string | null {
	const token = process.env[RUNTIME_AUTH_TOKEN_ENV]?.trim();
	if (token) return writeRuntimeAuthToken(paths, token);
	if (readRuntimeAuthToken(paths)) {
		rmSync(legacyRuntimeAuthTokenPath(paths), { force: true });
		return paths.daemonAuthToken;
	}
	rmSync(paths.daemonAuthToken, { force: true });
	rmSync(legacyRuntimeAuthTokenPath(paths), { force: true });
	return null;
}

export function runtimeAuthTokenFileLabel(paths: RuntimePaths): string {
	return paths.daemonAuthToken;
}
