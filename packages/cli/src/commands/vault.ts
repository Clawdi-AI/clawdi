import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { parseDotenvDetailed } from "../lib/dotenv";
import { listProjects, resolveProjectId } from "../lib/project-resolver";
import { sanitizeMetadata } from "../lib/sanitize";
import { buildExactClawdiReference } from "../lib/secret-references";
import { isInteractive } from "../lib/tty";

const VAULT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
const VAULT_ITEM_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const BROAD_VAULT_SLUGS = new Set([
	"dev",
	"development",
	"prod",
	"production",
	"stage",
	"staging",
	"test",
	"testing",
]);

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

interface VaultSetOptions {
	project?: string;
	value?: string;
	stdin?: boolean;
	prompt?: boolean;
	allowEmpty?: boolean;
}

export async function vaultSet(key: string, opts: VaultSetOptions = {}) {
	requireAuth();

	const { vaultSlug, section, field } = parseVaultKey(key);
	const normalizedKey = formatVaultKey(vaultSlug, section, field);
	warnIfBroadVaultSlug(vaultSlug);

	const value = await readVaultSetValue(key, opts);
	if (value === null) {
		return;
	}

	const api = new ApiClient();

	const targetProject = await resolveVaultWriteProject(api, opts.project);
	console.log(chalk.gray(`  Target: ${formatVaultTarget(vaultSlug, section, targetProject)}`));

	await ensureVault(api, vaultSlug, vaultSlug, targetProject.projectId);
	await warnIfSharedVaultWrite(api, vaultSlug);

	unwrap(
		await api.PUT("/api/vault/{slug}/items", {
			params: {
				path: { slug: vaultSlug },
				query: { project_id: targetProject.projectId },
			},
			body: { section, fields: { [field]: value } },
		}),
	);

	console.log(chalk.green(`✓ Stored ${normalizedKey}`));
	console.log(
		chalk.gray(
			`  Reference: ${buildExactClawdiReference(targetProject.projectId, vaultSlug, section, field)}`,
		),
	);
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
			if (!hasVaultItems(items)) continue;
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

	const groups = new Map<
		string,
		{
			projectId: string | undefined;
			rows: Array<{ vault: VaultListRow; items: Record<string, string[]> }>;
		}
	>();
	for (const v of vaults) {
		const attachedProjectId = projectId ?? vaultProjectIds(v)[0];
		const items = await fetchItems(v.slug, attachedProjectId);
		if (!hasVaultItems(items)) continue;
		const key = attachedProjectId ?? "(unattached)";
		const group = groups.get(key) ?? { projectId: attachedProjectId, rows: [] };
		group.rows.push({ vault: v, items });
		groups.set(key, group);
	}
	if (groups.size === 0) {
		console.log(chalk.gray("No vaults."));
		return;
	}

	const projects = await listProjects(api.baseUrl, api.apiKey).catch(() => []);
	const projectLabel = (projectId: string | undefined) => {
		if (!projectId) return "unattached";
		const project = projects.find((item) => item.id === projectId);
		return project ? `${formatProjectLabel(project)} (${projectId})` : projectId;
	};

	for (const group of groups.values()) {
		console.log(chalk.white(`Project ${projectLabel(group.projectId)}`));
		for (const { vault, items } of group.rows) {
			const projectCount = vaultProjectIds(vault).length;
			const attachedSummary = projectCount > 1 ? ` (${projectCount} attached Projects)` : "";
			console.log(chalk.gray(`  Vault ${sanitizeMetadata(vault.slug)}${attachedSummary}`));
			for (const row of group.projectId
				? buildVaultReferenceRows(group.projectId, vault.slug, items)
				: []) {
				console.log(chalk.gray(`    ${sanitizeMetadata(row.key)}`));
				console.log(chalk.gray(`      ${row.reference}`));
			}
		}
	}
}

interface VaultProjectOptions {
	project?: string;
}

