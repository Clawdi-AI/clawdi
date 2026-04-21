import chalk from "chalk";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { AGENT_LABELS, AGENT_TYPES, type AgentType } from "@clawdi-cloud/shared/consts";
import type { SyncState } from "@clawdi-cloud/shared/types";
import type { AgentAdapter, RawSession, RawSkill } from "../adapters/base";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import { CodexAdapter } from "../adapters/codex";
import { HermesAdapter } from "../adapters/hermes";
import { OpenClawAdapter } from "../adapters/openclaw";
import { ApiClient } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";
import { tarSkillDir } from "../lib/tar-helpers";

function askYesNo(message: string, def = true): Promise<boolean> {
	const stdin = process.stdin;
	const stdout = process.stdout;
	const hint = def ? "[Y/n]" : "[y/N]";
	stdout.write(`${chalk.cyan(message)} ${chalk.gray(hint)} `);

	if (!stdin.isTTY) {
		stdout.write((def ? "y" : "n") + "\n");
		return Promise.resolve(def);
	}

	return new Promise((resolve) => {
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");

		const cleanup = () => {
			stdin.removeListener("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
		};

		const onData = (key: string) => {
			if (key === "") {
				cleanup();
				stdout.write("\n");
				resolve(false);
				return;
			}
			if (key === "\r" || key === "\n") {
				cleanup();
				stdout.write((def ? "y" : "n") + "\n");
				resolve(def);
				return;
			}
			const c = key.toLowerCase();
			if (c === "y") {
				cleanup();
				stdout.write("y\n");
				resolve(true);
				return;
			}
			if (c === "n") {
				cleanup();
				stdout.write("n\n");
				resolve(false);
				return;
			}
		};

		stdin.on("data", onData);
	});
}

type SelectOption<T extends string> = { value: T; label: string; hint?: string };

function runInteractiveSelect<T extends string>(
	message: string,
	options: SelectOption<T>[],
	multi: boolean,
	initiallySelected: Set<T>,
): Promise<Set<T> | null> {
	const stdin = process.stdin;
	const stdout = process.stdout;
	let cursor = 0;
	const labelWidth = Math.max(...options.map((o) => o.value.length));
	let linesRendered = 0;

	const render = () => {
		if (linesRendered > 0) {
			readline.moveCursor(stdout, 0, -linesRendered);
			readline.clearScreenDown(stdout);
		}
		const lines: string[] = [];
		lines.push(chalk.cyan(message));
		for (let i = 0; i < options.length; i++) {
			const opt = options[i]!;
			const active = i === cursor;
			const selected = initiallySelected.has(opt.value);
			const pointer = active ? chalk.cyan("▸") : " ";
			const mark = multi
				? selected
					? chalk.green("●")
					: chalk.gray("○")
				: active
					? chalk.cyan("●")
					: chalk.gray("○");
			const label = opt.value.padEnd(labelWidth);
			const coloredLabel = active ? chalk.white(label) : chalk.gray(label);
			const hint = opt.hint ? "  " + chalk.gray(opt.hint) : "";
			lines.push(`${pointer} ${mark} ${coloredLabel}${hint}`);
		}
		const footer = multi
			? "↑↓ move · space toggle · enter confirm · ctrl-c cancel"
			: "↑↓ move · enter confirm · ctrl-c cancel";
		lines.push(chalk.gray(`  ${footer}`));
		stdout.write(lines.join("\n") + "\n");
		linesRendered = lines.length;
	};

	return new Promise((resolve) => {
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		stdout.write("\x1B[?25l"); // hide cursor

		const cleanup = () => {
			stdin.removeListener("data", onData);
			stdin.setRawMode?.(false);
			stdin.pause();
			stdout.write("\x1B[?25h"); // show cursor
		};

		const onData = (key: string) => {
			if (key === "") {
				cleanup();
				resolve(null);
				return;
			}
			if (key === "\r" || key === "\n") {
				cleanup();
				if (!multi) {
					resolve(new Set([options[cursor]!.value]));
				} else {
					resolve(initiallySelected);
				}
				return;
			}
			if (multi && key === " ") {
				const v = options[cursor]!.value;
				if (initiallySelected.has(v)) initiallySelected.delete(v);
				else initiallySelected.add(v);
				render();
				return;
			}
			if (key === "\x1B[A" || key === "k") {
				cursor = (cursor - 1 + options.length) % options.length;
				render();
				return;
			}
			if (key === "\x1B[B" || key === "j") {
				cursor = (cursor + 1) % options.length;
				render();
				return;
			}
		};

		stdin.on("data", onData);
		render();
	});
}

async function askMulti<T extends string>(
	message: string,
	options: SelectOption<T>[],
	defaultSelected?: T[],
): Promise<T[] | null> {
	if (!process.stdin.isTTY) {
		return defaultSelected ?? options.map((o) => o.value);
	}
	const initial = new Set<T>(defaultSelected ?? options.map((o) => o.value));
	const result = await runInteractiveSelect(message, options, true, initial);
	if (!result) return null;
	return options.map((o) => o.value).filter((v) => result.has(v));
}

async function askOne<T extends string>(
	message: string,
	options: SelectOption<T>[],
): Promise<T | null> {
	if (!process.stdin.isTTY) return null;
	const result = await runInteractiveSelect(message, options, false, new Set<T>());
	if (!result) return null;
	return [...result][0] ?? null;
}

function parseModules(
	input: string | undefined,
	available: Array<{ value: string }>,
): string[] | null {
	if (!input) return available.map((o) => o.value);
	const chosen = input.split(",").map((s) => s.trim()).filter(Boolean);
	const valid = new Set(available.map((o) => o.value));
	const invalid = chosen.filter((c) => !valid.has(c));
	if (invalid.length > 0) {
		console.log(chalk.red(`Unknown module(s): ${invalid.join(", ")}`));
		console.log(chalk.gray(`  Valid: ${available.map((o) => o.value).join(", ")}`));
		return null;
	}
	if (chosen.length === 0) return null;
	return chosen;
}

function getEnvIdByAgent(agentType: string): string | null {
	const envPath = join(getClawdiDir(), "environments", `${agentType}.json`);
	if (!existsSync(envPath)) return null;
	return JSON.parse(readFileSync(envPath, "utf-8")).id;
}

function adapterForType(agentType: AgentType): AgentAdapter | null {
	if (agentType === "claude_code") return new ClaudeCodeAdapter();
	if (agentType === "hermes") return new HermesAdapter();
	if (agentType === "openclaw") return new OpenClawAdapter();
	if (agentType === "codex") return new CodexAdapter();
	return null;
}

function listRegisteredAgentTypes(): AgentType[] {
	const envDir = join(getClawdiDir(), "environments");
	if (!existsSync(envDir)) return [];
	const types: AgentType[] = [];
	for (const file of readdirSync(envDir)) {
		if (!file.endsWith(".json")) continue;
		const name = file.slice(0, -".json".length) as AgentType;
		if (AGENT_TYPES.includes(name)) types.push(name);
	}
	return types;
}

async function selectAdapter(agentOpt?: string): Promise<AgentAdapter | null> {
	// 1. Explicit --agent wins.
	if (agentOpt) {
		if (!AGENT_TYPES.includes(agentOpt as AgentType)) {
			console.log(chalk.red(`Unknown agent type: ${agentOpt}`));
			console.log(chalk.gray(`Valid types: ${AGENT_TYPES.join(", ")}`));
			return null;
		}
		const adapter = adapterForType(agentOpt as AgentType);
		if (!adapter) {
			console.log(chalk.red(`Agent ${agentOpt} has no adapter implementation.`));
			return null;
		}
		return adapter;
	}

	// 2. Prefer registered environments.
	const registered = listRegisteredAgentTypes().filter((t) => adapterForType(t));
	if (registered.length === 1) return adapterForType(registered[0]!);
	if (registered.length > 1) {
		const picked = await askOne<AgentType>(
			"Multiple agents registered. Select one:",
			registered.map((t) => ({ value: t, label: AGENT_LABELS[t] })),
		);
		return picked ? adapterForType(picked) : null;
	}

	// 3. Fall back to detection.
	const allAdapters: AgentAdapter[] = [
		new ClaudeCodeAdapter(),
		new HermesAdapter(),
		new OpenClawAdapter(),
		new CodexAdapter(),
	];
	const detected = (
		await Promise.all(allAdapters.map(async (a) => ((await a.detect()) ? a : null)))
	).filter((a): a is AgentAdapter => a !== null);
	if (detected.length === 0) return null;
	if (detected.length === 1) return detected[0]!;
	const picked = await askOne<AgentType>(
		"Multiple agents detected. Select one:",
		detected.map((a) => ({ value: a.agentType, label: AGENT_LABELS[a.agentType] })),
	);
	return picked ? adapterForType(picked) : null;
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
	{ value: "skills", label: "Skills", hint: "skill directories as tar.gz" },
];

const DOWN_MODULES = [
	{ value: "skills", label: "Skills", hint: "pull skill archives to agent directories" },
];

export async function syncUp(opts: {
	modules?: string;
	since?: string;
	project?: string;
	all?: boolean;
	dryRun?: boolean;
	agent?: string;
}) {
	if (!opts.dryRun && !isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		return;
	}

	const adapter = await selectAdapter(opts.agent);
	if (!adapter) {
		console.log(chalk.red("No supported agent detected on this machine."));
		return;
	}

	const envId = getEnvIdByAgent(adapter.agentType);
	if (!opts.dryRun && !envId) {
		console.log(chalk.red("No environment registered. Run `clawdi setup` first."));
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
			console.log(chalk.gray("Cancelled."));
			return;
		}
		modules = picked;
	}
	if (modules.length === 0) {
		console.log(chalk.gray("Nothing to sync."));
		return;
	}

	console.log(chalk.gray(`Agent:   ${AGENT_LABELS[adapter.agentType]}`));
	console.log(chalk.gray(`Modules: ${modules.join(", ")}`));

	// 2. Scan data
	const syncState = getSyncState();
	const since = opts.since
		? new Date(opts.since)
		: syncState.sessions?.lastSyncedAt
			? new Date(syncState.sessions.lastSyncedAt)
			: undefined;
	const projectFilter = opts.all ? undefined : (opts.project ?? process.cwd());

	if (
		adapter.agentType === "hermes" &&
		modules.includes("sessions") &&
		projectFilter !== undefined
	) {
		console.log(
			chalk.yellow("⚠ Hermes does not support project filtering; syncing all sessions."),
		);
		console.log(chalk.gray("  Use --all to suppress this notice."));
	}

	let sessions: RawSession[] = [];
	let skills: RawSkill[] = [];

	console.log();
	console.log(chalk.cyan("→ Scanning local data..."));
	if (modules.includes("sessions")) {
		sessions = await adapter.collectSessions(since, projectFilter);
	}
	if (modules.includes("skills")) {
		skills = await adapter.collectSkills();
	}

	// 3. Summary
	console.log();
	console.log(chalk.bold("Summary"));
	if (modules.includes("sessions")) {
		console.log(chalk.gray(`  Sessions: ${sessions.length} to upload`));
	}
	if (modules.includes("skills")) {
		console.log(chalk.gray(`  Skills:   ${skills.length} to upload`));
	}
	console.log();

	if (sessions.length === 0 && skills.length === 0) {
		console.log(chalk.gray("Nothing to sync."));
		return;
	}

	// 4. Confirm
	if (opts.dryRun) {
		console.log(chalk.gray("Dry run complete."));
		return;
	}
	const ok = await askYesNo("Proceed with upload?");
	if (!ok) {
		console.log(chalk.gray("Cancelled."));
		return;
	}

	// 5. Execute
	const api = new ApiClient();

	if (sessions.length > 0) {
		console.log(chalk.cyan(`→ Uploading ${sessions.length} sessions...`));
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
			console.log(
				chalk.green(`  ✓ Synced ${result.synced} session${result.synced === 1 ? "" : "s"}`),
			);

			// Upload session content (messages) for new sessions
			if (result.synced > 0) {
				console.log(chalk.cyan("→ Uploading session content..."));
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
					} catch {
						// Session might already exist, skip
					}
				}
				console.log(
					chalk.green(`  ✓ Uploaded ${uploaded} session content${uploaded === 1 ? "" : "s"}`),
				);
			}
		} catch (e: any) {
			console.log(chalk.red(`  ✗ Failed: ${e.message}`));
		}
		syncState.sessions = { lastSyncedAt: new Date().toISOString() };
	}

	if (skills.length > 0) {
		console.log(chalk.cyan(`→ Uploading ${skills.length} skills...`));
		let synced = 0;
		const failed: { key: string; error: string }[] = [];
		for (const skill of skills) {
			try {
				const tarBytes = await tarSkillDir(skill.directoryPath);
				await api.uploadFile(
					"/api/skills/upload",
					{ skill_key: skill.skillKey },
					tarBytes,
					`${skill.skillKey}.tar.gz`,
				);
				synced++;
			} catch (e: any) {
				failed.push({ key: skill.skillKey, error: e?.message ?? String(e) });
			}
		}
		console.log(
			chalk.green(`  ✓ Synced ${synced}/${skills.length} skill${skills.length === 1 ? "" : "s"}`),
		);
		for (const f of failed) {
			console.log(chalk.red(`  ✗ ${f.key}: ${f.error}`));
		}
		syncState.skills = { lastSyncedAt: new Date().toISOString() };
	}

	saveSyncState(syncState);
	console.log();
	console.log(chalk.green("✓ Sync complete"));
}

