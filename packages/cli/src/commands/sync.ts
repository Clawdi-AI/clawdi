import * as p from "@clack/prompts";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncState } from "@clawdi-cloud/shared/types";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import { ApiClient } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";

function getEnvIdByAgent(agentType: string): string | null {
	const envPath = join(getClawdiDir(), "environments", `${agentType}.json`);
	if (!existsSync(envPath)) return null;
	return JSON.parse(readFileSync(envPath, "utf-8")).id;
}

function getSyncState(): SyncState {
	const syncPath = join(getClawdiDir(), "sync.json");
	if (!existsSync(syncPath)) return {};
	return JSON.parse(readFileSync(syncPath, "utf-8"));
}

function saveSyncState(state: SyncState) {
	const syncPath = join(getClawdiDir(), "sync.json");
	writeFileSync(syncPath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

const UP_MODULES = [
	{ value: "sessions", label: "Sessions", hint: "agent conversation history" },
	{ value: "skills", label: "Skills", hint: "SKILL.md files" },
];

const DOWN_MODULES = [
	{ value: "skills", label: "Skills", hint: "pull SKILL.md to agent directories" },
];

async function pickModules(
	available: typeof UP_MODULES,
	direction: "upload" | "download",
): Promise<string[] | null> {
	const selected = await p.multiselect({
		message: `Select modules to ${direction} (space to toggle, enter to confirm)`,
		options: available,
		initialValues: available.map((m) => m.value),
	});
	if (p.isCancel(selected) || selected.length === 0) return null;
	return selected;
}

export async function syncUp(opts: {
	modules?: string;
	since?: string;
	project?: string;
	all?: boolean;
	dryRun?: boolean;
}) {
	if (!opts.dryRun && !isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		return;
	}

	const adapter = new ClaudeCodeAdapter();
	if (!(await adapter.detect())) {
		console.log(chalk.red("Claude Code not detected on this machine."));
		return;
	}

	const envId = getEnvIdByAgent(adapter.agentType);
	if (!opts.dryRun && !envId) {
		console.log(chalk.red("No environment registered. Run `clawdi setup` first."));
		return;
	}

	let modules: string[];
	if (opts.modules) {
		modules = opts.modules.split(",");
	} else {
		const picked = await pickModules(UP_MODULES, "upload");
		if (!picked) {
			p.cancel("Cancelled.");
			return;
		}
		modules = picked;
	}

	const syncState = getSyncState();
	const api = opts.dryRun ? null : new ApiClient();

	if (modules.includes("sessions")) {
		const spin = p.spinner();
		spin.start("Collecting sessions...");

		const since = opts.since
			? new Date(opts.since)
			: syncState.sessions?.lastSyncedAt
				? new Date(syncState.sessions.lastSyncedAt)
				: undefined;

		const projectFilter = opts.all ? undefined : (opts.project ?? process.cwd());
		const sessions = await adapter.collectSessions(since, projectFilter);

		if (sessions.length === 0) {
			spin.stop("No new sessions to sync.");
		} else if (opts.dryRun) {
			spin.stop(`Would upload ${sessions.length} sessions (dry run)`);
			for (const s of sessions.slice(0, 5)) {
				console.log(
					chalk.gray(
						`    ${s.localSessionId.slice(0, 8)}  ${s.messageCount} msgs  ${s.model ?? "?"}  ${s.summary?.slice(0, 50) ?? ""}`,
					),
				);
			}
			if (sessions.length > 5) {
				console.log(chalk.gray(`    ... and ${sessions.length - 5} more`));
			}
		} else {
			spin.message(`Uploading ${sessions.length} sessions...`);
			const batch = sessions.map((s) => ({
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
			}));

			try {
				const result = await api!.post<{ synced: number }>("/api/sessions/batch", {
					sessions: batch,
				});
				spin.stop(`Synced ${result.synced} sessions`);
			} catch (e: any) {
				spin.stop(`Failed: ${e.message}`);
				return;
			}
		}

		if (!opts.dryRun) {
			syncState.sessions = { lastSyncedAt: new Date().toISOString() };
		}
	}

	if (modules.includes("skills")) {
		const spin = p.spinner();
		spin.start("Collecting skills...");
		const skills = await adapter.collectSkills();

		if (skills.length === 0) {
			spin.stop("No skills found.");
		} else if (opts.dryRun) {
			spin.stop(`Would upload ${skills.length} skills (dry run)`);
		} else {
			spin.message(`Uploading ${skills.length} skills...`);
			try {
				const result = await api!.post<{ synced: number }>("/api/skills/batch", {
					skills: skills.map((s) => ({
						skill_key: s.skillKey,
						name: s.name,
						content: s.content,
					})),
				});
				spin.stop(`Synced ${result.synced} skills`);
			} catch (e: any) {
				spin.stop(`Failed: ${e.message}`);
			}
		}

		if (!opts.dryRun) {
			syncState.skills = { lastSyncedAt: new Date().toISOString() };
		}
	}

	if (!opts.dryRun) {
		saveSyncState(syncState);
	}
}

export async function syncDown(opts: { modules?: string; dryRun?: boolean }) {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		return;
	}

	const adapter = new ClaudeCodeAdapter();
	const api = new ApiClient();

	let modules: string[];
	if (opts.modules) {
		modules = opts.modules.split(",");
	} else {
		const picked = await pickModules(DOWN_MODULES, "download");
		if (!picked) {
			p.cancel("Cancelled.");
			return;
		}
		modules = picked;
	}

	if (modules.includes("skills")) {
		const spin = p.spinner();
		spin.start("Pulling skills from cloud...");

		try {
			const skills = await api.get<Array<{ skill_key: string; name: string; content?: string }>>(
				"/api/skills?include_content=true",
			);

			if (skills.length === 0) {
				spin.stop("No skills in cloud.");
			} else if (opts.dryRun) {
				spin.stop(`Would download ${skills.length} skills (dry run)`);
			} else {
				spin.stop(`Found ${skills.length} skills`);

				let pulled = 0;
				for (const skill of skills) {
					if (!skill.content) continue;
					const dest = adapter.getSkillPath(skill.skill_key);
					if (existsSync(dest)) {
						const overwrite = await p.confirm({
							message: `${skill.skill_key} already exists. Overwrite?`,
							initialValue: false,
						});
						if (p.isCancel(overwrite) || !overwrite) {
							console.log(chalk.gray(`    ${skill.skill_key} skipped`));
							continue;
						}
					}
					await adapter.writeSkill(skill.skill_key, skill.content);
					console.log(chalk.gray(`    ${skill.skill_key} → ${dest}`));
					pulled++;
				}
				p.outro(`Pulled ${pulled} skills`);
			}
		} catch (e: any) {
			spin.stop(`Failed: ${e.message}`);
		}
	}
}