export async function vaultAttach(vaultSlugArg: string, opts: VaultProjectOptions = {}) {
	requireAuth();
	if (!opts.project) {
		throw new Error("Pass --project to choose which Project should use this Vault.");
	}

	const vaultSlug = cleanVaultSlug(vaultSlugArg);
	const api = new ApiClient();
	const targetProject = await resolveVaultWriteProject(api, opts.project);
	const vault = await loadVault(api, vaultSlug);
	if (!vault) {
		throw new Error(
			`No Vault named "${vaultSlug}" was found. Store a key first with \`clawdi vault set ${vaultSlug}/KEY --prompt\`.`,
		);
	}
	const projectIdsBefore = vaultProjectIds(vault);
	if (projectIdsBefore.includes(targetProject.projectId)) {
		console.log(
			chalk.gray(
				`Vault "${sanitizeMetadata(vaultSlug)}" is already available in ${formatProjectTarget(targetProject)}.`,
			),
		);
		return;
	}

	await ensureVault(api, vaultSlug, vaultSlug, targetProject.projectId);
	const attachedCount = projectIdsBefore.length + 1;
	console.log(
		chalk.green(
			`✓ Attached vault "${sanitizeMetadata(vaultSlug)}" to ${formatProjectTarget(targetProject)}`,
		),
	);
	console.log(
		chalk.gray(
			`  Keys in this Vault are now available from ${attachedCount} Project${attachedCount === 1 ? "" : "s"} and remain one shared key set.`,
		),
	);
}

