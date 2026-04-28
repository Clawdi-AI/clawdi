import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { type AgentType, adapterRegistry } from "../adapters/registry";
import { ApiClient, unwrap } from "../lib/api-client";
import type { SessionListItem, SkillSummary } from "../lib/api-schemas";
import { getClawdiDir, isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { askMulti, askYesNo, parseModules } from "../lib/prompts";
import { sanitizeMetadata } from "../lib/sanitize";
import { adapterForType, resolveTargetAgentTypes } from "../lib/select-adapter";
import { readSkillsLock, type SkillsLock, writeSkillsLock } from "../lib/skills-lock";

const DOWN_MODULES = [
	{ value: "skills", label: "Skills", hint: "pull skill archives to agent directories" },
	{ value: "sessions", label: "Sessions", hint: "mirror cloud sessions to ~/.clawdi/sessions/" },
];

interface PullOpts {
	modules?: string;
	dryRun?: boolean;
	agent?: string;
	allAgents?: boolean;
	yes?: boolean;
}

export async function pull(opts: PullOpts) {
	p.intro(chalk.bold("clawdi pull"));

	if (!isLoggedIn()) {
		p.log.error("Not logged in. Run `clawdi auth login` first.");
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	const targetTypes = await resolveTargetAgentTypes(opts.agent, !!opts.allAgents);
	if (targetTypes.length === 0) {
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	let modules: string[];
	if (opts.modules) {
		const parsed = parseModules(opts.modules, DOWN_MODULES);
		if (!parsed) return;
		modules = parsed;
	} else {
		const picked = await askMulti("Modules to download:", DOWN_MODULES);
		if (!picked) {
			p.outro(chalk.gray("Cancelled."));
			return;
		}
		modules = picked;
	}
	if (modules.length === 0) {
		p.outro(chalk.gray("Nothing to download."));
		return;
	}

	if (targetTypes.length > 1) {
		p.log.info(`Targets: ${targetTypes.map((t) => adapterRegistry[t].displayName).join(", ")}`);
	}

	const totals = {
		skills: 0,
		skillsAlreadyInSync: 0,
		sessionsNew: 0,
		sessionsUpdated: 0,
		sessionsUnchanged: 0,
	};
	const api = new ApiClient();
	// Read once before the loop, mutate as we go, persist once at the end —
	// matches the push-side pattern. Lost work on partial failure is safe
	// (re-running a pull is idempotent: cloud diff just kicks in again).
	const skillsLock = modules.includes("skills") ? readSkillsLock() : null;

	for (const agentType of targetTypes) {
		if (targetTypes.length > 1) {
			p.log.step(chalk.bold(`▶ ${adapterRegistry[agentType].displayName}`));
		}

		if (modules.includes("skills") && skillsLock) {
			const counts = await pullSkills(api, agentType, opts, skillsLock);
			totals.skills += counts.pulled;
			totals.skillsAlreadyInSync += counts.alreadyInSync;
		}

		if (modules.includes("sessions")) {
			const counts = await pullSessions(api, agentType, opts);
			totals.sessionsNew += counts.fresh;
			totals.sessionsUpdated += counts.updated;
			totals.sessionsUnchanged += counts.unchanged;
		}
	}

	if (!opts.dryRun && skillsLock) writeSkillsLock(skillsLock);

	if (opts.dryRun) {
		p.outro(chalk.gray("Dry run complete."));
		return;
	}

	const parts: string[] = [];
	if (modules.includes("skills")) {
		const skillsLabel =
			totals.skillsAlreadyInSync > 0
				? `${totals.skills} skill${totals.skills === 1 ? "" : "s"} downloaded, ${totals.skillsAlreadyInSync} already in sync`
				: `${totals.skills} skill${totals.skills === 1 ? "" : "s"}`;
		parts.push(skillsLabel);
	}
	if (modules.includes("sessions")) {
		parts.push(
			`${totals.sessionsNew} new sessions, ${totals.sessionsUpdated} updated, ${totals.sessionsUnchanged} unchanged`,
		);
	}
	p.outro(chalk.green(`✓ Pull complete — ${parts.join(", ")}`));
}

interface SkillPullCounts {
	pulled: number;
	alreadyInSync: number;
}

async function pullSkills(
	api: ApiClient,
	agentType: AgentType,
	opts: PullOpts,
	skillsLock: SkillsLock,
): Promise<SkillPullCounts> {
	const adapter = adapterForType(agentType);
	if (!adapter) return { pulled: 0, alreadyInSync: 0 };

	const fetchSpinner = p.spinner();
	fetchSpinner.start("Fetching skills...");
	const page = unwrap(await api.GET("/api/skills", { params: { query: { page_size: 200 } } }));
	const cloudSkills: SkillSummary[] = page.items;
	fetchSpinner.stop(
		`Found ${cloudSkills.length} skill${cloudSkills.length === 1 ? "" : "s"} in cloud`,
	);

	if (cloudSkills.length === 0) return { pulled: 0, alreadyInSync: 0 };

	// Diff: a skill is "in sync" iff its cloud `content_hash` matches our
	// cached hash AND we have a local file for it. The local-file check
	// catches the case where the user wiped `~/.claude/skills/` but kept
	// the lock file — we'd otherwise silently skip and never restore.
	const toDownload: SkillSummary[] = [];
	let alreadyInSync = 0;
	for (const skill of cloudSkills) {
		const cached = skillsLock.skills[skill.skill_key]?.hash;
		const localExists = existsSync(adapter.getSkillPath(skill.skill_key));
		if (cached && cached === skill.content_hash && localExists) {
			alreadyInSync++;
			continue;
		}
		toDownload.push(skill);
	}

	const newCount = toDownload.filter((s) => !existsSync(adapter.getSkillPath(s.skill_key))).length;
	const updatedCount = toDownload.length - newCount;
	p.log.message(
		chalk.gray(`${newCount} new, ${updatedCount} updated, ${alreadyInSync} already in sync`),
	);

	if (opts.dryRun || toDownload.length === 0) return { pulled: 0, alreadyInSync };

	if (!opts.yes) {
		const ok = await askYesNo("Proceed with skill download?");
		if (!ok) return { pulled: 0, alreadyInSync };
	}

	let pulled = 0;
	for (const skill of toDownload) {
		const safeKey = sanitizeMetadata(skill.skill_key);
		const dest = adapter.getSkillPath(skill.skill_key);
		if (existsSync(dest) && !opts.yes) {
			const overwrite = await askYesNo(`${safeKey} already exists. Overwrite?`, false);
			if (!overwrite) {
				p.log.info(`${safeKey} skipped`);
				continue;
			}
		}

		try {
			const tarBytes = await api.getBytes(`/api/skills/${skill.skill_key}/download`);
			await adapter.writeSkillArchive(skill.skill_key, tarBytes);
			skillsLock.skills[skill.skill_key] = { hash: skill.content_hash };
			const skillDir = dirname(adapter.getSkillPath(skill.skill_key));
			p.log.success(`${safeKey} → ${skillDir}/ (${tarBytes.length} bytes)`);
			pulled++;
		} catch (e) {
			p.log.warn(`${safeKey} failed: ${errMessage(e)}`);
		}
	}
	return { pulled, alreadyInSync };
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

interface SessionPullCounts {
	fresh: number;
	updated: number;
	unchanged: number;
}

async function pullSessions(
	api: ApiClient,
	agentType: AgentType,
	opts: PullOpts,
): Promise<SessionPullCounts> {
	// Page through every session for this agent. Server side already sorts
	// by started_at desc; order doesn't matter for our diff anyway.
	const cloudSessions: SessionListItem[] = [];
	const fetchSpinner = p.spinner();
	fetchSpinner.start(`Fetching ${adapterRegistry[agentType].displayName} sessions...`);
	let page = 1;
	const pageSize = 200;
	for (;;) {
		const result = unwrap(
			await api.GET("/api/sessions", {
				params: { query: { agent: agentType, page, page_size: pageSize } },
			}),
		);
		cloudSessions.push(...result.items);
		if (result.items.length < pageSize) break;
		page++;
	}
	fetchSpinner.stop(
		`Found ${cloudSessions.length} session${cloudSessions.length === 1 ? "" : "s"} in cloud`,
	);

	const mirrorDir = sessionMirrorDir(agentType);

	const toDownload: { remote: SessionListItem; reason: "new" | "updated" }[] = [];
	let unchanged = 0;
	for (const remote of cloudSessions) {
		const sidecar = readSidecar(mirrorDir, remote.local_session_id);
		if (!sidecar) {
			toDownload.push({ remote, reason: "new" });
			continue;
		}
		// Treat null/missing remote hash as "must download" — legacy rows
		// pre-dating the column have no way to compare.
		if (!remote.content_hash || sidecar.content_hash !== remote.content_hash) {
			toDownload.push({ remote, reason: "updated" });
			continue;
		}
		unchanged++;
	}

	const fresh = toDownload.filter((d) => d.reason === "new").length;
	const updated = toDownload.length - fresh;
	p.log.message(chalk.gray(`${fresh} new, ${updated} updated, ${unchanged} unchanged`));

	if (opts.dryRun || toDownload.length === 0) {
		return { fresh, updated, unchanged };
	}

	if (!opts.yes) {
		const ok = await askYesNo(
			`Download ${toDownload.length} session${toDownload.length === 1 ? "" : "s"}?`,
		);
		if (!ok) {
			// Cancelled — report only what's actually in sync. The pending
			// downloads stay pending; counting them as "unchanged" would lie.
			return { fresh: 0, updated: 0, unchanged };
		}
	}

	mkdirSync(mirrorDir, { recursive: true });

	const dlSpinner = p.spinner();
	dlSpinner.start(`Downloading content (0/${toDownload.length})...`);
	let freshDone = 0;
	let updatedDone = 0;
	let failed = 0;
	for (const { remote, reason } of toDownload) {
		try {
			const body = await api.getSessionContent(remote.id);
			writeMirrorAtomic(mirrorDir, remote, body);
			if (reason === "new") freshDone++;
			else updatedDone++;
			dlSpinner.message(`Downloading content (${freshDone + updatedDone}/${toDownload.length})...`);
		} catch (e) {
			failed++;
			p.log.warn(`${remote.local_session_id} failed: ${errMessage(e)}`);
		}
	}
	const done = freshDone + updatedDone;
	dlSpinner.stop(
		failed > 0
			? `Downloaded ${done}, ${failed} failed`
			: `Downloaded ${done} session${done === 1 ? "" : "s"}`,
	);

	return { fresh: freshDone, updated: updatedDone, unchanged };
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
