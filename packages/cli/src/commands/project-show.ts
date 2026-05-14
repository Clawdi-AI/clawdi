import chalk from "chalk";
import { getAuth, getConfig } from "../lib/config";
import { listProjects, resolveProjectId } from "../lib/project-resolver";

interface ProjectBrief {
	id: string;
	name: string;
	slug: string;
	kind: string;
	origin_environment_id?: string | null;
	archived_at?: string | null;
	created_at?: string;
	is_owner?: boolean;
}

interface SkillRow {
	project_id?: string | null;
	scope_id?: string | null;
	skill_key: string;
}

interface VaultRow {
	project_id?: string | null;
	scope_id?: string | null;
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

export async function projectShowCommand(
	projectArg: string,
	opts: { json?: boolean } = {},
): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}

	const projectId = await resolveProjectId(apiUrl, auth.apiKey, projectArg);
	const projects = (await listProjects(apiUrl, auth.apiKey)) as ProjectBrief[];
	const project = projects.find((s) => s.id === projectId);
	if (!project) {
		console.error(chalk.red(`No project matches '${projectArg}'. Try \`clawdi project list\`.`));
		process.exitCode = 1;
		return;
	}

	const [skills, vaultsPage] = await Promise.all([
		fetchAllSkills(apiUrl, auth.apiKey).catch(() => []),
		authedJson<{ items: VaultRow[] }>(apiUrl, auth.apiKey, "/api/vault?page_size=200").catch(
			() => ({ items: [] }),
		),
	]);
	const ownSkills = skills.filter((s) => (s.project_id ?? s.scope_id) === projectId);
	const ownVaults = vaultsPage.items.filter((v) => (v.project_id ?? v.scope_id) === projectId);

	const payload = {
		project: {
			id: project.id,
			slug: project.slug,
			name: project.name,
			kind: project.kind,
			is_owner: project.is_owner !== false,
			origin_environment_id: project.origin_environment_id ?? null,
			archived_at: project.archived_at ?? null,
			created_at: project.created_at ?? null,
		},
		skills: {
			count: ownSkills.length,
			keys: ownSkills.map((s) => s.skill_key).sort(),
		},
		vaults: ownVaults.map((v) => ({ slug: v.slug, name: v.name })),
	};

	if (opts.json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(chalk.bold(project.name));
	console.log(`  slug: ${chalk.cyan(project.slug)}`);
	console.log(`  id:   ${chalk.gray(project.id)}`);
	console.log(
		`  kind: ${project.kind}${project.is_owner === false ? chalk.gray(" (shared)") : ""}`,
	);
	console.log(`  skills: ${ownSkills.length}`);
	console.log(`  vaults: ${ownVaults.length}`);
}