export async function vaultDetach(vaultSlugArg: string, opts: VaultProjectOptions = {}) {
	requireAuth();
	if (!opts.project) {
		throw new Error("Pass --project to choose which Project should stop using this Vault.");
	}

	const vaultSlug = cleanVaultSlug(vaultSlugArg);
	const api = new ApiClient();
	const targetProject = await resolveVaultWriteProject(api, opts.project);
	const vault = await loadVault(api, vaultSlug);
	if (!vault) {
		throw new Error(`No Vault named "${vaultSlug}" was found.`);
	}
	const projectIdsBefore = vaultProjectIds(vault);
	if (!projectIdsBefore.includes(targetProject.projectId)) {
		console.log(
			chalk.gray(
				`Vault "${sanitizeMetadata(vaultSlug)}" is not attached to ${formatProjectTarget(targetProject)}.`,
			),
		);
		return;
	}

	unwrap(
		await api.DELETE("/api/vault/{slug}", {
			params: { path: { slug: vaultSlug }, query: { project_id: targetProject.projectId } },
		}),
	);
	const remainingCount = Math.max(projectIdsBefore.length - 1, 0);
	console.log(
		chalk.green(
			`✓ Detached vault "${sanitizeMetadata(vaultSlug)}" from ${formatProjectTarget(targetProject)}`,
		),
	);
	console.log(
		chalk.gray(
			`  No keys were deleted. This Vault remains attached to ${remainingCount} Project${remainingCount === 1 ? "" : "s"}.`,
		),
	);
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

interface VaultImportOptions {
	yes?: boolean;
	project?: string;
	section?: string;
	vault?: string;
}

export async function vaultImport(file: string, opts: VaultImportOptions = {}) {
	requireAuth();

	const vaultSlug = cleanVaultSlug(opts.vault ?? "default");
	const section = cleanVaultSection(opts.section ?? "");
	warnIfBroadVaultSlug(vaultSlug);
	const content = readFileSync(file, "utf-8");
	const fields: Record<string, string> = {};
	const parsed = parseDotenvDetailed(content);
	for (const [key, value] of parsed.entries) {
		fields[key] = value;
	}

	if (parsed.skippedInvalidIdentifiers.length > 0) {
		console.log(chalk.yellow(formatSkippedInvalidIdentifiers(parsed.skippedInvalidIdentifiers)));
	}

	if (Object.keys(fields).length === 0) {
		console.log(
			chalk.gray(
				parsed.skippedInvalidIdentifiers.length > 0
					? "No valid keys found in file."
					: "No keys found in file.",
			),
		);
		return;
	}

	const api = new ApiClient();
	const targetProject = await resolveVaultWriteProject(api, opts.project);
	const target = formatVaultTarget(vaultSlug, section, targetProject);

	// Skip the confirmation prompt under `--yes` so CI / scripted
	// imports (demos, .env bootstrap) don't hang on stdin. The
	// preview banner still renders so the operator can see what
	// just landed.
	p.note(
		Object.keys(fields).join("\n"),
		`${Object.keys(fields).length} keys from ${file} -> ${target}`,
	);
	if (!opts.yes) {
		const ok = await p.confirm({ message: `Import these keys to ${target}?` });
		if (p.isCancel(ok) || !ok) {
			p.cancel("Cancelled.");
			return;
		}
	}

	await ensureVault(
		api,
		vaultSlug,
		vaultSlug === "default" ? "Default" : vaultSlug,
		targetProject.projectId,
	);
	await warnIfSharedVaultWrite(api, vaultSlug);

	unwrap(
		await api.PUT("/api/vault/{slug}/items", {
			params: {
				path: { slug: vaultSlug },
				query: { project_id: targetProject.projectId },
			},
			body: { section, fields },
		}),
	);

	console.log(chalk.green(`✓ Imported ${Object.keys(fields).length} keys to ${target}`));
	console.log(chalk.gray("  References:"));
	for (const field of Object.keys(fields).sort()) {
		console.log(
			chalk.gray(
				`    ${sanitizeMetadata(field)}=${buildExactClawdiReference(targetProject.projectId, vaultSlug, section, field)}`,
			),
		);
	}
}

interface VaultRmOptions {
	project?: string;
	yes?: boolean;
	global?: boolean;
}

export async function vaultRm(key: string, opts: VaultRmOptions = {}) {
	requireAuth();

	const { vaultSlug, section, field } = parseVaultKey(key);
	const normalizedKey = formatVaultKey(vaultSlug, section, field);
	if (!opts.yes && !isInteractive()) {
		throw new Error(
			"Cannot prompt for vault deletion in a non-interactive shell. Pass --yes to confirm explicitly.",
		);
	}

	const api = new ApiClient();
	const targetProject = await resolveVaultWriteProject(api, opts.project);
	const target = formatVaultTarget(vaultSlug, section, targetProject);
	const attachedProjectIds = await loadVaultProjectIds(api, vaultSlug);
	if (attachedProjectIds.length > 1 && !opts.global) {
		throw new Error(
			`Refusing to delete ${normalizedKey} from shared vault "${vaultSlug}". This Vault is attached to ${attachedProjectIds.length} Projects, so deleting the key would remove it for every Project. Re-run with --global after you have confirmed that is intended.`,
		);
	}

	if (!opts.yes) {
		const ok = await p.confirm({
			message:
				attachedProjectIds.length > 1
					? `Delete ${normalizedKey} globally from ${attachedProjectIds.length} Projects using ${target}?`
					: `Delete ${normalizedKey} from ${target}?`,
		});
		if (p.isCancel(ok) || !ok) {
			p.cancel("Cancelled.");
			return;
		}
	}

	unwrap(
		await api.DELETE("/api/vault/{slug}/items", {
			params: {
				path: { slug: vaultSlug },
				query: { project_id: targetProject.projectId, global_delete: Boolean(opts.global) },
			},
			body: { section, fields: [field] },
		}),
	);

	const suffix =
		attachedProjectIds.length > 1
			? ` globally from shared ${target} (${attachedProjectIds.length} Projects attached)`
			: ` from ${target}`;
	console.log(chalk.green(`✓ Deleted ${normalizedKey}${suffix}`));
}

async function readVaultSetValue(key: string, opts: VaultSetOptions): Promise<string | null> {
	const selectedSources = [
		opts.value !== undefined,
		Boolean(opts.stdin),
		Boolean(opts.prompt),
	].filter(Boolean).length;
	if (selectedSources > 1) {
		throw new Error("Pass only one of --value, --stdin, or --prompt.");
	}
	if (opts.value !== undefined) {
		assertNonEmptyVaultValue(opts.value, "--value", opts);
		return opts.value;
	}
	if (opts.stdin) {
		if (process.stdin.isTTY) {
			throw new Error("Refusing to read --stdin from an interactive TTY.");
		}
		const value = stripFinalNewline(await readStdin());
		assertNonEmptyVaultValue(value, "--stdin", opts);
		return value;
	}
	if ((opts.prompt || selectedSources === 0) && !isInteractive()) {
		throw new Error(
			"Cannot prompt for a vault value in a non-interactive shell. Use --stdin with piped input.",
		);
	}
	const value = await p.password({ message: `Value for ${key}:` });
	if (p.isCancel(value)) {
		p.cancel("Cancelled.");
		return null;
	}
	if (!value && !opts.allowEmpty) {
		p.cancel("Cancelled.");
		return null;
	}
	return value;
}

function assertNonEmptyVaultValue(
	value: string,
	source: "--value" | "--stdin",
	opts: VaultSetOptions,
) {
	if (value.length > 0 || opts.allowEmpty) return;
	throw new Error(
		`Refusing to store an empty secret from ${source}. Pass --allow-empty to store an empty value intentionally.`,
	);
}

async function readStdin(): Promise<string> {
	return await new Promise((resolve, reject) => {
		let input = "";
		const cleanup = () => {
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
			process.stdin.off("error", onError);
		};
		const onData = (chunk: string) => {
			input += chunk;
		};
		const onEnd = () => {
			cleanup();
			resolve(input);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", onData);
		process.stdin.once("end", onEnd);
		process.stdin.once("error", onError);
	});
}

function stripFinalNewline(value: string): string {
	return value.replace(/\r?\n$/, "");
}

function hasVaultItems(items: Record<string, string[]>): boolean {
	return Object.values(items).some((fields) => fields.length > 0);
}

function warnIfBroadVaultSlug(vaultSlug: string) {
	if (!BROAD_VAULT_SLUGS.has(vaultSlug)) return;
	console.log(
		chalk.yellow(
			`Hint: consider using a service-specific vault slug instead of "${sanitizeMetadata(vaultSlug)}" for shared project secrets.`,
		),
	);
}

async function loadVaultProjectIds(api: ApiClient, vaultSlug: string): Promise<string[]> {
	const vault = await loadVault(api, vaultSlug);
	return vault ? vaultProjectIds(vault) : [];
}

async function loadVault(api: ApiClient, vaultSlug: string): Promise<VaultListRow | null> {
	const page = await fetchAllVaults(api);
	const vault = page.items.find((item) => item.slug === vaultSlug);
	return vault ?? null;
}

async function warnIfSharedVaultWrite(api: ApiClient, vaultSlug: string) {
	const projectIds = await loadVaultProjectIds(api, vaultSlug).catch(() => []);
	if (projectIds.length <= 1) return;
	console.log(
		chalk.yellow(
			`  Shared Vault: "${sanitizeMetadata(vaultSlug)}" is attached to ${projectIds.length} Projects. This write updates the same key set for every attached Project.`,
		),
	);
}

function cleanVaultSlug(value: string): string {
	const slug = value.trim();
	if (!VAULT_SLUG_RE.test(slug)) {
		throw new Error(
			"Vault slug must use lowercase letters, numbers, and hyphens, without leading or trailing hyphens.",
		);
	}
	return slug;
}

function cleanVaultSection(value: string): string {
	const section = value.trim();
	if (!section) return "";
	if (section.length > 200) throw new Error("Vault section must be at most 200 characters.");
	if (!VAULT_ITEM_SEGMENT_RE.test(section)) {
		throw new Error(
			"Vault section may contain only letters, numbers, dots, underscores, and hyphens.",
		);
	}
	return section;
}

function cleanVaultField(value: string): string {
	const field = value.trim();
	if (!field) throw new Error("Vault field cannot be empty.");
	if (field.length > 200) throw new Error("Vault field must be at most 200 characters.");
	if (!VAULT_ITEM_SEGMENT_RE.test(field)) {
		throw new Error(
			"Vault field may contain only letters, numbers, dots, underscores, and hyphens.",
		);
	}
	return field;
}

interface VaultWriteProject {
	projectId: string;
	label: string;
	source: "explicit" | "default";
}

async function resolveVaultWriteProject(
	api: ApiClient,
	projectArg: string | undefined,
): Promise<VaultWriteProject> {
	const projectId = await resolveProjectId(api.baseUrl, api.apiKey, projectArg);
	const project = (await listProjects(api.baseUrl, api.apiKey).catch(() => [])).find(
		(item) => item.id === projectId,
	);
	return {
		projectId,
		label: project ? formatProjectLabel(project) : projectArg || projectId,
		source: projectArg ? "explicit" : "default",
	};
}

function formatVaultTarget(vaultSlug: string, section: string, project: VaultWriteProject): string {
	const target = section ? `vault "${vaultSlug}" section "${section}"` : `vault "${vaultSlug}"`;
	const source = project.source === "explicit" ? "explicit project" : "default-write project";
	return `${target} in ${source} "${sanitizeMetadata(project.label)}" (${project.projectId})`;
}

function formatProjectTarget(project: VaultWriteProject): string {
	const source = project.source === "explicit" ? "explicit project" : "default-write project";
	return `${source} "${sanitizeMetadata(project.label)}" (${project.projectId})`;
}

function formatProjectLabel(project: {
	slug: string;
	is_owner?: boolean;
	owner_handle?: string | null;
}) {
	if (project.is_owner === false && project.owner_handle) {
		return `@${project.owner_handle}/${project.slug}`;
	}
	return project.slug;
}

function formatVaultKey(vaultSlug: string, section: string, field: string): string {
	if (vaultSlug === "default" && !section) return field;
	return [vaultSlug, section, field].filter(Boolean).join("/");
}

function formatSkippedInvalidIdentifiers(identifiers: string[]): string {
	const maxShown = 10;
	const shown = identifiers.slice(0, maxShown).map(sanitizeMetadata).join(", ");
	const more = identifiers.length > maxShown ? `, +${identifiers.length - maxShown} more` : "";
	return `Skipped ${identifiers.length} ${pluralize(
		"key",
		identifiers.length,
	)} with invalid identifiers: ${shown}${more}`;
}

function pluralize(word: string, count: number): string {
	return count === 1 ? word : `${word}s`;
}

function parseVaultKey(key: string): { vaultSlug: string; section: string; field: string } {
	const cleaned = key.replace(/^clawdi:\/\//, "").trim();
	const parts = cleaned.split("/");
	if (parts.length === 1) {
		return { vaultSlug: "default", section: "", field: cleanVaultField(parts[0] ?? "") };
	}
	if (parts.length === 2) {
		return {
			vaultSlug: cleanVaultSlug(parts[0] ?? ""),
			section: "",
			field: cleanVaultField(parts[1] ?? ""),
		};
	}
	if (parts.length === 3) {
		if (!(parts[1] ?? "").trim()) throw new Error("Vault section cannot be empty.");
		return {
			vaultSlug: cleanVaultSlug(parts[0] ?? ""),
			section: cleanVaultSection(parts[1] ?? ""),
			field: cleanVaultField(parts[2] ?? ""),
		};
	}
	throw new Error("Vault key must be KEY, vault/KEY, or vault/section/KEY.");
}
