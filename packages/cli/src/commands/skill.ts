import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import type { AgentAdapter } from "../adapters/base";
import { adapterRegistry } from "../adapters/registry";
import { ApiClient, ApiError } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";
import { parseFrontmatter } from "../lib/frontmatter";
import { sanitizeMetadata, sanitizeName } from "../lib/sanitize";
import { type ParsedSource, parseSource } from "../lib/source-parser";
import { tarSingleFile, tarSkillDir } from "../lib/tar";
import { isInteractive } from "../lib/tty";

interface SkillRow {
	skill_key: string;
	version?: number;
	source?: string;
	source_repo?: string;
	file_count?: number;
	name?: string;
	description?: string;
}

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
}

function getRegisteredAdapters(): AgentAdapter[] {
	const envDir = join(getClawdiDir(), "environments");
	if (!existsSync(envDir)) return [];

	const files = new Set(readdirSync(envDir));
	const adapters: AgentAdapter[] = [];
	for (const entry of Object.values(adapterRegistry)) {
		if (files.has(entry.envFileName)) adapters.push(entry.create());
	}
	return adapters;
}

function countFiles(dir: string): number {
	let count = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) count += countFiles(full);
		else count++;
	}
	return count;
}

export async function skillList(opts: { json?: boolean } = {}) {
	requireAuth();
	const api = new ApiClient();
	const skills = await api.get<SkillRow[]>("/api/skills");

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(skills, null, 2));
		return;
	}

	if (skills.length === 0) {
		console.log(chalk.gray("No skills uploaded."));
		return;
	}

	for (const s of skills) {
		const key = sanitizeMetadata(s.skill_key);
		const src = s.source ? sanitizeMetadata(s.source) : "";
		const repo = s.source_repo ? chalk.gray(` (${sanitizeMetadata(s.source_repo)})`) : "";
		const files = s.file_count ? chalk.gray(` ${s.file_count} files`) : "";
		console.log(`  ${chalk.white(key)}  v${s.version ?? "?"}  ${chalk.gray(src)}${repo}${files}`);
	}
	console.log(chalk.gray(`\n  ${skills.length} skill${skills.length === 1 ? "" : "s"} total`));
}

export async function skillAdd(path: string, opts: { yes?: boolean } = {}) {
	requireAuth();
	const resolved = resolve(path);
	const stat = statSync(resolved);
	const api = new ApiClient();

	let tarBytes: Buffer;
	let skillKey: string;
	let skillName: string | undefined;
	let skillDescription: string | undefined;
	let fileCount: number | undefined;
	let skillMdSource: string;

	if (stat.isDirectory()) {
		const skillMdPath = join(resolved, "SKILL.md");
		if (!existsSync(skillMdPath)) {
			console.log(chalk.red("Directory must contain a SKILL.md"));
			process.exit(1);
		}
		skillMdSource = readFileSync(skillMdPath, "utf-8");
		skillKey = sanitizeName(basename(resolved));
		fileCount = countFiles(resolved);
		tarBytes = await tarSkillDir(resolved);
	} else {
		skillMdSource = readFileSync(resolved, "utf-8");
		skillKey = sanitizeName(basename(resolved, ".md"));
		fileCount = 1;
		tarBytes = await tarSingleFile(skillKey, skillMdSource);
	}

	// Parse frontmatter for preview. We require name + description to avoid
	// uploading skills that agents can't meaningfully surface.
	const { data } = parseFrontmatter(skillMdSource);
	if (!data.name || !data.description) {
		console.log(chalk.red("SKILL.md must declare both `name` and `description` in frontmatter."));
		console.log(
			chalk.gray("  Example:\n    ---\n    name: my-skill\n    description: what it does\n    ---"),
		);
		process.exit(1);
	}
	skillName = sanitizeMetadata(data.name);
	skillDescription = sanitizeMetadata(data.description);

	// Preview + confirm (skippable with --yes or in non-interactive mode)
	if (isInteractive() && !opts.yes) {
		p.note(
			`name:        ${skillName}\n` +
				`description: ${skillDescription}\n` +
				`skill_key:   ${skillKey}\n` +
				`files:       ${fileCount}`,
			"Skill to upload",
		);
		const ok = await p.confirm({ message: "Upload this skill?", initialValue: true });
		if (p.isCancel(ok) || !ok) {
			p.cancel("Cancelled.");
			return;
		}
	}

	const result = await api.uploadFile<{ skill_key: string; version: number; file_count: number }>(
		"/api/skills/upload",
		{ skill_key: skillKey },
		tarBytes,
		`${skillKey}.tar.gz`,
	);

	console.log(
		chalk.green(
			`✓ Uploaded ${sanitizeMetadata(result.skill_key)} (v${result.version}, ${result.file_count} files)`,
		),
	);
}

