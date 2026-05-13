import chalk from "chalk";
import { getAuth, getConfig } from "../lib/config";
import { listScopes, resolveScopeId } from "../lib/scope-resolver";

interface ScopeBrief {
	id: string;
	name: string;
	slug: string;
	kind: string;
	origin_environment_id?: string | null;
	archived_at?: string | null;
	created_at?: string;
	is_owner?: boolean;
}

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

interface SkillRow {
	scope_id?: string | null;
	skill_key: string;
}

interface VaultRow {
	scope_id: string;
	slug: string;
	name: string;
}

async function authedJson<T>(apiUrl: string, bearer: string, path: string): Promise<T> {
	const r = await fetch(`${apiUrl}${path}`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (!r.ok) throw new Error(`API error ${r.status}: ${await r.text()}`);
	return r.json() as Promise<T>;
}

async function fetchAllSkills(apiUrl: string, bearer: string): Promise<SkillRow[]> {
	const items: SkillRow[] = [];
	let page = 1;
	const pageSize = 200;
	while (page <= 50) {
		const body = await authedJson<{ items: SkillRow[]; total?: number }>(
			apiUrl,
			bearer,
			`/api/skills?page=${page}&page_size=${pageSize}`,
		);
		items.push(...body.items);
		if (items.length >= (body.total ?? items.length) || body.items.length === 0) break;
		page += 1;
	}
	return items;
}

export async function scopeShowCommand(
	scopeArg: string,
	opts: { json?: boolean } = {},
): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}

	const scopeId = await resolveScopeId(apiUrl, auth.apiKey, scopeArg);
	const scopes = (await listScopes(apiUrl, auth.apiKey)) as ScopeBrief[];
	const scope = scopes.find((s) => s.id === scopeId);
	if (!scope) {
		console.error(chalk.red(`No scope matches '${scopeArg}'. Try \`clawdi scope list\`.`));
		process.exitCode = 1;
		return;
	}

	const [mounts, skills, vaultsPage] = await Promise.all([
		authedJson<MountRow[]>(apiUrl, auth.apiKey, `/api/scopes/${scopeId}/mounts`).catch(() => []),
		fetchAllSkills(apiUrl, auth.apiKey).catch(() => []),
		authedJson<{ items: VaultRow[] }>(apiUrl, auth.apiKey, "/api/vault?page_size=200").catch(
			() => ({ items: [] }),
		),
	]);
	const ownSkills = skills.filter((s) => s.scope_id === scopeId);
	const ownVaults = vaultsPage.items.filter((v) => v.scope_id === scopeId);

	const payload = {
		scope: {
			id: scope.id,
			slug: scope.slug,
			name: scope.name,
			kind: scope.kind,
			is_owner: scope.is_owner !== false,
			origin_environment_id: scope.origin_environment_id ?? null,
			archived_at: scope.archived_at ?? null,
			created_at: scope.created_at ?? null,
		},
		skills: {
			count: ownSkills.length,
			keys: ownSkills.map((s) => s.skill_key).sort(),
		},
		vaults: ownVaults.map((v) => ({ slug: v.slug, name: v.name })),
		mounts,
	};

	if (opts.json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(chalk.bold(scope.name));
	console.log(`  slug: ${chalk.cyan(scope.slug)}`);
	console.log(`  id:   ${chalk.gray(scope.id)}`);
	console.log(`  kind: ${scope.kind}${scope.is_owner === false ? chalk.gray(" (shared)") : ""}`);
	console.log(`  skills: ${ownSkills.length}`);
	console.log(`  vaults: ${ownVaults.length}`);
	if (mounts.length > 0) {
		console.log("  mounts:");
		for (const m of mounts) {
			console.log(
				`    ${chalk.bold(m.alias)} ${chalk.gray("←")} ${m.source_owner_display} ` +
					chalk.gray(`@${m.source_owner_handle}/${m.source_scope_slug}`),
			);
		}
	}
}
