import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// NOTE: these paths are computed lazily so tests can override HOME per-run
// and module caching doesn't freeze the path at first import.
// We honor $HOME directly because os.homedir() is cached by the runtime
// and doesn't update when $HOME is reassigned mid-process.
function clawdiDir() {
	return join(process.env.HOME || homedir(), ".clawdi");
}
function configFile() {
	return join(clawdiDir(), "config.json");
}
function authFile() {
	return join(clawdiDir(), "auth.json");
}

export interface ClawdiConfig {
	apiUrl: string;
	// Default-on. Set to "false" to opt out of background auto-updates.
	// `CLAWDI_NO_AUTO_UPDATE=1` env var has the same effect for ad-hoc opt-out.
	autoUpdate?: "true" | "false";
}

// Keys accepted by `clawdi config set/get/unset`. Add a new entry here
// when introducing a new persistent setting.
export const CONFIG_KEYS = ["apiUrl", "autoUpdate"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface ClawdiAuth {
	apiKey: string;
	userId?: string;
	email?: string;
}

function ensureDir() {
	const dir = clawdiDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
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

// Replaced by `bun build --define 'process.env.CLAWDI_DEFAULT_API_URL=...'`
// at release build; dev runs fall through to localhost.
const DEFAULT_API_URL = process.env.CLAWDI_DEFAULT_API_URL || "http://localhost:8000";

export function getConfig(): ClawdiConfig {
	// Precedence: CLAWDI_API_URL env var > ~/.clawdi/config.json > default.
	// Env var wins so CI / scripted runs can override without writing to disk.
	const stored = readJson<Partial<ClawdiConfig>>(configFile()) ?? {};
	return {
		apiUrl: process.env.CLAWDI_API_URL || stored.apiUrl || DEFAULT_API_URL,
	};
}

/** Raw config on disk, without env overrides. Used by `config list / get`. */
export function getStoredConfig(): Partial<ClawdiConfig> {
	return readJson<Partial<ClawdiConfig>>(configFile()) ?? {};
}

export function setConfig(config: ClawdiConfig) {
	writeJson(configFile(), config);
}

export function setConfigKey(key: ConfigKey, value: string) {
	const current = getStoredConfig();
	writeJson(configFile(), { ...current, [key]: value });
}

export function unsetConfigKey(key: ConfigKey) {
	const current = getStoredConfig();
	delete current[key];
	writeJson(configFile(), current);
}

export function getAuth(): ClawdiAuth | null {
	return readJson<ClawdiAuth>(authFile());
}

export function setAuth(auth: ClawdiAuth) {
	writeJson(authFile(), auth);
}

export function clearAuth() {
	const p = authFile();
	if (existsSync(p)) {
		unlinkSync(p);
	}
	// Drop cached environment ids too — they belong to the user that just
	// logged out. Surviving across an account switch is exactly how a stale
	// env_id ends up in the next user's session uploads.
	const envDir = join(clawdiDir(), "environments");
	if (existsSync(envDir)) {
		rmSync(envDir, { recursive: true, force: true });
	}
}

export function isLoggedIn(): boolean {
	return getAuth() !== null;
}

export function getClawdiDir(): string {
	return clawdiDir();
}
