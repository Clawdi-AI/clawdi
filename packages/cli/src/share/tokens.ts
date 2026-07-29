/**
 * Local state for accepted share-links — one JSON file under
 * `~/.clawdi/share-tokens.json`, written 0600.
 *
 * The raw token IS stored locally (unlike cloud-api which stores
 * only `sha256(token)`) because the CLI needs the raw value to
 * send to the server on every sync round. The file is therefore
 * the bearer credential for every shared project this device has
 * accepted; 0600 mode is the security measure. We don't envelope-
 * encrypt the file because losing the device is already game-over
 * for any locally-cached credential (api_keys, vault plaintext
 * caches, etc.), so a second crypto layer would be cargo-cult.
 *
 * Forward compat: read-side preserves unknown fields on the token
 * objects so a future CLI version adding a column doesn't get
 * silently stripped when an older daemon writes the file back.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Use `process.env.HOME` first so test fixtures that overwrite the
// env var pick up the new value immediately. `os.homedir()` caches
// the original HOME at process start in some runtimes (Bun does).
function userHome(): string {
	return process.env.HOME ?? homedir();
}

// Mirror lib/config.ts's `clawdiDir()` precedence so a dev wrapper
// (`clawdi-dev`) or multi-user demo harness pointing at an isolated
// state tree via CLAWDI_HOME also gets isolated share-tokens.json.
// Without this, three personas in one demo would all share the
// host's real `~/.clawdi/share-tokens.json` and pollute each other.
function clawdiHome(): string {
	const override = process.env.CLAWDI_HOME;
	if (override) return override;
	return join(userHome(), ".clawdi");
}

export interface ShareToken {
	project_id: string;
	project_name: string;
	owner_display: string;
	owner_handle: string;
	token: string;
	redeemed_at: string; // ISO8601
	upgraded_at?: string; // set after clawdi auth login + upgrade
	// Last set of skill_keys this token's project reported on the
	// most recent /api/share/{token}/project index call. Used at
	// cleanup time to avoid erasing folders that belong to OTHER
	// shared projects from the same owner (which share the
	// `__<owner-handle>` suffix).
	last_seen_skill_keys?: string[];
}

interface PersistedShareTokensFile {
	version: 1;
	tokens: unknown[];
}

export interface ShareTokenStoreIssue {
	label: string;
	reason: string;
}

const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function filePath(): string {
	return join(clawdiHome(), "share-tokens.json");
}

function loadRaw(): PersistedShareTokensFile {
	const path = filePath();
	if (!existsSync(path)) {
		return { version: 1, tokens: [] };
	}
	try {
		const text = readFileSync(path, "utf-8");
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("version" in parsed) ||
			parsed.version !== 1 ||
			!("tokens" in parsed) ||
			!Array.isArray(parsed.tokens)
		) {
			// Malformed file: treat as empty. Operator can re-accept
			// any shares they care about; we don't brick the CLI
			// over local-state corruption.
			return { version: 1, tokens: [] };
		}
		return { version: 1, tokens: parsed.tokens };
	} catch {
		return { version: 1, tokens: [] };
	}
}

function save(state: PersistedShareTokensFile): void {
	const path = filePath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function persistedProjectId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return (
		("project_id" in value ? nonEmptyString(value.project_id) : undefined) ??
		("scope_id" in value ? nonEmptyString(value.scope_id) : undefined)
	);
}

function issueLabel(value: unknown, index: number): string {
	if (typeof value !== "object" || value === null) return `local share entry ${index + 1}`;
	const name =
		("project_name" in value ? nonEmptyString(value.project_name) : undefined) ??
		("scope_name" in value ? nonEmptyString(value.scope_name) : undefined);
	if (name) return name;
	const projectId = persistedProjectId(value);
	return projectId ? `Project ${projectId}` : `local share entry ${index + 1}`;
}

function normalizeToken(
	value: unknown,
	index: number,
): { kind: "token"; token: ShareToken } | { kind: "issue"; issue: ShareTokenStoreIssue } {
	const label = issueLabel(value, index);
	if (typeof value !== "object" || value === null) {
		return { kind: "issue", issue: { label, reason: "entry is not an object" } };
	}

	const projectId = persistedProjectId(value);
	const projectName =
		("project_name" in value ? nonEmptyString(value.project_name) : undefined) ??
		("scope_name" in value ? nonEmptyString(value.scope_name) : undefined);
	const ownerDisplay = "owner_display" in value ? nonEmptyString(value.owner_display) : undefined;
	const ownerHandle = "owner_handle" in value ? nonEmptyString(value.owner_handle) : undefined;
	const token = "token" in value ? nonEmptyString(value.token) : undefined;
	const redeemedAt = "redeemed_at" in value ? nonEmptyString(value.redeemed_at) : undefined;

	const missing: string[] = [];
	if (!projectId) missing.push("project id");
	if (!projectName) missing.push("project name");
	if (!ownerDisplay) missing.push("owner display");
	if (!ownerHandle) missing.push("owner handle");
	if (!redeemedAt) missing.push("redeemed timestamp");
	if (!token) missing.push("share token");
	if (token && !RAW_TOKEN_RE.test(token)) {
		return {
			kind: "issue",
			issue: { label, reason: "invalid 43-character share token" },
		};
	}
	if (!projectId || !projectName || !ownerDisplay || !ownerHandle || !redeemedAt || !token) {
		return { kind: "issue", issue: { label, reason: `missing ${missing.join(", ")}` } };
	}

	// `scope_id`/`scope_name` were the released version:1 names before
	// 911c955b renamed them without bumping the persisted-file version.
	// Canonical fields are overlaid at read time while all other fields,
	// including future fields, remain available to subsequent upserts.
	const normalized: ShareToken & Record<string, unknown> = {
		...value,
		project_id: projectId,
		project_name: projectName,
		owner_display: ownerDisplay,
		owner_handle: ownerHandle,
		token,
		redeemed_at: redeemedAt,
	};
	if ("upgraded_at" in value && typeof value.upgraded_at !== "string") {
		delete normalized.upgraded_at;
	}
	if (
		"last_seen_skill_keys" in value &&
		(!Array.isArray(value.last_seen_skill_keys) ||
			!value.last_seen_skill_keys.every((key) => typeof key === "string"))
	) {
		delete normalized.last_seen_skill_keys;
	}
	return { kind: "token", token: normalized };
}

export function readTokenStore(): {
	tokens: ShareToken[];
	issues: ShareTokenStoreIssue[];
} {
	const tokens: ShareToken[] = [];
	const issues: ShareTokenStoreIssue[] = [];
	for (const [index, value] of loadRaw().tokens.entries()) {
		const normalized = normalizeToken(value, index);
		if (normalized.kind === "issue") issues.push(normalized.issue);
		else tokens.push(normalized.token);
	}
	return { tokens, issues };
}

export function listTokens(): ShareToken[] {
	return readTokenStore().tokens;
}

export function addToken(token: ShareToken): void {
	const state = loadRaw();
	const idx = state.tokens.findIndex((value) => persistedProjectId(value) === token.project_id);
	if (idx === -1) {
		state.tokens.push(token);
	} else {
		// Upsert: replace the existing entry. The whole object is
		// passed in by callers so they handle merging unknown
		// fields explicitly (use `{...existing, ...patch}` pattern
		// on the caller side to preserve fields).
		state.tokens[idx] = token;
	}
	save(state);
}

export function removeToken(projectId: string): void {
	const state = loadRaw();
	state.tokens = state.tokens.filter((value) => persistedProjectId(value) !== projectId);
	save(state);
}

export function findToken(projectId: string): ShareToken | undefined {
	return listTokens().find((t) => t.project_id === projectId);
}
