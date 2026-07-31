/** Canonical native credential-store helpers shared by local apply and hosted runtime. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { NativeOAuthCredentialObservation } from "./chatgpt-oauth-reconciliation";

export type HermesCodexAuthAction = "inspect" | "seed-if-missing" | "upsert" | "remove";

export type OpenClawProviderAuthAction = "inspect" | "seed-if-missing" | "upsert" | "remove";

export interface OAuthCredentialOwnership {
	nativeProfileId: string;
	credentialRevision?: string;
	credentialFingerprint?: string;
}

export function nativeOAuthProfileId(
	runtime: "codex" | "hermes" | "openclaw",
	providerId: string,
): string {
	if (runtime === "codex") return "default";
	const providerHash = createHash("sha256").update(providerId).digest("hex").slice(0, 24);
	return runtime === "hermes" ? `clawdi:${providerHash}` : `openai:clawdi-${providerHash}`;
}

export function oauthCredentialFingerprint(
	credentialRevision: string,
	accessToken: string,
	refreshToken: string,
): string {
	return `sha256:${createHash("sha256")
		.update(
			JSON.stringify([
				"clawdi.runtimeOAuthCredential.v1",
				credentialRevision,
				accessToken,
				refreshToken,
			]),
		)
		.digest("hex")}`;
}

export function resolveOpenClawProviderAuthSdkExport(
	startPaths: ReadonlyArray<string | null | undefined>,
): string | null {
	const packageRoots = new Set<string>();
	for (const startPath of startPaths) {
		if (!startPath || !existsSync(startPath)) continue;
		let current = realpathSync(startPath);
		if (!existsSync(join(current, "package.json"))) current = dirname(current);
		for (let depth = 0; depth < 10; depth += 1) {
			const packageJsonPath = join(current, "package.json");
			if (existsSync(packageJsonPath)) {
				try {
					const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
					if (
						typeof parsed === "object" &&
						parsed !== null &&
						"name" in parsed &&
						parsed.name === "openclaw"
					) {
						packageRoots.add(current);
					}
				} catch {
					// Ignore unrelated malformed package metadata while walking candidates.
				}
			}
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	for (const packageRoot of packageRoots) {
		try {
			const resolved = createRequire(join(packageRoot, "package.json")).resolve(
				"openclaw/plugin-sdk/provider-auth",
			);
			if (existsSync(resolved)) return resolved;
		} catch {
			// The installed package does not expose the public provider-auth SDK.
		}
	}
	return null;
}

export function nativeOAuthObservation(value: unknown): NativeOAuthCredentialObservation {
	if (value === "missing" || value === "managed" || value === "foreign") return value;
	throw new Error("Native OAuth credential observation is invalid");
}

export const HERMES_CODEX_AUTH_HELPER = String.raw`
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [authPath, action, profileId, ownedProfileId = ""] = process.argv.slice(1);
const material = process.stdin.isTTY ? null : JSON.parse(readFileSync(0, "utf8") || "null");
const storeExists = existsSync(authPath);
const store = storeExists ? JSON.parse(readFileSync(authPath, "utf8")) : {};
if (!store || typeof store !== "object" || Array.isArray(store)) {
  throw new Error("Hermes auth store must be an object");
}
if (store.version !== undefined && typeof store.version !== "number") {
  throw new Error("Hermes auth store version must be numeric");
}
if (store.credential_pool !== undefined && (!store.credential_pool || typeof store.credential_pool !== "object" || Array.isArray(store.credential_pool))) {
  throw new Error("Hermes credential_pool must be an object");
}
const pool = store.credential_pool ? { ...store.credential_pool } : {};
if (pool["openai-codex"] !== undefined && !Array.isArray(pool["openai-codex"])) {
  throw new Error("Hermes openai-codex credential pool must be an array");
}
const rawEntries = Array.isArray(pool["openai-codex"]) ? pool["openai-codex"] : [];
const entries = rawEntries.filter((entry) => entry && typeof entry === "object");
const valid = (entry) => typeof entry.access_token === "string" && entry.access_token.length > 0 && typeof entry.refresh_token === "string" && entry.refresh_token.length > 0;
const reservedEntry = entries.find((entry) => entry.id === profileId);
const present = Boolean(reservedEntry);
const managed = present && valid(reservedEntry) && reservedEntry.auth_type === "oauth" && reservedEntry.source === "manual:device_code" && ownedProfileId === profileId;
if (action === "inspect") {
  process.stdout.write(JSON.stringify({ observation: !present ? "missing" : managed ? "managed" : "foreign" }));
} else {
  let updated = false;
  if ((action === "seed-if-missing" && !present) || action === "upsert") {
    if (!material || typeof material.accessToken !== "string" || typeof material.refreshToken !== "string") {
      throw new Error("Hermes Codex credential material is invalid");
    }
    pool["openai-codex"] = [{
      id: profileId,
      label: "Clawdi managed connection",
      auth_type: "oauth",
      priority: 0,
      source: "manual:device_code",
      access_token: material.accessToken,
      refresh_token: material.refreshToken,
      base_url: "https://chatgpt.com/backend-api/codex",
      last_refresh: material.lastRefresh,
      last_status: null,
      last_status_at: null,
      last_error_code: null,
      last_error_reason: null,
      last_error_message: null,
      last_error_reset_at: null,
    }, ...entries.filter((entry) => entry.id !== profileId)];
    updated = true;
  } else if (action === "remove" && managed) {
    const remaining = entries.filter((entry) => entry.id !== profileId);
    if (remaining.length > 0) pool["openai-codex"] = remaining;
    else delete pool["openai-codex"];
    updated = true;
  } else if (action !== "seed-if-missing" && action !== "remove") {
    throw new Error("unsupported Hermes Codex auth action");
  }
  if (updated) {
    if (store.version === undefined) store.version = 1;
    store.credential_pool = pool;
    store.updated_at = new Date().toISOString();
    const tempPath = authPath + ".tmp." + process.pid + "." + Math.random().toString(16).slice(2);
    const fd = openSync(tempPath, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(store, null, 2) + "\n"); } finally { closeSync(fd); }
    renameSync(tempPath, authPath);
  }
  process.stdout.write(JSON.stringify({ updated }));
}
`;

export const OPENCLAW_PROVIDER_AUTH_HELPER = `
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const [sdkPath, agentDir, action, profileId, ownedProfileId = ""] = process.argv.slice(1);
const sdk = await import(pathToFileURL(sdkPath).href);
if (action === "inspect") {
  const store = sdk.ensureAuthProfileStoreForLocalUpdate(agentDir);
  const present = Object.prototype.hasOwnProperty.call(store.profiles, profileId);
  const credential = present ? store.profiles[profileId] : undefined;
  const managed = credential?.type === "oauth" && credential.provider === "openai" && typeof credential.access === "string" && typeof credential.refresh === "string" && ownedProfileId === profileId;
  process.stdout.write(JSON.stringify({ observation: !present ? "missing" : managed ? "managed" : "foreign" }));
} else {
  const credential = JSON.parse(readFileSync(0, "utf8") || "null");
  let changed = false;
  const result = await sdk.updateAuthProfileStoreWithLock({
    agentDir,
    updater: (store) => {
      const present = Object.prototype.hasOwnProperty.call(store.profiles, profileId);
      if (action === "seed-if-missing" && present) return false;
      if (action === "seed-if-missing" || action === "upsert") {
        store.profiles[profileId] = credential;
        const existingOrder = Array.isArray(store.order?.openai) ? store.order.openai : [];
        store.order = {
          ...(store.order ?? {}),
          openai: [profileId, ...existingOrder.filter((id) => id !== profileId)],
        };
        changed = true;
        return true;
      }
      if (action === "remove") {
        const current = present ? store.profiles[profileId] : undefined;
        const owned = current?.type === "oauth" && current.provider === "openai" && typeof current.access === "string" && typeof current.refresh === "string" && ownedProfileId === profileId;
        if (!owned) return false;
        delete store.profiles[profileId];
        if (store.order?.openai) store.order.openai = store.order.openai.filter((id) => id !== profileId);
        if (store.order?.openai?.length === 0) delete store.order.openai;
        if (store.lastGood?.openai === profileId) delete store.lastGood.openai;
        if (store.usageStats) delete store.usageStats[profileId];
        changed = true;
        return true;
      }
      throw new Error("unsupported OpenClaw provider-auth action");
    },
  });
  if (result === null) throw new Error("OpenClaw provider-auth SQLite update failed");
  process.stdout.write(JSON.stringify({ updated: changed }));
}
`;
