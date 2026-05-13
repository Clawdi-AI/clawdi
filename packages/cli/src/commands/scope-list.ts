import chalk from "chalk";

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

	// Parallel mount fetch — one request per owned scope, all in
	// flight at once. Sequentially this was an N+1 stall whose
	// total wait grew with the number of owned scopes; an account
	// with five envs felt noticeably laggy on a slow network.
	// Best-effort per scope: failed lookups render as an empty
	// mount list for that parent rather than aborting the whole
	// `scope list` invocation.
	const mountsByParent = new Map<string, MountRow[]>();
	const mountResults = await Promise.all(
		owned.map(async (s): Promise<[string, MountRow[]]> => {
			try {
				const r = await fetch(`${apiUrl}/api/scopes/${s.id}/mounts`, {
					headers: { Authorization: `Bearer ${auth.apiKey}` },
				});
				if (r.ok) return [s.id, (await r.json()) as MountRow[]];
			} catch {
				// fall through to empty
			}
			return [s.id, []];
		}),
	);
	for (const [scopeId, mounts] of mountResults) mountsByParent.set(scopeId, mounts);
	const mountsAcrossParents = [...mountsByParent.values()].flat();
	const mountedSourceIds = new Set(mountsAcrossParents.map((m) => m.source_scope_id));
	const sharedMounted = shared.filter((s) => mountedSourceIds.has(s.id));
	const sharedPendingMount = shared.filter((s) => !mountedSourceIds.has(s.id));

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
					// Shared scopes with no mount edge into any owned
					// parent. Agents can render these as "ready to mount".
					shared_pending_mount: sharedPendingMount.map((s) => ({
						id: s.id,
						slug: s.slug,
						name: s.name,
						kind: s.kind,
					})),
					// A shared source can be mounted into more than one
					// owned parent. Surface mounted memberships separately
					// so callers do not mistake them for unmounted work.
					shared_mounted: sharedMounted.map((s) => ({
						id: s.id,
						slug: s.slug,
						name: s.name,
						kind: s.kind,
						mounts: mountsAcrossParents.filter((m) => m.source_scope_id === s.id),
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

	if (sharedMounted.length > 0) {
		console.log();
		console.log(
			chalk.gray(
				`Shared with you and mounted (${sharedMounted.length}) — you can mount the same shared scope ` +
					`into additional owned scopes with \`clawdi scope mount <slug> --into <parent>\`.`,
			),
		);
		for (const s of sharedMounted) {
			const mounts = mountsAcrossParents.filter((m) => m.source_scope_id === s.id);
			console.log(
				`  ${chalk.magenta(s.slug)}  ${chalk.gray(s.id.slice(0, 8))}  ` +
					chalk.dim(`mounted ${mounts.length} time${mounts.length === 1 ? "" : "s"}`),
			);
		}
	}

	if (sharedPendingMount.length > 0) {
		console.log();
		console.log(
			chalk.gray(
				`Shared with you but not mounted (${sharedPendingMount.length}) — these scopes are visible via membership but ` +
					`haven't been composed into one of your scopes yet. ` +
					`Run \`clawdi scope mount <slug> --into <parent>\` to compose, ` +
					`or accept again via \`clawdi inbox accept <url>\`.`,
			),
		);
		for (const s of sharedPendingMount) {
			console.log(
				`  ${chalk.magenta(s.slug)}  ${chalk.gray(s.id.slice(0, 8))}  ${chalk.dim(`(${s.kind})`)}`,
			);
		}
	}
}
