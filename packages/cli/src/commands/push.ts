import * as p from "@clack/prompts";
import chalk from "chalk";
import type { RawSession, RawSkill } from "../adapters/base";
import { adapterRegistry } from "../adapters/registry";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { askMulti, askYesNo, parseModules } from "../lib/prompts";
import { getEnvIdByAgent, selectAdapter } from "../lib/select-adapter";
import { readModuleState, writeModuleState } from "../lib/state";
import { tarSkillDir } from "../lib/tar";

const RESETUP_HINT =
	"This machine's environment is no longer registered. Run `clawdi setup` again.";

const UP_MODULES = [
	{ value: "sessions", label: "Sessions", hint: "agent conversation history" },
	{ value: "skills", label: "Skills", hint: "skill directories as tar.gz" },
];

export async function push(opts: {
	modules?: string;
	since?: string;
	project?: string;
	all?: boolean;
	dryRun?: boolean;
	agent?: string;
}) {
	p.intro(chalk.bold("clawdi push"));

	if (!opts.dryRun && !isLoggedIn()) {
		p.log.error("Not logged in. Run `clawdi auth login` first.");
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	const adapter = await selectAdapter(opts.agent);
	if (!adapter) {
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	const envId = getEnvIdByAgent(adapter.agentType);
	if (!opts.dryRun && !envId) {
		p.log.error("No environment registered. Run `clawdi setup` first.");
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
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
					p.outro(chalk.red("Aborted."));
					process.exitCode = 1;
					return;
				}
				// Anything else (401, network, 5xx) — let the actual upload bubble
				// up the proper error; don't double-report here.
			}
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) {
				p.log.error(RESETUP_HINT);
				p.outro(chalk.red("Aborted."));
				process.exitCode = 1;
				return;
			}
			// Same reasoning as above — fall through and let upload surface it.
		}
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

	p.log.info(`Agent:   ${adapterRegistry[adapter.agentType].displayName}`);
	p.log.info(`Modules: ${modules.join(", ")}`);

	// 2. Scan data
	const moduleState = readModuleState();
	const sinceSource: "flag" | "state" | "none" = opts.since
		? "flag"
		: moduleState.sessions?.lastActivityAt
			? "state"
			: "none";
	const since = opts.since
		? new Date(opts.since)
		: moduleState.sessions?.lastActivityAt
			? new Date(moduleState.sessions.lastActivityAt)
			: undefined;
	const projectFilter = opts.all ? undefined : (opts.project ?? process.cwd());

	if (modules.includes("sessions")) {
		const scope = projectFilter ? `project ${projectFilter}` : "all projects";
		const sinceLabel = since
			? `since ${since.toISOString()}${sinceSource === "state" ? " (from last push)" : ""}`
			: "no since cutoff";
		p.log.info(chalk.gray(`Scanning ${scope}, ${sinceLabel}`));
	}

	if (
		adapter.agentType === "hermes" &&
		modules.includes("sessions") &&
		projectFilter !== undefined
	) {
		p.log.warn("Hermes does not support project filtering; pushing all sessions.");
		p.log.info("Use --all to suppress this notice.");
	}

	let sessions: RawSession[] = [];
	let skills: RawSkill[] = [];

	const scanSpinner = p.spinner();
	scanSpinner.start("Scanning local data...");
	if (modules.includes("sessions")) {
		sessions = await adapter.collectSessions(since, projectFilter);
	}
	if (modules.includes("skills")) {
		skills = await adapter.collectSkills();
	}
	scanSpinner.stop(
		`Scanned ${sessions.length} session${sessions.length === 1 ? "" : "s"}, ${skills.length} skill${skills.length === 1 ? "" : "s"}`,
	);

	// 3. Summary
	if (modules.includes("sessions")) {
		p.log.message(chalk.gray(`Sessions: ${sessions.length} to upload`));
		if (sessions.length === 0 && projectFilter) {
			p.log.info(
				chalk.gray(
					"No sessions matched. Try --all to scan every project, or --since <date> to override the last-push cutoff.",
				),
			);
		}
	}
	if (modules.includes("skills")) {
		p.log.message(chalk.gray(`Skills:   ${skills.length} to upload`));
	}

	if (sessions.length === 0 && skills.length === 0) {
		p.outro(chalk.gray("Nothing to push."));
		return;
	}

	// 4. Confirm
	if (opts.dryRun) {
		p.outro(chalk.gray("Dry run complete."));
		return;
	}
	const ok = await askYesNo("Proceed with upload?");
	if (!ok) {
		p.outro(chalk.gray("Cancelled."));
		return;
	}

	// 5. Execute — `envId` was guarded against null up-front, but the narrowing
	// is gone by now. Re-check so TS can forward it into the batch body.
	if (!envId) {
		p.log.error("Environment id missing — rerun `clawdi setup`.");
		return;
	}
	const api = new ApiClient();

	if (sessions.length > 0) {
		const sessionSpinner = p.spinner();
		sessionSpinner.start(
			`Uploading ${sessions.length} session${sessions.length === 1 ? "" : "s"}...`,
		);
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
						})),
					},
				}),
			);
			sessionSpinner.stop(`Pushed ${result.synced} session${result.synced === 1 ? "" : "s"}`);

			if (result.synced > 0) {
				const contentSpinner = p.spinner();
				contentSpinner.start("Uploading session content...");
				let uploaded = 0;
				for (const s of sessions) {
					if (s.messages.length === 0) continue;
					try {
						const content = Buffer.from(JSON.stringify(s.messages), "utf-8");
						await api.uploadSessionContent(s.localSessionId, content, `${s.localSessionId}.json`);
						uploaded++;
						contentSpinner.message(`Uploading session content (${uploaded}/${result.synced})...`);
					} catch (e) {
						// Content upload is best-effort — the session header was
						// already committed in the batch POST above. Surface the
						// reason so misconfigured file stores don't appear to
						// succeed silently.
						p.log.warn(`Content upload skipped for ${s.localSessionId}: ${errMessage(e)}`);
					}
				}
				contentSpinner.stop(`Uploaded ${uploaded} session content${uploaded === 1 ? "" : "s"}`);
			}
		} catch (e) {
			// Stop the spinner with a plain "failed" message — handleError
			// will render the final red error box, so we avoid double-red.
			sessionSpinner.stop("Session upload failed.");
			// Translate the backend's "unknown_environment" 400 into the same
			// re-setup hint the up-front probe uses. The probe catches the
			// common case; this catches a race where the env was deleted
			// between probe and batch.
			if (e instanceof ApiError && e.status === 400 && e.body.includes("unknown_environment")) {
				p.log.error(RESETUP_HINT);
				p.outro(chalk.red("Aborted."));
				process.exitCode = 1;
				return;
			}
			throw e;
		}
		moduleState.sessions = { lastActivityAt: new Date().toISOString() };
	}

	if (skills.length > 0) {
		const skillSpinner = p.spinner();
		skillSpinner.start(`Uploading ${skills.length} skill${skills.length === 1 ? "" : "s"}...`);
		let pushed = 0;
		const skipped: { key: string; reason: string }[] = [];
		try {
			for (const skill of skills) {
				const tarBytes = await tarSkillDir(skill.directoryPath);
				try {
					await api.uploadSkill(skill.skillKey, tarBytes, `${skill.skillKey}.tar.gz`);
					pushed++;
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
			const parts = [`Pushed ${pushed} skill${pushed === 1 ? "" : "s"}`];
			if (skipped.length > 0) {
				parts.push(`skipped ${skipped.length} (too large)`);
			}
			skillSpinner.stop(parts.join(", "));
			for (const s of skipped) {
				p.log.warn(`Skipped ${s.key} — ${s.reason}`);
			}
		} catch (e) {
			skillSpinner.stop(`Failed after ${pushed} skill${pushed === 1 ? "" : "s"}.`);
			throw e;
		}
		moduleState.skills = { lastActivityAt: new Date().toISOString() };
	}

	writeModuleState(moduleState);
	p.outro(chalk.green("✓ Push complete"));
}
