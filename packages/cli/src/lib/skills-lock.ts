import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getClawdiDir } from "./config";
import { withPrivateDirectoryLockSync } from "./private-directory-lock";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "./private-file";
import { isValidSkillKey } from "./skill-key";
import { snapshotSkillArchive } from "./tar";

/**
 * Durable Agent Skill projection ledger plus legacy upload baselines.
 * A v3 claim records the exact stable Agent, resolved Agent Project,
 * adapter, Skill key, and last successfully projected hash. Only such
 * an exact claim is evidence that a subsequently missing local Skill
 * may delete its Cloud projection. v1/v2 hash entries are retained as
 * best-effort upload baselines, but never authorize deletion.
 *
 * Lives at `~/.clawdi/skills-lock.json` — single file, version-stamped,
 * corrupt-tolerant. The Agent filesystem is authoritative; deleting the
 * ledger intentionally loses deletion authority until a successful
 * upload establishes a new claim, which is fail-safe.
 */
export interface SkillsLock {
	version: 5;
	// Historical v1/v2 hash cache. These entries may suppress a redundant
	// upload after callers re-confirm remote state, but are not ownership
	// evidence and must never drive a projection delete.
	skills: Record<string, { hash: string }>;
	// Keyed by skillClaimCacheKey(agent_id, project_id, skill_key). Entries
	// repeat every identity field so hand-edited/corrupt mismatches can be
	// rejected fail-closed on read.
	claims: Record<string, SkillProjectionClaim>;
	// Project-owned Skills materialized into an Agent filesystem stay
	// references to their source Project. Their local bytes must never be
	// promoted into an agent_sync claim by push or daemon reconciliation.
	materializations: Record<string, ProjectSkillMaterialization>;
}

export interface SkillProjectionClaim {
	agent_type: string;
	agent_id: string;
	project_id: string;
	skill_key: string;
	hash: string;
}

export interface SkillProjectionIdentity {
	agentType: string;
	agentId: string;
	projectId: string;
	skillKey: string;
}

export interface ProjectSkillMaterialization {
	agent_type: string;
	local_skill_key: string;
	source_project_id: string;
	source_skill_key: string;
	content_hash: string;
	/** Agent whose desired-inventory reconcile owns install/remove lifecycle.
	 * Absent on explicit legacy pull materializations, which the daemon must
	 * never remove merely because they are outside its desired inventory. */
	reconcile_agent_id?: string;
}

export interface ProjectSkillMaterializationIdentity {
	agentType: string;
	localSkillKey: string;
}

type ProjectSkillMaterializationInput = ProjectSkillMaterializationIdentity & {
	sourceProjectId: string;
	sourceSkillKey: string;
	contentHash: string;
	reconcileAgentId?: string;
};

export interface SkillProjectionState {
	claims: Map<string, string>;
	legacyBaselines: Map<string, string>;
}

type LegacyWritableSkillsLock = {
	version: 1 | 2;
	skills: Record<string, { hash: string }>;
};

const LOCK_FILE = "skills-lock.json";
const CURRENT_VERSION = 5;

function lockPath(): string {
	return join(getClawdiDir(), `${LOCK_FILE}.lock`);
}

function dataPath(): string {
	return join(getClawdiDir(), LOCK_FILE);
}

/** Compose the partitioned cache key. Mirrors `cacheKey()` in
 * sessions-lock so the two locks stay shape-aligned. */
export function skillCacheKey(agentType: string, skillKey: string): string {
	return `${agentType}:${skillKey}`;
}

/** Stable claim key. Encoding makes component boundaries unambiguous even
 * if a future Skill-key grammar permits a separator used by IDs. */
export function skillClaimCacheKey(agentId: string, projectId: string, skillKey: string): string {
	return [agentId, projectId, skillKey].map((value) => encodeURIComponent(value)).join(":");
}

export function projectSkillMaterializationCacheKey(
	agentType: string,
	localSkillKey: string,
): string {
	return [agentType, localSkillKey].map((value) => encodeURIComponent(value)).join(":");
}

/** Convert a platform path relative to an adapter root into wire Skill-key form. */
export function canonicalMaterializedSkillKey(relativePath: string): string {
	const canonical = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (!isValidSkillKey(canonical)) throw new Error("Invalid materialized Skill path");
	return canonical;
}

