import chalk from "chalk";
import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { listProjects, resolveProjectId } from "../lib/project-resolver";

interface BindingRow {
	id: string;
	agent_id: string;
	project_id: string;
	binding_type: "primary" | "context";
	priority: number;
	default_write_enabled: boolean;
	created_at: string;
}

interface ProjectBrief {
	id: string;
	name: string;
	slug: string;
	kind: string;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

function requireAuth(): { apiUrl: string; apiKey: string } {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		throw new Error("Not signed in. Run `clawdi auth login` first.");
	}
	return { apiUrl, apiKey: auth.apiKey };
}

async function authedJson<T>(
	apiUrl: string,
	apiKey: string,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const r = await fetch(`${apiUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...(init.headers ?? {}),
		},
	});
	if (!r.ok) {
		throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	}
	return r.json() as Promise<T>;
}

export async function agentProjectsListCommand(
	agentId: string,
	opts: { json?: boolean } = {},
): Promise<void> {
	const { apiUrl, apiKey } = requireAuth();
	const rows = await authedJson<BindingRow[]>(
		apiUrl,
		apiKey,
		`/api/agents/${encodeURIComponent(agentId)}/project-bindings`,
	);
	const projectsById = new Map<string, ProjectBrief>();
	for (const project of await listProjects(apiUrl, apiKey).catch(() => [])) {
		projectsById.set(project.id, project);
	}
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					agent_id: agentId,
					bindings: rows.map((row) => ({
						...row,
						project: projectsById.get(row.project_id) ?? null,
					})),
				},
				null,
				2,
			),
		);
		return;
	}
	const primary = rows.find((row) => row.binding_type === "primary") ?? null;
	const contexts = rows
		.filter((row) => row.binding_type === "context")
		.sort((a, b) => a.priority - b.priority);
	console.log(chalk.bold(`Projects used by ${agentId}`));
	console.log(chalk.gray("Order matters: Home wins first, then attached projects in order."));
	console.log();
	console.log(chalk.bold("Home project"));
	if (primary) {
		console.log(`  ${formatBindingProject(primary, projectsById)}`);
	} else {
		console.log("  No Home project set.");
		console.log(
			`  ${chalk.gray(`Set one: clawdi agent projects set-primary ${agentId} --project <owned-project>`)}`,
		);
	}
	console.log();
	console.log(chalk.bold(`Attached projects (${contexts.length})`));
	if (contexts.length === 0) {
		console.log("  No attached projects yet.");
		console.log(
			`  ${chalk.gray(`Attach one: clawdi agent projects add-context ${agentId} --project <project>`)}`,
		);
		return;
	}
	for (const [index, row] of contexts.entries()) {
		console.log(`  ${index + 1}. ${formatBindingProject(row, projectsById)}`);
	}
	console.log();
	console.log(
		chalk.gray("Reorder: ") +
			chalk.cyan(`clawdi agent projects reorder ${agentId} --item <attachment-id>:1`),
	);
	console.log(
		chalk.gray("Detach:  ") +
			chalk.cyan(`clawdi agent projects remove-context ${agentId} --project <project>`),
	);
}

export async function agentProjectsSetPrimaryCommand(
	agentId: string,
	opts: { project: string },
): Promise<void> {
	const { apiUrl, apiKey } = requireAuth();
	const projectId = await resolveProjectId(apiUrl, apiKey, opts.project);
	await authedJson<BindingRow>(
		apiUrl,
		apiKey,
		`/api/agents/${encodeURIComponent(agentId)}/project-bindings/primary`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ project_id: projectId }),
		},
	);
	console.log(`${chalk.green("✓")} Set Home project for ${agentId}.`);
	console.log(chalk.gray("  Shared projects stay attached; the Home project must be owned."));
}

export async function agentProjectsAddContextCommand(
	agentId: string,
	opts: { project: string; priority?: string },
): Promise<void> {
	const { apiUrl, apiKey } = requireAuth();
	const projectId = await resolveProjectId(apiUrl, apiKey, opts.project);
	const priority =
		opts.priority !== undefined && opts.priority !== ""
			? Number.parseInt(opts.priority, 10)
			: undefined;
	await authedJson<BindingRow>(
		apiUrl,
		apiKey,
		`/api/agents/${encodeURIComponent(agentId)}/project-bindings/context`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ project_id: projectId, priority }),
		},
	);
	console.log(`${chalk.green("✓")} Attached project to ${agentId}.`);
	console.log(chalk.gray("  Order matters: Home wins first, then attached projects by order."));
}

export async function agentProjectsRemoveContextCommand(
	agentId: string,
	opts: { project: string },
): Promise<void> {
	const { apiUrl, apiKey } = requireAuth();
	const projectId = await resolveProjectId(apiUrl, apiKey, opts.project);
	const rows = await authedJson<BindingRow[]>(
		apiUrl,
		apiKey,
		`/api/agents/${encodeURIComponent(agentId)}/project-bindings`,
	);
	const matches = rows.filter(
		(row) => row.binding_type === "context" && row.project_id === projectId,
	);
	if (matches.length === 0) {
		console.error(chalk.red("No matching attached project found."));
		process.exitCode = 1;
		return;
	}
	if (matches.length > 1) {
		console.error(chalk.red("Multiple attachments matched this project. Detach by id."));
		process.exitCode = 1;
		return;
	}
	await authedJson<{ status: string }>(
		apiUrl,
		apiKey,
		`/api/agents/${encodeURIComponent(agentId)}/project-bindings/${encodeURIComponent(matches[0].id)}`,
		{ method: "DELETE" },
	);
	console.log(`${chalk.green("✓")} Detached project from ${agentId}.`);
	console.log(chalk.gray("  Project membership is unchanged; only this agent stopped using it."));
}

export async function agentProjectsReorderCommand(
	agentId: string,
	opts: { item?: string[] },
): Promise<void> {
	const { apiUrl, apiKey } = requireAuth();
	const items = (opts.item ?? []).map((raw) => {
		const [bindingId, priorityRaw] = raw.split(":");
		const priority = Number.parseInt(priorityRaw ?? "", 10);
		if (!bindingId || !Number.isFinite(priority) || priority < 1) {
			throw new Error("--item must use <attachment-id>:<priority> with priority >= 1.");
		}
		return { binding_id: bindingId, priority };
	});
	if (items.length === 0) {
		throw new Error("Pass at least one --item <attachment-id>:<priority>.");
	}
	await authedJson<{ status: string }>(
		apiUrl,
		apiKey,
		`/api/agents/${encodeURIComponent(agentId)}/project-bindings/context/reorder`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ items }),
		},
	);
	console.log(`${chalk.green("✓")} Reordered attached projects for ${agentId}.`);
}

function formatBindingProject(row: BindingRow, projectsById: Map<string, ProjectBrief>): string {
	const project = projectsById.get(row.project_id);
	const alias = project ? projectAlias(project) : row.project_id;
	const ownership = project?.is_owner === false ? "viewer" : "owner";
	const name = project?.name && project.name !== project.slug ? ` ${chalk.dim(project.name)}` : "";
	return (
		`${chalk.cyan(alias)} ${chalk.gray(ownership)}${name} ` +
		chalk.gray(
			`attachment=${row.id.slice(0, 8)}… project=${row.project_id.slice(0, 8)} order=${row.priority}`,
		)
	);
}

function projectAlias(project: ProjectBrief): string {
	if (project.is_owner === false && project.owner_handle) {
		return `@${project.owner_handle}/${project.slug}`;
	}
	return project.slug;
}