export async function skillInstall(
	repoInput: string,
	opts: { agent?: string; list?: boolean; yes?: boolean } = {},
) {
	requireAuth();

	let parsed: ParsedSource;
	try {
		parsed = parseSource(repoInput);
	} catch (e) {
		console.log(chalk.red((e as Error).message));
		process.exit(1);
	}

	if (parsed.type !== "github") {
		console.log(
			chalk.red(`Only GitHub sources are supported by the backend for now (got ${parsed.type}).`),
		);
		process.exit(1);
	}

	const repo = `${parsed.owner}/${parsed.repo}`;
	const path = parsed.path;

	// --list mode: we don't have a backend endpoint that merely lists; the install
	// endpoint actually performs the install. Until a dedicated list endpoint
	// exists, surface this clearly rather than silently installing.
	if (opts.list) {
		console.log(
			chalk.yellow(
				"--list is not supported yet. The backend installs in a single call; a preview endpoint is planned.",
			),
		);
		process.exit(2);
	}

	console.log(chalk.cyan(`Fetching from ${repo}${path ? `/${path}` : ""}...`));

	const api = new ApiClient();

	const installResult = await api.post<{
		skill_key: string;
		name: string;
		version: number;
		file_count: number;
	}>("/api/skills/install", { repo, path });

	// Select adapters to install to.
	let adapters = getRegisteredAdapters();
	if (opts.agent) {
		adapters = adapters.filter((a) => a.agentType === opts.agent);
		if (adapters.length === 0) {
			const entry = Object.values(adapterRegistry).find((e) => e.agentType === opts.agent);
			if (!entry) {
				console.log(
					chalk.red(
						`Unknown agent "${opts.agent}". Valid: ${Object.keys(adapterRegistry).join(", ")}`,
					),
				);
			} else {
				console.log(
					chalk.yellow(
						`Agent ${entry.displayName} is not registered. Run \`clawdi setup --agent ${opts.agent}\` first.`,
					),
				);
			}
			console.log(
				chalk.gray(
					`  The skill was installed in the cloud as ${sanitizeMetadata(installResult.skill_key)} — run \`clawdi pull\` later to fetch it.`,
				),
			);
			process.exit(1);
		}
	}

	const failed: Array<{ agent: string; error: string }> = [];
	if (adapters.length > 0) {
		let tarBytes: Buffer;
		try {
			tarBytes = await api.getBytes(`/api/skills/${installResult.skill_key}/download`);
		} catch (e) {
			console.log(
				chalk.red(`✗ Download failed: ${e instanceof ApiError ? e.message : (e as Error).message}`),
			);
			console.log(
				chalk.gray(
					`  Cloud install succeeded as ${sanitizeMetadata(installResult.skill_key)}; retry with \`clawdi pull\`.`,
				),
			);
			process.exit(1);
		}

		for (const adapter of adapters) {
			const label = adapterRegistry[adapter.agentType].displayName;
			try {
				await adapter.writeSkillArchive(installResult.skill_key, tarBytes);
				const skillDir = dirname(adapter.getSkillPath(installResult.skill_key));
				console.log(chalk.green(`  ✓ ${label} → ${skillDir}/ (${installResult.file_count} files)`));
			} catch (e) {
				failed.push({ agent: adapter.agentType, error: (e as Error).message });
				console.log(chalk.red(`  ✗ ${label} failed: ${(e as Error).message}`));
			}
		}
	}

	console.log(
		chalk.green(
			`\n✓ Installed ${sanitizeMetadata(installResult.name)} in cloud (v${installResult.version}, ${installResult.file_count} files)`,
		),
	);

	if (failed.length > 0) {
		console.log();
		console.log(
			chalk.yellow(
				`  ${failed.length} agent${failed.length === 1 ? "" : "s"} did not receive the skill locally.`,
			),
		);
		for (const f of failed) {
			console.log(
				chalk.gray(
					`    • ${adapterRegistry[f.agent as keyof typeof adapterRegistry]?.displayName ?? f.agent}: ${f.error}`,
				),
			);
		}
		console.log(chalk.gray(`  Retry those with: clawdi pull --agent <type>`));
		// If ALL targeted adapters failed, exit non-zero so scripts notice.
		if (adapters.length > 0 && failed.length === adapters.length) {
			process.exit(1);
		}
	}
}

export async function skillRm(key: string) {
	requireAuth();
	const api = new ApiClient();
	await api.delete(`/api/skills/${encodeURIComponent(key)}`);
	console.log(chalk.green(`✓ Removed ${sanitizeMetadata(key)}`));
}

export function skillInit(nameArg?: string) {
	const cwd = process.cwd();
	const hasName = Boolean(nameArg);
	const name = sanitizeName(nameArg ?? basename(cwd));
	const targetDir = hasName ? join(cwd, name) : cwd;
	const skillMd = join(targetDir, "SKILL.md");
	const displayPath = hasName ? `${name}/SKILL.md` : "SKILL.md";

	if (existsSync(skillMd)) {
		console.log(chalk.yellow(`A skill already exists at ${displayPath}`));
		return;
	}

	if (hasName) {
		mkdirSync(targetDir, { recursive: true });
	}

	const template = `---
name: ${name}
description: A brief description of what this skill does
---

# ${name}

Instructions for the agent to follow when this skill is activated.

## When to use

Describe the triggers: what the user says, what files they're looking at,
what task they're trying to accomplish.

## How to help

Step-by-step guidance, conventions, and examples.
`;
	writeFileSync(skillMd, template);
	console.log(chalk.green(`✓ Created ${displayPath}`));
}
