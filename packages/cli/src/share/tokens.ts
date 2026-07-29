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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeCloudApiBaseUrl } from "../lib/api-origin";
import { withPrivateDirectoryLock } from "../lib/private-directory-lock";
import {
	chmodBestEffort,
	PRIVATE_DIR_MODE,
	PRIVATE_FILE_MODE,
	writePrivateFileAtomic,
} from "../lib/private-file";

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
	// Legacy marker retained for read compatibility. Explicit join ignores
	// these previously upgraded records and never acts on them automatically.
	upgraded_at?: string;
	// API origin that accepted the anonymous token. New records are bound so
	// another Cloud endpoint never receives a credential it did not issue.
	api_origin?: string;
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

export class ShareTokenStoreCorruptionError extends Error {
	constructor(message: string) {
		super(`share token store is corrupt: ${message}`);
		this.name = "ShareTokenStoreCorruptionError";
	}
}

function filePath(): string {
	return join(clawdiHome(), "share-tokens.json");
}

function lockPath(): string {
	return join(clawdiHome(), "share-tokens.lock");
}

function hardenStorePermissions(path: string): void {
	if (existsSync(clawdiHome())) chmodBestEffort(clawdiHome(), PRIVATE_DIR_MODE);
	if (existsSync(path)) chmodBestEffort(path, PRIVATE_FILE_MODE);
}

function loadRaw(): PersistedShareTokensFile {
	const path = filePath();
	hardenStorePermissions(path);
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
			throw new ShareTokenStoreCorruptionError("expected a version 1 tokens array");
		}
		return { version: 1, tokens: parsed.tokens };
	} catch (error) {
		if (error instanceof ShareTokenStoreCorruptionError) throw error;
		if (error instanceof SyntaxError) {
			throw new ShareTokenStoreCorruptionError("file is not valid JSON");
		}
		throw error;
	}
}

function save(state: PersistedShareTokensFile): void {
	const path = filePath();
	writePrivateFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizedApiOrigin(value: unknown): string | undefined {
	const origin = nonEmptyString(value);
	if (!origin) return undefined;
	try {
		return normalizeCloudApiBaseUrl(origin);
	} catch {
		return undefined;
	}
}

function normalizeToken(
	value: unknown,
	index: number,
):
	| { kind: "token"; token: ShareToken; projectId: string }
	| { kind: "issue"; issue: ShareTokenStoreIssue; projectId?: string } {
	if (typeof value !== "object" || value === null) {
		return {
			kind: "issue",
			issue: { label: `local share entry ${index + 1}`, reason: "entry is not an object" },
		};
	}

	// `scope_id`/`scope_name` were the released version:1 names before
	// 911c955b renamed them without bumping the persisted-file version. This is
	// the only compatibility boundary: recognized legacy fields are read here,
	// removed from the output, and never enter normal runtime data or writes.
	const canonicalFields: Record<string, unknown> = { ...value };
	const projectId =
		nonEmptyString(canonicalFields.project_id) ?? nonEmptyString(canonicalFields.scope_id);
	const projectName =
		nonEmptyString(canonicalFields.project_name) ?? nonEmptyString(canonicalFields.scope_name);
	delete canonicalFields.scope_id;
	delete canonicalFields.scope_name;
	const ownerDisplay = nonEmptyString(canonicalFields.owner_display);
	const ownerHandle = nonEmptyString(canonicalFields.owner_handle);
	const token = nonEmptyString(canonicalFields.token);
	const redeemedAt = nonEmptyString(canonicalFields.redeemed_at);
	const label =
		projectName ?? (projectId ? `Project ${projectId}` : `local share entry ${index + 1}`);
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
			projectId,
		};
	}
	if (!projectId || !projectName || !ownerDisplay || !ownerHandle || !redeemedAt || !token) {
		return {
			kind: "issue",
			issue: { label, reason: `missing ${missing.join(", ")}` },
			projectId,
		};
	}

	const normalized: ShareToken & Record<string, unknown> = {
		...canonicalFields,
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
	if ("api_origin" in value) {
		const apiOrigin = normalizedApiOrigin(value.api_origin);
		if (apiOrigin) normalized.api_origin = apiOrigin;
		else delete normalized.api_origin;
	}
	if (
		"last_seen_skill_keys" in value &&
		(!Array.isArray(value.last_seen_skill_keys) ||
			!value.last_seen_skill_keys.every((key) => typeof key === "string"))
	) {
		delete normalized.last_seen_skill_keys;
	}
	return { kind: "token", token: normalized, projectId };
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

async function mutateTokenStore<T>(
	mutate: (state: PersistedShareTokensFile) => { result: T; changed: boolean },
): Promise<T> {
	return withPrivateDirectoryLock(lockPath(), async (lease) => {
		const state = loadRaw();
		const { result, changed } = mutate(state);
		if (changed) {
			lease.assertOwned();
			save(state);
			lease.assertOwned();
		}
		return result;
	});
}

export async function addToken(token: ShareToken): Promise<void> {
	await mutateTokenStore((state) => {
		const idx = state.tokens.findIndex((value, index) => {
			const normalized = normalizeToken(value, index);
			return (
				normalized.projectId === token.project_id ||
				(normalized.kind === "token" && normalized.token.token === token.token)
			);
		});
		if (idx === -1) state.tokens.push(token);
		else state.tokens[idx] = token;
		return { result: undefined, changed: true };
	});
}

export async function removeToken(projectId: string, expectedToken?: string): Promise<boolean> {
	return mutateTokenStore((state) => {
		const before = state.tokens.length;
		state.tokens = state.tokens.filter((value, index) => {
			const normalized = normalizeToken(value, index);
			if (normalized.projectId !== projectId) return true;
			return (
				expectedToken !== undefined &&
				(normalized.kind !== "token" || normalized.token.token !== expectedToken)
			);
		});
		const changed = state.tokens.length !== before;
		return { result: changed, changed };
	});
}

export function findToken(projectId: string): ShareToken | undefined {
	return listTokens().find((t) => t.project_id === projectId);
}
