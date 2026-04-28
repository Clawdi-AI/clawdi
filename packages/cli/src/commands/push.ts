import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import type { AgentAdapter, RawSession, RawSkill } from "../adapters/base";
import { adapterRegistry } from "../adapters/registry";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { sha256Hex } from "../lib/hash";
import { askMulti, askYesNo, parseModules } from "../lib/prompts";
import { adapterForType, getEnvIdByAgent, resolveTargetAgentTypes } from "../lib/select-adapter";
import {
	cacheKey,
	readSessionsLock,
	type SessionsLock,
	writeSessionsLock,
} from "../lib/sessions-lock";
import {
	computeSkillFolderHash,
	readSkillsLock,
	type SkillsLock,
	writeSkillsLock,
} from "../lib/skills-lock";
import { type ModuleState, readModuleState, writeModuleState } from "../lib/state";
import { tarSkillDir } from "../lib/tar";
import { isInteractive } from "../lib/tty";

const RESETUP_HINT =
	"This machine's environment is no longer registered. Run `clawdi setup` again.";

const UP_MODULES = [
	{ value: "sessions", label: "Sessions", hint: "agent conversation history" },
	{ value: "skills", label: "Skills", hint: "skill directories as tar.gz" },
];

interface PushOpts {
	modules?: string;
	project?: string;
	excludeProject?: string[];
	all?: boolean;
	allAgents?: boolean;
	dryRun?: boolean;
	agent?: string;
	yes?: boolean;
}

interface AgentPushResult {
	sessionsCacheSkipped: number;
	sessionsCreated: number;
	sessionsUpdated: number;
	sessionsUnchanged: number;
	contentUploaded: number;
	skillsCacheSkipped: number;
	skillsPushed: number;
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

