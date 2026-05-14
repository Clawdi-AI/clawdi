import chalk from "chalk";

import { getAuth, getConfig } from "../lib/config";
import { listScopes } from "../lib/scope-resolver";

/**
 * `clawdi project list [--json]` — projects visible to the caller.
 * `--json` emits a stable schema for agent consumers.
 */

export async function scopeListCommand(opts: { json?: boolean }): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}

	const scopes = await listScopes(apiUrl, auth.apiKey);
	const owned = scopes.filter((s) => s.is_owner !== false);
	const shared = scopes.filter((s) => s.is_owner === false);

	if (opts.json) {
		const ownedProjects = owned.map((s) => ({
			id: s.id,
			slug: s.slug,
			name: s.name,
			kind: s.kind,
			is_owner: true,
		}));
		const sharedProjects = shared.map((s) => ({
			id: s.id,
			slug: s.slug,
			name: s.name,
			kind: s.kind,
			is_owner: false,
		}));
		console.log(
			JSON.stringify(
				{
					projects: [...ownedProjects, ...sharedProjects],
					owned_projects: ownedProjects,
					shared_projects: sharedProjects,
					// Backward-compatible alias retained for older
					// machine consumers that still read `scopes`.
					scopes: ownedProjects,
				},
				null,
				2,
			),
		);
		return;
	}

	if (scopes.length === 0) {
		console.log("No projects yet.");
		return;
	}

	console.log(chalk.bold(`My projects (${owned.length}):`));
	for (const s of owned) {
		console.log(
			`  ${chalk.cyan(s.slug.padEnd(24))} ${chalk.gray(s.id.slice(0, 8))}  ${chalk.dim(`(${s.kind})`)}`,
		);
		if (s.name && s.name !== s.slug) {
			console.log(`    ${chalk.dim(s.name)}`);
		}
	}

	if (shared.length > 0) {
		console.log();
		console.log(
			chalk.gray(`Shared with you (${shared.length}) — access granted, binding is separate.`),
		);
		for (const s of shared) {
			console.log(
				`  ${chalk.magenta(s.slug)}  ${chalk.gray(s.id.slice(0, 8))}  ${chalk.dim(`(${s.kind})`)}`,
			);
		}
	}
}
