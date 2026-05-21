import chalk from "chalk";

import { projectAlias, projectAuthOrExit } from "../lib/project-command-utils";
import { listProjects } from "../lib/project-resolver";

/**
 * `clawdi project list [--json]` — projects visible to the caller.
 * `--json` emits a stable schema for agent consumers.
 */

export async function projectListCommand(opts: {
	json?: boolean;
	sharedWithMe?: boolean;
	owned?: boolean;
	includeEnvs?: boolean;
}): Promise<void> {
	const ctx = projectAuthOrExit();
	if (!ctx) return;
	const { apiUrl, apiKey } = ctx;
	if (opts.sharedWithMe && opts.owned) {
		console.error(chalk.red("Pass either --shared-with-me or --owned, not both."));
		process.exitCode = 1;
		return;
	}

	const projects = await listProjects(apiUrl, apiKey);
	const environmentProjects = projects.filter((s) => s.kind === "environment");
	const defaultProjects = opts.includeEnvs
		? projects
		: projects.filter((s) => s.kind !== "environment");
	const owned = defaultProjects.filter((s) => s.is_owner !== false && s.kind !== "environment");
	const shared = defaultProjects.filter((s) => s.is_owner === false);
	const machines = opts.includeEnvs
		? projects.filter((s) => s.kind === "environment" && s.is_owner !== false)
		: [];
	const visibleProjects = opts.sharedWithMe ? shared : opts.owned ? owned : projects;
	const filteredVisibleProjects = opts.includeEnvs
		? visibleProjects
		: visibleProjects.filter((s) => s.kind !== "environment");

	if (opts.json) {
		const ownedProjects = owned.map((s) => ({
			id: s.id,
			slug: s.slug,
			name: s.name,
			kind: s.kind,
			is_owner: true,
			owner_display: s.owner_display ?? null,
			owner_handle: s.owner_handle ?? null,
		}));
		const sharedProjects = shared.map((s) => ({
			id: s.id,
			slug: s.slug,
			name: s.name,
			kind: s.kind,
			is_owner: false,
			owner_display: s.owner_display ?? null,
			owner_handle: s.owner_handle ?? null,
		}));
		console.log(
			JSON.stringify(
				{
					projects: filteredVisibleProjects.map((s) => ({
						id: s.id,
						slug: s.slug,
						name: s.name,
						kind: s.kind,
						is_owner: s.is_owner !== false,
						owner_display: s.owner_display ?? null,
						owner_handle: s.owner_handle ?? null,
					})),
					owned_projects: ownedProjects,
					shared_projects: sharedProjects,
					environment_projects: opts.includeEnvs
						? environmentProjects.map((s) => ({
								id: s.id,
								slug: s.slug,
								name: s.name,
								kind: s.kind,
								is_owner: s.is_owner !== false,
								owner_display: s.owner_display ?? null,
								owner_handle: s.owner_handle ?? null,
							}))
						: [],
					hidden_environment_project_count: opts.includeEnvs ? 0 : environmentProjects.length,
				},
				null,
				2,
			),
		);
		return;
	}

	if (filteredVisibleProjects.length === 0) {
		if (opts.sharedWithMe) {
			console.log("No shared projects yet.");
			console.log(chalk.gray("Accept an invite with `clawdi inbox`, or accept a link with:"));
			console.log(`  ${chalk.cyan("clawdi inbox accept <share-url>")}`);
		} else if (opts.owned) {
			console.log("No projects you own yet.");
			console.log(`Create one: ${chalk.cyan('clawdi project create "Engineering"')}`);
		} else {
			console.log("No projects yet.");
			console.log(`Create one: ${chalk.cyan('clawdi project create "Engineering"')}`);
		}
		if (!opts.includeEnvs && environmentProjects.length > 0 && !opts.sharedWithMe) {
			console.log(
				chalk.gray(
					`Hidden machine projects: ${environmentProjects.length}. Show them with \`clawdi project list --include-envs\`.`,
				),
			);
		}
		return;
	}

	if (!opts.sharedWithMe) {
		console.log(chalk.bold(`My projects (${owned.length}):`));
		for (const s of owned) {
			const alias = projectAlias(s);
			console.log(
				`  ${chalk.cyan(alias.padEnd(24))} ${chalk.gray("owner")}  ${chalk.gray(s.id.slice(0, 8))}`,
			);
			if (s.name && s.name !== s.slug) {
				console.log(`    ${chalk.dim(s.name)}`);
			}
			console.log(`    ${chalk.gray("Owner: you · Role: owner")}`);
			console.log(`    ${chalk.gray(`Open:  clawdi project show ${alias}`)}`);
			console.log(`    ${chalk.gray(`Share: clawdi project share ${alias}`)}`);
		}
	}

	if (!opts.sharedWithMe && machines.length > 0) {
		if (owned.length > 0) console.log();
		console.log(chalk.bold(`Machines (${machines.length}):`));
		console.log(chalk.gray("  Auto-created environment projects for registered local agents."));
		for (const s of machines) {
			const alias = projectAlias(s);
			console.log(
				`  ${chalk.cyan(alias.padEnd(24))} ${chalk.gray("machine")}  ${chalk.gray(s.id.slice(0, 8))}`,
			);
			if (s.name && s.name !== s.slug) {
				console.log(`    ${chalk.dim(s.name)}`);
			}
			console.log(`    ${chalk.gray(`Open: clawdi project show ${alias}`)}`);
		}
	}

	if (!opts.owned && shared.length > 0) {
		if (!opts.sharedWithMe) console.log();
		console.log(chalk.bold(`Shared with me (${shared.length}):`));
		console.log(chalk.gray("  Viewer access is read-only. Attach to an Agent when needed."));
		for (const s of shared) {
			const alias = projectAlias(s);
			console.log(
				`  ${chalk.magenta(alias.padEnd(24))} ${chalk.gray("viewer")}  ${chalk.gray(s.id.slice(0, 8))}`,
			);
			console.log(
				`    ${chalk.gray(`Owner: ${s.owner_display ?? s.owner_handle ?? "Unknown"} · Role: viewer`)}`,
			);
			console.log(`    ${chalk.gray(`Open:  clawdi project show ${alias}`)}`);
			console.log(
				`    ${chalk.gray(`Attach to Agent: clawdi agent projects attach <agent-id> --project ${alias}`)}`,
			);
		}
	}

	if (!opts.includeEnvs && environmentProjects.length > 0 && !opts.sharedWithMe) {
		if (owned.length > 0 || shared.length > 0) console.log();
		console.log(
			chalk.gray(
				`Hidden machine projects: ${environmentProjects.length}. Show them with \`clawdi project list --include-envs\`.`,
			),
		);
	}
}
