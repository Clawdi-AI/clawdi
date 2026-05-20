import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { parseDotenv } from "../lib/dotenv";
import { sanitizeMetadata } from "../lib/sanitize";
import { buildExactClawdiReference } from "../lib/secret-references";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
}

interface VaultListRow {
	project_ids?: string[];
	project_id?: string | null;
	slug: string;
	name: string;
}

interface VaultListPage {
	items: VaultListRow[];
	total: number;
	page: number;
	page_size: number;
}

/**
 * Create a vault if it doesn't exist, and attach it to the selected
 * Project when the caller pins one. The endpoint is idempotent for an
 * existing slug, so this is safe before every item write.
 */
async function ensureVault(api: ApiClient, slug: string, name = slug, projectId?: string) {
	const created = await api.POST("/api/vault", {
		body: { slug, name },
		params: projectId ? { query: { project_id: projectId } } : { query: {} },
	});
	if (created.error !== undefined && created.response.status === 409) return;
	unwrap(created);
}

function vaultProjectIds(vault: VaultListRow): string[] {
	return vault.project_ids ?? (vault.project_id ? [vault.project_id] : []);
}

async function fetchAllVaults(api: ApiClient, projectId?: string): Promise<VaultListPage> {
	const VAULT_PAGE_SIZE = 200;
	const items: VaultListRow[] = [];
	let page = 1;
	let total = 0;
	while (page <= 50) {
		const result = unwrap(
			await api.GET("/api/vault", {
				params: {
					query: projectId
						? {
								...(page === 1 ? {} : { page }),
								page_size: VAULT_PAGE_SIZE,
								project_id: projectId,
							}
						: { ...(page === 1 ? {} : { page }), page_size: VAULT_PAGE_SIZE },
				},
			}),
		);
		items.push(...result.items);
		total = result.total ?? items.length;
		if (items.length >= total || result.items.length === 0) {
			return { items, total, page: 1, page_size: VAULT_PAGE_SIZE };
		}
		page += 1;
	}
	throw new Error("Too many vault pages to load safely. Use --project to narrow the listing.");
}

async function resolveVaultProjectId(api: ApiClient, slug: string): Promise<string | null> {
	const list = await fetchAllVaults(api);
	const candidate = list.items.find((v) => v.slug === slug);
	if (!candidate) return null;
	const defaultProject = await api.GET("/api/projects/default");
	const def = defaultProject.error === undefined ? (unwrap(defaultProject).project_id ?? "") : "";
	const projectIds = vaultProjectIds(candidate);
	if (def && projectIds.includes(def)) return def;
	return projectIds[0] ?? null;
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
	if (project_id) {
		console.log(
			chalk.gray(
				`  Reference: ${buildExactClawdiReference(project_id, vaultSlug, section, field)}`,
			),
		);
	}
}

export async function vaultList(opts: { json?: boolean; project?: string } = {}) {
	requireAuth();
	const api = new ApiClient();
	let projectId: string | undefined;
	if (opts.project) {
		const { resolveProjectId } = await import("../lib/project-resolver.js");
		const { getAuth, getConfig } = await import("../lib/config.js");
		const cfg = getConfig();
		const auth = getAuth();
		if (!auth?.apiKey) {
			console.log(chalk.red("Not signed in. Run `clawdi auth login` first."));
			process.exit(1);
		}
		projectId = await resolveProjectId(cfg.apiUrl, auth.apiKey, opts.project);
	}
	const page = await fetchAllVaults(api, projectId);
	const vaults = page.items;

	const fetchItems = (slug: string, attachedProjectId?: string) =>
		api
			.GET("/api/vault/{slug}/items", {
				params: {
					path: { slug },
					query: attachedProjectId ? { project_id: attachedProjectId } : {},
				},
			})
			.then(unwrap);

	if (opts.json || !process.stdout.isTTY) {
		// Emit an array so tooling can inspect each vault with its
		// attached Projects. Keys belong to the vault; project_ids are
		// where that vault is available.
		const out: Array<{
			slug: string;
			project_id: string | null;
			project_ids: string[];
			name: string;
			items: Awaited<ReturnType<typeof fetchItems>>;
			references: VaultReferenceRow[];
		}> = [];
		for (const v of vaults) {
			const projectIds = vaultProjectIds(v);
			const attachedProjectId = projectId ?? projectIds[0];
			const items = await fetchItems(v.slug, attachedProjectId);
			out.push({
				slug: v.slug,
				project_id: attachedProjectId ?? null,
				project_ids: projectIds,
				name: v.name,
				items,
				references: attachedProjectId
					? buildVaultReferenceRows(attachedProjectId, v.slug, items)
					: [],
			});
		}
		console.log(JSON.stringify(out, null, 2));
		return;
	}

	if (vaults.length === 0) {
		console.log(chalk.gray("No vaults."));
		return;
	}

	for (const v of vaults) {
		const attachedProjectId = projectId ?? vaultProjectIds(v)[0];
		const items = await fetchItems(v.slug, attachedProjectId);
		const projectLabel = attachedProjectId ? `project=${attachedProjectId}` : "project=unattached";
		console.log(chalk.white(`  ${sanitizeMetadata(v.slug)} ${chalk.gray(projectLabel)}`));
		for (const row of attachedProjectId
			? buildVaultReferenceRows(attachedProjectId, v.slug, items)
			: []) {
			console.log(chalk.gray(`    ${sanitizeMetadata(row.key)}`));
			console.log(chalk.gray(`      ${row.reference}`));
		}
	}
}

interface VaultReferenceRow {
	key: string;
	section: string;
	field: string;
	reference: string;
}

function buildVaultReferenceRows(
	projectId: string,
	vaultSlug: string,
	items: Record<string, string[]>,
): VaultReferenceRow[] {
	return Object.entries(items).flatMap(([section, fields]) =>
		fields.map((field) => {
			const normalizedSection = section === "(default)" ? "" : section;
			return {
				key: normalizedSection ? `${normalizedSection}/${field}` : field,
				section: normalizedSection,
				field,
				reference: buildExactClawdiReference(projectId, vaultSlug, normalizedSection, field),
			};
		}),
	);
}

export async function vaultImport(file: string, opts: { yes?: boolean; project?: string } = {}) {
	requireAuth();

	const content = readFileSync(file, "utf-8");
	const fields: Record<string, string> = {};
	for (const [key, value] of parseDotenv(content)) {
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
	if (project_id) {
		console.log(chalk.gray("  References:"));
		for (const field of Object.keys(fields).sort()) {
			console.log(
				chalk.gray(
					`    ${sanitizeMetadata(field)}=${buildExactClawdiReference(project_id, "default", "", field)}`,
				),
			);
		}
	}
}

function parseVaultKey(key: string): { vaultSlug: string; section: string; field: string } {
	const cleaned = key.replace(/^clawdi:\/\//, "");
	const [a = "", b = "", c = ""] = cleaned.split("/");
	if (c) return { vaultSlug: a, section: b, field: c };
	if (b) return { vaultSlug: a, section: "", field: b };
	return { vaultSlug: "default", section: "", field: a };
}
