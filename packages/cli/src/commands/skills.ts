import chalk from "chalk";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { AGENT_LABELS, AGENT_TYPES, type AgentType } from "@clawdi-cloud/shared/consts";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import { CodexAdapter } from "../adapters/codex";
import { HermesAdapter } from "../adapters/hermes";
import { OpenClawAdapter } from "../adapters/openclaw";
import type { AgentAdapter } from "../adapters/base";
import { ApiClient } from "../lib/api-client";
import {
	addExtraSkillPath,
	getClawdiDir,
	isKnownAgent,
	isLoggedIn,
	listExtraSkillPaths,
	removeExtraSkillPath,
} from "../lib/config";
import { tarSkillDir, tarSingleFile } from "../lib/tar-helpers";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		process.exit(1);
	}
}

function getRegisteredAdapters(): AgentAdapter[] {
	const envDir = join(getClawdiDir(), "environments");
	if (!existsSync(envDir)) return [];

	const adapters: AgentAdapter[] = [];
	for (const file of readdirSync(envDir)) {
		if (file === "claude_code.json") adapters.push(new ClaudeCodeAdapter());
		else if (file === "hermes.json") adapters.push(new HermesAdapter());
		else if (file === "openclaw.json") adapters.push(new OpenClawAdapter());
		else if (file === "codex.json") adapters.push(new CodexAdapter());
	}
	return adapters;
}

export async function skillsList() {
	requireAuth();
	const api = new ApiClient();
	const skills = await api.get<any[]>("/api/skills");

	if (skills.length === 0) {
		console.log(chalk.gray("No skills synced."));
		return;
	}

	for (const s of skills) {
		const repo = s.source_repo ? chalk.gray(` (${s.source_repo})`) : "";
		const files = s.file_count ? chalk.gray(` ${s.file_count} files`) : "";
		console.log(`  ${chalk.white(s.skill_key)}  v${s.version}  ${chalk.gray(s.source)}${repo}${files}`);
	}
	console.log(chalk.gray(`\n  ${skills.length} skill${skills.length === 1 ? "" : "s"} total`));
}

export async function skillsAdd(path: string) {
	requireAuth();
	const resolved = resolve(path);
	const stat = statSync(resolved);
	const api = new ApiClient();

	let tarBytes: Buffer;
	let skillKey: string;

	if (stat.isDirectory()) {
		const skillMdPath = join(resolved, "SKILL.md");
		if (!existsSync(skillMdPath)) {
			console.log(chalk.red("Directory must contain a SKILL.md"));
			return;
		}
		skillKey = basename(resolved);
		tarBytes = await tarSkillDir(resolved);
	} else {
		skillKey = basename(resolved, ".md");
		const content = readFileSync(resolved, "utf-8");
		tarBytes = await tarSingleFile(skillKey, content);
	}

	const result = await api.uploadFile<{ skill_key: string; version: number; file_count: number }>(
		"/api/skills/upload",
		{ skill_key: skillKey },
		tarBytes,
		`${skillKey}.tar.gz`,
	);

	console.log(chalk.green(`✓ Uploaded ${result.skill_key} (v${result.version}, ${result.file_count} files)`));
}

export async function skillsInstall(repoInput: string) {
	requireAuth();

	// Parse "owner/repo" or "owner/repo/path" or full GitHub URL
	const parts = repoInput.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "").split("/");
	if (parts.length < 2) {
		console.log(chalk.red("Invalid format. Use owner/repo or owner/repo/path"));
		return;
	}
	const repo = `${parts[0]}/${parts[1]}`;
	const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;

	console.log(chalk.cyan(`Fetching from ${repo}${path ? `/${path}` : ""}...`));

	const api = new ApiClient();

	// 1. Install via backend (fetches full directory, packages tar.gz)
	let installResult: { skill_key: string; name: string; version: number; file_count: number };
	try {
		installResult = await api.post("/api/skills/install", { repo, path });
	} catch (e: any) {
		console.log(chalk.red(`Failed: ${e.message}`));
		return;
	}

	// 2. Download tar.gz and extract to local agent directories
	const adapters = getRegisteredAdapters();
	if (adapters.length > 0) {
		try {
			const tarBytes = await api.getBytes(`/api/skills/${installResult.skill_key}/download`);

			for (const adapter of adapters) {
				await adapter.writeSkillArchive(installResult.skill_key, tarBytes);
				const skillDir = dirname(adapter.getSkillPath(installResult.skill_key));
				console.log(chalk.green(`  ✓ ${AGENT_LABELS[adapter.agentType]} → ${skillDir}/ (${installResult.file_count} files)`));
			}
		} catch (e: any) {
			console.log(chalk.yellow(`  ⚠ Local install failed: ${e.message}`));
		}
	}

	console.log(chalk.green(`\n✓ Installed ${installResult.name} (v${installResult.version}, ${installResult.file_count} files)`));
}

export async function skillsRm(key: string) {
	requireAuth();
	const api = new ApiClient();
	await api.delete(`/api/skills/${key}`);
	console.log(chalk.green(`✓ Removed ${key}`));
}

function unknownAgentMessage(agent: string): void {
	console.log(chalk.red(`Unknown agent: ${agent}`));
	console.log(chalk.gray(`  Valid: ${AGENT_TYPES.join(", ")}`));
}

export function skillSourceList() {
	const all = listExtraSkillPaths();
	const entries = Object.entries(all) as [AgentType, string[]][];
	if (entries.length === 0) {
		console.log(chalk.gray("No extra skill paths configured."));
		console.log(
			chalk.gray(
				"  Add one with: clawdi skill source add <agent> <path>\n" +
					"  Supported agents: " +
					AGENT_TYPES.join(", "),
			),
		);
		return;
	}
	for (const [agent, paths] of entries) {
		console.log(chalk.cyan(AGENT_LABELS[agent] ?? agent));
		for (const p of paths ?? []) {
			const marker = existsSync(p) ? chalk.green("✓") : chalk.yellow("!");
			const note = existsSync(p) ? "" : chalk.gray(" (missing)");
			console.log(`  ${marker} ${p}${note}`);
		}
	}
}

export function skillSourceAdd(agent: string, path: string) {
	if (!isKnownAgent(agent)) {
		unknownAgentMessage(agent);
		process.exit(1);
	}
	const resolved = resolve(path);
	if (!existsSync(resolved)) {
		console.log(chalk.yellow(`Warning: ${resolved} does not exist (added anyway).`));
	}
	addExtraSkillPath(agent, resolved);
	console.log(chalk.green(`✓ Added ${resolved} to ${agent} skill sources`));
}

export function skillSourceRemove(agent: string, path: string) {
	if (!isKnownAgent(agent)) {
		unknownAgentMessage(agent);
		process.exit(1);
	}
	const removed = removeExtraSkillPath(agent, path);
	if (!removed) {
		console.log(chalk.yellow(`${path} was not configured for ${agent}.`));
		process.exit(1);
	}
	console.log(chalk.green(`✓ Removed ${path} from ${agent} skill sources`));
}
