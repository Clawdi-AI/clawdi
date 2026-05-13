/**
 * Owner-side mount management — explicit verbs that wrap the
 * backend mount CRUD endpoints. `inbox accept` already creates a
 * mount as a side-effect of joining a scope; these commands are
 * for the cases that side-effect doesn't cover:
 *
 *   - Move a mount to a different parent (unmount + mount)
 *   - Drop a mount edge while keeping membership (sharee wants
 *     read access but not composition in their workspace)
 *   - Mount a scope you already have membership in (after
 *     `inbox accept --no-mount` or after dropping a prior mount)
 *   - Inspect mounts on a parent (also surfaced by `scope list`
 *     as a tree; the explicit `scope mounts <parent>` command
 *     gives a focused single-parent view + machine-readable JSON)
 *
 * Spec: docs/superpowers/specs/2026-05-11-scope-sharing-spec.md
 * Plan: docs/superpowers/plans/2026-05-12-scope-sharing.md §ME3.1
 */

import chalk from "chalk";

import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { resolveScopeId } from "../lib/scope-resolver";

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
	created_at: string;
}

async function requireAuth(): Promise<{ apiUrl: string; apiKey: string } | null> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return null;
	}
	return { apiUrl, apiKey: auth.apiKey };
}

async function fetchMounts(
	apiUrl: string,
	bearer: string,
	parentScopeId: string,
): Promise<MountRow[]> {
	const r = await fetch(`${apiUrl}/api/scopes/${parentScopeId}/mounts`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	return r.json() as Promise<MountRow[]>;
}

// ────────────────────────────────────────────────────────────────
// scope mounts <parent>
// ────────────────────────────────────────────────────────────────

export async function scopeMountsCommand(
	parentArg: string,
	opts: { json?: boolean },
): Promise<void> {
	const ctx = await requireAuth();
	if (!ctx) return;

	const parentId = await resolveScopeId(ctx.apiUrl, ctx.apiKey, parentArg);
	const mounts = await fetchMounts(ctx.apiUrl, ctx.apiKey, parentId);

	if (opts.json) {
		console.log(JSON.stringify({ parent_scope_id: parentId, mounts }, null, 2));
		return;
	}

	if (mounts.length === 0) {
		console.log(`No mounts on ${parentArg}.`);
		console.log();
		console.log(
			chalk.gray("Mount a scope you have access to: ") +
				chalk.cyan(`clawdi scope mount <source> --into ${parentArg}`),
		);
		return;
	}

	console.log(chalk.bold(`Mounts on ${parentArg} (${mounts.length}):`));
	for (const m of mounts) {
		console.log(
			`  ${chalk.bold(m.alias)}  ${chalk.gray(`(${m.id.slice(0, 8)}…)`)}\n` +
				`    ${chalk.gray("source:")} ${m.source_scope_name} ${chalk.gray(`(${m.source_scope_slug})`)}\n` +
				`    ${chalk.gray("owner: ")} ${m.source_owner_display} ${chalk.gray(`@${m.source_owner_handle}`)}`,
		);
	}
	console.log();
	console.log(chalk.gray("Unmount: ") + chalk.cyan(`clawdi scope unmount ${parentArg} <alias>`));
}

// ────────────────────────────────────────────────────────────────
// scope mount <source> --into <parent> [--alias <name>]
// ────────────────────────────────────────────────────────────────

export async function scopeMountCommand(
	sourceArg: string,
	opts: { into: string; alias?: string; allowVaultConflicts?: boolean; json?: boolean },
): Promise<void> {
	const ctx = await requireAuth();
	if (!ctx) return;

	if (sourceArg.startsWith("http")) {
		console.error(
			chalk.red(
				"`scope mount` takes a source scope you already have access to (UUID / slug / name).\n" +
					"For share URLs, use `clawdi inbox accept <url>` — that joins AND mounts in one step.",
			),
		);
		process.exitCode = 1;
		return;
	}

	const [sourceId, parentId] = await Promise.all([
		resolveScopeId(ctx.apiUrl, ctx.apiKey, sourceArg),
		resolveScopeId(ctx.apiUrl, ctx.apiKey, opts.into),
	]);

	const r = await fetch(`${ctx.apiUrl}/api/scopes/${parentId}/mounts`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${ctx.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			source_scope_id: sourceId,
			alias: opts.alias,
			mode: "live",
			allow_vault_conflicts: !!opts.allowVaultConflicts,
		}),
	});

	if (r.status === 400 || r.status === 403 || r.status === 404 || r.status === 409) {
		const body = (await r.json().catch(() => ({}))) as {
			detail?: { error?: string; message?: string };
		};
		const err = body.detail?.error;
		if (err === "self_mount") {
			console.error(chalk.red("Can't mount a scope into itself."));
		} else if (err === "source_not_visible") {
			console.error(
				chalk.red(
					"You don't have membership in that source scope. Accept the share link " +
						"or invitation first, then mount it.",
				),
			);
		} else if (err === "unsupported_mode") {
			console.error(chalk.red("Only `live` mount mode is supported."));
		} else if (err === "alias_collision_exhausted") {
			const tried = (body.detail as { attempted_aliases?: string[] })?.attempted_aliases ?? [];
			console.error(
				chalk.red(
					`Couldn't find an unused alias on ${opts.into}. ` +
						(tried.length > 0 ? `Tried: ${tried.join(", ")}. ` : "") +
						"Pass --alias <name> with a free name.",
				),
			);
		} else if (err === "vault_conflicts_blocked") {
			const conflicts =
				(
					body.detail as {
						conflicts?: Array<{ vault_slug: string; section: string; item_name: string }>;
					}
				)?.conflicts ?? [];
			console.error(chalk.red("⚠ Vault conflict — mount blocked."));
			console.error(
				chalk.gray(
					"  The source scope has vault key(s) that already exist in your parent vault.\n" +
						"  Re-run with --allow-vault-conflicts to keep both (your parent values\n" +
						"  keep priority), or remove the conflicting key on one side.",
				),
			);
			for (const c of conflicts) {
				const sec = c.section ? `${c.section}/` : "";
				console.error(chalk.gray(`    · ${c.vault_slug}/${sec}${c.item_name}`));
			}
			process.exitCode = 5;
			return;
		} else {
			console.error(chalk.red(`Failed: ${body.detail?.message ?? r.status}`));
		}
		process.exitCode = 1;
		return;
	}
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });

	const mount = (await r.json()) as MountRow;
	if (opts.json) {
		console.log(JSON.stringify({ status: "mounted", mount }, null, 2));
		return;
	}
	console.log(
		chalk.green("✓") +
			` Mounted ` +
			chalk.bold(`${mount.source_scope_name}`) +
			` into ${opts.into} as ` +
			chalk.bold(mount.alias) +
			".",
	);
}

