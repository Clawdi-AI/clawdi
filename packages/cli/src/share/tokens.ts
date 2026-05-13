/**
 * Local state for accepted share-links — one JSON file under
 * `~/.clawdi/share-tokens.json`, written 0600.
 *
 * The raw token IS stored locally (unlike cloud-api which stores
 * only `sha256(token)`) because the CLI needs the raw value to
 * send to the server on every sync round. The file is therefore
 * the bearer credential for every shared scope this device has
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
	scope_id: string;
	scope_name: string;
	owner_display: string;
	owner_handle: string;
	token: string;
	redeemed_at: string; // ISO8601
	upgraded_at?: string; // set after clawdi auth login + upgrade
	// Last set of skill_keys this token's scope reported on the
	// most recent /api/share/{token}/scope index call. Used at
	// cleanup time to avoid erasing folders that belong to OTHER
	// shared scopes from the same owner (which share the
	// `__<owner-handle>` suffix).
	last_seen_skill_keys?: string[];
}

interface ShareTokensFile {
	version: 1;
	tokens: ShareToken[];
}

function filePath(): string {
	return join(clawdiHome(), "share-tokens.json");
}

function loadRaw(): ShareTokensFile {
	const path = filePath();
	if (!existsSync(path)) {
		return { version: 1, tokens: [] };
	}
	try {
		const text = readFileSync(path, "utf-8");
		const parsed = JSON.parse(text) as ShareTokensFile;
		if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) {
			// Malformed file: treat as empty. Operator can re-accept
			// any shares they care about; we don't bricks the CLI
			// over local-state corruption.
			return { version: 1, tokens: [] };
		}
		return parsed;
	} catch {
		return { version: 1, tokens: [] };
	}
}

function save(state: ShareTokensFile): void {
	const path = filePath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function listTokens(): ShareToken[] {
	return loadRaw().tokens;
}

export function addToken(token: ShareToken): void {
	const state = loadRaw();
	const idx = state.tokens.findIndex((t) => t.scope_id === token.scope_id);
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

export function removeToken(scopeId: string): void {
	const state = loadRaw();
	state.tokens = state.tokens.filter((t) => t.scope_id !== scopeId);
	save(state);
}

export function findToken(scopeId: string): ShareToken | undefined {
	return listTokens().find((t) => t.scope_id === scopeId);
}
