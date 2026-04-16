import chalk from "chalk";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENT_LABELS } from "@clawdi-cloud/shared/consts";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import type { AgentAdapter } from "../adapters/base";
import { ApiClient } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";

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
		// Add other adapters as they are implemented
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
		console.log(`  ${chalk.white(s.skill_key)}  v${s.version}  ${chalk.gray(s.source)}${repo}`);
	}
	console.log(chalk.gray(`\n  ${skills.length} skills total`));
}

export async function skillsAdd(path: string) {
	requireAuth();
	const content = readFileSync(path, "utf-8");
	const key = basename(path, ".md");
	const api = new ApiClient();

	const result = await api.post<{ skill_key: string; version: number }>("/api/skills", {
		skill_key: key,
		name: key,
		content,
	});

	console.log(chalk.green(`✓ Uploaded ${result.skill_key} (v${result.version})`));
}

export async function skillsInstall(repoInput: string) {
	// Parse "owner/repo" or "owner/repo/path" or full GitHub URL
	const parts = repoInput.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "").split("/");
	if (parts.length < 2) {
		console.log(chalk.red("Invalid format. Use owner/repo or owner/repo/path"));
		return;
	}
	const repo = `${parts[0]}/${parts[1]}`;
	const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;

	// 1. Fetch SKILL.md from GitHub
	console.log(chalk.cyan(`Fetching from ${repo}${path ? `/${path}` : ""}...`));

	const searchPaths: string[] = [];
	if (path) {
		searchPaths.push(`${path}/SKILL.md`);
		searchPaths.push(`skills/${path}/SKILL.md`);
	}
	searchPaths.push("SKILL.md");

	let content: string | null = null;
	for (const sp of searchPaths) {
		for (const branch of ["main", "master"]) {
			const url = `https://raw.githubusercontent.com/${repo}/${branch}/${sp}`;
			const resp = await fetch(url);
			if (resp.ok) {
				content = await resp.text();
				break;
			}
		}
		if (content) break;
	}

	if (!content) {
		console.log(chalk.red(`No SKILL.md found in ${repo}${path ? `/${path}` : ""}`));
		return;
	}

	// Parse frontmatter for name
	const fmMatch = content.match(/^---\s*\n(.*?)\n---/s);
	let skillName = path || repo.split("/")[1];
	if (fmMatch) {
		const nameLine = fmMatch[1].split("\n").find((l) => l.startsWith("name:"));
		if (nameLine) skillName = nameLine.split(":").slice(1).join(":").trim();
	}
	const skillKey = skillName.toLowerCase().replace(/\s+/g, "-");

	// 2. Write to all registered agents' skill directories
	const adapters = getRegisteredAdapters();
	if (adapters.length === 0) {
		console.log(chalk.yellow("No agents registered. Run `clawdi setup` first."));
		console.log(chalk.gray("Skill will only be saved to cloud."));
	}

	for (const adapter of adapters) {
		await adapter.writeSkill(skillKey, content);
		const skillPath = adapter.getSkillPath(skillKey);
		console.log(chalk.green(`  ✓ ${AGENT_LABELS[adapter.agentType]} → ${skillPath}`));
	}

	// 3. Upload to cloud for cross-device sync
	if (isLoggedIn()) {
		try {
			const api = new ApiClient();
			await api.post("/api/skills/install", { repo, path });
			console.log(chalk.green("  ✓ Synced to cloud"));
		} catch {
			console.log(chalk.yellow("  ⚠ Cloud sync failed (skill saved locally)"));
		}
	}

	console.log(chalk.green(`\n✓ Installed ${skillName} from ${repo}`));
}

export async function skillsRm(key: string) {
	requireAuth();
	const api = new ApiClient();
	await api.delete(`/api/skills/${key}`);
	console.log(chalk.green(`✓ Removed ${key}`));
}
