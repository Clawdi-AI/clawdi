import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { sanitizeMetadata } from "../lib/sanitize";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
}

/**
 * Create a vault if it doesn't exist. 409 is the common "already exists"
 * response and is expected when the caller is about to PUT items into a
 * pre-existing vault; everything else propagates as a normal ApiError so
 * users see auth/network failures instead of a silent skip.
 */
async function ensureVault(api: ApiClient, slug: string, name = slug, projectId?: string) {
	const created = await api.POST("/api/vault", {
		body: { slug, name },
		params: projectId ? { query: { project_id: projectId } } : { query: {} },
	});
	// `response` is only populated when the server actually replied — on a
	// network-level failure `response` is undefined, so optional-chain it
	// before inspecting the status, then let `unwrap` raise the right
	// ApiError (either the HTTP one or a synthetic network one).
	if (created.error !== undefined && created.response?.status !== 409) {
		unwrap(created);
	}
}

/**
 * Resolve the slug → exact project_id. Round 30 added a 409
 * `ambiguous_vault_slug` whenever a JWT (or unbound) caller can
 * see the same slug under multiple projects (Personal + env-A, two
 * envs with collision-named vaults, etc.). Slug-only lookups
 * pre-this-helper would 409 in those cases. We resolve by:
 *   1. Listing visible vaults (cheap — `/api/vault` returns
 *      a single page with project_id per row).
 *   2. Picking the row whose project_id matches the caller's
 *      default WRITE scope (`/api/projects/default`). For
 *      env-bound api_keys this is unambiguous (one visible
 *      scope); for JWT/unbound it picks the same scope a
 *      fresh `clawdi vault set` would create the vault in,
 *      keeping CLI behavior consistent across read+write.
 *   3. Falling back to any unique match if no slug+default
 *      pair exists (fresh CLI account where the vault was
 *      created in a non-default scope by the dashboard).
 *   4. Returning `null` when the slug genuinely doesn't
 *      exist for this caller; downstream calls then surface
 *      the server's 404 to the user.
 */
async function resolveVaultProjectId(api: ApiClient, slug: string): Promise<string | null> {
	const list = unwrap(await api.GET("/api/vault", { params: { query: { page_size: 100 } } }));
	const candidates = list.items.filter((v) => v.slug === slug);
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0].project_id;
	const headers: Record<string, string> = {};
	if (api.apiKey) headers.Authorization = `Bearer ${api.apiKey}`;
	const projectRes = await fetch(`${api.baseUrl}/api/projects/default`, { headers });
	let def: string;
	if (projectRes.ok) {
		const body = (await projectRes.json()) as { project_id: string };
		def = body.project_id;
	} else {
		// Backward compat with older field names.
		const legacy = (
			unwrap(await api.GET("/api/projects/default")) as {
				project_id?: string;
				scope_id?: string;
			}
		).project_id;
		def = legacy ?? "";
	}
	const inDefault = candidates.find((v) => v.project_id === def);
	if (inDefault) return inDefault.project_id;
	// Multiple matches, none in the default scope. Pick the
	// first deterministically — caller still gets a single
	// scope, which is better than a 409 for any sane user
	// flow (and we surface a hint in the diagnostics path).
	return candidates[0].project_id;
}

export async function vaultSet(key: string, opts: { project?: string } = {}) {
	requireAuth();

	const { vaultSlug, section, field } = parseVaultKey(key);

	const value = await p.password({ message: `Value for ${key}:` });
	if (p.isCancel(value) || !value) {
		p.cancel("Cancelled.");
		return;
	}

	const api = new ApiClient();

	// Resolve --project to a concrete UUID up front so both
	// ensureVault (create) AND the items PUT land in the same project.
	let pinnedProjectId: string | undefined;
	if (opts.project) {
		const { resolveProjectId } = await import("../lib/project-resolver.js");
		const { getAuth, getConfig } = await import("../lib/config.js");
		const cfg = getConfig();
		const auth = getAuth();
		if (!auth?.apiKey) {
			console.log(chalk.red("Not signed in. Run `clawdi auth login` first."));
			process.exit(1);
		}
		pinnedProjectId = await resolveProjectId(cfg.apiUrl, auth.apiKey, opts.project);
	}

	await ensureVault(api, vaultSlug, vaultSlug, pinnedProjectId);

	// Pass project_id so the server's slug → vault lookup
	// doesn't 409 on JWT / unbound callers who can see the
	// same slug under multiple projects. For env-bound api_keys
	// this is a no-op — only one project is visible. `ensureVault`
	// above just guaranteed at least one match exists.
	const project_id = pinnedProjectId ?? (await resolveVaultProjectId(api, vaultSlug));
	unwrap(
		await api.PUT("/api/vault/{slug}/items", {
			params: {
				path: { slug: vaultSlug },
				query: project_id ? { project_id } : {},
			},
			body: { section, fields: { [field]: value } },
		}),
	);

	console.log(chalk.green(`✓ Stored ${key}`));
}