/** SHA-256 over the exact safe, dereferenced regular-file projection that
 * `tarSkillDir` would upload. Building and re-reading the archive is
 * intentional: symlink trust/cycle handling and excludes cannot drift from
 * the bytes verified by `backend/app/routes/skills.py:_compute_file_tree_hash`.
 * The published identity remains sorted relative `path + content`; modes and
 * mtimes are deliberately outside that contract. */
export async function computeSkillFolderHash(
	skillDir: string,
	trustRoot?: string | string[],
	skillKey?: string,
): Promise<string> {
	return (await snapshotSkillArchive(skillDir, trustRoot, skillKey)).hash;
}

/** Read `~/.clawdi/skills-lock.json` and normalize v1/v2 baselines to v3.
 * Future/corrupt files reset to an empty ledger. Invalid individual claims
 * are omitted, because ambiguous identity must never authorize deletion. */
export function readSkillsLock(): SkillsLock {
	const path = dataPath();
	if (!existsSync(path)) return emptyLock();
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(parsed)) return emptyLock();
		if (
			parsed.version !== 1 &&
			parsed.version !== 2 &&
			parsed.version !== 3 &&
			parsed.version !== 4 &&
			parsed.version !== CURRENT_VERSION
		) {
			return emptyLock();
		}
		const skills = readHashEntries(parsed.skills);
		if (parsed.version === 1 || parsed.version === 2) {
			return { version: CURRENT_VERSION, skills, claims: {}, materializations: {} };
		}
		return {
			version: CURRENT_VERSION,
			skills,
			claims: readProjectionClaims(parsed.claims),
			materializations:
				parsed.version === 4 || parsed.version === CURRENT_VERSION
					? readProjectSkillMaterializations(parsed.materializations)
					: {},
		};
	} catch {
		console.log(chalk.yellow(`⚠ ~/.clawdi/${LOCK_FILE} is corrupted; resetting.`));
		return emptyLock();
	}
}

export function writeSkillsLock(lock: SkillsLock | LegacyWritableSkillsLock): void {
	withPrivateDirectoryLockSync(lockPath(), (lease) => {
		// Baseline writers still use the released read/mutate/write API.
		// Preserve exact claims committed after their read so a stale
		// manual command cannot erase daemon deletion authority.
		const current = readSkillsLock();
		const currentClaims = current.claims;
		const currentMaterializations = current.materializations;
		const requestedClaims =
			lock.version === CURRENT_VERSION ? readProjectionClaims(lock.claims) : {};
		const requestedMaterializations =
			lock.version === CURRENT_VERSION
				? readProjectSkillMaterializations(lock.materializations)
				: {};
		lease.assertOwned();
		writeSkillsLockUnlocked({
			version: CURRENT_VERSION,
			skills: lock.skills,
			claims: { ...requestedClaims, ...currentClaims },
			materializations: { ...requestedMaterializations, ...currentMaterializations },
		});
	});
}

