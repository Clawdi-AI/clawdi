import { existsSync } from "node:fs";
import { dirname } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { adapterRegistry } from "../adapters/registry";
import { ApiClient, unwrap } from "../lib/api-client";
import type { SkillSummary } from "../lib/api-schemas";
import { isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { askMulti, askYesNo, parseModules } from "../lib/prompts";
import { sanitizeMetadata } from "../lib/sanitize";
import { selectAdapter } from "../lib/select-adapter";

const DOWN_MODULES = [
	{ value: "skills", label: "Skills", hint: "pull skill archives to agent directories" },
];

export async function pull(opts: { modules?: string; dryRun?: boolean; agent?: string }) {
	p.intro(chalk.bold("clawdi pull"));

	if (!isLoggedIn()) {
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

	let modules: string[];
	if (opts.modules) {
		const parsed = parseModules(opts.modules, DOWN_MODULES);
		if (!parsed) return;
		modules = parsed;
	} else {
		const picked = await askMulti("Modules to download:", DOWN_MODULES);
		if (!picked) {
			p.outro(chalk.gray("Cancelled."));
			return;
		}
		modules = picked;
	}
	if (modules.length === 0) {
		p.outro(chalk.gray("Nothing to download."));
		return;
	}

	p.log.info(`Agent:   ${adapterRegistry[adapter.agentType].displayName}`);
	p.log.info(`Modules: ${modules.join(", ")}`);

	const api = new ApiClient();

	let cloudSkills: SkillSummary[] = [];

	const fetchSpinner = p.spinner();
	fetchSpinner.start("Fetching from cloud...");
	if (modules.includes("skills")) {
		const page = unwrap(await api.GET("/api/skills", { params: { query: { page_size: 200 } } }));
		cloudSkills = page.items;
	}
	fetchSpinner.stop(
		`Found ${cloudSkills.length} skill${cloudSkills.length === 1 ? "" : "s"} in cloud`,
	);

	if (modules.includes("skills")) {
		const newCount = cloudSkills.filter(
			(s) => !existsSync(adapter.getSkillPath(s.skill_key)),
		).length;
		const existingCount = cloudSkills.length - newCount;
		p.log.message(chalk.gray(`${newCount} new, ${existingCount} existing`));
	}

	if (cloudSkills.length === 0) {
		p.outro(chalk.gray("Nothing to download."));
		return;
	}

	if (opts.dryRun) {
		p.outro(chalk.gray("Dry run complete."));
		return;
	}
	const ok = await askYesNo("Proceed with download?");
	if (!ok) {
		p.outro(chalk.gray("Cancelled."));
		return;
	}

	let pulled = 0;
	for (const skill of cloudSkills) {
		const safeKey = sanitizeMetadata(skill.skill_key);
		const dest = adapter.getSkillPath(skill.skill_key);
		if (existsSync(dest)) {
			const overwrite = await askYesNo(`${safeKey} already exists. Overwrite?`, false);
			if (!overwrite) {
				p.log.info(`${safeKey} skipped`);
				continue;
			}
		}

		try {
			const tarBytes = await api.getBytes(`/api/skills/${skill.skill_key}/download`);
			await adapter.writeSkillArchive(skill.skill_key, tarBytes);
			const skillDir = dirname(adapter.getSkillPath(skill.skill_key));
			p.log.success(`${safeKey} → ${skillDir}/ (${tarBytes.length} bytes)`);
			pulled++;
		} catch (e) {
			p.log.warn(`${safeKey} failed: ${errMessage(e)}`);
		}
	}
	p.outro(chalk.green(`✓ Pulled ${pulled} skill${pulled === 1 ? "" : "s"}`));
}
