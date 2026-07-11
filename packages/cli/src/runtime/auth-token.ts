import { readFileSync, rmSync } from "node:fs";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimePaths } from "./paths";

export const RUNTIME_AUTH_TOKEN_ENV = "CLAWDI_AUTH_TOKEN";
export const RUNTIME_AUTH_ENV_SELECTOR = "CLAWDI_RUNTIME_AUTH_ENV";

export function runtimeAuthEnvName(): string {
	const selected = process.env[RUNTIME_AUTH_ENV_SELECTOR]?.trim();
	if (!selected) {
		throw new Error(`missing ${RUNTIME_AUTH_ENV_SELECTOR}`);
	}
	if (!/^[A-Z_][A-Z0-9_]*$/.test(selected)) {
		throw new Error(
			`invalid ${RUNTIME_AUTH_ENV_SELECTOR}: expected an uppercase environment variable name`,
		);
	}
	return selected;
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
	writePrivateFileAtomic(paths.daemonAuthToken, `${normalized}\n`, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
	return paths.daemonAuthToken;
}

export function ensureRuntimeAuthTokenFile(paths: RuntimePaths): string | null {
	const envName = paths.mode === "hosted" ? runtimeAuthEnvName() : RUNTIME_AUTH_TOKEN_ENV;
	const token = process.env[envName]?.trim();
	if (token) return writeRuntimeAuthToken(paths, token);
	if (readRuntimeAuthToken(paths)) {
		return paths.daemonAuthToken;
	}
	rmSync(paths.daemonAuthToken, { force: true });
	return null;
}

export function runtimeAuthTokenFileLabel(paths: RuntimePaths): string {
	return paths.daemonAuthToken;
}