// ────────────────────────────────────────────────────────────────
// scope unmount <parent> <alias-or-id>
// ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function scopeUnmountCommand(
	parentArg: string,
	aliasOrId: string,
	opts: { json?: boolean } = {},
): Promise<void> {
	const ctx = await requireAuth();
	if (!ctx) return;

	const parentId = await resolveScopeId(ctx.apiUrl, ctx.apiKey, parentArg);

	// Resolve alias → mount_id via the list endpoint. Backend wants
	// the mount UUID directly; the alias shorthand is a CLI ergonomic
	// — `scope mounts` prints aliases, users shouldn't have to
	// copy-paste the UUID slice from the parenthetical hint.
	let mountId = aliasOrId;
	if (!UUID_RE.test(aliasOrId)) {
		const mounts = await fetchMounts(ctx.apiUrl, ctx.apiKey, parentId);
		const matches = mounts.filter((m) => m.alias === aliasOrId);
		if (matches.length === 0) {
			console.error(chalk.red(`No mount aliased '${aliasOrId}' on ${parentArg}.`));
			console.error(
				chalk.gray("Run ") +
					chalk.cyan(`clawdi scope mounts ${parentArg}`) +
					chalk.gray(" to list aliases."),
			);
			process.exitCode = 1;
			return;
		}
		if (matches.length > 1) {
			console.error(
				chalk.red(
					`Alias '${aliasOrId}' matches ${matches.length} mounts on ${parentArg} — pass the mount id.`,
				),
			);
			process.exitCode = 1;
			return;
		}
		mountId = matches[0].id;
	}

	const r = await fetch(`${ctx.apiUrl}/api/scopes/${parentId}/mounts/${mountId}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${ctx.apiKey}` },
	});
	if (r.status === 404) {
		console.error(chalk.red("Mount not found."));
		process.exitCode = 1;
		return;
	}
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });

	if (opts.json) {
		console.log(
			JSON.stringify(
				{ status: "unmounted", parent_scope_id: parentId, mount_id: mountId },
				null,
				2,
			),
		);
		return;
	}
	console.log(`${chalk.green("✓")} Unmounted.`);
	console.log(
		chalk.gray(
			"  Membership in the source scope is unchanged — you still see its " +
				"content in unscoped reads. Drop the membership separately if you want " +
				"to fully leave.",
		),
	);
}
