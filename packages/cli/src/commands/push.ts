import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import type { AgentAdapter, RawSession, RawSkill } from "../adapters/base";
import { type AgentType, adapterRegistry } from "../adapters/registry";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { sha256Hex } from "../lib/hash";
import { parseModules } from "../lib/prompts";
import {
	adapterForType,
	fetchProjectIdForEnv,
	getEnvIdByAgent,
	resolveTargetAgentTypes,
} from "../lib/select-adapter";
import { computeLastActivityIso } from "../lib/session-activity";
import {
	cacheKey,
	readSessionsLock,
	type SessionsLock,
	writeSessionsLock,
} from "../lib/sessions-lock";
import { isValidSkillKey } from "../lib/skill-key";
import {
	computeSkillFolderHash,
	readSkillsLock,
	type SkillsLock,
	skillCacheKey,
	writeSkillsLock,
} from "../lib/skills-lock";
import { type ModuleState, readModuleState, writeModuleState } from "../lib/state";
import { tarSkillDir } from "../lib/tar";

const RESETUP_HINT =
	"This machine's environment is no longer registered. Run `clawdi setup` again.";

const UP_MODULES = ["sessions", "skills"] as const;

interface PushOpts {
	modules?: string;
	project?: string;
	excludeProject?: string[];
	all?: boolean;
	allAgents?: boolean;
	dryRun?: boolean;
	agent?: string;
}

/** What `uploadOneAgent` actually pushed for a single agent. */
interface AgentUploadResult {
	sessionsCreated: number;
	sessionsUpdated: number;
	sessionsUnchanged: number;
	contentUploaded: number;
	skillsPushed: number;
}

/**
 * What `scanOneAgent` found for a single agent: the sessions and skills
 * staged for upload. Splitting scan from upload lets `push` show a
 * combined, per-agent summary across every target agent before uploading,
 * instead of interleaving scan and upload per agent (which made a multi-agent
 * `clawdi push` look like it had only picked the first agent).
 */
interface AgentScanResult {
	agentType: AgentType;
	envId: string | null;
	sessions: RawSession[];
	skills: RawSkill[];
	sessionsCacheSkipped: number;
	skillsCacheSkipped: number;
	/** Per-agent advisories (hermes filter notice, first-run hint,
	 * exclusion summary) — collected during the scan and rendered
	 * under the agent in the unified summary instead of being printed
	 * mid-scan, so the scan reads as one operation across all agents. */
	notes: string[];
}

/** Whether a scan turned up anything to actually upload. */
function scanHasWork(scan: AgentScanResult): boolean {
	return scan.sessions.length > 0 || scan.skills.length > 0;
}

