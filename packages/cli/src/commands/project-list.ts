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
		console.log("No projects yet.");
		return;
	}

	if (!opts.sharedWithMe) {
		console.log(chalk.bold(`My projects (${owned.length}):`));
		for (const s of owned) {
			console.log(
				`  ${chalk.cyan(s.slug.padEnd(24))} ${chalk.gray(s.id.slice(0, 8))}  ${chalk.dim(`(${s.kind})`)}`,
			);
			if (s.name && s.name !== s.slug) {
				console.log(`    ${chalk.dim(s.name)}`);
			}
		}
	}

	if (!opts.owned && shared.length > 0) {
		if (!opts.sharedWithMe) console.log();
		console.log(
			chalk.gray(`Shared with you (${shared.length}) — access granted, binding is separate.`),
		);
		for (const s of shared) {
			const alias = s.owner_handle ? `@${s.owner_handle}/${s.slug}` : s.slug;
			console.log(
				`  ${chalk.magenta(alias)}  ${chalk.gray(s.id.slice(0, 8))}  ${chalk.dim(`(${s.kind})`)}`,
			);
			if (s.owner_display) console.log(`    ${chalk.dim(`from ${s.owner_display}`)}`);
		}
	}
}
