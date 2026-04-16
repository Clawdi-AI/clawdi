import chalk from "chalk";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ApiClient } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		process.exit(1);
	}
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
		console.log(`  ${chalk.white(s.skill_key)}  v${s.version}  ${chalk.gray(s.source)}`);
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
	requireAuth();
	const api = new ApiClient();

	// Parse "owner/repo" or "owner/repo/path"
	const parts = repoInput.replace(/^https?:\/\/github\.com\//, "").split("/");
	const repo = `${parts[0]}/${parts[1]}`;
	const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;

	try {
		const result = await api.post<{ skill_key: string; name: string; repo: string; version: number }>(
			"/api/skills/install",
			{ repo, path },
		);
		console.log(chalk.green(`✓ Installed ${result.name} from ${result.repo} (v${result.version})`));
	} catch (e: any) {
		console.log(chalk.red(`Failed to install: ${e.message}`));
	}
}

export async function skillsRm(key: string) {
	requireAuth();
	const api = new ApiClient();
	await api.delete(`/api/skills/${key}`);
	console.log(chalk.green(`✓ Removed ${key}`));
}
