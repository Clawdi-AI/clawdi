import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAWDI_DIR = join(homedir(), ".clawdi");
const CONFIG_FILE = join(CLAWDI_DIR, "config.json");
const AUTH_FILE = join(CLAWDI_DIR, "auth.json");
const SYNC_FILE = join(CLAWDI_DIR, "sync.json");

export interface ClawdiConfig {
	apiUrl: string;
}

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
	writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

export function getConfig(): ClawdiConfig {
	return readJson<ClawdiConfig>(CONFIG_FILE) ?? { apiUrl: "http://localhost:8000" };
}

export function setConfig(config: ClawdiConfig) {
	writeJson(CONFIG_FILE, config);
}

export function getAuth(): ClawdiAuth | null {
	return readJson<ClawdiAuth>(AUTH_FILE);
}

export function setAuth(auth: ClawdiAuth) {
	writeJson(AUTH_FILE, auth);
}

export function clearAuth() {
	const { unlinkSync } = require("node:fs");
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
