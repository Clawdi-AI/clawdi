import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import type { SyncState } from "@clawdi-cloud/shared/types";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import { ApiClient } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";

function getEnvIdByAgent(agentType: string): string | null {
	const path = join(getClawdiDir(), "environments", `${agentType}.json`);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf-8")).id;
}

function getSyncState(): SyncState {
	const path = join(getClawdiDir(), "sync.json");
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf-8"));
}

function saveSyncState(state: SyncState) {
	const path = join(getClawdiDir(), "sync.json");
	writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

const UP_MODULES = ["sessions", "skills"] as const;
const DOWN_MODULES = ["skills"] as const;

async function selectModules(
	rl: ReturnType<typeof createInterface>,
	available: readonly string[],
	direction: "upload" | "download",
): Promise<string[]> {
	console.log(chalk.cyan(`\nSelect modules to ${direction}:`));
	const selected: string[] = [];
	for (const mod of available) {
		const answer = await rl.question(chalk.cyan(`  ${mod}? [Y/n] `));
		if (answer.toLowerCase() !== "n") {
			selected.push(mod);
		}
	}
	if (selected.length === 0) {
		console.log(chalk.gray("No modules selected."));
	}
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

	// If --modules specified, use directly; otherwise ask
	let modules: string[];
	if (opts.modules) {
		modules = opts.modules.split(",");
	} else {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			modules = await selectModules(rl, UP_MODULES, "upload");
		} finally {
			rl.close();
		}
		if (modules.length === 0) return;
	}

	console.log();
	const syncState = getSyncState();
	const api = opts.dryRun ? null : new ApiClient();

	if (modules.includes("sessions")) {
		console.log(chalk.cyan("Syncing sessions..."));

		const since = opts.since
			? new Date(opts.since)
			: syncState.sessions?.lastSyncedAt
				? new Date(syncState.sessions.lastSyncedAt)
				: undefined;

		const projectFilter = opts.all ? undefined : (opts.project ?? process.cwd());
		const sessions = await adapter.collectSessions(since, projectFilter);

		if (sessions.length === 0) {
			console.log(chalk.gray("  No new sessions to sync."));
		} else if (opts.dryRun) {
			console.log(chalk.yellow(`  Would upload ${sessions.length} sessions (dry run)`));
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
				console.log(chalk.green(`  ✓ Synced ${result.synced} sessions`));
			} catch (e: any) {
				console.log(chalk.red(`  Failed: ${e.message}`));
				return;
			}
		}

		if (!opts.dryRun) {
			syncState.sessions = { lastSyncedAt: new Date().toISOString() };
		}
	}

	if (modules.includes("skills")) {
		console.log(chalk.cyan("Syncing skills..."));
		const skills = await adapter.collectSkills();
		if (skills.length === 0) {
			console.log(chalk.gray("  No skills found."));
		} else if (opts.dryRun) {
			console.log(chalk.yellow(`  Would upload ${skills.length} skills (dry run)`));
		} else {
			try {
				const result = await api!.post<{ synced: number }>("/api/skills/batch", {
					skills: skills.map((s) => ({
						skill_key: s.skillKey,
						name: s.name,
						content: s.content,
					})),
				});
				console.log(chalk.green(`  ✓ Synced ${result.synced} skills`));
			} catch (e: any) {
				console.log(chalk.red(`  Failed: ${e.message}`));
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

	// If --modules specified, use directly; otherwise ask
	let modules: string[];
	if (opts.modules) {
		modules = opts.modules.split(",");
	} else {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			modules = await selectModules(rl, DOWN_MODULES, "download");
		} finally {
			rl.close();
		}
		if (modules.length === 0) return;
	}

	console.log();

	if (modules.includes("skills")) {
		console.log(chalk.cyan("Pulling skills from cloud..."));
		try {
			const skills = await api.get<Array<{ skill_key: string; name: string; content?: string }>>(
				"/api/skills?include_content=true",
			);

			if (skills.length === 0) {
				console.log(chalk.gray("  No skills in cloud."));
			} else if (opts.dryRun) {
				console.log(chalk.yellow(`  Would download ${skills.length} skills (dry run)`));
			} else {
				let pulled = 0;
				const rl = createInterface({ input: process.stdin, output: process.stdout });
				try {
					for (const skill of skills) {
						if (!skill.content) continue;
						const dest = adapter.getSkillPath(skill.skill_key);
						if (existsSync(dest)) {
							const answer = await rl.question(
								chalk.yellow(`    ${skill.skill_key} already exists. Overwrite? [y/N] `),
							);
							if (answer.toLowerCase() !== "y") {
								console.log(chalk.gray(`    ${skill.skill_key} skipped`));
								continue;
							}
						}
						await adapter.writeSkill(skill.skill_key, skill.content);
						console.log(chalk.gray(`    ${skill.skill_key} → ${dest}`));
						pulled++;
					}
				} finally {
					rl.close();
				}
				console.log(chalk.green(`  ✓ Pulled ${pulled} skills`));
			}
		} catch (e: any) {
			console.log(chalk.red(`  Failed: ${e.message}`));
		}
	}
}
