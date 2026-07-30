import { readFileSync, rmSync } from "node:fs";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimePaths } from "./paths";
import type { RuntimeEnvironmentAuthority } from "./secret-values";

export const RUNTIME_AUTH_TOKEN_ENV = "CLAWDI_AUTH_TOKEN";
export const RUNTIME_AUTH_TOKEN_SECRET_REF = `env://${RUNTIME_AUTH_TOKEN_ENV}`;
export const RUNTIME_AUTH_ENV_SELECTOR = "CLAWDI_RUNTIME_AUTH_ENV";

export function runtimeAuthEnvName(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const selected = env[RUNTIME_AUTH_ENV_SELECTOR]?.trim();
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

export function readRuntimeCredential(
	paths: RuntimePaths,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): string | null {
	return readRuntimeCredentialSource(paths, runtimeEnvironment)?.token ?? null;
}

export function ensureRuntimeAuthTokenFile(
	paths: RuntimePaths,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): string | null {
	const credential = readRuntimeCredentialSource(paths, runtimeEnvironment);
	if (credential?.source === "environment") {
		return writeRuntimeAuthToken(paths, credential.token);
	}
	if (credential?.source === "file") return paths.daemonAuthToken;
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

function readRuntimeCredentialSource(
	paths: RuntimePaths,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): { source: "environment" | "file"; token: string } | null {
	const envName =
		paths.mode === "hosted"
			? runtimeAuthEnvName(runtimeEnvironment.values)
			: RUNTIME_AUTH_TOKEN_ENV;
	const rawToken = runtimeEnvironment.values[envName];
	if (rawToken?.trim()) {
		const token = normalizeRuntimeAuthToken(rawToken);
		if (!token) {
			throw new Error("runtime auth token must be non-empty and contain no control characters");
		}
		return { source: "environment", token };
	}
	if (runtimeEnvironment.kind === "projected-environment") return null;
	const token = readRuntimeAuthToken(paths);
	return token ? { source: "file", token } : null;
}
