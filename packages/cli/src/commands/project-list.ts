import chalk from "chalk";

import { getAuth, getConfig } from "../lib/config";
import { listProjects } from "../lib/project-resolver";

/**
 * `clawdi project list [--json]` — projects visible to the caller.
 * `--json` emits a stable schema for agent consumers.
 */

export async function projectListCommand(opts: {
	json?: boolean;
	sharedWithMe?: boolean;
	owned?: boolean;
}): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}
	if (opts.sharedWithMe && opts.owned) {
		console.error(chalk.red("Pass either --shared-with-me or --owned, not both."));
		process.exitCode = 1;
		return;
	}

	const projects = await listProjects(apiUrl, auth.apiKey);
	const owned = projects.filter((s) => s.is_owner !== false);
	const shared = projects.filter((s) => s.is_owner === false);
	const visibleProjects = opts.sharedWithMe ? shared : opts.owned ? owned : projects;

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
					projects: visibleProjects.map((s) => ({
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
				},
				null,
				2,
			),
		);
		return;
	}

	if (visibleProjects.length === 0) {
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

	if (!opts.owned && shared.length > 0) {
		if (!opts.sharedWithMe) console.log();
		console.log(chalk.bold(`Shared with me (${shared.length}):`));
		console.log(chalk.gray("  Viewer access is read-only. Use with an agent when needed."));
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
				`    ${chalk.gray(`Use with agent: clawdi agent projects add-context <agent-id> --project ${alias}`)}`,
			);
		}
	}
}

function projectAlias(project: {
	slug: string;
	is_owner?: boolean;
	owner_handle?: string | null;
}): string {
	if (project.is_owner === false && project.owner_handle) {
		return `@${project.owner_handle}/${project.slug}`;
	}
	return project.slug;
}
