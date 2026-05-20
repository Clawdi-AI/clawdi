import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import {
	adapterForType,
	fetchProjectIdForEnv,
	getEnvIdByAgent,
	resolveTargetAgentTypes,
} from "../lib/select-adapter";
import {
	readSkillsLock,
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
	yes?: boolean;
}

/**
 * What `scanOneAgent` found for a single agent: the skills and sessions
 * staged for download. Splitting scan from download lets `pull` show a
 * combined, per-agent summary across every target agent and ask for ONE
 * confirmation — the same shape as `clawdi push`.
 */
interface AgentPullScan {
	agentType: AgentType;
	/** Project to download skills from; null when skills aren't being
	 * pulled or the agent has no registered environment. */
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
	/** Per-agent advisories rendered under the agent in the summary. */
	notes: string[];
}

/** What `downloadOneAgent` actually pulled for a single agent. */
interface AgentPullResult {
	skillsPulled: number;
	sessionsNew: number;
	sessionsUpdated: number;
}

/** Whether a scan turned up anything to actually download. */
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

	// Module default: when --modules is omitted, take every module —
	// no multi-select prompt to block an agent harness on.
	const modules = parseModules(opts.modules, DOWN_MODULES);
	if (!modules) return;

	if (opts.project && modules.includes("sessions")) {
		p.log.error("--project is supported for skill pulls only. Use --modules skills.");
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	const api = new ApiClient();
	// Read once before the loop, mutate as downloads land, persist once at
	// the end. Lost work on partial failure is safe — re-running a pull is
	// idempotent (the cloud diff just kicks in again).
	const skillsLock = modules.includes("skills") ? readSkillsLock() : null;

	// Scan every agent first — one spinner, one combined summary — so a
	// multi-agent pull reads as a single scan, matching `clawdi push`.
	const scanSpinner = p.spinner();
	scanSpinner.start(
		`Scanning ${targetTypes.length} agent${targetTypes.length === 1 ? "" : "s"}...`,
	);
	const scans: AgentPullScan[] = [];
	try {
		for (const agentType of targetTypes) {
			scans.push(await scanOneAgent(api, agentType, modules, opts, skillsLock));
		}
	} catch (e) {
		scanSpinner.stop("Scan failed.");
		throw e;
	}
	scanSpinner.stop("Scan complete.");

	// Combined per-agent summary, visible in full before the confirmation.
	for (const scan of scans) {
		const name = adapterRegistry[scan.agentType].displayName;
		const bits: string[] = [];
		if (modules.includes("skills")) {
			const sync = scan.skillsInSync > 0 ? ` (${scan.skillsInSync} in sync)` : "";
			bits.push(`${scan.skills.length} skill${scan.skills.length === 1 ? "" : "s"}${sync}`);
		}
		if (modules.includes("sessions")) {
			const sync = scan.sessionsUnchanged > 0 ? ` (${scan.sessionsUnchanged} unchanged)` : "";
			bits.push(`${scan.sessions.length} session${scan.sessions.length === 1 ? "" : "s"}${sync}`);
		}
		p.log.message(`${chalk.bold(name)} — ${bits.join(", ")} to download`);
		for (const note of scan.notes) {
			p.log.message(chalk.gray(`  ${note}`));
		}
	}

	const toDownload = scans.filter(scanHasWork);

	if (opts.dryRun) {
		p.outro(
			chalk.gray(
				toDownload.length > 0
					? "Dry run complete."
					: "Dry run — nothing to pull, everything already in sync.",
			),
		);
		return;
	}

	const totals = {
		skills: 0,
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
		// Header only when more than one agent actually downloads.
		if (toDownload.length > 1) {
			p.log.step(chalk.bold(`▶ ${adapterRegistry[scan.agentType].displayName}`));
		}
		const result = await downloadOneAgent(api, scan, skillsLock);
		totals.skills += result.skillsPulled;
		totals.sessionsNew += result.sessionsNew;
		totals.sessionsUpdated += result.sessionsUpdated;
	}

	if (skillsLock) writeSkillsLock(skillsLock);

	const parts: string[] = [];
	if (modules.includes("skills")) {
		parts.push(
			totals.skillsInSync > 0
				? `${totals.skills} skill${totals.skills === 1 ? "" : "s"} downloaded, ${totals.skillsInSync} already in sync`
				: `${totals.skills} skill${totals.skills === 1 ? "" : "s"}`,
		);
	}
	if (modules.includes("sessions")) {
		parts.push(
			`${totals.sessionsNew} new sessions, ${totals.sessionsUpdated} updated, ${totals.sessionsUnchanged} unchanged`,
		);
	}
	p.outro(chalk.green(`✓ Pull complete — ${parts.join(", ")}`));
}

/**
 * Scan one agent against the cloud and stage what would be downloaded.
 * Prints nothing — advisories go into `notes` for the combined summary.
 * Does network reads (skill listing, session paging) but writes nothing.
 */
