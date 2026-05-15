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
	owner_display?: string | null;
	owner_handle?: string | null;
}

interface SkillRow {
	project_id?: string | null;
	skill_key: string;
}

interface VaultRow {
	project_id?: string | null;
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
	const ownSkills = skills.filter((s) => s.project_id === projectId);
	const ownVaults = vaultsPage.items.filter((v) => v.project_id === projectId);

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
			owner_display: project.owner_display ?? null,
			owner_handle: project.owner_handle ?? null,
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

	const isOwner = project.is_owner !== false;
	const alias = projectAlias(project);
	const owner = isOwner
		? "you"
		: project.owner_display && project.owner_handle
			? `${project.owner_display} (@${project.owner_handle})`
			: project.owner_display || (project.owner_handle ? `@${project.owner_handle}` : "Unknown");
	console.log(chalk.bold(project.name));
	console.log(`  Project: ${chalk.cyan(alias)}`);
	console.log(`  Role: ${isOwner ? "owner" : "viewer"}`);
	console.log(`  Owner: ${owner}`);
	console.log(
		`  Access: ${isOwner ? "edit resources and manage sharing" : "read-only project access"}`,
	);
	console.log(`  Type: ${project.kind}`);
	console.log(`  ID: ${chalk.gray(project.id)}`);
	console.log();
	console.log(chalk.bold("Resources"));
	console.log(`  Skills: ${ownSkills.length}`);
	console.log(`  Vault refs: ${ownVaults.length}`);
	console.log();
	if (isOwner) {
		console.log(chalk.bold("Next actions"));
		console.log(`  Manage sharing: ${chalk.cyan(`clawdi project share ${alias}`)}`);
		console.log(`  People:         ${chalk.cyan(`clawdi project members ${alias}`)}`);
		console.log(
			`  Set as Home:    ${chalk.cyan(`clawdi agent projects set-home <agent-id> --project ${alias}`)}`,
		);
	} else {
		console.log(chalk.bold("Next actions"));
		console.log("  Use with agent:");
		console.log(`    ${chalk.cyan(`clawdi agent projects attach <agent-id> --project ${alias}`)}`);
		console.log(`  Leave: ${chalk.cyan(`clawdi project leave ${alias}`)}`);
	}
}

function projectAlias(project: {
	slug: string;
	is_owner?: boolean;
	owner_handle?: string | null;
}): string {
	if (project.is_owner === false && project.owner_handle) {
		return `@${project.owner_handle}/${project.slug}`;
	}
	return project.slug;
}
