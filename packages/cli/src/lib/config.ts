import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeCloudApiBaseUrl, normalizeHostedDeployApiBaseUrl } from "./api-origin";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "./private-file";

// NOTE: these paths are computed lazily so tests can override HOME per-run
// and module caching doesn't freeze the path at first import.
// We honor $HOME directly because os.homedir() is cached by the runtime
// and doesn't update when $HOME is reassigned mid-process.
//
// `CLAWDI_HOME` lets a sibling `clawdi-dev` wrapper (or a test harness,
// or a multi-tenant service account) point the CLI at an isolated state
// tree without trampling the user's real `~/.clawdi/`. When set, takes
// precedence over $HOME-derived path; falls back to the historical
// `$HOME/.clawdi` shape so existing installs are unaffected.
function clawdiDir() {
	const override = process.env.CLAWDI_HOME;
	if (override) return override;
	return join(process.env.HOME || homedir(), ".clawdi");
}
function configFile() {
	return join(clawdiDir(), "config.json");
}
function authFile() {
	return join(clawdiDir(), "auth.json");
}
function pendingAuthFile() {
	return join(clawdiDir(), "pending-auth.json");
}
export interface ClawdiConfig {
	apiUrl: string;
	deployApiUrl: string;
	// Default-on. Set to false to opt out of background auto-updates.
	// `CLAWDI_NO_AUTO_UPDATE=1` env var has the same effect for ad-hoc opt-out.
	autoUpdate?: boolean;
}

// Keys accepted by `clawdi config set/get/unset`. Add a new entry here
// when introducing a new persistent setting.
export const CONFIG_KEYS = ["apiUrl", "deployApiUrl", "autoUpdate"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface LegacyClawdiAuth {
	authType?: "api_key";
	apiKey: string;
	userId?: string;
	email?: string;
	endpointBinding?: CredentialEndpointBinding;
}

export interface CredentialEndpointBinding {
	version: 1;
	cloudApiOrigin: string;
	hostedApiOrigin?: string;
}

export interface ClerkOAuthAuth {
	authType: "clerk_oauth";
	/** Current Clerk OAuth access token. Kept under the historical name for compatibility. */
	apiKey: string;
	refreshToken: string;
	accessTokenExpiresAt: string;
	issuer: string;
	clientId: string;
	audience: string;
	/** Clerk Account Portal/custom-domain origins accepted from the optional `azp` claim. */
	authorizedParties?: string[];
	tokenEndpoint: string;
	scopes: string[];
	/** Stable Clerk user id from the OAuth access token `sub` claim. */
	subject: string;
	/** Cloud-local user id, populated after `/v1/auth/me` succeeds. */
	userId: string;
	email?: string;
	/** Exact Cloud + Hosted origins selected when this OAuth grant was created. */
	endpointBinding?: CredentialEndpointBinding;
}

export type ClawdiAuth = LegacyClawdiAuth | ClerkOAuthAuth;

/**
 * Short-lived PKCE transaction state persisted between `clawdi auth login`
 * and `clawdi auth complete` for SSH and non-interactive callers. It contains
 * no access or refresh credential.
 */
export interface PendingAuth {
	authType: "clerk_oauth_pkce";
	state: string;
	codeVerifier: string;
	authorizationUrl: string;
	redirectUri: string;
	issuer: string;
	clientId: string;
	audience: string;
	authorizedParties: string[];
	tokenEndpoint: string;
	expiresAt: string;
	apiUrl: string;
	endpointBinding?: CredentialEndpointBinding;
	scopes: string[];
}

function readJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf-8"));
}

type StoredConfigRecord = Partial<ClawdiConfig> & Record<string, unknown>;

function readStoredConfig(): StoredConfigRecord {
	const value = readJson<unknown>(configFile());
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const normalized: Record<string, unknown> = { ...value };
	// Released CLIs persisted these two spellings; collapse them once here so
	// every consumer sees the canonical boolean shape.
	if (normalized.autoUpdate === "true") normalized.autoUpdate = true;
	else if (normalized.autoUpdate === "false") normalized.autoUpdate = false;
	else if (typeof normalized.autoUpdate !== "boolean") delete normalized.autoUpdate;
	if (typeof normalized.apiUrl !== "string") delete normalized.apiUrl;
	if (typeof normalized.deployApiUrl !== "string") delete normalized.deployApiUrl;
	return normalized;
}

