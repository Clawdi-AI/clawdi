import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import type { AgentAdapter } from "../adapters/base";
import { adapterRegistry } from "../adapters/registry";
import { ApiClient, unwrap } from "../lib/api-client";
import type { SkillSummary } from "../lib/api-schemas";
import { getClawdiAccessToken } from "../lib/clerk-oauth";
import { getConfig, isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { parseFrontmatter } from "../lib/frontmatter";
import { fetchGithubSkillArchive, readBoundedResponseBytes } from "../lib/github-skill-archive";
import { resolveProjectId } from "../lib/project-resolver";
import { sanitizeMetadata } from "../lib/sanitize";
import {
	fetchDefaultProjectId,
	fetchProjectIdForEnv,
	getEnvIdByAgent,
} from "../lib/select-adapter";
import { sanitizeSkillKey } from "../lib/skill-key";
import {
	readProjectSkillMaterialization,
	readSkillProjectionState,
	recordSkillProjectionClaim,
	removeProjectSkillMaterialization,
	removeSkillProjectionClaim,
} from "../lib/skills-lock";
import { type ParsedSource, parseSource } from "../lib/source-parser";
import { snapshotSkillArchive, tarSingleFile } from "../lib/tar";
import { isInteractive } from "../lib/tty";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
}

async function fetchAllSkills(api: ApiClient, projectId?: string): Promise<SkillSummary[]> {
	const items: SkillSummary[] = [];
	let page = 1;
	const pageSize = 200;
	while (page <= 50) {
		const result = unwrap(
			await api.GET("/v1/skills", {
				params: {
					query: projectId
						? { ...(page === 1 ? {} : { page }), page_size: pageSize, project_id: projectId }
						: { ...(page === 1 ? {} : { page }), page_size: pageSize },
				},
			}),
		);
		items.push(...result.items);
		if (items.length >= (result.total ?? items.length) || result.items.length === 0) break;
		page += 1;
	}
	if (page > 50) throw new Error("Too many skill pages to load safely.");
	return items;
}

interface SkillMutationTarget {
	projectId: string;
	agentId?: string;
	adapter?: AgentAdapter;
}

async function resolveAgentProjectTarget(
	api: ApiClient,
	projectId: string,
): Promise<SkillMutationTarget> {
	const project = unwrap(
		await api.GET("/v1/projects/{project_id}", {
			params: { path: { project_id: projectId } },
		}),
	);
	if (project.kind !== "environment") return { projectId };

	const agentId = project.origin_environment_id;
	if (!agentId) {
		throw new Error(
			"This Workspace no longer has a live Agent identity. Skill mutation is disabled.",
		);
	}
	const agent = unwrap(
		await api.GET("/v1/agents/{agent_id}", {
			params: { path: { agent_id: agentId } },
		}),
	);
	if (agent.default_project_id !== projectId) {
		throw new Error("The Workspace identity changed; refusing an unfenced Skill mutation.");
	}
	if (getEnvIdByAgent(agent.agent_type) !== agentId) {
		const machineName = agent.machine_name || "another machine";
		throw new Error(
			`This Workspace belongs to ${machineName}'s ${agent.agent_type} Agent. Run the command on that machine.`,
		);
	}
	const entry = adapterRegistry[agent.agent_type as keyof typeof adapterRegistry];
	if (!entry) throw new Error(`Unknown agent "${agent.agent_type}".`);
	return { projectId, agentId, adapter: entry.create() };
}

