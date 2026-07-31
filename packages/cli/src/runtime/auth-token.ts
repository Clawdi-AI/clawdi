import { readFileSync, rmSync } from "node:fs";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimePaths } from "./paths";
import { runtimeSecretValue } from "./secret-values";

export const RUNTIME_AUTH_TOKEN_SECRET_REF = "secret://clawdi/auth-token";

export function readRuntimeAuthToken(paths: RuntimePaths): string | null {
	try {
		return normalizeRuntimeAuthToken(readFileSync(paths.daemonAuthToken, "utf-8"));
	} catch {
		return null;
	}
}

export function writeRuntimeAuthToken(paths: RuntimePaths, token: string): string {
	const normalized = normalizeRuntimeAuthToken(token);
	if (!normalized) {
		throw new Error("runtime auth token must be non-empty and contain no control characters");
	}
	writePrivateFileAtomic(paths.daemonAuthToken, `${normalized}\n`, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
	return paths.daemonAuthToken;
}

export function readRuntimeCredential(secretValues: Record<string, unknown>): string | null {
	return runtimeSecretValue(secretValues, RUNTIME_AUTH_TOKEN_SECRET_REF);
}

export function ensureRuntimeAuthTokenFile(
	paths: RuntimePaths,
	secretValues: Record<string, unknown>,
): string | null {
	const token = readRuntimeCredential(secretValues);
	if (token) return writeRuntimeAuthToken(paths, token);
	rmSync(paths.daemonAuthToken, { force: true });
	return null;
}

export function runtimeAuthTokenFileLabel(paths: RuntimePaths): string {
	return paths.daemonAuthToken;
}

function normalizeRuntimeAuthToken(token: string): string | null {
	const normalized = token.trim();
	if (!normalized) return null;
	for (const character of normalized) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return null;
	}
	return normalized;
}
