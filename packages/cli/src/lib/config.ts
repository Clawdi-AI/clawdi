import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { AGENT_TYPES, type AgentType } from "@clawdi-cloud/shared/consts";

const CLAWDI_DIR = join(homedir(), ".clawdi");
const CONFIG_FILE = join(CLAWDI_DIR, "config.json");
const AUTH_FILE = join(CLAWDI_DIR, "auth.json");
const SYNC_FILE = join(CLAWDI_DIR, "sync.json");

export interface ClawdiConfig {
	apiUrl: string;
	/**
	 * Per-agent additional directories to scan for skills, in addition to the
	 * adapter's default location (e.g. ~/.claude/skills). Typically project-
	 * scoped dirs like /path/to/project/.claude/skills or ad-hoc personal
	 * libraries. Each path is scanned flat: a direct child is a skill if it
	 * contains SKILL.md.
	 */
	extraSkillPaths?: Partial<Record<AgentType, string[]>>;
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
	writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
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

/**
 * Return the effective extra skill paths for an agent, merged from:
 *   - env var CLAWDI_EXTRA_SKILL_PATHS_<AGENT_UPPER> (colon-separated)
 *   - ~/.clawdi/config.json → extraSkillPaths[agent]
 *
 * Paths are absolutized; order preserved (env first, then config); duplicates
 * collapsed. Silently returns [] for unknown/unset configuration — callers
 * don't need to guard.
 */
export function getExtraSkillPaths(agent: AgentType): string[] {
	const envKey = `CLAWDI_EXTRA_SKILL_PATHS_${agent.toUpperCase()}`;
	const fromEnv = (process.env[envKey] ?? "")
		.split(":")
		.map((s) => s.trim())
		.filter(Boolean);
	const stored = getStoredConfig().extraSkillPaths?.[agent] ?? [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of [...fromEnv, ...stored]) {
		const abs = resolvePath(p.replace(/^~(?=\/|$)/, homedir()));
		if (seen.has(abs)) continue;
		seen.add(abs);
		out.push(abs);
	}
	return out;
}

export function isKnownAgent(s: string): s is AgentType {
	return (AGENT_TYPES as readonly string[]).includes(s);
}

/** Append a path to extraSkillPaths[agent]; idempotent. */
export function addExtraSkillPath(agent: AgentType, path: string): void {
	const current = getStoredConfig();
	const byAgent = { ...(current.extraSkillPaths ?? {}) };
	const abs = resolvePath(path.replace(/^~(?=\/|$)/, homedir()));
	const list = byAgent[agent] ?? [];
	if (!list.includes(abs)) list.push(abs);
	byAgent[agent] = list;
	writeJson(CONFIG_FILE, { ...current, extraSkillPaths: byAgent });
}

/** Remove a path from extraSkillPaths[agent]; tolerates non-existent entries. */
export function removeExtraSkillPath(agent: AgentType, path: string): boolean {
	const current = getStoredConfig();
	const byAgent = { ...(current.extraSkillPaths ?? {}) };
	const list = byAgent[agent] ?? [];
	const abs = resolvePath(path.replace(/^~(?=\/|$)/, homedir()));
	const next = list.filter((p) => p !== abs && p !== path);
	if (next.length === list.length) return false;
	if (next.length === 0) delete byAgent[agent];
	else byAgent[agent] = next;
	writeJson(CONFIG_FILE, { ...current, extraSkillPaths: byAgent });
	return true;
}

export function listExtraSkillPaths(): Partial<Record<AgentType, string[]>> {
	return getStoredConfig().extraSkillPaths ?? {};
}
