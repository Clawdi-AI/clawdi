import chalk from "chalk";

import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { listScopes } from "../lib/scope-resolver";

/**
 * `clawdi scope list [--json]` — owned scopes rendered as a tree with
 * any ScopeMount edges shown as nested children. `--json` emits a
 * stable schema for agent consumers.
 */

interface MountRow {
	id: string;
	parent_scope_id: string;
	source_scope_id: string;
	source_scope_name: string;
	source_scope_slug: string;
	source_owner_display: string;
	source_owner_handle: string;
	alias: string;
	mode: string;
}

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

	// Fetch mounts per owned scope (best-effort; if the endpoint
	// errors for one scope, we render an empty mount list for it).
	const mountsByParent = new Map<string, MountRow[]>();
	for (const s of owned) {
		try {
			const r = await fetch(`${apiUrl}/api/scopes/${s.id}/mounts`, {
				headers: { Authorization: `Bearer ${auth.apiKey}` },
			});
			if (r.ok) mountsByParent.set(s.id, (await r.json()) as MountRow[]);
			else mountsByParent.set(s.id, []);
		} catch {
			mountsByParent.set(s.id, []);
		}
	}

	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					scopes: owned.map((s) => ({
						id: s.id,
						slug: s.slug,
						name: s.name,
						kind: s.kind,
						is_owner: true,
						mounts: mountsByParent.get(s.id) ?? [],
					})),
					// Shared scopes (membership, not mounted into any owned)
					// surfaced for completeness — agents can render them as
					// "ready to mount" rows.
					shared_pending_mount: shared.map((s) => ({
						id: s.id,
						slug: s.slug,
						name: s.name,
						kind: s.kind,
					})),
				},
				null,
				2,
			),
		);
		return;
	}

	if (scopes.length === 0) {
		console.log("No scopes yet.");
		return;
	}

	console.log(chalk.bold(`My scopes (${owned.length}):`));
	for (const s of owned) {
		console.log(
			`  ${chalk.cyan(s.slug.padEnd(24))} ${chalk.gray(s.id.slice(0, 8))}  ${chalk.dim(`(${s.kind})`)}`,
		);
		if (s.name && s.name !== s.slug) {
			console.log(`    ${chalk.dim(s.name)}`);
		}
		const mounts = mountsByParent.get(s.id) ?? [];
		for (const m of mounts) {
			console.log(
				`    └─ ${chalk.bold(m.alias)}  ${chalk.gray(`← mounted from`)} ` +
					`${chalk.dim(m.source_owner_display)} ${chalk.gray(`@${m.source_owner_handle}`)}`,
			);
		}
	}

	if (shared.length > 0) {
		console.log();
		console.log(
			chalk.gray(
				`Shared with you but not mounted (${shared.length}) — these scopes are visible via membership but ` +
					`haven't been composed into one of your scopes yet. ` +
					`Run \`clawdi scope mount <slug> --into <parent>\` to compose, ` +
					`or accept again via \`clawdi inbox accept <url>\`.`,
			),
		);
		for (const s of shared) {
			console.log(
				`  ${chalk.magenta(s.slug)}  ${chalk.gray(s.id.slice(0, 8))}  ${chalk.dim(`(${s.kind})`)}`,
			);
		}
	}
}
