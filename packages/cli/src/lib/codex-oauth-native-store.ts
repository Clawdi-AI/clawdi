/** Canonical native credential-store helpers for Hosted Hermes and OpenClaw runtimes. */

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

export interface NativeOAuthCredentialMutationResult {
	updated: boolean;
	casMatched: boolean;
	beforeCredentialFingerprint?: string;
	afterCredentialFingerprint?: string;
}

export interface HermesCodexAuthInvocation {
	command: string;
	args: string[];
}

export function hermesCodexAuthInvocation(
	action: HermesCodexAuthAction,
	nodeArgs: string[],
	lockPath: string,
	platform: NodeJS.Platform = process.platform,
): HermesCodexAuthInvocation {
	if (platform === "win32") {
		if (action !== "inspect") {
			throw new Error(
				"Hermes Codex auth mutation is unavailable on Windows because Clawdi cannot acquire Hermes auth.lock with the official msvcrt protocol.",
			);
		}
		return { command: "node", args: nodeArgs };
	}
	return {
		command: "flock",
		args: ["--timeout", "10", lockPath, "node", ...nodeArgs],
	};
}

export function nativeOAuthProfileId(runtime: "hermes" | "openclaw", providerId: string): string {
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

export function nativeOAuthCredentialEvidenceFingerprint(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(["clawdi.nativeOAuthCredentialEvidence.v1", value]))
		.digest("hex")}`;
}

function resolveOpenClawSdkExport(
	startPaths: ReadonlyArray<string | null | undefined>,
	exportPath: `openclaw/plugin-sdk/${string}`,
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
			const resolved = createRequire(join(packageRoot, "package.json")).resolve(exportPath);
			if (existsSync(resolved)) return resolved;
		} catch {
			// The installed package does not expose this public SDK subpath.
		}
	}
	return null;
}

export function resolveOpenClawProviderAuthSdkExport(
	startPaths: ReadonlyArray<string | null | undefined>,
): string | null {
	return resolveOpenClawSdkExport(startPaths, "openclaw/plugin-sdk/provider-auth");
}

export function resolveOpenClawConfigMutationSdkExport(
	startPaths: ReadonlyArray<string | null | undefined>,
): string | null {
	return resolveOpenClawSdkExport(startPaths, "openclaw/plugin-sdk/config-mutation");
}

export function nativeOAuthObservation(value: unknown): NativeOAuthCredentialObservation {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Native OAuth credential observation is invalid");
	}
	const observation = "observation" in value ? value.observation : undefined;
	const credentialFingerprint =
		"credentialFingerprint" in value ? value.credentialFingerprint : undefined;
	if (observation !== "missing" && observation !== "managed" && observation !== "foreign") {
		throw new Error("Native OAuth credential observation is invalid");
	}
	if (
		credentialFingerprint !== undefined &&
		(typeof credentialFingerprint !== "string" ||
			!/^sha256:[a-f0-9]{64}$/.test(credentialFingerprint))
	) {
		throw new Error("Native OAuth credential fingerprint is invalid");
	}
	if (observation !== "missing" && !credentialFingerprint) {
		throw new Error("Present native OAuth credential requires fingerprint evidence");
	}
	return {
		state: observation,
		...(credentialFingerprint ? { credentialFingerprint } : {}),
	};
}

export function nativeOAuthMutationResult(value: unknown): NativeOAuthCredentialMutationResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Native OAuth credential mutation evidence is invalid");
	}
	const updated = "updated" in value ? value.updated : undefined;
	const casMatched = "casMatched" in value ? value.casMatched : undefined;
	const beforeCredentialFingerprint =
		"beforeCredentialFingerprint" in value ? value.beforeCredentialFingerprint : undefined;
	const afterCredentialFingerprint =
		"afterCredentialFingerprint" in value ? value.afterCredentialFingerprint : undefined;
	if (typeof updated !== "boolean" || typeof casMatched !== "boolean") {
		throw new Error("Native OAuth credential mutation evidence is invalid");
	}
	for (const fingerprint of [beforeCredentialFingerprint, afterCredentialFingerprint]) {
		if (
			fingerprint !== undefined &&
			(typeof fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(fingerprint))
		) {
			throw new Error("Native OAuth credential mutation fingerprint is invalid");
		}
	}
	return {
		updated,
		casMatched,
		...(typeof beforeCredentialFingerprint === "string" ? { beforeCredentialFingerprint } : {}),
		...(typeof afterCredentialFingerprint === "string" ? { afterCredentialFingerprint } : {}),
	};
}

export const HERMES_CODEX_AUTH_HELPER = String.raw`
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [authPath, action, profileId, ownedProfileId = "", credentialRevision = "", expectedFingerprint = ""] = process.argv.slice(1);
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
if (rawEntries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
  throw new Error("Hermes openai-codex credential pool contains an unknown entry");
}
const entries = rawEntries;
const valid = (entry) => typeof entry.access_token === "string" && entry.access_token.length > 0 && typeof entry.refresh_token === "string" && entry.refresh_token.length > 0;
const digest = (value) => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (entry, revision) => valid(entry)
  ? digest(["clawdi.runtimeOAuthCredential.v1", revision, entry.access_token, entry.refresh_token])
  : digest(["clawdi.nativeOAuthCredentialEvidence.v1", entry]);
