/** Canonical native credential-store helpers shared by local apply and hosted runtime. */

export type HermesCodexAuthAction =
	| "inspect-any"
	| "inspect-clawdi"
	| "seed-if-missing"
	| "upsert"
	| "remove";

export type OpenClawProviderAuthAction = "inspect" | "seed-if-missing" | "upsert" | "remove";

export const HERMES_CODEX_AUTH_HELPER = String.raw`
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [authPath, action] = process.argv.slice(1);
const material = process.stdin.isTTY ? null : JSON.parse(readFileSync(0, "utf8") || "null");
const store = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) : {};
const providers = store.providers && typeof store.providers === "object" ? { ...store.providers } : {};
const pool = store.credential_pool && typeof store.credential_pool === "object" ? { ...store.credential_pool } : {};
const providerState = providers["openai-codex"] && typeof providers["openai-codex"] === "object" ? providers["openai-codex"] : {};
const providerTokens = providerState.tokens && typeof providerState.tokens === "object" ? providerState.tokens : {};
const rawEntries = Array.isArray(pool["openai-codex"]) ? pool["openai-codex"] : [];
const entries = rawEntries.filter((entry) => entry && typeof entry === "object");
const valid = (entry) => typeof entry.access_token === "string" && entry.access_token.length > 0 && typeof entry.refresh_token === "string" && entry.refresh_token.length > 0;
const presentAny = valid(providerTokens) || entries.some(valid);
const presentClawdi = entries.some((entry) => entry.id === "clawdi" && valid(entry));
const clawdiEntry = entries.find((entry) => entry.id === "clawdi" && valid(entry));
const ownsProviderState = Boolean(clawdiEntry) && valid(providerTokens) && providerTokens.access_token === clawdiEntry.access_token && providerTokens.refresh_token === clawdiEntry.refresh_token;
if (action === "inspect-any" || action === "inspect-clawdi") {
  process.stdout.write(JSON.stringify({ present: action === "inspect-any" ? presentAny : presentClawdi }));
} else {
  let updated = false;
  if ((action === "seed-if-missing" && !presentAny) || action === "upsert") {
    if (!material || typeof material.accessToken !== "string" || typeof material.refreshToken !== "string") {
      throw new Error("Hermes Codex credential material is invalid");
    }
    providers["openai-codex"] = {
      ...providerState,
      label: "clawdi",
      auth_mode: "chatgpt",
      tokens: {
        access_token: material.accessToken,
        refresh_token: material.refreshToken,
        ...(material.idToken ? { id_token: material.idToken } : {}),
        ...(material.accountId ? { account_id: material.accountId } : {}),
      },
      last_refresh: material.lastRefresh,
    };
    pool["openai-codex"] = [{
      id: "clawdi",
      label: "clawdi",
      auth_type: "oauth",
      priority: 0,
      source: "device_code",
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
    }, ...entries.filter((entry) => entry.id !== "clawdi")];
    const suppressed = store.suppressed_sources && typeof store.suppressed_sources === "object" ? { ...store.suppressed_sources } : {};
    const nextSuppressed = Array.isArray(suppressed["openai-codex"]) ? suppressed["openai-codex"].filter((source) => source !== "device_code") : [];
    if (nextSuppressed.length > 0) suppressed["openai-codex"] = nextSuppressed;
    else delete suppressed["openai-codex"];
    store.suppressed_sources = suppressed;
    store.active_provider = "openai-codex";
    updated = true;
  } else if (action === "remove" && presentClawdi) {
    const remaining = entries.filter((entry) => entry.id !== "clawdi");
    if (remaining.length > 0) pool["openai-codex"] = remaining;
    else delete pool["openai-codex"];
    if (ownsProviderState) delete providers["openai-codex"];
    if (store.active_provider === "openai-codex" && !providers["openai-codex"] && remaining.length === 0) delete store.active_provider;
    updated = true;
  } else if (action !== "seed-if-missing" && action !== "remove") {
    throw new Error("unsupported Hermes Codex auth action");
  }
  if (updated) {
    store.version = 1;
    store.providers = providers;
    store.credential_pool = pool;
    if (store.suppressed_sources && Object.keys(store.suppressed_sources).length === 0) delete store.suppressed_sources;
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
const [sdkPath, agentDir, action, profileId] = process.argv.slice(1);
const sdk = await import(pathToFileURL(sdkPath).href);
if (action === "inspect") {
  const store = sdk.ensureAuthProfileStoreForLocalUpdate(agentDir);
  process.stdout.write(JSON.stringify({ present: sdk.listProfilesForProvider(store, "openai").includes(profileId) }));
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
        store.order = { ...(store.order ?? {}), openai: [profileId, ...(store.order?.openai ?? []).filter((id) => id !== profileId)] };
        changed = true;
        return true;
      }
      if (action === "remove") {
        if (!present) return false;
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