function writeSkillsLockUnlocked(lock: SkillsLock): void {
	// Sort keys for deterministic output — keeps `git diff` readable when
	// users commit the file alongside their dotfiles, and stabilizes test
	// snapshots.
	const sortedSkills: Record<string, { hash: string }> = {};
	for (const key of Object.keys(lock.skills).sort()) {
		const entry = lock.skills[key];
		if (entry) sortedSkills[key] = entry;
	}
	const sortedClaims: Record<string, SkillProjectionClaim> = {};
	for (const key of Object.keys(lock.claims).sort()) {
		const claim = lock.claims[key];
		if (claim) sortedClaims[key] = claim;
	}
	const sortedMaterializations: Record<string, ProjectSkillMaterialization> = {};
	for (const key of Object.keys(lock.materializations).sort()) {
		const materialization = lock.materializations[key];
		if (materialization) sortedMaterializations[key] = materialization;
	}
	const sorted: SkillsLock = {
		version: CURRENT_VERSION,
		skills: sortedSkills,
		claims: sortedClaims,
		materializations: sortedMaterializations,
	};
	writePrivateFileAtomic(dataPath(), `${JSON.stringify(sorted, null, 2)}\n`, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

/** Return only claims fenced to the exact adapter, Agent, and Project.
 * Legacy baselines are returned separately to make their weaker authority
 * explicit in callers. */
export function readSkillProjectionState(
	agentType: string,
	agentId: string,
	projectId: string,
): SkillProjectionState {
	const lock = readSkillsLock();
	const claims = new Map<string, string>();
	for (const claim of Object.values(lock.claims)) {
		if (
			claim.agent_type === agentType &&
			claim.agent_id === agentId &&
			claim.project_id === projectId
		) {
			claims.set(claim.skill_key, claim.hash);
		}
	}

	const legacyBaselines = new Map<string, string>();
	// v1 flat entries are the weakest fallback.
	for (const [key, entry] of Object.entries(lock.skills)) {
		if (!key.includes(":")) legacyBaselines.set(key, entry.hash);
	}
	// v2 adapter-partitioned entries override v1.
	const agentPrefix = `${agentType}:`;
	const projectPrefix = `${agentType}:${projectId}:`;
	for (const [key, entry] of Object.entries(lock.skills)) {
		if (key.startsWith(agentPrefix) && !key.startsWith(projectPrefix)) {
			legacyBaselines.set(key.slice(agentPrefix.length), entry.hash);
		}
	}
	// Some released pull paths also included project ID inside the old key.
	for (const [key, entry] of Object.entries(lock.skills)) {
		if (key.startsWith(projectPrefix)) {
			legacyBaselines.set(key.slice(projectPrefix.length), entry.hash);
		}
	}
	return { claims, legacyBaselines };
}

/** Enumerate every exact claim for a stable Agent across Project
 * assignments. Callers use this to retire claims stamped for an old
 * Project without treating legacy baselines as deletion authority. */
export function readSkillProjectionClaimsForAgent(
	agentType: string,
	agentId: string,
): SkillProjectionClaim[] {
	return Object.values(readSkillsLock().claims)
		.filter((claim) => claim.agent_type === agentType && claim.agent_id === agentId)
		.map((claim) => ({ ...claim }));
}

/** Persist an exact projection claim after both local activation and the
 * authenticated Cloud upsert have succeeded. */
export function recordSkillProjectionClaim(
	claim: SkillProjectionIdentity & { hash: string },
): void {
	assertValidProjectionIdentity(claim);
	if (claim.hash.length === 0) throw new Error("Skill projection claim hash must not be empty");
	withPrivateDirectoryLockSync(lockPath(), (lease) => {
		const lock = readSkillsLock();
		const key = skillClaimCacheKey(claim.agentId, claim.projectId, claim.skillKey);
		lock.claims[key] = {
			agent_type: claim.agentType,
			agent_id: claim.agentId,
			project_id: claim.projectId,
			skill_key: claim.skillKey,
			hash: claim.hash,
		};
		// Maintain the released baseline shape for mixed-version local callers.
		lock.skills[skillCacheKey(claim.agentType, claim.skillKey)] = { hash: claim.hash };
		lease.assertOwned();
		writeSkillsLockUnlocked(lock);
	});
}

/** Remove only the exact fenced claim after the authenticated projection
 * delete succeeds. Returns false when no such claim exists. */
export function removeSkillProjectionClaim(identity: SkillProjectionIdentity): boolean {
	assertValidProjectionIdentity(identity);
	return withPrivateDirectoryLockSync(lockPath(), (lease) => {
		const lock = readSkillsLock();
		const key = skillClaimCacheKey(identity.agentId, identity.projectId, identity.skillKey);
		const existing = lock.claims[key];
		if (
			!existing ||
			existing.agent_type !== identity.agentType ||
			existing.agent_id !== identity.agentId ||
			existing.project_id !== identity.projectId ||
			existing.skill_key !== identity.skillKey
		) {
			return false;
		}
		delete lock.claims[key];
		const baselineKey = skillCacheKey(identity.agentType, identity.skillKey);
		if (lock.skills[baselineKey]?.hash === existing.hash) delete lock.skills[baselineKey];
		lease.assertOwned();
		writeSkillsLockUnlocked(lock);
		return true;
	});
}

/** Read the exact Project materialization occupying an Agent-local Skill key. */
export function readProjectSkillMaterialization(
	identity: ProjectSkillMaterializationIdentity,
): ProjectSkillMaterialization | null {
	assertValidMaterializationIdentity(identity);
	const key = projectSkillMaterializationCacheKey(identity.agentType, identity.localSkillKey);
	const materialization = readSkillsLock().materializations[key];
	if (
		!materialization ||
		materialization.agent_type !== identity.agentType ||
		materialization.local_skill_key !== identity.localSkillKey
	) {
		return null;
	}
	return { ...materialization };
}

export function hasExactProjectSkillMaterialization(
	materialization: ProjectSkillMaterializationInput,
): boolean {
	const existing = readProjectSkillMaterialization(materialization);
	return Boolean(
		existing &&
			existing.source_project_id === materialization.sourceProjectId &&
			existing.source_skill_key === materialization.sourceSkillKey &&
			existing.content_hash === materialization.contentHash &&
			(materialization.reconcileAgentId === undefined ||
				existing.reconcile_agent_id === materialization.reconcileAgentId),
	);
}

/** Persist Project ownership before its archive commits to the adapter filesystem. */
export function recordProjectSkillMaterialization(
	materialization: ProjectSkillMaterializationInput,
): void {
	assertValidMaterializationIdentity(materialization);
	if (!materialization.sourceProjectId) throw new Error("Source Project ID is required");
	if (!isValidSkillKey(materialization.sourceSkillKey)) {
		throw new Error("Invalid source Project Skill key");
	}
	if (!materialization.contentHash) throw new Error("Materialized Skill hash is required");
	if (materialization.reconcileAgentId !== undefined && !materialization.reconcileAgentId) {
		throw new Error("Reconcile Agent ID must not be empty");
	}
	withPrivateDirectoryLockSync(lockPath(), (lease) => {
		const lock = readSkillsLock();
		const key = projectSkillMaterializationCacheKey(
			materialization.agentType,
			materialization.localSkillKey,
		);
		lock.materializations[key] = {
			agent_type: materialization.agentType,
			local_skill_key: materialization.localSkillKey,
			source_project_id: materialization.sourceProjectId,
			source_skill_key: materialization.sourceSkillKey,
			content_hash: materialization.contentHash,
			...(materialization.reconcileAgentId
				? { reconcile_agent_id: materialization.reconcileAgentId }
				: {}),
		};
		lease.assertOwned();
		writeSkillsLockUnlocked(lock);
	});
}

/** Fence source authority durably before an adapter atomically activates bytes. */
export async function commitProjectSkillMaterialization(
	materialization: ProjectSkillMaterializationInput,
	activate: () => Promise<void>,
): Promise<void> {
	const previous = readProjectSkillMaterialization(materialization);
	recordProjectSkillMaterialization(materialization);
	try {
		await activate();
	} catch (error) {
		withPrivateDirectoryLockSync(lockPath(), (lease) => {
			const lock = readSkillsLock();
			const key = projectSkillMaterializationCacheKey(
				materialization.agentType,
				materialization.localSkillKey,
			);
			const current = lock.materializations[key];
			if (
				current?.source_project_id === materialization.sourceProjectId &&
				current.source_skill_key === materialization.sourceSkillKey &&
				current.content_hash === materialization.contentHash &&
				current.reconcile_agent_id === materialization.reconcileAgentId
			) {
				if (previous) lock.materializations[key] = previous;
				else delete lock.materializations[key];
				lease.assertOwned();
				writeSkillsLockUnlocked(lock);
			}
		});
		throw error;
	}
}

export function readProjectSkillMaterializationsForReconcile(
	agentType: string,
	agentId: string,
): ProjectSkillMaterialization[] {
	return Object.values(readSkillsLock().materializations)
		.filter(
			(materialization) =>
				materialization.agent_type === agentType && materialization.reconcile_agent_id === agentId,
		)
		.map((materialization) => ({ ...materialization }));
}

/** Explicit Agent install/remove commands retire only the exact local reference. */
export function removeProjectSkillMaterialization(
	identity: ProjectSkillMaterializationIdentity,
): boolean {
	assertValidMaterializationIdentity(identity);
	return withPrivateDirectoryLockSync(lockPath(), (lease) => {
		const lock = readSkillsLock();
		const key = projectSkillMaterializationCacheKey(identity.agentType, identity.localSkillKey);
		const existing = lock.materializations[key];
		if (
			!existing ||
			existing.agent_type !== identity.agentType ||
			existing.local_skill_key !== identity.localSkillKey
		) {
			return false;
		}
		delete lock.materializations[key];
		lease.assertOwned();
		writeSkillsLockUnlocked(lock);
		return true;
	});
}

/** Remove only the receipt that still matches the complete source identity. */
export function removeExactProjectSkillMaterialization(
	materialization: ProjectSkillMaterializationInput,
): boolean {
	assertValidMaterializationIdentity(materialization);
	return withPrivateDirectoryLockSync(lockPath(), (lease) => {
		const lock = readSkillsLock();
		const key = projectSkillMaterializationCacheKey(
			materialization.agentType,
			materialization.localSkillKey,
		);
		const existing = lock.materializations[key];
		if (
			!existing ||
			existing.agent_type !== materialization.agentType ||
			existing.local_skill_key !== materialization.localSkillKey ||
			existing.source_project_id !== materialization.sourceProjectId ||
			existing.source_skill_key !== materialization.sourceSkillKey ||
			existing.content_hash !== materialization.contentHash ||
			existing.reconcile_agent_id !== materialization.reconcileAgentId
		) {
			return false;
		}
		delete lock.materializations[key];
		lease.assertOwned();
		writeSkillsLockUnlocked(lock);
		return true;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHashEntries(value: unknown): Record<string, { hash: string }> {
	if (!isRecord(value)) return {};
	const entries: Record<string, { hash: string }> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (isRecord(raw) && typeof raw.hash === "string" && raw.hash.length > 0) {
			entries[key] = { hash: raw.hash };
		}
	}
	return entries;
}

function readProjectionClaims(value: unknown): Record<string, SkillProjectionClaim> {
	if (!isRecord(value)) return {};
	const claims: Record<string, SkillProjectionClaim> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!isRecord(raw)) continue;
		if (
			typeof raw.agent_type !== "string" ||
			raw.agent_type.length === 0 ||
			typeof raw.agent_id !== "string" ||
			raw.agent_id.length === 0 ||
			typeof raw.project_id !== "string" ||
			raw.project_id.length === 0 ||
			typeof raw.skill_key !== "string" ||
			!isValidSkillKey(raw.skill_key) ||
			typeof raw.hash !== "string" ||
			raw.hash.length === 0
		) {
			continue;
		}
		if (key !== skillClaimCacheKey(raw.agent_id, raw.project_id, raw.skill_key)) continue;
		claims[key] = {
			agent_type: raw.agent_type,
			agent_id: raw.agent_id,
			project_id: raw.project_id,
			skill_key: raw.skill_key,
			hash: raw.hash,
		};
	}
	return claims;
}

function readProjectSkillMaterializations(
	value: unknown,
): Record<string, ProjectSkillMaterialization> {
	if (!isRecord(value)) return {};
	const materializations: Record<string, ProjectSkillMaterialization> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!isRecord(raw)) continue;
		if (
			typeof raw.agent_type !== "string" ||
			raw.agent_type.length === 0 ||
			typeof raw.local_skill_key !== "string" ||
			!isValidSkillKey(raw.local_skill_key) ||
			typeof raw.source_project_id !== "string" ||
			raw.source_project_id.length === 0 ||
			typeof raw.source_skill_key !== "string" ||
			!isValidSkillKey(raw.source_skill_key) ||
			typeof raw.content_hash !== "string" ||
			raw.content_hash.length === 0
		) {
			continue;
		}
		if (key !== projectSkillMaterializationCacheKey(raw.agent_type, raw.local_skill_key)) {
			continue;
		}
		materializations[key] = {
			agent_type: raw.agent_type,
			local_skill_key: raw.local_skill_key,
			source_project_id: raw.source_project_id,
			source_skill_key: raw.source_skill_key,
			content_hash: raw.content_hash,
			...(typeof raw.reconcile_agent_id === "string" && raw.reconcile_agent_id.length > 0
				? { reconcile_agent_id: raw.reconcile_agent_id }
				: {}),
		};
	}
	return materializations;
}

function assertValidProjectionIdentity(identity: SkillProjectionIdentity): void {
	if (identity.agentType.length === 0) throw new Error("Skill projection Agent type is required");
	if (identity.agentId.length === 0) throw new Error("Skill projection Agent ID is required");
	if (identity.projectId.length === 0) throw new Error("Skill projection Project ID is required");
	if (!isValidSkillKey(identity.skillKey)) throw new Error("Invalid Skill projection key");
}

function assertValidMaterializationIdentity(identity: ProjectSkillMaterializationIdentity): void {
	if (!identity.agentType) throw new Error("Materialized Skill Agent type is required");
	if (!isValidSkillKey(identity.localSkillKey)) throw new Error("Invalid materialized Skill key");
}

function emptyLock(): SkillsLock {
	return { version: CURRENT_VERSION, skills: {}, claims: {}, materializations: {} };
}