export async function push(opts: PushOpts) {
	p.intro(chalk.bold("clawdi push"));

	if (!opts.dryRun && !isLoggedIn()) {
		p.log.error("Not logged in. Run `clawdi auth login` first.");
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	if (opts.project && opts.excludeProject && opts.excludeProject.length > 0) {
		p.log.error(
			"--project and --exclude-project cannot be combined (--project is positive selection, --exclude-project is subtractive).",
		);
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	// `--all` widens every axis it can. Explicit narrowing flags
	// (--agent, --modules, --project, --exclude-project) still win
	// per-axis — `--all --agent codex` means "all modules, all
	// projects, but only codex".
	if (opts.all && !opts.agent && !opts.allAgents) {
		opts.allAgents = true;
	}

	const targetTypes = await resolveTargetAgentTypes(opts.agent, !!opts.allAgents);
	if (targetTypes.length === 0) {
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	// Module default: when --modules is omitted, take every module.
	// `parseModules(undefined, …)` already returns the full list — no
	// multi-select prompt to block an agent harness on.
	const modules = parseModules(opts.modules, UP_MODULES);
	if (!modules) return;

	const moduleState = readModuleState();
	const sessionsLock = readSessionsLock();
	const skillsLock = readSkillsLock();

	// Project selection is agent-independent (derived only from flags), so
	// resolve it once and report it once — not per agent.
	const projectFilter = opts.project ?? (opts.all ? undefined : process.cwd());
	if (modules.includes("sessions")) {
		const target = projectFilter ? `project ${projectFilter}` : "all projects";
		p.log.info(chalk.gray(`Scanning ${target}`));
	}

	// Scan every agent first — one spinner, one combined summary — so a
	// multi-agent push reads as a single scan, not a per-agent block
	// sequence that looks like only the first agent was picked.
	const scanSpinner = p.spinner();
	scanSpinner.start(
		`Scanning ${targetTypes.length} agent${targetTypes.length === 1 ? "" : "s"}...`,
	);
	const scans: AgentScanResult[] = [];
	let scanError: string | null = null;
	try {
		for (const agentType of targetTypes) {
			const adapter = adapterForType(agentType);
			if (!adapter) continue;
			const scan = await scanOneAgent(
				adapter,
				modules,
				opts,
				projectFilter,
				sessionsLock,
				skillsLock,
			);
			if ("error" in scan) {
				scanError = scan.error;
				break;
			}
			scans.push(scan);
		}
	} catch (e) {
		// A genuine throw (adapter scan / skill hashing failed) — stop the
		// spinner before the error bubbles to `handleError`.
		scanSpinner.stop("Scan failed.");
		throw e;
	}
	scanSpinner.stop(scanError ? "Scan failed." : "Scan complete.");

	if (scanError) {
		// Scan phase mutates no caches — nothing to persist.
		p.log.error(scanError);
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	// Combined per-agent summary: every target agent, its counts, and
	// any advisories — visible in full before uploads begin.
	for (const scan of scans) {
		const name = adapterRegistry[scan.agentType].displayName;
		const bits: string[] = [];
		if (modules.includes("sessions")) {
			const sync = scan.sessionsCacheSkipped > 0 ? ` (${scan.sessionsCacheSkipped} in sync)` : "";
			bits.push(`${scan.sessions.length} session${scan.sessions.length === 1 ? "" : "s"}${sync}`);
		}
		if (modules.includes("skills")) {
			const sync = scan.skillsCacheSkipped > 0 ? ` (${scan.skillsCacheSkipped} in sync)` : "";
			bits.push(`${scan.skills.length} skill${scan.skills.length === 1 ? "" : "s"}${sync}`);
		}
		p.log.message(`${chalk.bold(name)} — ${bits.join(", ")} to upload`);
		for (const note of scan.notes) {
			p.log.message(chalk.gray(`  ${note}`));
		}
	}

	const toUpload = scans.filter(scanHasWork);

	if (opts.dryRun) {
		p.outro(
			chalk.gray(
				toUpload.length > 0
					? "Dry run complete."
					: "Dry run — nothing to push, everything already in sync.",
			),
		);
		return;
	}

	const totals = {
		cacheSkipped: 0,
		created: 0,
		updated: 0,
		unchanged: 0,
		content: 0,
		skillsCacheSkipped: 0,
		skills: 0,
	};
	let aborted = false;
	for (const scan of scans) {
		// Cache-skip counts are scan facts — fold them in regardless of
		// whether this agent goes on to upload anything.
		totals.cacheSkipped += scan.sessionsCacheSkipped;
		totals.skillsCacheSkipped += scan.skillsCacheSkipped;
		if (!scanHasWork(scan)) continue;
		// Header only when more than one agent actually uploads — a
		// lone upload block needs no disambiguating label.
		if (toUpload.length > 1) {
			p.log.step(chalk.bold(`▶ ${adapterRegistry[scan.agentType].displayName}`));
		}
		const result = await uploadOneAgent(scan, moduleState, sessionsLock, skillsLock);
		if (result === "aborted") {
			aborted = true;
			break;
		}
		totals.created += result.sessionsCreated;
		totals.updated += result.sessionsUpdated;
		totals.unchanged += result.sessionsUnchanged;
		totals.content += result.contentUploaded;
		totals.skills += result.skillsPushed;
	}

	writeModuleState(moduleState);
	// Persist content-hash caches once per push command, even if the
	// loop aborted partway — entries we mutated for successful agents
	// are still valid and would otherwise be lost on the next push.
	writeSessionsLock(sessionsLock);
	writeSkillsLock(skillsLock);

	if (aborted) {
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	const parts: string[] = [];
	if (modules.includes("sessions")) {
		// Merge `cacheSkipped` into `unchanged` for display — they mean the
		// same thing to the user ("this session didn't need any work"). The
		// distinction (client cache hit vs. server hash match) is purely an
		// internal perf metric and only confuses non-technical users.
		const unchangedTotal = totals.cacheSkipped + totals.unchanged;
		parts.push(`${totals.created} new, ${totals.updated} updated, ${unchangedTotal} unchanged`);
		parts.push(`${totals.content} content upload${totals.content === 1 ? "" : "s"}`);
	}
	if (modules.includes("skills")) {
		const skillsLabel =
			totals.skillsCacheSkipped > 0
				? `${totals.skills} skill${totals.skills === 1 ? "" : "s"} uploaded, ${totals.skillsCacheSkipped} already in sync`
				: `${totals.skills} skill${totals.skills === 1 ? "" : "s"}`;
		parts.push(skillsLabel);
	}
	parts.push(`across ${targetTypes.length} agent${targetTypes.length === 1 ? "" : "s"}`);
	p.outro(chalk.green(`✓ Push complete — ${parts.join(", ")}`));
}

/**
 * Scan one agent's local data and stage what would be uploaded. Prints
 * nothing and mutates nothing (no cache writes, no network writes —
 * only reads the sessions-lock to diff). Advisories go into the
 * returned `notes` so the caller can render one combined summary
 * across every agent. Returns `{ error }` on an unrecoverable env
 * problem so the caller can surface it after stopping the scan spinner.
 */
async function scanOneAgent(
	adapter: AgentAdapter,
	modules: string[],
	opts: PushOpts,
	projectFilter: string | undefined,
	sessionsLock: SessionsLock,
	skillsLock: SkillsLock,
): Promise<AgentScanResult | { error: string }> {
	const agentType = adapter.agentType;
	const envId = getEnvIdByAgent(agentType);
	// True when `projectFilter` came from the cwd default rather than an
	// explicit --project — drives whether "--all" is a useful hint.
	const usedCwdDefault = !opts.all && !opts.project;

	if (!opts.dryRun && !envId) {
		return {
			error: `No environment registered for ${adapterRegistry[agentType].displayName}. Run \`clawdi setup\` first.`,
		};
	}

	// Probe the cached env_id before doing any local work. The CLI keeps a
	// per-agent file under ~/.clawdi/environments/, but the corresponding row
	// can disappear server-side (account switch, prod reset, env teardown).
	// Catching that here means the user runs `clawdi setup` once and is back
	// in business — instead of pushing 60 sessions that all show up as
	// "Unknown" in the dashboard.
	if (!opts.dryRun && envId) {
		const probe = new ApiClient();
		try {
			const res = await probe.GET("/v1/agents/{agent_id}", {
				params: { path: { agent_id: envId } },
			});
			if (res.error || !res.data) {
				const status = res.response?.status ?? 0;
				if (status === 404) return { error: RESETUP_HINT };
				// Anything else (401, network, 5xx) — let the actual upload bubble
				// up the proper error; don't double-report here.
			}
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) return { error: RESETUP_HINT };
			// Same reasoning as above — fall through and let upload surface it.
		}
	}

	const notes: string[] = [];
	const excludeSet = new Set<string>(
		(opts.excludeProject ?? []).map((path) => normalizeProject(path)),
	);

	if (agentType === "hermes" && modules.includes("sessions") && projectFilter !== undefined) {
		// `--all` (alone) clears projectFilter, so suggesting it only
		// helps when the filter came from the cwd default.
		notes.push(
			usedCwdDefault
				? "Hermes ignores project filters — pushing all sessions. Use --all to suppress."
				: "Hermes ignores project filters — pushing all sessions.",
		);
	}

	let sessions: RawSession[] = [];
	const skills: RawSkill[] = [];
	let skillsCacheSkipped = 0;
	if (modules.includes("sessions")) {
		// `collectSessions` also reports a `dedupedCount` (resume chains it
		// collapsed). That's internal housekeeping — not actionable and not
		// perceptible to the user — so it isn't surfaced.
		sessions = (await adapter.collectSessions({ projectFilter })).sessions;
	}
	if (modules.includes("skills")) {
		// Hash each skill's file tree and diff against the skills-lock here,
		// in the scan — the same per-entity cache check sessions get below —
		// so the summary's skill count reflects what will actually upload.
		let invalidSkillCount = 0;
		for (const skill of await adapter.collectSkills()) {
			if (!isValidSkillKey(skill.skillKey)) {
				invalidSkillCount++;
				continue;
			}
			skill.contentHash = await computeSkillFolderHash(skill.directoryPath);
			const cached = skillsLock.skills[skillCacheKey(agentType, skill.skillKey)]?.hash;
			if (cached === skill.contentHash) skillsCacheSkipped++;
			else skills.push(skill);
		}
		if (invalidSkillCount > 0) {
			notes.push(
				`Skipped ${invalidSkillCount} skill ${invalidSkillCount === 1 ? "directory" : "directories"} with invalid names. Rename local skill directories to letters, numbers, dot, underscore, hyphen, or up to 4 slash-separated components.`,
			);
		}
	}

	// Fingerprint each session's content. The server's batch endpoint
	// compares this against the stored `content_hash` to decide whether
	// the body needs reupload, so we hash exactly the bytes we'd send.
	for (const s of sessions) {
		s.contentHash = sha256Hex(JSON.stringify(s.messages));
	}

	// Apply --exclude-project after scan. Exact-equality match on normalized
	// absolute paths — `~/work` does NOT exclude `~/work/foo` (users say what
	// they mean; prefix-match would silently drop sibling repos).
	if (excludeSet.size > 0 && sessions.length > 0) {
		const before = sessions.length;
		const matchedExcludes = new Set<string>();
		sessions = sessions.filter((s) => {
			if (!s.projectPath) return true;
			const normalized = normalizeProject(s.projectPath);
			if (excludeSet.has(normalized)) {
				matchedExcludes.add(normalized);
				return false;
			}
			return true;
		});
		const removed = before - sessions.length;
		if (removed > 0) {
			notes.push(
				`Excluded ${removed} session${removed === 1 ? "" : "s"} from ${matchedExcludes.size} project${matchedExcludes.size === 1 ? "" : "s"}.`,
			);
		}
		for (const requested of excludeSet) {
			if (!matchedExcludes.has(requested)) {
				notes.push(`--exclude-project ${requested} matched no local sessions; ignored.`);
			}
		}
	}

	// Filter against the sessions-lock cache: any session whose hash matches
	// the stored value can be skipped — the server already has it. This is
	// the per-entity diff that replaces the old global mtime cursor; project
	// filters can't pollute it because each session has its own entry.
	let sessionsCacheSkipped = 0;
	if (modules.includes("sessions")) {
		const before = sessions.length;
		sessions = sessions.filter((s) => {
			const cached = sessionsLock.sessions[cacheKey(agentType, s.localSessionId)];
			return cached?.hash !== s.contentHash;
		});
		sessionsCacheSkipped = before - sessions.length;
	}

	// Guidance when nothing matched at all.
	if (modules.includes("sessions") && sessions.length === 0 && sessionsCacheSkipped === 0) {
		const isFirstRun = !Object.keys(sessionsLock.sessions).some((k) =>
			k.startsWith(`${agentType}:`),
		);
		if (excludeSet.size > 0) {
			notes.push("Nothing left to push after exclusions.");
		} else if (usedCwdDefault && isFirstRun) {
			notes.push(
				`No sessions in ${process.cwd()} — looks like a first run. Use --all to scan every project.`,
			);
		} else if (projectFilter) {
			// Don't suggest --all if the user already passed it (explicit
			// --project alongside --all): --all wouldn't widen anything,
			// the project just didn't match.
			notes.push(
				opts.all
					? "No sessions matched that project — check the --project path."
					: "No sessions matched. Use --all to scan every project, or --project <abs-path>.",
			);
		}
	}

	return { agentType, envId, sessions, skills, sessionsCacheSkipped, skillsCacheSkipped, notes };
}

/**
 * Upload one agent's scanned data. Mutates `moduleState` and both lock
 * caches as uploads land. Returns "aborted" if the server reports the
 * environment vanished mid-batch.
 */
async function uploadOneAgent(
	scan: AgentScanResult,
	moduleState: ModuleState,
	sessionsLock: SessionsLock,
	skillsLock: SkillsLock,
): Promise<AgentUploadResult | "aborted"> {
	const { agentType, envId, sessions, skills } = scan;

	if (!envId) {
		p.log.error("Environment id missing — rerun `clawdi setup`.");
		return "aborted";
	}

	const api = new ApiClient();
	let sessionsCreated = 0;
	let sessionsUpdated = 0;
	let sessionsUnchanged = 0;
	let contentUploaded = 0;
	let skillsPushed = 0;

	if (sessions.length > 0) {
		const sessionSpinner = p.spinner();
		sessionSpinner.start(
			`Uploading metadata for ${sessions.length} session${sessions.length === 1 ? "" : "s"}...`,
		);
		const needsContent: Set<string> = new Set();
		const rejectedIds: Set<string> = new Set();
		// Chunk sessions into batches that fit under PostgreSQL's
		// 32767 bound-parameters-per-query limit. The server upsert
		// builds a single multi-VALUES INSERT with ~17 columns per
		// row; in prod we observed
		// `sqlalchemy.exc.InterfaceError: ... query arguments cannot
		// exceed 32767` 500-ing this endpoint when a heavy user's
		// initial backfill shipped 1900+ sessions in one body.
		// Schema-side cap (max_length=500 on SessionBatchRequest)
		// gives the same protection as defense-in-depth.
		const SESSION_BATCH_CHUNK = 500;
		try {
			for (let offset = 0; offset < sessions.length; offset += SESSION_BATCH_CHUNK) {
				const chunk = sessions.slice(offset, offset + SESSION_BATCH_CHUNK);
				const result = unwrap(
					await api.POST("/v1/sessions/batch", {
						body: {
							sessions: chunk.map((s) => ({
								environment_id: envId,
								local_session_id: s.localSessionId,
								project_path: s.projectPath,
								started_at: s.startedAt.toISOString(),
								ended_at: s.endedAt?.toISOString() ?? null,
								last_activity_at: computeLastActivityIso(s),
								duration_seconds: s.durationSeconds,
								message_count: s.messageCount,
								input_tokens: s.inputTokens,
								output_tokens: s.outputTokens,
								cache_read_tokens: s.cacheReadTokens,
								model: s.model,
								models_used: s.modelsUsed,
								summary: s.summary,
								status: "completed",
								content_hash: s.contentHash ?? null,
							})),
						},
					}),
				);
				for (const id of result.needs_content) needsContent.add(id);
				sessionsCreated += result.created;
				sessionsUpdated += result.updated;
				sessionsUnchanged += result.unchanged;
				// Server flagged these ids as cross-env race casualties
				// (see SessionBatchResponse.rejected). They are NOT
				// synced; the caller must skip the lock-write step
				// below so the next push retries. Pre-fix the absence
				// from `needs_content` looked like success and we
				// wrote a stale lock.
				for (const id of result.rejected ?? []) rejectedIds.add(id);
			}
			if (rejectedIds.size > 0) {
				p.log.warn(
					`${rejectedIds.size} session${rejectedIds.size === 1 ? "" : "s"} rejected by server (cross-env race) — will retry on next push`,
				);
			}
			sessionSpinner.stop(
				`Metadata: ${sessionsCreated} new, ${sessionsUpdated} updated, ${sessionsUnchanged} unchanged`,
			);
		} catch (e) {
			sessionSpinner.stop("Session metadata upload failed.");
			// Translate the backend's "unknown_environment" 400 into the same
			// re-setup hint the up-front probe uses. The probe catches the
			// common case; this catches a race where the env was deleted
			// between probe and batch.
			if (e instanceof ApiError && e.status === 400 && e.body.includes("unknown_environment")) {
				p.log.error(RESETUP_HINT);
				return "aborted";
			}
			throw e;
		}

		// Track which uploads actually landed bytes on the server. Caching
		// a hash for a session whose upload threw would be a silent footgun:
		// next push sees cache hit → skips → server still has metadata
		// without file_key → forever broken until cache is wiped.
		const uploadedIds = new Set<string>();
		if (needsContent.size > 0) {
			const contentSpinner = p.spinner();
			contentSpinner.start(
				`Uploading content for ${needsContent.size} session${needsContent.size === 1 ? "" : "s"}...`,
			);
			for (const s of sessions) {
				if (!needsContent.has(s.localSessionId)) continue;
				if (s.messages.length === 0) continue;
				try {
					const content = Buffer.from(JSON.stringify(s.messages), "utf-8");
					await api.uploadSessionContent(s.localSessionId, content, `${s.localSessionId}.json`);
					uploadedIds.add(s.localSessionId);
					contentUploaded++;
					contentSpinner.message(`Uploading content (${contentUploaded}/${needsContent.size})...`);
				} catch (e) {
					// Content upload is best-effort — the metadata row was
					// already committed in the batch POST above. Surface the
					// reason so misconfigured file stores don't appear to
					// succeed silently.
					p.log.warn(`Content upload skipped for ${s.localSessionId}: ${errMessage(e)}`);
				}
			}
			contentSpinner.stop(
				`Uploaded ${contentUploaded} content blob${contentUploaded === 1 ? "" : "s"}`,
			);
		}

		// Update the per-session lock for sessions that are genuinely in
		// sync with the server now: either the server already had matching
		// content (not in `needs_content`), or we just delivered the bytes
		// (id in `uploadedIds`). Sessions whose upload failed stay un-cached
		// so the next push retries. Server-rejected ids ALSO stay un-cached
		// so the cross-env race loser retries on the next push.
		for (const s of sessions) {
			if (!s.contentHash) continue;
			const id = s.localSessionId;
			if (rejectedIds.has(id)) continue;
			if (needsContent.has(id) && !uploadedIds.has(id)) continue;
			sessionsLock.sessions[cacheKey(agentType, id)] = { hash: s.contentHash };
		}
		moduleState[`sessions:${agentType}`] = { lastActivityAt: new Date().toISOString() };
	}

	if (skills.length > 0) {
		// Skill upload uses project-explicit URLs. Resolve
		// THIS agent's env's default_project_id directly — not the
		// auth key's "most recently active env" heuristic. With a
		// multi-agent setup on an unbound CLI key, the latter would
		// route a `claude_code` push under whichever env was
		// touched last (often `codex` from the previous push),
		// while sessions still wrote correctly to `envId`. The
		// `claude_code` daemon would never see these skills because
		// its reconcile listing is tied to its own project.
		if (!envId) {
			throw new Error(
				`internal error: skill push without envId for ${agentType}; the early-return guard above should have caught this`,
			);
		}
		const skillProjectId = await fetchProjectIdForEnv(api, envId);

		// `skills` is already the to-upload set — the scan phase hashed
		// every skill and dropped the ones already in sync.
		const skillSpinner = p.spinner();
		skillSpinner.start(`Uploading ${skills.length} skill${skills.length === 1 ? "" : "s"}...`);
		let pushed = 0;
		const skipped: { key: string; reason: string }[] = [];
		try {
			for (const skill of skills) {
				// Pass skill_key so nested Hermes layouts archive
				// entries under `category/foo/...` (matching the
				// cloud key), not just `foo/...` which would
				// extract to the wrong path on pull.
				const tarBytes = await tarSkillDir(skill.directoryPath, undefined, skill.skillKey);
				try {
					await api.uploadSkill(
						skillProjectId,
						skill.skillKey,
						tarBytes,
						`${skill.skillKey}.tar.gz`,
						skill.contentHash,
					);
					pushed++;
					// Cache key is partitioned by `(agentType, skillKey)`: in
					// multi-agent push, agent A and agent B can have the same
					// `foo` content under different projects; a flat skill_key
					// cache would say "B already in sync" the moment A pushed,
					// leaving B's project missing the skill.
					if (skill.contentHash) {
						skillsLock.skills[skillCacheKey(agentType, skill.skillKey)] = {
							hash: skill.contentHash,
						};
					}
				} catch (e) {
					// 413 = upstream (Cloudflare / nginx) refused the body. Almost
					// always a single oversized skill; skip it and keep going so
					// one fat tarball doesn't kill the whole batch. Other errors
					// (auth, 5xx, network) still bubble out and abort.
					//
					// Prefer the status code; fall back to a body match only when the
					// edge masks the status (some Cloudflare error pages serve 502
					// with "413 Request Entity Too Large" in the HTML body). Body
					// regex is anchored to a word boundary so an unrelated 4XX whose
					// body happens to contain "413" doesn't get silently skipped.
					const is413 =
						e instanceof ApiError &&
						(e.status === 413 ||
							(typeof e.body === "string" &&
								/(?:^|[^0-9])413(?:[^0-9]|$)|payload too large/i.test(e.body)));
					if (!is413) throw e;
					const mb = (tarBytes.length / 1024 / 1024).toFixed(1);
					skipped.push({ key: skill.skillKey, reason: `${mb} MB exceeds upload limit` });
				}
				skillSpinner.message(`Uploading skills (${pushed + skipped.length}/${skills.length})...`);
			}
			const summary = [`Pushed ${pushed} skill${pushed === 1 ? "" : "s"}`];
			if (skipped.length > 0) {
				summary.push(`skipped ${skipped.length} (too large)`);
			}
			skillSpinner.stop(summary.join(", "));
			for (const s of skipped) {
				p.log.warn(`Skipped ${s.key} — ${s.reason}`);
			}
			skillsPushed = pushed;
		} catch (e) {
			skillSpinner.stop(`Failed after ${pushed} skill${pushed === 1 ? "" : "s"}.`);
			throw e;
		}
		moduleState.skills = { lastActivityAt: new Date().toISOString() };
	}

	return {
		sessionsCreated,
		sessionsUpdated,
		sessionsUnchanged,
		contentUploaded,
		skillsPushed,
	};
}

function normalizeProject(input: string): string {
	// Expand `~` ourselves — `path.resolve` doesn't do tilde expansion, so a
	// shell-less caller (e.g. an agent invoking the CLI directly) that passes
	// `~/scratch` would otherwise get `<cwd>/~/scratch`, which never matches.
	let expanded = input;
	if (expanded === "~") expanded = homedir();
	else if (expanded.startsWith("~/")) expanded = `${homedir()}${expanded.slice(1)}`;
	return resolvePath(expanded);
}