	const targetTypes = await resolveTargetAgentTypes(opts.agent, !!opts.allAgents);
	if (targetTypes.length === 0) {
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	let modules: string[];
	if (opts.modules) {
		const parsed = parseModules(opts.modules, UP_MODULES);
		if (!parsed) return;
		modules = parsed;
	} else {
		const picked = await askMulti("Modules to upload:", UP_MODULES);
		if (!picked) {
			p.outro(chalk.gray("Cancelled."));
			return;
		}
		modules = picked;
	}
	if (modules.length === 0) {
		p.outro(chalk.gray("Nothing to push."));
		return;
	}

	if (targetTypes.length > 1) {
		p.log.info(`Targets: ${targetTypes.map((t) => adapterRegistry[t].displayName).join(", ")}`);
	}

	const moduleState = readModuleState();
	const sessionsLock = readSessionsLock();
	const skillsLock = readSkillsLock();
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

	for (const agentType of targetTypes) {
		const adapter = adapterForType(agentType);
		if (!adapter) continue;
		if (targetTypes.length > 1) {
			p.log.step(chalk.bold(`▶ ${adapterRegistry[agentType].displayName}`));
		}
		const result = await pushOneAgent(
			adapter,
			modules,
			opts,
			moduleState,
			sessionsLock,
			skillsLock,
		);
		if (result === "aborted") {
			aborted = true;
			break;
		}
		if (result === "skipped") continue;
		totals.cacheSkipped += result.sessionsCacheSkipped;
		totals.created += result.sessionsCreated;
		totals.updated += result.sessionsUpdated;
		totals.unchanged += result.sessionsUnchanged;
		totals.content += result.contentUploaded;
		totals.skillsCacheSkipped += result.skillsCacheSkipped;
		totals.skills += result.skillsPushed;
	}

	if (!opts.dryRun) {
		writeModuleState(moduleState);
		// Persist content-hash caches once per push command, even if the
		// loop aborted partway — entries we mutated for successful agents
		// are still valid and would otherwise be lost on the next push.
		writeSessionsLock(sessionsLock);
		writeSkillsLock(skillsLock);
	}

	if (aborted) {
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	if (opts.dryRun) {
		p.outro(chalk.gray("Dry run complete."));
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

async function pushOneAgent(
	adapter: AgentAdapter,
	modules: string[],
	opts: PushOpts,
	moduleState: ModuleState,
	sessionsLock: SessionsLock,
	skillsLock: SkillsLock,
): Promise<AgentPushResult | "aborted" | "skipped"> {
	const agentType = adapter.agentType;
	const envId = getEnvIdByAgent(agentType);

	if (!opts.dryRun && !envId) {
		p.log.error(
			`No environment registered for ${adapterRegistry[agentType].displayName}. Run \`clawdi setup\` first.`,
		);
		return "aborted";
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
			const res = await probe.GET("/api/environments/{environment_id}", {
				params: { path: { environment_id: envId } },
			});
			if (res.error || !res.data) {
				const status = res.response?.status ?? 0;
				if (status === 404) {
					p.log.error(RESETUP_HINT);
					return "aborted";
				}
				// Anything else (401, network, 5xx) — let the actual upload bubble
				// up the proper error; don't double-report here.
			}
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) {
				p.log.error(RESETUP_HINT);
				return "aborted";
			}
			// Same reasoning as above — fall through and let upload surface it.
		}
	}

	// Project filter: explicit --all wins, then explicit --project, else cwd.
	const usedCwdDefault = !opts.all && !opts.project;
	const projectFilter = opts.all ? undefined : (opts.project ?? process.cwd());

	const excludeSet = new Set<string>(
		(opts.excludeProject ?? []).map((path) => normalizeProject(path)),
	);

	if (modules.includes("sessions")) {
		const scope = projectFilter ? `project ${projectFilter}` : "all projects";
		p.log.info(chalk.gray(`Scanning ${scope}`));
	}

	if (agentType === "hermes" && modules.includes("sessions") && projectFilter !== undefined) {
		p.log.warn("Hermes does not support project filtering; pushing all sessions.");
		p.log.info("Use --all to suppress this notice.");
	}

	let sessions: RawSession[] = [];
	let skills: RawSkill[] = [];

	const scanSpinner = p.spinner();
	scanSpinner.start("Scanning local data...");
	if (modules.includes("sessions")) {
		sessions = await adapter.collectSessions({ projectFilter });
	}
	if (modules.includes("skills")) {
		skills = await adapter.collectSkills();
	}
	scanSpinner.stop(
		`Scanned ${sessions.length} session${sessions.length === 1 ? "" : "s"}, ${skills.length} skill${skills.length === 1 ? "" : "s"}`,
	);

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
			p.log.info(
				chalk.gray(
					`Excluded ${removed} session${removed === 1 ? "" : "s"} from ${matchedExcludes.size} project${matchedExcludes.size === 1 ? "" : "s"}`,
				),
			);
		}
		for (const requested of excludeSet) {
			if (!matchedExcludes.has(requested)) {
				p.log.warn(`--exclude-project ${requested} did not match any local sessions; ignoring`);
			}
		}
	}

	// Filter against the sessions-lock cache: any session whose hash matches
	// the stored value can be skipped — the server already has it. This is
	// the per-entity diff that replaces the old global mtime cursor; scope
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

	if (modules.includes("sessions")) {
		const tail = sessionsCacheSkipped > 0 ? ` (${sessionsCacheSkipped} already in sync)` : "";
		p.log.message(chalk.gray(`Sessions: ${sessions.length} to upload${tail}`));
		if (sessions.length === 0 && sessionsCacheSkipped === 0) {
			// Nothing scanned at all — guide first-run cwd-default users.
			const isFirstRun = !Object.keys(sessionsLock.sessions).some((k) =>
				k.startsWith(`${agentType}:`),
			);
			if (usedCwdDefault && isFirstRun && !isInteractive()) {
				p.log.info(
					chalk.gray(
						`No sessions matched in ${process.cwd()}. This looks like a first run — re-run with --all to scan every project, or pass --project <abs-path> if your sessions live elsewhere.`,
					),
				);
			} else if (projectFilter) {
				p.log.info(
					chalk.gray(
						"No sessions matched. Try --all to scan every project, or pass --project <abs-path> for a different scope.",
					),
				);
			}
		}
	}
	if (modules.includes("skills")) {
		p.log.message(chalk.gray(`Skills:   ${skills.length} to upload`));
	}