const reservedEntries = entries.filter((entry) => entry.id === profileId);
if (reservedEntries.length > 1) {
  throw new Error("Hermes openai-codex credential pool contains duplicate reserved IDs");
}
const reservedEntry = reservedEntries[0];
const present = Boolean(reservedEntry);
const beforeCredentialFingerprint = present ? fingerprint(reservedEntry, credentialRevision) : undefined;
const managed = present && valid(reservedEntry) && reservedEntry.auth_type === "oauth" && reservedEntry.source === "manual:device_code" && ownedProfileId === profileId;
if (action === "inspect") {
  process.stdout.write(JSON.stringify({
    observation: !present ? "missing" : managed ? "managed" : "foreign",
    ...(beforeCredentialFingerprint ? { credentialFingerprint: beforeCredentialFingerprint } : {}),
  }));
} else {
  let updated = false;
  let afterCredentialFingerprint = beforeCredentialFingerprint;
  const casMatched = expectedFingerprint === "missing"
    ? !present
    : Boolean(expectedFingerprint) && beforeCredentialFingerprint === expectedFingerprint;
  if (!casMatched) {
    process.stdout.write(JSON.stringify({ updated, casMatched, ...(beforeCredentialFingerprint ? { beforeCredentialFingerprint } : {}), ...(afterCredentialFingerprint ? { afterCredentialFingerprint } : {}) }));
  } else if (action === "seed-if-missing" || action === "upsert") {
    if (!material || typeof material.accessToken !== "string" || typeof material.refreshToken !== "string") {
      throw new Error("Hermes Codex credential material is invalid");
    }
    const targetEntry = {
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
    };
    pool["openai-codex"] = [targetEntry, ...entries.filter((entry) => entry.id !== profileId)];
    afterCredentialFingerprint = fingerprint(targetEntry, credentialRevision);
    updated = true;
  } else if (action === "remove" && managed) {
    const remaining = entries.filter((entry) => entry.id !== profileId);
    if (remaining.length > 0) pool["openai-codex"] = remaining;
    else delete pool["openai-codex"];
    afterCredentialFingerprint = undefined;
    updated = true;
  } else if (action !== "remove") {
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
  if (casMatched) {
    process.stdout.write(JSON.stringify({ updated, casMatched: action !== "remove" || managed, ...(beforeCredentialFingerprint ? { beforeCredentialFingerprint } : {}), ...(afterCredentialFingerprint ? { afterCredentialFingerprint } : {}) }));
  }
}
`;

export const OPENCLAW_PROVIDER_AUTH_HELPER = `
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const [sdkPath, agentDir, action, profileId, ownedProfileId = "", credentialRevision = "", expectedFingerprint = ""] = process.argv.slice(1);
const sdk = await import(pathToFileURL(sdkPath).href);
const valid = (credential) => credential?.type === "oauth" && credential.provider === "openai" && typeof credential.access === "string" && credential.access.length > 0 && typeof credential.refresh === "string" && credential.refresh.length > 0;
const digest = (value) => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (credential, revision) => valid(credential)
  ? digest(["clawdi.runtimeOAuthCredential.v1", revision, credential.access, credential.refresh])
  : digest(["clawdi.nativeOAuthCredentialEvidence.v1", credential]);
if (action === "inspect") {
  const store = sdk.ensureAuthProfileStoreForLocalUpdate(agentDir);
  const present = Object.prototype.hasOwnProperty.call(store.profiles, profileId);
  const credential = present ? store.profiles[profileId] : undefined;
  const credentialFingerprint = present ? fingerprint(credential, credentialRevision) : undefined;
  const managed = valid(credential) && ownedProfileId === profileId;
  process.stdout.write(JSON.stringify({ observation: !present ? "missing" : managed ? "managed" : "foreign", ...(credentialFingerprint ? { credentialFingerprint } : {}) }));
} else {
  const credential = JSON.parse(readFileSync(0, "utf8") || "null");
  let changed = false;
  let casMatched = false;
  let beforeCredentialFingerprint;
  let afterCredentialFingerprint;
  const result = await sdk.updateAuthProfileStoreWithLock({
    agentDir,
    updater: (store) => {
      const present = Object.prototype.hasOwnProperty.call(store.profiles, profileId);
      const current = present ? store.profiles[profileId] : undefined;
      beforeCredentialFingerprint = present ? fingerprint(current, credentialRevision) : undefined;
      afterCredentialFingerprint = beforeCredentialFingerprint;
      casMatched = expectedFingerprint === "missing"
        ? !present
        : Boolean(expectedFingerprint) && beforeCredentialFingerprint === expectedFingerprint;
      if (!casMatched) return false;
      if (action === "seed-if-missing" || action === "upsert") {
        store.profiles[profileId] = credential;
        const existingOrder = Array.isArray(store.order?.openai) ? store.order.openai : [];
        store.order = {
          ...(store.order ?? {}),
          openai: [profileId, ...existingOrder.filter((id) => id !== profileId)],
        };
        afterCredentialFingerprint = fingerprint(credential, credentialRevision);
        changed = true;
        return true;
      }
      if (action === "remove") {
        const owned = valid(current) && ownedProfileId === profileId;
        if (!owned) {
          casMatched = false;
          return false;
        }
        delete store.profiles[profileId];
        if (store.order?.openai) store.order.openai = store.order.openai.filter((id) => id !== profileId);
        if (store.order?.openai?.length === 0) delete store.order.openai;
        if (store.lastGood?.openai === profileId) delete store.lastGood.openai;
        if (store.usageStats) delete store.usageStats[profileId];
        afterCredentialFingerprint = undefined;
        changed = true;
        return true;
      }
      throw new Error("unsupported OpenClaw provider-auth action");
    },
  });
  if (result === null) throw new Error("OpenClaw provider-auth SQLite update failed");
  process.stdout.write(JSON.stringify({ updated: changed, casMatched, ...(beforeCredentialFingerprint ? { beforeCredentialFingerprint } : {}), ...(afterCredentialFingerprint ? { afterCredentialFingerprint } : {}) }));
}
`;