async function resolveSkillMutationTarget(
	api: ApiClient,
	opts: { agent?: string; project?: string },
): Promise<SkillMutationTarget> {
	if (opts.agent && opts.project) {
		throw new Error("Pass either --project or --agent, not both.");
	}
	if (opts.agent) {
		const agentId = getEnvIdByAgent(opts.agent);
		if (!agentId) {
			const entry = adapterRegistry[opts.agent as keyof typeof adapterRegistry];
			const label = entry ? entry.displayName : opts.agent;
			throw new Error(
				`No environment registered for ${label}. Run \`clawdi setup --agent ${opts.agent}\` first.`,
			);
		}
		const entry = adapterRegistry[opts.agent as keyof typeof adapterRegistry];
		if (!entry) throw new Error(`Unknown agent "${opts.agent}".`);
		return {
			projectId: await fetchProjectIdForEnv(api, agentId),
			agentId,
			adapter: entry.create(),
		};
	}

	let projectId: string;
	if (opts.project) {
		const cfg = getConfig();
		projectId = await resolveProjectId(
			cfg.apiUrl,
			await getClawdiAccessToken(cfg.apiUrl),
			opts.project,
		);
	} else {
		projectId = await fetchDefaultProjectId(api);
	}
	return await resolveAgentProjectTarget(api, projectId);
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

export { readBoundedResponseBytes };

async function installGithubSkillForAgent(
	api: ApiClient,
	source: Extract<ParsedSource, { type: "github" }>,
	target: SkillMutationTarget & { agentId: string; adapter: AgentAdapter },
): Promise<void> {
	const downloaded = await fetchGithubSkillArchive(source);

	// Local activation is authoritative and guarded by the adapter's managed
	// reservation boundary. No Cloud mutation occurs if this commit fails.
	await target.adapter.writeSkillArchive(downloaded.skillKey, downloaded.tarBytes);
	removeProjectSkillMaterialization({
		agentType: target.adapter.agentType,
		localSkillKey: downloaded.skillKey,
	});
	const committedDir = dirname(target.adapter.getSkillPath(downloaded.skillKey));
	const committedSnapshot = await snapshotSkillArchive(
		committedDir,
		undefined,
		downloaded.skillKey,
	);
	let result: Awaited<ReturnType<ApiClient["uploadAgentSkill"]>>;
	try {
		result = await api.uploadAgentSkill(
			target.agentId,
			target.projectId,
			downloaded.skillKey,
			committedSnapshot.archive,
			`${downloaded.skillKey}.tar.gz`,
			committedSnapshot.hash,
		);
	} catch (error) {
		console.log(
			chalk.yellow(
				`Installed ${sanitizeMetadata(downloaded.skillKey)} locally; the dashboard will retry the update the next time the daemon syncs.`,
			),
		);
		throw error;
	}
	recordSkillProjectionClaim({
		agentType: target.adapter.agentType,
		agentId: target.agentId,
		projectId: target.projectId,
		skillKey: downloaded.skillKey,
		hash: committedSnapshot.hash,
	});
	console.log(
		chalk.green(
			`✓ Installed ${sanitizeMetadata(result.name)} for ${adapterRegistry[target.adapter.agentType].displayName} (v${result.version}, ${result.file_count} files)`,
		),
	);
}

export async function skillList(opts: { json?: boolean; project?: string } = {}) {
	requireAuth();
	const api = new ApiClient();
	let projectId: string | undefined;
	if (opts.project) {
		const cfg = getConfig();
		projectId = await resolveProjectId(
			cfg.apiUrl,
			await getClawdiAccessToken(cfg.apiUrl),
			opts.project,
		);
	}
	const skills = await fetchAllSkills(api, projectId);

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

export async function skillAdd(
	path: string,
	opts: { yes?: boolean; agent?: string; project?: string } = {},
) {
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
	// File-tree hash for the directory case so the server can early-return
	// on identical re-uploads. Single-file case omits the hash and lets the
	// server compute its own from the synthesized tar — the saving doesn't
	// matter for one-shot ad-hoc uploads.
	let contentHash: string | undefined;

	if (stat.isDirectory()) {
		const skillMdPath = join(resolved, "SKILL.md");
		if (!existsSync(skillMdPath)) {
			console.log(chalk.red("Directory must contain a SKILL.md"));
			process.exit(1);
		}
		skillMdSource = readFileSync(skillMdPath, "utf-8");
		skillKey = sanitizeSkillKey(basename(resolved));
		fileCount = countFiles(resolved);
		// Tar the skill under the SANITIZED key so the archive's
		// directory entries match what the upload route expects.
		// `tarSkillDir(resolved)` would default to
		// `basename(resolved)`; for a directory like `My Skill`
		// the basename and the sanitized key (`my-skill`) differ
		// and the round-45 archive-root check would 400.
		//
		// We can't just pass `skillKey` to `tarSkillDir` — its
		// `tar.create` call resolves entries via cwd-relative
		// paths, and `<parent>/my-skill` isn't a real directory
		// when the on-disk name is `My Skill`. Stage a copy in a
		// tmpdir under the canonical name, tar that, then clean
		// up. Recursive copy is cheap for skill dirs (typically
		// < 1 MB) and avoids the symlink-escape footgun a
		// symbolic link would trip.
		const stagingRoot = mkdtempSync(join(tmpdir(), "clawdi-skill-stage-"));
		const stagedDir = join(stagingRoot, skillKey);
		try {
			cpSync(resolved, stagedDir, { recursive: true });
			// Pass BOTH the original parent dir AND the staging
			// dir as symlink trust roots. cpSync preserves
			// symlinks as symlinks (without dereferencing), so
			// the staged tree contains:
			//   * absolute symlinks pointing into the original
			//     skills tree (gstack-style sibling references
			//     like `<src>/SKILL.md → <src>/../gstack/<key>/...`)
			//     — these resolve OUTSIDE the staging tmpdir
			//     into the user's real skills tree;
			//   * relative in-skill symlinks (`link.txt → data.txt`)
			//     — these resolve INSIDE the staging dir.
			// Round-49 single-trust-root + dirname(resolved) only
			// covered case 1, so a relative-symlink-inside-skill
			// like `link.txt → data.txt` falsely escaped (its
			// realpath was `<staging>/data.txt`, outside the
			// original parent). Passing both roots accepts both
			// shapes; an out-of-tree leak (e.g. `→ /etc/passwd`)
			// still fails because /etc/passwd is in neither root.
			const snapshot = await snapshotSkillArchive(
				stagedDir,
				[dirname(resolved), stagingRoot],
				skillKey,
			);
			tarBytes = snapshot.archive;
			contentHash = snapshot.hash;
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	} else {
		skillMdSource = readFileSync(resolved, "utf-8");
		skillKey = sanitizeSkillKey(basename(resolved, ".md"));
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

	const target = await resolveSkillMutationTarget(api, opts);
	let result: Awaited<ReturnType<ApiClient["uploadSkill"]>>;
	if (target.agentId && target.adapter) {
		// The real adapter target is the commit point. An arbitrary source
		// directory is only input; it cannot become an Agent projection until
		// its validated archive has atomically activated under the skills root.
		await target.adapter.writeSkillArchive(skillKey, tarBytes);
		removeProjectSkillMaterialization({
			agentType: target.adapter.agentType,
			localSkillKey: skillKey,
		});
		const committedDir = dirname(target.adapter.getSkillPath(skillKey));
		const committedSnapshot = await snapshotSkillArchive(committedDir, undefined, skillKey);
		try {
			result = await api.uploadAgentSkill(
				target.agentId,
				target.projectId,
				skillKey,
				committedSnapshot.archive,
				`${skillKey}.tar.gz`,
				committedSnapshot.hash,
			);
		} catch (error) {
			console.log(
				chalk.yellow(
					`Saved ${sanitizeMetadata(skillKey)} in the Agent filesystem; the dashboard will retry the update the next time the daemon syncs.`,
				),
			);
			throw error;
		}
		recordSkillProjectionClaim({
			agentType: target.adapter.agentType,
			agentId: target.agentId,
			projectId: target.projectId,
			skillKey,
			hash: committedSnapshot.hash,
		});
	} else {
		result = await api.uploadSkill(
			target.projectId,
			skillKey,
			tarBytes,
			`${skillKey}.tar.gz`,
			contentHash,
		);
	}

	console.log(
		chalk.green(
			`✓ Uploaded ${sanitizeMetadata(result.skill_key)} (v${result.version}, ${result.file_count} files)`,
		),
	);
}

export async function skillInstall(
	repoInput: string,
	opts: { agent?: string; project?: string } = {},
) {
	requireAuth();

	let parsed: ParsedSource;
	try {
		parsed = parseSource(repoInput);
	} catch (e) {
		console.log(chalk.red(errMessage(e)));
		process.exit(1);
	}

	if (parsed.type !== "github") {
		console.log(
			chalk.red(`Only GitHub sources are supported by the backend for now (got ${parsed.type}).`),
		);
		process.exit(1);
	}
	if (opts.agent && opts.project) {
		console.log(chalk.red("Pass either --project or --agent, not both."));
		process.exit(1);
	}

	const api = new ApiClient();
	const target = await resolveSkillMutationTarget(api, opts);
	if (target.agentId && target.adapter) {
		console.log(
			chalk.cyan(
				`Fetching from ${parsed.owner}/${parsed.repo}${parsed.path ? `/${parsed.path}` : ""}...`,
			),
		);
		await installGithubSkillForAgent(api, parsed, {
			projectId: target.projectId,
			agentId: target.agentId,
			adapter: target.adapter,
		});
		return;
	}

	const repo = `${parsed.owner}/${parsed.repo}`;
	const path = parsed.path;

	console.log(chalk.cyan(`Fetching from ${repo}${path ? `/${path}` : ""}...`));

	const installResult = unwrap(
		await api.POST("/v1/projects/{project_id}/skills/install", {
			params: { path: { project_id: target.projectId } },
			body: { repo, path },
		}),
	);

	console.log(
		chalk.green(
			`\n✓ Installed ${sanitizeMetadata(installResult.name)} in cloud (v${installResult.version}, ${installResult.file_count} files)`,
		),
	);
}

export async function skillRm(key: string, opts: { agent?: string; project?: string } = {}) {
	requireAuth();
	const api = new ApiClient();
	const target = await resolveSkillMutationTarget(api, opts);
	if (target.agentId && target.adapter) {
		const materialization = readProjectSkillMaterialization({
			agentType: target.adapter.agentType,
			localSkillKey: key,
		});
		const hasAgentProjection = readSkillProjectionState(
			target.adapter.agentType,
			target.agentId,
			target.projectId,
		).claims.has(key);
		// Filesystem absence is authoritative. The adapter mutation is guarded
		// by managed-Skill reservations, so a reserved target fails before any
		// Cloud delete can be reported.
		await target.adapter.removeLocalSkill(key);
		if (materialization) {
			removeProjectSkillMaterialization({
				agentType: target.adapter.agentType,
				localSkillKey: key,
			});
		}
		if (materialization && !hasAgentProjection) {
			console.log(chalk.green(`✓ Removed ${sanitizeMetadata(key)} from Agent`));
			return;
		}
		try {
			await api.deleteAgentSkill(target.agentId, key, target.projectId);
		} catch (error) {
			console.log(
				chalk.yellow(
					`Removed ${sanitizeMetadata(key)} locally; the dashboard will retry the update the next time the daemon syncs.`,
				),
			);
			throw error;
		}
		removeSkillProjectionClaim({
			agentType: target.adapter.agentType,
			agentId: target.agentId,
			projectId: target.projectId,
			skillKey: key,
		});
	} else {
		unwrap(
			await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
				params: { path: { project_id: target.projectId, skill_key: key } },
			}),
		);
	}
	console.log(chalk.green(`✓ Removed ${sanitizeMetadata(key)}`));
}

export function skillInit(nameArg?: string) {
	const cwd = process.cwd();
	const hasName = Boolean(nameArg);
	const name = sanitizeSkillKey(nameArg ?? basename(cwd));
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
