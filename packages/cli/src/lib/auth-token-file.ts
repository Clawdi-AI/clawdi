import { chmodSync, mkdirSync, readFileSync, type Stats, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function normalizedPath(path: string, label: string): string {
	const normalized = path.trim();
	if (!normalized) throw new Error(`${label} must not be empty`);
	return normalized;
}

function assertOwnerOnly(path: string, label: string): void {
	let stats: Stats;
	try {
		stats = statSync(path);
	} catch {
		throw new Error(`${label} ${path} could not be read.`);
	}
	if ((stats.mode & 0o077) !== 0) {
		throw new Error(`${label} ${path} must be readable only by its owner (mode 0600).`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(`${label} ${path} must be owned by the current user.`);
	}
}

export function readAuthTokenFile(path: string, label = "--auth-token-file"): string {
	const normalized = normalizedPath(path, label);
	assertOwnerOnly(normalized, label);
	const token = readFileSync(normalized, "utf-8").trim();
	if (!token) throw new Error(`${label} ${normalized} is empty`);
	return token;
}

export function loadAuthTokenFile(path: string | undefined, label = "--auth-token-file"): void {
	if (!path) return;
	process.env.CLAWDI_AUTH_TOKEN = readAuthTokenFile(path, label);
}

/** Persist an environment credential for a supervisor without putting it in its unit. */
export function persistAuthTokenFile(root: string, token: string): string {
	const normalizedToken = token.trim();
	if (!normalizedToken) throw new Error("CLAWDI_AUTH_TOKEN must not be empty");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const path = join(root, "auth-token");
	if (statExists(path)) assertOwnerOnly(path, "daemon auth token file");
	writeFileSync(path, `${normalizedToken}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		throw new Error(`Could not set owner-only permissions on daemon auth token file ${path}.`);
	}
	assertOwnerOnly(path, "daemon auth token file");
	return path;
}

function statExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}