function writeJson(path: string, data: unknown) {
	writePrivateFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

// Replaced by `bun build --define 'process.env.CLAWDI_DEFAULT_API_URL=...'`
// at release build; dev runs fall through to localhost.
const DEFAULT_API_URL = process.env.CLAWDI_DEFAULT_API_URL || "http://localhost:8000";
const DEFAULT_DEPLOY_API_URL =
	process.env.CLAWDI_DEFAULT_DEPLOY_API_URL || "http://localhost:50021";

export function getConfig(): ClawdiConfig {
	// Precedence: CLAWDI_API_URL env var > ~/.clawdi/config.json > default.
	// Env var wins so CI / scripted runs can override without writing to disk.
	const stored = readStoredConfig();
	return {
		apiUrl: process.env.CLAWDI_API_URL || stored.apiUrl || DEFAULT_API_URL,
		deployApiUrl:
			process.env.CLAWDI_DEPLOY_API_URL || stored.deployApiUrl || DEFAULT_DEPLOY_API_URL,
		autoUpdate: stored.autoUpdate,
	};
}

/** Raw config on disk, without env overrides. Used by `config list / get`. */
export function getStoredConfig(): Partial<ClawdiConfig> {
	return readStoredConfig();
}

export function setConfig(config: Pick<ClawdiConfig, "apiUrl"> & Partial<ClawdiConfig>) {
	const normalized: Partial<ClawdiConfig> = {
		...config,
		apiUrl: normalizeConfigUrl("apiUrl", config.apiUrl),
	};
	if (config.deployApiUrl !== undefined) {
		normalized.deployApiUrl = normalizeConfigUrl("deployApiUrl", config.deployApiUrl);
	}
	if (config.autoUpdate !== undefined && typeof config.autoUpdate !== "boolean") {
		throw new Error("autoUpdate must be true or false.");
	}
	writeJson(configFile(), normalized);
}

export function setConfigKey(key: ConfigKey, value: string) {
	const normalized = normalizeConfigValue(key, value);
	const current = getStoredConfig();
	writeJson(configFile(), { ...current, [key]: normalized });
}

function normalizeConfigValue(key: ConfigKey, value: string): string | boolean {
	if (key === "autoUpdate") {
		if (value === "true") return true;
		if (value === "false") return false;
		throw new Error("autoUpdate must be true or false.");
	}
	return normalizeConfigUrl(key, value);
}

function normalizeConfigUrl(key: "apiUrl" | "deployApiUrl", value: string): string {
	return key === "apiUrl"
		? normalizeCloudApiBaseUrl(value)
		: normalizeHostedDeployApiBaseUrl(value);
}

export function unsetConfigKey(key: ConfigKey) {
	const current = getStoredConfig();
	delete current[key];
	writeJson(configFile(), current);
}

export function getAuth(): ClawdiAuth | null {
	// Precedence: CLAWDI_AUTH_TOKEN env var > ~/.clawdi/auth.json.
	// Hosted pods get the token via env (the monorepo writes it
	// into the container's startup config); they have no
	// auth.json on disk and never round-trip through interactive
	// login. Laptops continue to use the file.
	const envToken = process.env.CLAWDI_AUTH_TOKEN;
	if (envToken) {
		return { apiKey: envToken };
	}
	return getStoredAuth();
}

/** Credential persisted in auth.json, ignoring CLAWDI_AUTH_TOKEN overrides. */
export function getStoredAuth(): ClawdiAuth | null {
	return readRecoverablePrivateJson<ClawdiAuth>(authFile());
}

export function setAuth(auth: ClawdiAuth) {
	writeJson(authFile(), auth);
}

export function clearAuth() {
	const ownerUserId = getStoredAuth()?.userId?.trim();
	if (ownerUserId) bindCachedEnvironmentsToUser(ownerUserId);
	const p = authFile();
	if (existsSync(p)) {
		unlinkSync(p);
	}
}

function bindCachedEnvironmentsToUser(userId: string): void {
	const envDir = join(clawdiDir(), "environments");
	if (!existsSync(envDir)) return;
	for (const fileName of readdirSync(envDir)) {
		if (!fileName.endsWith(".json")) continue;
		const path = join(envDir, fileName);
		const value = readRecoverablePrivateJson<unknown>(path);
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const registration = value as Record<string, unknown>;
		if (typeof registration.id !== "string" || typeof registration.agentType !== "string") {
			continue;
		}
		if (typeof registration.userId === "string") continue;
		writeJson(path, { ...registration, userId });
	}
}

export function isLoggedIn(): boolean {
	return getAuth() !== null;
}

export function getPendingAuth(): PendingAuth | null {
	return readRecoverablePrivateJson<PendingAuth>(pendingAuthFile());
}

export function setPendingAuth(pending: PendingAuth) {
	writeJson(pendingAuthFile(), pending);
}

export function clearPendingAuth() {
	const p = pendingAuthFile();
	if (existsSync(p)) {
		unlinkSync(p);
	}
}

export function readRecoverablePrivateJson<T>(
	path: string,
	reader: (candidate: string) => T | null = readJson<T>,
): T | null {
	try {
		return reader(path);
	} catch {
		// A failed read is only an observation. Another process can atomically
		// replace the stale bytes before this catch runs, so deleting here could
		// remove a newer credential committed under the credential lock.
		return null;
	}
}

export function getClawdiDir(): string {
	return clawdiDir();
}
