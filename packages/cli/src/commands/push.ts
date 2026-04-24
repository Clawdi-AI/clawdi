import * as p from "@clack/prompts";
import chalk from "chalk";
import type { RawSession, RawSkill } from "../adapters/base";
import { adapterRegistry } from "../adapters/registry";
import { ApiClient } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { askMulti, askYesNo, parseModules } from "../lib/prompts";
import { getEnvIdByAgent, selectAdapter } from "../lib/select-adapter";
import { readModuleState, writeModuleState } from "../lib/state";
import { tarSkillDir } from "../lib/tar";

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
		p.log.error("No supported agent detected on this machine.");
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
	const since = opts.since
		? new Date(opts.since)
		: moduleState.sessions?.lastActivityAt
			? new Date(moduleState.sessions.lastActivityAt)
			: undefined;
	const projectFilter = opts.all ? undefined : (opts.project ?? process.cwd());

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

	// 5. Execute
	const api = new ApiClient();

	if (sessions.length > 0) {
		const sessionSpinner = p.spinner();
		sessionSpinner.start(
			`Uploading ${sessions.length} session${sessions.length === 1 ? "" : "s"}...`,
		);
		try {
			const result = await api.post<{ synced: number }>("/api/sessions/batch", {
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
			});
			sessionSpinner.stop(`Pushed ${result.synced} session${result.synced === 1 ? "" : "s"}`);

			if (result.synced > 0) {
				const contentSpinner = p.spinner();
				contentSpinner.start("Uploading session content...");
				let uploaded = 0;
				for (const s of sessions) {
					if (s.messages.length === 0) continue;
					try {
						const content = Buffer.from(JSON.stringify(s.messages), "utf-8");
						await api.uploadFile(
							`/api/sessions/${s.localSessionId}/upload`,
							{},
							content,
							`${s.localSessionId}.json`,
						);
						uploaded++;
						contentSpinner.message(`Uploading session content (${uploaded}/${result.synced})...`);
					} catch {
						// Session might already exist, skip
					}
				}
				contentSpinner.stop(`Uploaded ${uploaded} session content${uploaded === 1 ? "" : "s"}`);
			}
		} catch (e) {
			// Stop the spinner with a plain "failed" message — handleError
			// will render the final red error box, so we avoid double-red.
			sessionSpinner.stop("Session upload failed.");
			throw e;
		}
		moduleState.sessions = { lastActivityAt: new Date().toISOString() };
	}

	if (skills.length > 0) {
		const skillSpinner = p.spinner();
		skillSpinner.start(`Uploading ${skills.length} skill${skills.length === 1 ? "" : "s"}...`);
		let pushed = 0;
		try {
			for (const skill of skills) {
				const tarBytes = await tarSkillDir(skill.directoryPath);
				await api.uploadFile(
					"/api/skills/upload",
					{ skill_key: skill.skillKey },
					tarBytes,
					`${skill.skillKey}.tar.gz`,
				);
				pushed++;
				skillSpinner.message(`Uploading skills (${pushed}/${skills.length})...`);
			}
			skillSpinner.stop(`Pushed ${pushed} skill${pushed === 1 ? "" : "s"}`);
		} catch (e) {
			skillSpinner.stop(`Failed after ${pushed} skill${pushed === 1 ? "" : "s"}.`);
			throw e;
		}
		moduleState.skills = { lastActivityAt: new Date().toISOString() };
	}

	writeModuleState(moduleState);
	p.outro(chalk.green("✓ Push complete"));
}
