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
	version: 3;
	// Historical v1/v2 hash cache. These entries may suppress a redundant
	// upload after callers re-confirm remote state, but are not ownership
	// evidence and must never drive a projection delete.
	skills: Record<string, { hash: string }>;
	// Keyed by skillClaimCacheKey(agent_id, project_id, skill_key). Entries
	// repeat every identity field so hand-edited/corrupt mismatches can be
	// rejected fail-closed on read.
	claims: Record<string, SkillProjectionClaim>;
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

export interface SkillProjectionState {
	claims: Map<string, string>;
	legacyBaselines: Map<string, string>;
}

type LegacyWritableSkillsLock = {
	version: 1 | 2;
	skills: Record<string, { hash: string }>;
};

const LOCK_FILE = "skills-lock.json";
const CURRENT_VERSION = 3;

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
		if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== CURRENT_VERSION) {
			return emptyLock();
		}
		const skills = readHashEntries(parsed.skills);
		if (parsed.version !== CURRENT_VERSION) {
			return { version: CURRENT_VERSION, skills, claims: {} };
		}
		return {
			version: CURRENT_VERSION,
			skills,
			claims: readProjectionClaims(parsed.claims),
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
		const currentClaims = readSkillsLock().claims;
		const requestedClaims =
			lock.version === CURRENT_VERSION ? readProjectionClaims(lock.claims) : {};
		lease.assertOwned();
		writeSkillsLockUnlocked({
			version: CURRENT_VERSION,
			skills: lock.skills,
			claims: { ...requestedClaims, ...currentClaims },
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
	const sorted: SkillsLock = {
		version: CURRENT_VERSION,
		skills: sortedSkills,
		claims: sortedClaims,
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

function assertValidProjectionIdentity(identity: SkillProjectionIdentity): void {
	if (identity.agentType.length === 0) throw new Error("Skill projection Agent type is required");
	if (identity.agentId.length === 0) throw new Error("Skill projection Agent ID is required");
	if (identity.projectId.length === 0) throw new Error("Skill projection Project ID is required");
	if (!isValidSkillKey(identity.skillKey)) throw new Error("Invalid Skill projection key");
}

function emptyLock(): SkillsLock {
	return { version: CURRENT_VERSION, skills: {}, claims: {} };
}