export async function vaultList(opts: { json?: boolean } = {}) {
	requireAuth();
	const api = new ApiClient();
	// `page_size=100` covers ~all realistic tenants; if someone crosses it we
	// surface the overflow below rather than silently dropping vaults.
	const VAULT_PAGE_SIZE = 100;
	const page = unwrap(
		await api.GET("/api/vault", { params: { query: { page_size: VAULT_PAGE_SIZE } } }),
	);
	const vaults = page.items;

	// Pass each vault's project_id from the listing so the
	// items lookup never trips the round-30 ambiguity 409.
	// For env-bound api_keys this is a no-op (single visible
	// project); for JWT / unbound it disambiguates a duplicate
	// slug across projects deterministically.
	const fetchItems = (slug: string, project_id: string) =>
		api
			.GET("/api/vault/{slug}/items", {
				params: { path: { slug }, query: { project_id } },
			})
			.then(unwrap);

	if (opts.json || !process.stdout.isTTY) {
		// Emit an ARRAY of `{slug, project_id, name, items}` instead
		// of a `slug → items` map. Round 30's per-project vault
		// uniqueness means a JWT or unbound caller can see the
		// same slug in two projects (Personal + env-A); the map
		// shape would have the second row silently overwrite the
		// first under the shared key, dropping one project's items
		// entirely. The array shape preserves both rows so
		// `jq '.[] | select(.project_id=="…")'` etc still works,
		// and downstream tooling can consistently key on
		// `(project_id, slug)` rather than guessing.
		const out: Array<{
			slug: string;
			project_id: string;
			name: string;
			items: Awaited<ReturnType<typeof fetchItems>>;
		}> = [];
		for (const v of vaults) {
			out.push({
				slug: v.slug,
				project_id: v.project_id,
				name: v.name,
				items: await fetchItems(v.slug, v.project_id),
			});
		}
		console.log(JSON.stringify(out, null, 2));
		return;
	}

	if (vaults.length === 0) {
		console.log(chalk.gray("No vaults."));
		return;
	}

	if (page.total > vaults.length) {
		console.log(
			chalk.yellow(`  Showing ${vaults.length} of ${page.total} vaults (first page only).`),
		);
	}

	for (const v of vaults) {
		const items = await fetchItems(v.slug, v.project_id);
		console.log(chalk.white(`  ${sanitizeMetadata(v.slug)}`));
		for (const [section, fields] of Object.entries(items)) {
			for (const field of fields) {
				const display =
					section === "(default)"
						? sanitizeMetadata(field)
						: `${sanitizeMetadata(section)}/${sanitizeMetadata(field)}`;
				console.log(chalk.gray(`    ${display}`));
			}
		}
	}
}

export async function vaultImport(file: string, opts: { yes?: boolean; project?: string } = {}) {
	requireAuth();

	const content = readFileSync(file, "utf-8");
	const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
	const api = new ApiClient();

	let pinnedProjectId: string | undefined;
	if (opts.project) {
		const { resolveProjectId } = await import("../lib/project-resolver.js");
		const { getAuth, getConfig } = await import("../lib/config.js");
		const cfg = getConfig();
		const auth = getAuth();
		if (!auth?.apiKey) {
			console.log(chalk.red("Not signed in. Run `clawdi auth login` first."));
			process.exit(1);
		}
		pinnedProjectId = await resolveProjectId(cfg.apiUrl, auth.apiKey, opts.project);
	}

	await ensureVault(api, "default", "Default", pinnedProjectId);

	const fields: Record<string, string> = {};
	for (const line of lines) {
		const eqIdx = line.indexOf("=");
		if (eqIdx === -1) continue;
		const key = line.slice(0, eqIdx).trim();
		let value = line.slice(eqIdx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}

	if (Object.keys(fields).length === 0) {
		console.log(chalk.gray("No keys found in file."));
		return;
	}

	// Skip the confirmation prompt under `--yes` so CI / scripted
	// imports (demos, .env bootstrap) don't hang on stdin. The
	// preview banner still renders so the operator can see what
	// just landed.
	p.note(Object.keys(fields).join("\n"), `${Object.keys(fields).length} keys from ${file}`);
	if (!opts.yes) {
		const ok = await p.confirm({ message: "Import these keys?" });
		if (p.isCancel(ok) || !ok) {
			p.cancel("Cancelled.");
			return;
		}
	}

	const project_id = pinnedProjectId ?? (await resolveVaultProjectId(api, "default"));
	unwrap(
		await api.PUT("/api/vault/{slug}/items", {
			params: {
				path: { slug: "default" },
				query: project_id ? { project_id } : {},
			},
			body: { section: "", fields },
		}),
	);

	console.log(chalk.green(`✓ Imported ${Object.keys(fields).length} keys to vault "default"`));
}

function parseVaultKey(key: string): { vaultSlug: string; section: string; field: string } {
	const cleaned = key.replace(/^clawdi:\/\//, "");
	const [a = "", b = "", c = ""] = cleaned.split("/");
	if (c) return { vaultSlug: a, section: b, field: c };
	if (b) return { vaultSlug: a, section: "", field: b };
	return { vaultSlug: "default", section: "", field: a };
}