export async function syncDown(opts: { modules?: string; dryRun?: boolean; agent?: string }) {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		return;
	}

	const adapter = await selectAdapter(opts.agent);
	if (!adapter) {
		console.log(chalk.red("No supported agent detected on this machine."));
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
			console.log(chalk.gray("Cancelled."));
			return;
		}
		modules = picked;
	}
	if (modules.length === 0) {
		console.log(chalk.gray("Nothing to download."));
		return;
	}

	console.log(chalk.gray(`Agent:   ${AGENT_LABELS[adapter.agentType]}`));
	console.log(chalk.gray(`Modules: ${modules.join(", ")}`));

	const api = new ApiClient();

	// 2. Fetch skill list from cloud
	let cloudSkills: Array<{ skill_key: string; name: string }> = [];

	console.log();
	console.log(chalk.cyan("→ Fetching from cloud..."));
	if (modules.includes("skills")) {
		cloudSkills = await api.get("/api/skills");
	}

	// 3. Summary
	console.log();
	console.log(chalk.bold("Summary"));
	if (modules.includes("skills")) {
		const newCount = cloudSkills.filter(
			(s) => !existsSync(adapter.getSkillPath(s.skill_key)),
		).length;
		const existingCount = cloudSkills.length - newCount;
		console.log(
			chalk.gray(
				`  Skills: ${cloudSkills.length} in cloud (${newCount} new, ${existingCount} existing)`,
			),
		);
	}
	console.log();

	if (cloudSkills.length === 0) {
		console.log(chalk.gray("Nothing to download."));
		return;
	}

	// 4. Confirm
	if (opts.dryRun) {
		console.log(chalk.gray("Dry run complete."));
		return;
	}
	const ok = await askYesNo("Proceed with download?");
	if (!ok) {
		console.log(chalk.gray("Cancelled."));
		return;
	}

	// 5. Download tar.gz archives and extract
	let pulled = 0;
	for (const skill of cloudSkills) {
		const dest = adapter.getSkillPath(skill.skill_key);
		if (existsSync(dest)) {
			const overwrite = await askYesNo(`${skill.skill_key} already exists. Overwrite?`, false);
			if (!overwrite) {
				console.log(chalk.gray(`  ${skill.skill_key} skipped`));
				continue;
			}
		}

		try {
			const tarBytes = await api.getBytes(`/api/skills/${skill.skill_key}/download`);
			await adapter.writeSkillArchive(skill.skill_key, tarBytes);
			const skillDir = dirname(adapter.getSkillPath(skill.skill_key));
			console.log(chalk.gray(`  ${skill.skill_key} → ${skillDir}/ (${tarBytes.length} bytes)`));
			pulled++;
		} catch (e: any) {
			console.log(chalk.yellow(`  ${skill.skill_key} failed: ${e.message}`));
		}
	}
	console.log();
	console.log(chalk.green(`✓ Pulled ${pulled} skill${pulled === 1 ? "" : "s"}`));
}
