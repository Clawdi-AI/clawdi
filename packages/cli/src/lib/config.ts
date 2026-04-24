import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAWDI_DIR = join(homedir(), ".clawdi");
const CONFIG_FILE = join(CLAWDI_DIR, "config.json");
const AUTH_FILE = join(CLAWDI_DIR, "auth.json");

export interface ClawdiConfig {
	apiUrl: string;
}

// Keys accepted by `clawdi config set/get/unset`. Add a new entry here
// when introducing a new persistent setting.
export const CONFIG_KEYS = ["apiUrl"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface ClawdiAuth {
	apiKey: string;
	userId?: string;
	email?: string;
}

function ensureDir() {
	if (!existsSync(CLAWDI_DIR)) {
		mkdirSync(CLAWDI_DIR, { recursive: true });
	}
}

function readJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, data: unknown) {
	ensureDir();
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

const DEFAULT_API_URL = "http://localhost:8000";

export function getConfig(): ClawdiConfig {
	// Precedence: CLAWDI_API_URL env var > ~/.clawdi/config.json > default.
	// Env var wins so CI / scripted runs can override without writing to disk.
	const stored = readJson<Partial<ClawdiConfig>>(CONFIG_FILE) ?? {};
	return {
		apiUrl: process.env.CLAWDI_API_URL || stored.apiUrl || DEFAULT_API_URL,
	};
}

/** Raw config on disk, without env overrides. Used by `config list / get`. */
export function getStoredConfig(): Partial<ClawdiConfig> {
	return readJson<Partial<ClawdiConfig>>(CONFIG_FILE) ?? {};
}

export function setConfig(config: ClawdiConfig) {
	writeJson(CONFIG_FILE, config);
}

export function setConfigKey(key: ConfigKey, value: string) {
	const current = getStoredConfig();
	writeJson(CONFIG_FILE, { ...current, [key]: value });
}

export function unsetConfigKey(key: ConfigKey) {
	const current = getStoredConfig();
	delete current[key];
	writeJson(CONFIG_FILE, current);
}

export function getAuth(): ClawdiAuth | null {
	return readJson<ClawdiAuth>(AUTH_FILE);
}

export function setAuth(auth: ClawdiAuth) {
	writeJson(AUTH_FILE, auth);
}

export function clearAuth() {
	if (existsSync(AUTH_FILE)) {
		unlinkSync(AUTH_FILE);
	}
}

export function isLoggedIn(): boolean {
	return getAuth() !== null;
}

export function getClawdiDir(): string {
	return CLAWDI_DIR;
}