	if (sessions.length === 0 && skills.length === 0) {
		if (sessionsCacheSkipped > 0) {
			// Cache covered everything. Surface the count to the top-level
			// totals so the user sees a non-zero "skipped (cache)" number.
			return {
				sessionsCacheSkipped,
				sessionsCreated: 0,
				sessionsUpdated: 0,
				sessionsUnchanged: 0,
				contentUploaded: 0,
				skillsCacheSkipped: 0,
				skillsPushed: 0,
			};
		}
		if (excludeSet.size > 0 && modules.includes("sessions")) {
			p.log.message(chalk.gray("Nothing left to push after exclusions."));
		}
		return "skipped";
	}

	if (opts.dryRun) {
		// Dry-run reports the local scan size — we can't know which sessions
		// the server already has without actually hitting the batch endpoint.
		return {
			sessionsCacheSkipped,
			sessionsCreated: sessions.length,
			sessionsUpdated: 0,
			sessionsUnchanged: 0,
			contentUploaded: sessions.length,
			skillsCacheSkipped: 0,
			skillsPushed: skills.length,
		};
	}

	// `--yes` skips the confirmation. `askYesNo` already returns true in
	// non-interactive contexts (CI / agent), so explicit `--yes` is mostly
	// a no-op in those, but keeps the skill's command line self-documenting.
	if (!opts.yes) {
		const ok = await askYesNo("Proceed with upload?");
		if (!ok) {
			p.log.info(chalk.gray("Cancelled."));
			return "skipped";
		}
	}

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
		let needsContent: Set<string>;
		try {
			const result = unwrap(
				await api.POST("/api/sessions/batch", {
					body: {
						sessions: sessions.map((s) => ({
							environment_id: envId,
							local_session_id: s.localSessionId,
							project_path: s.projectPath,
							started_at: s.startedAt.toISOString(),
							ended_at: s.endedAt?.toISOString() ?? null,
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
			needsContent = new Set(result.needs_content);
			sessionsCreated = result.created;
			sessionsUpdated = result.updated;
			sessionsUnchanged = result.unchanged;
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
		// so the next push retries.
		for (const s of sessions) {
			if (!s.contentHash) continue;
			const id = s.localSessionId;
			if (needsContent.has(id) && !uploadedIds.has(id)) continue;
			sessionsLock.sessions[cacheKey(agentType, id)] = { hash: s.contentHash };
		}
		moduleState[`sessions:${agentType}`] = { lastActivityAt: new Date().toISOString() };
	}

	let skillsCacheSkipped = 0;
	if (skills.length > 0) {
		const skillSpinner = p.spinner();
		skillSpinner.start(`Hashing ${skills.length} skill${skills.length === 1 ? "" : "s"}...`);
		let pushed = 0;
		const skipped: { key: string; reason: string }[] = [];
		try {
			for (const skill of skills) {
				// Compute the file-tree hash first. Cheap (no tar build) — if
				// it matches the cache, we skip the whole upload path.
				const computedHash = await computeSkillFolderHash(skill.directoryPath);
				if (skillsLock.skills[skill.skillKey]?.hash === computedHash) {
					skillsCacheSkipped++;
					skillSpinner.message(
						`Hashing skills (${pushed + skipped.length + skillsCacheSkipped}/${skills.length})...`,
					);
					continue;
				}
				const tarBytes = await tarSkillDir(skill.directoryPath);
				try {
					await api.uploadSkill(skill.skillKey, tarBytes, `${skill.skillKey}.tar.gz`, computedHash);
					pushed++;
					skillsLock.skills[skill.skillKey] = { hash: computedHash };
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
				skillSpinner.message(
					`Uploading skills (${pushed + skipped.length + skillsCacheSkipped}/${skills.length})...`,
				);
			}
			const summary = [`Pushed ${pushed} skill${pushed === 1 ? "" : "s"}`];
			if (skillsCacheSkipped > 0) {
				summary.push(`${skillsCacheSkipped} already in sync`);
			}
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
		sessionsCacheSkipped,
		sessionsCreated,
		sessionsUpdated,
		sessionsUnchanged,
		contentUploaded,
		skillsCacheSkipped,
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
