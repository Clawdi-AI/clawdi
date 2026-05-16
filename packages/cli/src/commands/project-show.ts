import chalk from "chalk";
import { authedJson, projectAlias, projectAuthOrExit } from "../lib/project-command-utils";
import { listProjects, type ProjectBrief, resolveProjectId } from "../lib/project-resolver";

interface ProjectDetail extends ProjectBrief {
	origin_environment_id?: string | null;
	archived_at?: string | null;
	created_at?: string;
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
	const ctx = projectAuthOrExit();
	if (!ctx) return;
	const { apiUrl, apiKey } = ctx;

	const projectId = await resolveProjectId(apiUrl, apiKey, projectArg);
	const projects = (await listProjects(apiUrl, apiKey)) as ProjectDetail[];
	const project = projects.find((s) => s.id === projectId);
	if (!project) {
		console.error(chalk.red(`No project matches '${projectArg}'. Try \`clawdi project list\`.`));
		process.exitCode = 1;
		return;
	}

	const [skills, vaultsPage] = await Promise.all([
		fetchAllSkills(apiUrl, apiKey).catch(() => []),
		authedJson<{ items: VaultRow[] }>(apiUrl, apiKey, "/api/vault?page_size=200").catch(() => ({
			items: [],
		})),
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
			`  Attach to Agent:${chalk.cyan(` clawdi agent projects attach <agent-id> --project ${alias}`)}`,
		);
	} else {
		console.log(chalk.bold("Next actions"));
		console.log("  Attach to Agent:");
		console.log(`    ${chalk.cyan(`clawdi agent projects attach <agent-id> --project ${alias}`)}`);
		console.log(`  Leave: ${chalk.cyan(`clawdi project leave ${alias}`)}`);
	}
}
