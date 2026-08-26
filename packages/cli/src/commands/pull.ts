import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { type AgentType, adapterRegistry } from "../adapters/registry";
import { ApiClient, unwrap } from "../lib/api-client";
import type { SessionListItem, SkillSummary } from "../lib/api-schemas";
import { getClawdiDir, isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { listProjects, resolveProjectId } from "../lib/project-resolver";
import { parseModules } from "../lib/prompts";
import { sanitizeMetadata } from "../lib/sanitize";
import { adapterForType, getEnvIdByAgent, resolveTargetAgentTypes } from "../lib/select-adapter";
import {
	SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
	SKILL_SYNC_PROTOCOL_HEADER,
} from "../lib/skill-sync-protocol";
import {
	canonicalMaterializedSkillKey,
	commitProjectSkillMaterialization,
	hasExactProjectSkillMaterialization,
	readSkillProjectionClaimsForAgent,
	readSkillsLock,
	removeSkillProjectionClaim,
	type SkillsLock,
	skillCacheKey,
	writeSkillsLock,
} from "../lib/skills-lock";

const DOWN_MODULES = ["skills", "sessions"] as const;

interface PullOpts {
	modules?: string;
	project?: string;
	dryRun?: boolean;
	agent?: string;
	allAgents?: boolean;
	all?: boolean;
}

/**
 * What `scanOneAgent` found for a single agent: explicit Cloud-owned Skill
 * imports and mirrored sessions. Splitting scan from apply lets `pull` show a
 * combined, per-agent summary across every target agent before downloading,
 * the same shape as `clawdi push`.
 */
interface AgentPullScan {
	agentType: AgentType;
	modules: (typeof DOWN_MODULES)[number][];
	/** Explicit Cloud-owned Project to import Skills from; null when Skills
	 * are not part of this pull. */
	skillProjectId: string | null;
	/** Non-null for shared projects so duplicate skill keys land under
	 * `<key>__<ownerHandle>` instead of overwriting the user's own skill. */
	sharedOwnerHandle: string | null;
	/** Explicit project pulls partition the lock by project_id because the
	 * same target agent can pull multiple visible projects with one key. */
	projectQualifiedSkillCache: boolean;
	skills: SkillSummary[];
	skillsInSync: number;
	sessions: { remote: SessionListItem; reason: "new" | "updated" }[];
	sessionsUnchanged: number;
}

/** What `applyOneAgentPull` committed for a single agent. */
interface AgentPullResult {
	skillsImported: number;
	sessionsNew: number;
	sessionsUpdated: number;
}

/** Whether a scan turned up an explicit import or session mirror to apply. */
function scanHasWork(scan: AgentPullScan): boolean {
	return scan.skills.length > 0 || scan.sessions.length > 0;
}

export async function pull(opts: PullOpts) {
	p.intro(chalk.bold("clawdi pull"));

	if (!isLoggedIn()) {
		p.log.error("Not logged in. Run `clawdi auth login` first.");
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	// `--all` widens every axis it can. Project selection only applies
	// to skill pulls; explicit narrowing via --agent or --modules wins.
	if (opts.all && !opts.agent && !opts.allAgents) {
		opts.allAgents = true;
	}

	const targetTypes = await resolveTargetAgentTypes(opts.agent, !!opts.allAgents);
	if (targetTypes.length === 0) {
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	// Module default remains broad for compatibility, but Agent Skills are
	// never sourced from the implicit Agent Project. Without an explicit
	// Cloud-owned Project, pull only mirrors sessions.
	let modules = parseModules(opts.modules, DOWN_MODULES);
	if (!modules) return;
	const explicitlySelectedModules = opts.modules !== undefined;
	const strictModuleSelection = explicitlySelectedModules && targetTypes.length === 1;
	if (!opts.project && modules.includes("skills")) {
		if (modules.length === 1) {
			p.log.error(
				"Skill import requires --project naming a Custom or personal Project. Agent Workspaces are filesystem-authoritative.",
			);
			p.outro(chalk.red("Aborted."));
			process.exitCode = 1;
			return;
		}
		modules = modules.filter((module) => module !== "skills");
	}

	if (opts.project && modules.includes("sessions")) {
		p.log.error("--project is supported for skill pulls only. Use --modules skills.");
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}
	if (strictModuleSelection && modules.includes("skills")) {
		for (const agentType of targetTypes) {
			const adapter = adapterForType(agentType);
			if (!adapter?.skills) {
				p.log.error(`${adapterRegistry[agentType].displayName} does not support skills.`);
				p.outro(chalk.red("Aborted."));
				process.exitCode = 1;
				return;
			}
		}
	}

	const api = new ApiClient();
	// Read once before the loop, mutate as explicit imports land, persist once
	// at the end. This is only an import dedup baseline, never projection
	// deletion authority.
	const skillsLock = modules.includes("skills") ? readSkillsLock() : null;

	// Scan every agent first — one spinner, one combined summary — so a
	// multi-agent pull reads as a single scan, matching `clawdi push`.
	const scanSpinner = p.spinner();
	scanSpinner.start(
		`Scanning ${targetTypes.length} agent${targetTypes.length === 1 ? "" : "s"}...`,
	);
	const scans: AgentPullScan[] = [];
	const moduleSkips: Array<{ agentType: AgentType; modules: string[] }> = [];
	try {
		for (const agentType of targetTypes) {
			const adapter = adapterForType(agentType);
			const availableModules = modules.filter(
				(module) => module === "sessions" || adapter?.skills !== undefined,
			);
			const missing = modules.filter((module) => !availableModules.includes(module));
			if (explicitlySelectedModules && missing.length > 0) {
				moduleSkips.push({ agentType, modules: missing });
			}
			if (availableModules.length === 0) continue;
			scans.push(await scanOneAgent(api, agentType, availableModules, opts, skillsLock));
		}
	} catch (e) {
		scanSpinner.stop("Scan failed.");
		throw e;
	}
	scanSpinner.stop("Scan complete.");
	for (const skip of moduleSkips) {
		p.log.warn(
			`${adapterRegistry[skip.agentType].displayName} skipped unsupported ${skip.modules.join(", ")}.`,
		);
	}

	// Combined per-agent summary, visible in full before downloads begin.
	for (const scan of scans) {
		const name = adapterRegistry[scan.agentType].displayName;
		const bits: string[] = [];
		if (scan.modules.includes("skills")) {
			const sync = scan.skillsInSync > 0 ? ` (${scan.skillsInSync} in sync)` : "";
			bits.push(`${scan.skills.length} skill import${scan.skills.length === 1 ? "" : "s"}${sync}`);
		}
		if (scan.modules.includes("sessions")) {
			const sync = scan.sessionsUnchanged > 0 ? ` (${scan.sessionsUnchanged} unchanged)` : "";
			bits.push(`${scan.sessions.length} session${scan.sessions.length === 1 ? "" : "s"}${sync}`);
		}
		p.log.message(`${chalk.bold(name)} — ${bits.join(", ")} pending`);
	}

	const toApply = scans.filter(scanHasWork);

	if (opts.dryRun) {
		p.outro(
			chalk.gray(
				toApply.length > 0
					? "Dry run complete."
					: "Dry run — nothing to pull, everything already in sync.",
			),
		);
		return;
	}

	const totals = {
		skillImports: 0,
		skillsInSync: 0,
		sessionsNew: 0,
		sessionsUpdated: 0,
		sessionsUnchanged: 0,
	};
	for (const scan of scans) {
		// "In sync" / "unchanged" are scan facts — fold them in regardless
		// of whether this agent goes on to download anything.
		totals.skillsInSync += scan.skillsInSync;
		totals.sessionsUnchanged += scan.sessionsUnchanged;
		if (!scanHasWork(scan)) continue;
		// Header only when more than one agent actually applies work.
		if (toApply.length > 1) {
			p.log.step(chalk.bold(`▶ ${adapterRegistry[scan.agentType].displayName}`));
		}
		const result = await applyOneAgentPull(api, scan, skillsLock);
		totals.skillImports += result.skillsImported;
		totals.sessionsNew += result.sessionsNew;
		totals.sessionsUpdated += result.sessionsUpdated;
	}

	if (skillsLock) {
		// Pull keeps a long-lived hash baseline snapshot while per-Skill
		// authority handoffs update claims/materializations transactionally.
		// Merge only the baselines into fresh authority state so this stale
		// snapshot cannot resurrect a projection claim retired above.
		const latestSkillsLock = readSkillsLock();
		latestSkillsLock.skills = { ...latestSkillsLock.skills, ...skillsLock.skills };
		writeSkillsLock(latestSkillsLock);
	}

	const parts: string[] = [];
	if (modules.includes("skills")) {
		parts.push(
			totals.skillsInSync > 0
				? `${totals.skillImports} skill import${totals.skillImports === 1 ? "" : "s"}, ${totals.skillsInSync} already imported`
				: `${totals.skillImports} skill import${totals.skillImports === 1 ? "" : "s"}`,
		);
	}
	if (modules.includes("sessions")) {
		parts.push(
			`${totals.sessionsNew} new sessions, ${totals.sessionsUpdated} updated, ${totals.sessionsUnchanged} unchanged`,
		);
	}
	if (opts.project && totals.skillImports > 0) {
		p.log.info(
			"Imported Skills remain Project-owned references and are not pushed back as Agent Skills. Explicit `clawdi skill install <repo> --agent <type>` or `clawdi skill add <path> --agent <type>` transfers that local key to Agent authority.",
		);
	}
	p.outro(chalk.green(`✓ Pull complete — ${parts.join(", ")}`));
}

/**
 * Scan one agent against the cloud and stage explicit imports/session mirrors.
 * Prints nothing; the caller renders one combined summary.
 * Does network reads (skill listing, session paging) but writes nothing.
 */
async function scanOneAgent(
	api: ApiClient,
	agentType: AgentType,
	modules: string[],
	opts: PullOpts,
	skillsLock: SkillsLock | null,
): Promise<AgentPullScan> {
	let skillProjectId: string | null = null;
	let sharedOwnerHandle: string | null = null;
	const skills: SkillSummary[] = [];
	let skillsInSync = 0;

	if (modules.includes("skills") && skillsLock) {
		const adapter = adapterForType(agentType);
		const agentId = getEnvIdByAgent(agentType);
		const claimedLocalSkillKeys = new Set(
			agentId
				? readSkillProjectionClaimsForAgent(agentType, agentId).map((claim) => claim.skill_key)
				: [],
		);
		if (adapter && opts.project) {
			const accessToken = await api.getAccessToken();
			skillProjectId = await resolveProjectId(api.baseUrl, accessToken, opts.project);
			const project = (await listProjects(api.baseUrl, accessToken)).find(
				(p) => p.id === skillProjectId,
			);
			if (!project) {
				throw new Error("The selected Project is no longer visible.");
			}
			if (project.kind !== "workspace" && project.kind !== "personal") {
				throw new Error(
					"Skill import only accepts Custom or personal Projects; Agent Workspaces are filesystem-authoritative.",
				);
			}
			if (project.is_owner === false) {
				sharedOwnerHandle = project.owner_handle ?? null;
				if (!sharedOwnerHandle) {
					throw new Error(
						"Shared project is missing owner handle; cannot choose shared skill path.",
					);
				}
			}
		}

		if (adapter?.skills && skillProjectId) {
			for (const skill of await fetchCloudSkills(api, skillProjectId)) {
				// A Project import is unchanged only when the hash, local path, and
				// exact durable materialization marker all agree. Legacy caches are
				// download baselines, not enough to fence reverse projection.
				const cacheKey = opts.project
					? skillCacheKey(agentType, `${skillProjectId}:${skill.skill_key}`)
					: skillCacheKey(agentType, skill.skill_key);
				const cached = skillsLock.skills[cacheKey]?.hash;
				const localPath = sharedOwnerHandle
					? adapter.skills.sharedPath(skill.skill_key, sharedOwnerHandle)
					: adapter.skills.path(skill.skill_key);
				const localDirectory = sharedOwnerHandle ? localPath : dirname(localPath);
				const localSkillKey = canonicalMaterializedSkillKey(
					relative(adapter.skills.rootDir(), localDirectory),
				);
				const localExists = existsSync(localPath);
				const materializationIsExact = hasExactProjectSkillMaterialization({
					agentType,
					localSkillKey,
					sourceProjectId: skillProjectId,
					sourceSkillKey: skill.skill_key,
					contentHash: skill.content_hash,
				});
				if (
					cached === skill.content_hash &&
					localExists &&
					materializationIsExact &&
					!claimedLocalSkillKeys.has(localSkillKey)
				) {
					skillsInSync++;
				} else skills.push(skill);
			}
		}
	}

	const sessions: { remote: SessionListItem; reason: "new" | "updated" }[] = [];
	let sessionsUnchanged = 0;
	if (modules.includes("sessions")) {
		const mirrorDir = sessionMirrorDir(agentType);
		for (const remote of await fetchCloudSessions(api, agentType)) {
			const sidecar = readSidecar(mirrorDir, remote.local_session_id);
			const remoteHash = remoteSessionSyncHash(remote);
			if (!sidecar) {
				sessions.push({ remote, reason: "new" });
			} else if (!remoteHash || (sidecar.sync_hash ?? sidecar.content_hash) !== remoteHash) {
				// Null/missing remote hash → must download (legacy rows
				// pre-dating the column have nothing to compare).
				sessions.push({ remote, reason: "updated" });
			} else {
				sessionsUnchanged++;
			}
		}
	}

	return {
		agentType,
		modules: modules as (typeof DOWN_MODULES)[number][],
		skillProjectId,
		sharedOwnerHandle,
		projectQualifiedSkillCache: Boolean(opts.project),
		skills,
		skillsInSync,
		sessions,
		sessionsUnchanged,
	};
}

/** Apply one agent's explicit Skill imports and session mirrors. Mutates `skillsLock`. */
async function applyOneAgentPull(
	api: ApiClient,
	scan: AgentPullScan,
	skillsLock: SkillsLock | null,
): Promise<AgentPullResult> {
	let skillsImported = 0;
	if (scan.skills.length > 0 && scan.skillProjectId && skillsLock) {
		const adapter = adapterForType(scan.agentType);
		const skills = adapter?.skills;
		if (skills) {
			for (const skill of scan.skills) {
				const safeKey = sanitizeMetadata(skill.skill_key);
				try {
					// The explicit Cloud-owned source Project selects the import bytes.
					const tarBytes = await api.getBytes(
						`/v1/projects/${encodeURIComponent(scan.skillProjectId)}/skills/${encodeURIComponent(skill.skill_key)}/download`,
						{
							[SKILL_SYNC_PROTOCOL_HEADER]: SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
						},
					);
					const localSkillDirectory = scan.sharedOwnerHandle
						? skills.sharedPath(skill.skill_key, scan.sharedOwnerHandle)
						: dirname(skills.path(skill.skill_key));
					const localSkillKey = canonicalMaterializedSkillKey(
						relative(skills.rootDir(), localSkillDirectory),
					);
					// Persist the source authority before committing any bytes. If
					// ledger persistence fails, the Agent filesystem stays untouched;
					// if archive activation fails, retaining this fence is fail-closed.
					await commitProjectSkillMaterialization(
						{
							agentType: scan.agentType,
							localSkillKey,
							sourceProjectId: scan.skillProjectId,
							sourceSkillKey: skill.skill_key,
							contentHash: skill.content_hash,
						},
						() =>
							scan.sharedOwnerHandle
								? skills.writeSharedArchive(skill.skill_key, scan.sharedOwnerHandle, tarBytes)
								: skills.writeArchive(skill.skill_key, tarBytes),
					);
					await retireAgentProjectionClaims(api, scan.agentType, localSkillKey);
					const cacheKey = scan.projectQualifiedSkillCache
						? skillCacheKey(scan.agentType, `${scan.skillProjectId}:${skill.skill_key}`)
						: skillCacheKey(scan.agentType, skill.skill_key);
					skillsLock.skills[cacheKey] = {
						hash: skill.content_hash,
					};
					const skillDir = dirname(
						scan.sharedOwnerHandle
							? skills.sharedPath(skill.skill_key, scan.sharedOwnerHandle)
							: skills.path(skill.skill_key),
					);
					p.log.success(`${safeKey} → ${skillDir}/ (${tarBytes.length} bytes)`);
					skillsImported++;
				} catch (e) {
					p.log.warn(`${safeKey} failed: ${errMessage(e)}`);
				}
			}
		}
	}

	let sessionsNew = 0;
	let sessionsUpdated = 0;
	if (scan.sessions.length > 0) {
		const mirrorDir = sessionMirrorDir(scan.agentType);
		mkdirSync(mirrorDir, { recursive: true });
		const dlSpinner = p.spinner();
		dlSpinner.start(`Downloading content (0/${scan.sessions.length})...`);
		let failed = 0;
		for (const { remote, reason } of scan.sessions) {
			try {
				const body = await api.getSessionContent(remote.id);
				writeMirrorAtomic(mirrorDir, remote, body);
				if (reason === "new") sessionsNew++;
				else sessionsUpdated++;
				dlSpinner.message(
					`Downloading content (${sessionsNew + sessionsUpdated}/${scan.sessions.length})...`,
				);
			} catch (e) {
				failed++;
				p.log.warn(`${remote.local_session_id} failed: ${errMessage(e)}`);
			}
		}
		const done = sessionsNew + sessionsUpdated;
		dlSpinner.stop(
			failed > 0
				? `Downloaded ${done}, ${failed} failed`
				: `Downloaded ${done} session${done === 1 ? "" : "s"}`,
		);
	}

	return { skillsImported, sessionsNew, sessionsUpdated };
}

/** Complete an Agent-to-Project authority handoff using only exact claims.
 * The materialization fence is already durable before this runs, so a failed
 * delete cannot cause the Project bytes to be reverse-claimed. A surviving
 * claim remains durable retry evidence for the daemon and the next pull. */
async function retireAgentProjectionClaims(
	api: ApiClient,
	agentType: AgentType,
	localSkillKey: string,
): Promise<void> {
	const agentId = getEnvIdByAgent(agentType);
	if (!agentId) return;
	const claims = readSkillProjectionClaimsForAgent(agentType, agentId).filter(
		(claim) => claim.skill_key === localSkillKey,
	);
	for (const claim of claims) {
		await api.deleteAgentSkill(agentId, localSkillKey, claim.project_id);
		removeSkillProjectionClaim({
			agentType,
			agentId,
			projectId: claim.project_id,
			skillKey: localSkillKey,
		});
	}
}

/** Page through every cloud skill for one Project. */
async function fetchCloudSkills(api: ApiClient, projectId: string): Promise<SkillSummary[]> {
	const all: SkillSummary[] = [];
	const pageSize = 200;
	for (let page = 1; page <= 50; page++) {
		const result = unwrap(
			await api.GET("/v1/skills", {
				params: {
					query: { ...(page === 1 ? {} : { page }), page_size: pageSize, project_id: projectId },
				},
			}),
		);
		all.push(...result.items);
		if (all.length >= (result.total ?? all.length) || result.items.length === 0) return all;
	}
	throw new Error("Too many skill pages to load safely.");
}

/** Page through every cloud session for one agent. */
async function fetchCloudSessions(
	api: ApiClient,
	agentType: AgentType,
): Promise<SessionListItem[]> {
	const all: SessionListItem[] = [];
	const pageSize = 200;
	for (let page = 1; page <= 50; page++) {
		const result = unwrap(
			await api.GET("/v1/sessions", {
				params: { query: { agent: agentType, page, page_size: pageSize } },
			}),
		);
		all.push(...result.items);
		if (all.length >= (result.total ?? all.length) || result.items.length < pageSize) return all;
	}
	throw new Error("Too many session pages to pull safely.");
}

interface SessionMirrorMeta {
	id: string;
	local_session_id: string;
	agent_type: string | null;
	machine_name: string | null;
	project_path: string | null;
	started_at: string;
	ended_at: string | null;
	message_count: number;
	model: string | null;
	summary: string | null;
	content_hash: string | null;
	content_protocol?: "snapshot-v1" | "events-v1";
	sync_hash?: string | null;
}

function remoteSessionSyncHash(remote: SessionListItem): string | null {
	return remote.content_protocol === "events-v1"
		? (remote.event_head_hash ?? null)
		: (remote.content_hash ?? null);
}

function sessionMirrorDir(agentType: AgentType): string {
	return join(getClawdiDir(), "sessions", agentType);
}

function readSidecar(mirrorDir: string, localSessionId: string): SessionMirrorMeta | null {
	const path = join(mirrorDir, `${localSessionId}.meta.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SessionMirrorMeta;
	} catch {
		// Corrupt sidecar → treat as missing, force re-download.
		return null;
	}
}

function writeMirrorAtomic(mirrorDir: string, remote: SessionListItem, body: Buffer) {
	// Write to a temp path first and rename into place — keeps a half-
	// downloaded body from leaving behind a sidecar that says "I have
	// this, hash X" while the .json is corrupt or missing.
	const contentPath = join(mirrorDir, `${remote.local_session_id}.json`);
	const metaPath = join(mirrorDir, `${remote.local_session_id}.meta.json`);
	const contentTmp = `${contentPath}.tmp`;
	const metaTmp = `${metaPath}.tmp`;

	writeFileSync(contentTmp, body, { mode: 0o600 });
	const meta: SessionMirrorMeta = {
		id: remote.id,
		local_session_id: remote.local_session_id,
		agent_type: remote.agent_type,
		machine_name: remote.machine_name ?? null,
		project_path: remote.project_path,
		started_at: remote.started_at,
		ended_at: remote.ended_at,
		message_count: remote.message_count,
		model: remote.model,
		summary: remote.summary,
		content_hash: remote.content_hash ?? null,
		content_protocol: remote.content_protocol,
		sync_hash: remoteSessionSyncHash(remote),
	};
	writeFileSync(metaTmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });

	// Rename content first, then meta. If we crash between the two, the
	// next pull sees no sidecar and re-downloads — never the inverse
	// (sidecar without content) which would falsely report "synced".
	renameSync(contentTmp, contentPath);
	renameSync(metaTmp, metaPath);
}
