import { chmodSync, chownSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimeContentSha256 } from "./applied-state";
import type { RuntimeApplyContext } from "./apply-identity";
import { egressProfileSecretRefs } from "./egress-profiles";
import type { RuntimeManifest } from "./manifest-contract";
import { recordValue, stringValue, writeRuntimePrivateFileAtomic } from "./manifest-shared";
import {
	loadCommittedRuntimeManifest,
	manifestSecretRefs,
	pruneRuntimeSnapshots,
	syncRuntimeSnapshotDirectory,
	writeRuntimeManifestSnapshot,
} from "./manifest-source";
import { legacyRuntimeManifestPaths, type RuntimePaths } from "./paths";
import { runningAsRoot, runtimeEgressGid, runtimeEgressUid } from "./runtime-user-command";
import { normalizeSecretValues, runtimeSecretValue } from "./secret-values";

export function writeLastGoodManifest(
	manifest: unknown,
	paths: RuntimePaths,
	secretValues: Record<string, string> | undefined,
	secretScopeManifest: RuntimeManifest,
	excludedSecretRefs: readonly string[] = egressSidecarOnlySecretRefs(secretScopeManifest),
): string | null {
	if (secretScopeManifest.recovery.cacheManifest === false) {
		for (const candidate of paths.mode === "hosted"
			? [paths, legacyRuntimeManifestPaths(paths)]
			: [paths]) {
			rmSync(candidate.manifestLastGood, { force: true });
			rmSync(candidate.managedSecretCacheFile, { force: true });
			syncRuntimeSnapshotDirectory(paths, dirname(candidate.manifestLastGood));
		}
		pruneRuntimeSnapshots(paths);
		return null;
	}
	const recoverable = omitSecretRefs(
		runtimeRecoverableSecretValues(secretScopeManifest, secretValues),
		excludedSecretRefs,
	);
	writeRuntimeManifestSnapshot(paths, manifest, recoverable);
	return paths.manifestLastGood;
}
export function cacheRuntimeLastGoodManifest(
	manifest: unknown,
	paths: RuntimePaths,
	secretValues: Record<string, string> | undefined,
	secretScopeManifest: RuntimeManifest,
): string | null {
	// The authority commit path needs the full active consumer union for exact
	// offline reconstruction.
	return writeLastGoodManifest(manifest, paths, secretValues, secretScopeManifest, []);
}
export function makeManagedSecretRoot(path: string): void {
	chmodSync(path, 0o711);
}
function omitSecretRefs(
	secretValues: Record<string, string> | undefined,
	excludedRefs: readonly string[],
): Record<string, string> {
	const normalized = normalizeSecretValues(secretValues);
	for (const ref of excludedRefs) delete normalized[ref];
	return normalized;
}
export function scopedSecretValues(
	secretValues: Record<string, string> | undefined,
	refs: readonly string[],
): Record<string, string> {
	const normalizedValues = normalizeSecretValues(secretValues);
	const scoped: Record<string, string> = {};
	for (const ref of refs) {
		const value = runtimeSecretValue(normalizedValues, ref);
		if (!value) throw new Error(`Runtime secret ${ref} is unavailable.`);
		scoped[ref] = value;
	}
	return scoped;
}
export function runtimeRecoverableSecretValues(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
): Record<string, string> {
	return scopedSecretValues(secretValues, manifestSecretRefs(manifest));
}
export function makeEgressIdentityOwned(path: string): void {
	if (!runningAsRoot()) return;
	const uid = runtimeEgressUid();
	const gid = runtimeEgressGid();
	chownSync(path, uid, gid);
}
export function egressSecretFilePath(paths: RuntimePaths): string {
	return join(paths.managedSecretRoot, "egress-secrets.json");
}
export interface RuntimeEgressSecretMaterial {
	content: string | null;
	revision: string;
}
function egressSecretMaterialRevision(secretValues: Record<string, string>): string {
	return runtimeContentSha256({
		schemaVersion: "clawdi.runtimeEgressSidecarSecrets.v1",
		secretValues,
	});
}
function egressSecretMaterial(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
): RuntimeEgressSecretMaterial {
	const scoped = scopedSecretValues(secretValues, egressSecretRefs(manifest));
	return {
		content: Object.keys(scoped).length > 0 ? `${JSON.stringify(scoped, null, 2)}\n` : null,
		revision: egressSecretMaterialRevision(scoped),
	};
}
function egressSecretRevisionFromContent(content: string | null): string | null {
	if (content === null) return egressSecretMaterialRevision({});
	try {
		const parsed = JSON.parse(content) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const secretValues: Record<string, string> = {};
		for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value !== "string") return null;
			secretValues[ref] = value;
		}
		return egressSecretMaterialRevision(secretValues);
	} catch {
		return null;
	}
}
export function writeEgressSecretMaterial(
	material: RuntimeEgressSecretMaterial,
	paths: RuntimePaths,
): string | null {
	const path = egressSecretFilePath(paths);
	if (material.content === null) {
		rmSync(path, { force: true });
		return null;
	}
	writeRuntimePrivateFileAtomic(paths, path, material.content, {
		mode: 0o600,
		dirMode: 0o700,
	});
	makeEgressIdentityOwned(path);
	makeManagedSecretRoot(paths.managedSecretRoot);
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort for non-POSIX local development environments.
	}
	return path;
}
export function writeEgressSecretFile(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	paths: RuntimePaths,
): {
	path: string | null;
	changed: boolean;
	material: RuntimeEgressSecretMaterial;
	previousRevision: string | null;
} {
	const secretFilePath = egressSecretFilePath(paths);
	const previousContent = existsSync(secretFilePath) ? readFileSync(secretFilePath, "utf-8") : null;
	const material = egressSecretMaterial(manifest, secretValues);
	const path = writeEgressSecretMaterial(material, paths);
	return {
		path,
		changed: previousContent !== material.content,
		material,
		previousRevision: egressSecretRevisionFromContent(previousContent),
	};
}
export function verifiedCommittedEgressSecretMaterial(
	paths: RuntimePaths,
	applyContext: RuntimeApplyContext,
): RuntimeEgressSecretMaterial | null {
	try {
		const committed = loadCommittedRuntimeManifest(paths, applyContext);
		if ("errors" in committed) return null;
		return egressSecretMaterial(committed.manifest, committed.secretValues);
	} catch {
		return null;
	}
}
function egressSecretRefs(manifest: RuntimeManifest): string[] {
	return egressProfileSecretRefs(manifest.egressProfiles);
}
function egressSidecarOnlySecretRefs(manifest: RuntimeManifest): string[] {
	const refs = new Set<string>();
	const profiles = Array.isArray(manifest.egressProfiles?.profiles)
		? manifest.egressProfiles.profiles
		: [];
	for (const profile of profiles) {
		const profileRecord = recordValue(profile);
		if (profileRecord?.owner === "provider-projection") {
			collectSecretRefs(profile, refs);
		}
		if (profileRecord?.owner === "mcp-projection") {
			collectSecretRefs(profile, refs);
		}
		if (profileRecord?.owner === "clawdi-native-channels") {
			collectChannelRewriteSecretRefs(profileRecord, refs);
		}
	}
	return [...refs].sort();
}
function collectChannelRewriteSecretRefs(
	profile: Record<string, unknown>,
	refs: Set<string>,
): void {
	const rewrite = recordValue(profile.rewrite);
	if (!rewrite) return;
	const pathReplace = recordValue(rewrite.pathReplace);
	const replacementSecretRef = stringValue(pathReplace?.replacementSecretRef);
	if (replacementSecretRef) refs.add(replacementSecretRef);
	const setHeaders = recordValue(rewrite.setHeaders);
	if (!setHeaders) return;
	for (const setter of Object.values(setHeaders)) {
		const setterRecord = recordValue(setter);
		if (setterRecord?.type !== "secretRef") continue;
		const secretRef = stringValue(setterRecord.secretRef);
		if (secretRef) refs.add(secretRef);
	}
}
function collectSecretRefs(value: unknown, refs: Set<string>): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectSecretRefs(item, refs);
		return;
	}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string" && (key === "secretRef" || key.endsWith("SecretRef"))) {
			refs.add(entry);
		}
		collectSecretRefs(entry, refs);
	}
}