async function scanOneAgent(
	api: ApiClient,
	agentType: AgentType,
	modules: string[],
	opts: PullOpts,
	skillsLock: SkillsLock | null,
): Promise<AgentPullScan> {
	const notes: string[] = [];
	let skillProjectId: string | null = null;
	let sharedOwnerHandle: string | null = null;
	const skills: SkillSummary[] = [];
	let skillsInSync = 0;

	if (modules.includes("skills") && skillsLock) {
		const adapter = adapterForType(agentType);
		if (adapter && opts.project) {
			skillProjectId = await resolveProjectId(api.baseUrl, api.apiKey, opts.project);
			const project = (await listProjects(api.baseUrl, api.apiKey)).find(
				(p) => p.id === skillProjectId,
			);
			if (project?.is_owner === false) {
				sharedOwnerHandle = project.owner_handle ?? null;
				if (!sharedOwnerHandle) {
					throw new Error(
						"Shared project is missing owner handle; cannot choose shared skill path.",
					);
				}
			}
		} else if (adapter) {
			const envId = getEnvIdByAgent(agentType);
			if (!envId) {
				// Sessions still pull fine (they query by agent type), but
				// skills need the env's Agent Project — skip them with a notice.
				notes.push("No environment registered — skipping skills. Run `clawdi setup`.");
			} else {
				// Resolve THIS agent's project so a multi-agent account doesn't
				// install sibling-agent skills into this adapter's directory.
				skillProjectId = await fetchProjectIdForEnv(api, envId);
			}
		}

		if (adapter && skillProjectId) {
			for (const skill of await fetchCloudSkills(api, skillProjectId)) {
				// A skill is "in sync" iff its cloud content_hash matches
				// our cached hash AND a local file exists — the local
				// check restores skills the user wiped but kept the lock.
				const cacheKey = opts.project
					? skillCacheKey(agentType, `${skillProjectId}:${skill.skill_key}`)
					: skillCacheKey(agentType, skill.skill_key);
				const cached = skillsLock.skills[cacheKey]?.hash;
				const localPath = sharedOwnerHandle
					? adapter.getSharedSkillPath(skill.skill_key, sharedOwnerHandle)
					: adapter.getSkillPath(skill.skill_key);
				const localExists = existsSync(localPath);
				if (cached && cached === skill.content_hash && localExists) skillsInSync++;
				else skills.push(skill);
			}
		}
	}

	const sessions: { remote: SessionListItem; reason: "new" | "updated" }[] = [];
	let sessionsUnchanged = 0;
	if (modules.includes("sessions")) {
		const mirrorDir = sessionMirrorDir(agentType);
		for (const remote of await fetchCloudSessions(api, agentType)) {
			const sidecar = readSidecar(mirrorDir, remote.local_session_id);
			if (!sidecar) {
				sessions.push({ remote, reason: "new" });
			} else if (!remote.content_hash || sidecar.content_hash !== remote.content_hash) {
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
		skillProjectId,
		sharedOwnerHandle,
		projectQualifiedSkillCache: Boolean(opts.project),
		skills,
		skillsInSync,
		sessions,
		sessionsUnchanged,
		notes,
	};
}

/** Download one agent's scanned skills + sessions. Mutates `skillsLock`. */
async function downloadOneAgent(
	api: ApiClient,
	scan: AgentPullScan,
	skillsLock: SkillsLock | null,
): Promise<AgentPullResult> {
	let skillsPulled = 0;
	if (scan.skills.length > 0 && scan.skillProjectId && skillsLock) {
		const adapter = adapterForType(scan.agentType);
		if (adapter) {
			for (const skill of scan.skills) {
				const safeKey = sanitizeMetadata(skill.skill_key);
				try {
					// Project-explicit download so duplicate skill_keys across
					// projects resolve to the right bytes for THIS agent.
					const tarBytes = await api.getBytes(
						`/api/projects/${encodeURIComponent(scan.skillProjectId)}/skills/${encodeURIComponent(skill.skill_key)}/download`,
					);
					if (scan.sharedOwnerHandle) {
						await adapter.writeSharedSkillArchive(
							skill.skill_key,
							scan.sharedOwnerHandle,
							tarBytes,
						);
					} else {
						await adapter.writeSkillArchive(skill.skill_key, tarBytes);
					}
					const cacheKey = scan.projectQualifiedSkillCache
						? skillCacheKey(scan.agentType, `${scan.skillProjectId}:${skill.skill_key}`)
						: skillCacheKey(scan.agentType, skill.skill_key);
					skillsLock.skills[cacheKey] = {
						hash: skill.content_hash,
					};
					const skillDir = dirname(
						scan.sharedOwnerHandle
							? adapter.getSharedSkillPath(skill.skill_key, scan.sharedOwnerHandle)
							: adapter.getSkillPath(skill.skill_key),
					);
					p.log.success(`${safeKey} → ${skillDir}/ (${tarBytes.length} bytes)`);
					skillsPulled++;
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

	return { skillsPulled, sessionsNew, sessionsUpdated };
}

/** Page through every cloud skill for one Project. */
async function fetchCloudSkills(api: ApiClient, projectId: string): Promise<SkillSummary[]> {
	const all: SkillSummary[] = [];
	const pageSize = 200;
	for (let page = 1; page <= 50; page++) {
		const result = unwrap(
			await api.GET("/api/skills", {
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
	for (let page = 1; ; page++) {
		const result = unwrap(
			await api.GET("/api/sessions", {
				params: { query: { agent: agentType, page, page_size: pageSize } },
			}),
		);
		all.push(...result.items);
		if (result.items.length < pageSize) break;
	}
	return all;
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
	};
	writeFileSync(metaTmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });

	// Rename content first, then meta. If we crash between the two, the
	// next pull sees no sidecar and re-downloads — never the inverse
	// (sidecar without content) which would falsely report "synced".
	renameSync(contentTmp, contentPath);
	renameSync(metaTmp, metaPath);
}
