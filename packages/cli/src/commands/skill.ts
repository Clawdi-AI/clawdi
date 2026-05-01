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
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { parseFrontmatter } from "../lib/frontmatter";
import { sanitizeMetadata, sanitizeName } from "../lib/sanitize";
import { fetchDefaultScopeId, fetchScopeIdForEnv, getEnvIdByAgent } from "../lib/select-adapter";
import { computeSkillFolderHash } from "../lib/skills-lock";
import { type ParsedSource, parseSource } from "../lib/source-parser";
import { tarSingleFile, tarSkillDir } from "../lib/tar";
import { isInteractive } from "../lib/tty";

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
	const page = unwrap(await api.GET("/api/skills", { params: { query: { page_size: 200 } } }));
	const skills = page.items;

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
	const summary =
		page.total > skills.length
			? `${skills.length} of ${page.total} skills (first ${skills.length})`
			: `${skills.length} skill${skills.length === 1 ? "" : "s"} total`;
	console.log(chalk.gray(`\n  ${summary}`));
}

export async function skillAdd(path: string, opts: { yes?: boolean; agent?: string } = {}) {
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
		skillKey = sanitizeName(basename(resolved));
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
			tarBytes = await tarSkillDir(stagedDir, [dirname(resolved), stagingRoot], skillKey);
			contentHash = await computeSkillFolderHash(stagedDir);
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
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

	// Phase-2 scope resolution. Mirrors `skill install --agent X`:
	//   --agent X → env-X's scope on THIS machine
	//   no --agent → default scope, but only if its owning env
	//                lives on THIS machine (else refuse so the
	//                user doesn't ship a local skill into a
	//                sibling machine's cloud inventory)
	let scopeId: string;
	if (opts.agent) {
		const envId = getEnvIdByAgent(opts.agent);
		if (!envId) {
			const entry = adapterRegistry[opts.agent as keyof typeof adapterRegistry];
			const label = entry ? entry.displayName : opts.agent;
			console.log(
				chalk.red(
					`No environment registered for ${label}. Run \`clawdi setup --agent ${opts.agent}\` first.`,
				),
			);
			process.exit(1);
		}
		scopeId = await fetchScopeIdForEnv(api, envId);
	} else {
		scopeId = await fetchDefaultScopeId(api);
		const envs = unwrap(await api.GET("/api/environments"));
		const owning = envs.find((e) => e.default_scope_id === scopeId);
		if (owning) {
			const localEnvIdForAgent = getEnvIdByAgent(owning.agent_type);
			if (localEnvIdForAgent !== owning.id) {
				const machineName = (owning as { machine_name?: string }).machine_name ?? "another machine";
				console.log(
					chalk.red(
						`Account default scope belongs to ${machineName}'s ${owning.agent_type} env. ` +
							`Pass \`--agent <type>\` to install for an env on this machine, or run ` +
							`\`clawdi skill add\` from that machine.`,
					),
				);
				process.exit(1);
			}
		}
	}
	const result = await api.uploadSkill(
		scopeId,
		skillKey,
		tarBytes,
		`${skillKey}.tar.gz`,
		contentHash,
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
		console.log(chalk.red(errMessage(e)));
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

	// Resolve the install scope BEFORE the adapter filter so
	// `--agent X` lands the cloud install in env-X's scope. Without
	// this, the install hit the account's default scope (typically
	// the most-recently-active env) while local writes went to
	// agent X's adapter — dashboard / daemon for X never saw the
	// skill, and the user's default-env home picked up rows it
	// didn't want.
	let scopeId: string;
	// `targetAgent` is the agent we'll write the local archive
	// for. With --agent it's explicit; without --agent we must
	// infer it from the default scope so the cloud install and
	// the local archive land in the same place. Pre-fix the
	// no-flag path installed to ONE cloud scope but wrote to
	// EVERY registered adapter — siblings ended up with a local
	// SKILL.md file and no cloud row in their own scope, so
	// their dashboard / daemon state diverged.
	let targetAgent: string | undefined = opts.agent;
	if (opts.agent) {
		const envId = getEnvIdByAgent(opts.agent);
		if (!envId) {
			const entry = adapterRegistry[opts.agent as keyof typeof adapterRegistry];
			const label = entry ? entry.displayName : opts.agent;
			console.log(
				chalk.red(
					`No environment registered for ${label}. Run \`clawdi setup --agent ${opts.agent}\` first.`,
				),
			);
			process.exit(1);
		}
		scopeId = await fetchScopeIdForEnv(api, envId);
	} else {
		// No --agent flag: install to the account's default scope
		// and ONLY write the local archive to the agent that owns
		// that scope. Mirrors the dashboard's "Install" semantics
		// when no env is selected.
		scopeId = await fetchDefaultScopeId(api);
		const envs = unwrap(await api.GET("/api/environments"));
		const owning = envs.find((e) => e.default_scope_id === scopeId);
		// Match the owning env to a LOCAL env on THIS machine. The
		// account's default scope can belong to a sibling machine
		// running the same agent type — in that case writing the
		// archive into this machine's adapter directory leaves a
		// local file with no cloud row in this machine's env scope
		// (the cloud row is under the sibling's env). Filtering by
		// `agent_type` alone hit that exact case for multi-machine
		// users. The proper match is `local env id == owning env id`.
		if (owning) {
			const localEnvIdForAgent = getEnvIdByAgent(owning.agent_type);
			if (localEnvIdForAgent === owning.id) {
				targetAgent = owning.agent_type;
			} else {
				// Default scope belongs to a sibling machine. Tell the
				// user explicitly so they can re-run with --agent or
				// `clawdi pull` later from the right machine.
				const machineName = (owning as { machine_name?: string }).machine_name ?? "another machine";
				console.log(
					chalk.yellow(
						`Note: account default points at ${machineName}'s ${owning.agent_type} env. ` +
							`Cloud install will land there; not writing a local copy on this machine. ` +
							`Pass --agent <type> to install for an env on this machine.`,
					),
				);
				targetAgent = "__skip_local__";
			}
		}
	}
	const installResult = unwrap(
		await api.POST("/api/scopes/{scope_id}/skills/install", {
			params: { path: { scope_id: scopeId } },
			body: { repo, path },
		}),
	);

	// Select adapters to install to.
	let adapters = getRegisteredAdapters();
	if (targetAgent === "__skip_local__") {
		// Cloud install landed in a sibling machine's scope; don't
		// write a local copy on this machine.
		adapters = [];
	} else if (targetAgent) {
		const adapterAgent = targetAgent;
		adapters = adapters.filter((a) => a.agentType === adapterAgent);
		if (adapters.length === 0) {
			const entry = adapterRegistry[adapterAgent as keyof typeof adapterRegistry];
			if (!entry) {
				console.log(
					chalk.red(
						`Unknown agent "${adapterAgent}". Valid: ${Object.keys(adapterRegistry).join(", ")}`,
					),
				);
			} else {
				console.log(
					chalk.yellow(
						`Agent ${entry.displayName} is not registered. Run \`clawdi setup --agent ${adapterAgent}\` first.`,
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
			// Scope-explicit download keyed off the scope we just
			// installed into. The legacy unscoped endpoint resolves
			// duplicate skill keys by "most recently updated across
			// visible scopes" — a multi-agent account where another
			// scope has a newer copy of the same skill_key would
			// land that other agent's bytes locally.
			tarBytes = await api.getBytes(
				`/api/scopes/${encodeURIComponent(scopeId)}/skills/${encodeURIComponent(installResult.skill_key)}/download`,
			);
		} catch (e) {
			console.log(
				chalk.red(`✗ Download failed: ${e instanceof ApiError ? e.message : errMessage(e)}`),
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
				failed.push({ agent: adapter.agentType, error: errMessage(e) });
				console.log(chalk.red(`  ✗ ${label} failed: ${errMessage(e)}`));
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

export async function skillRm(key: string, opts: { agent?: string } = {}) {
	requireAuth();
	const api = new ApiClient();
	// Phase-2 scope-explicit delete: only the targeted scope's
	// copy is removed. Mirrors `skill add`/`install`: --agent X
	// pins env-X's scope on this machine; without --agent we
	// require the default scope's owning env to be a LOCAL env on
	// THIS machine, otherwise we'd silently uninstall from a
	// sibling machine's agent. (Pre-fix the no-flag path used
	// `fetchDefaultScopeId` blindly — the heuristic resolves to
	// "most-recently-active env" which on multi-machine accounts
	// is often someone else's env.)
	let scopeId: string;
	if (opts.agent) {
		const envId = getEnvIdByAgent(opts.agent);
		if (!envId) {
			const entry = adapterRegistry[opts.agent as keyof typeof adapterRegistry];
			const label = entry ? entry.displayName : opts.agent;
			console.log(
				chalk.red(
					`No environment registered for ${label}. Run \`clawdi setup --agent ${opts.agent}\` first.`,
				),
			);
			process.exit(1);
		}
		scopeId = await fetchScopeIdForEnv(api, envId);
	} else {
		scopeId = await fetchDefaultScopeId(api);
		const envs = unwrap(await api.GET("/api/environments"));
		const owning = envs.find((e) => e.default_scope_id === scopeId);
		if (owning) {
			const localEnvIdForAgent = getEnvIdByAgent(owning.agent_type);
			if (localEnvIdForAgent !== owning.id) {
				const machineName = (owning as { machine_name?: string }).machine_name ?? "another machine";
				console.log(
					chalk.red(
						`Account default scope belongs to ${machineName}'s ${owning.agent_type} env. ` +
							`Pass \`--agent <type>\` to remove from an env on this machine, or run ` +
							`\`clawdi skill rm\` from that machine.`,
					),
				);
				process.exit(1);
			}
		}
	}
	unwrap(
		await api.DELETE("/api/scopes/{scope_id}/skills/{skill_key}", {
			params: { path: { scope_id: scopeId, skill_key: key } },
		}),
	);
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
