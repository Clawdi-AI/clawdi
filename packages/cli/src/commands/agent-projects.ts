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
	if (rows.length === 0) {
		console.log(`No project bindings on agent ${agentId}.`);
		return;
	}
	console.log(chalk.bold(`Project bindings on ${agentId} (${rows.length}):`));
	for (const row of rows) {
		const mode = row.binding_type === "primary" ? chalk.green("primary") : chalk.cyan("context");
		const project = projectsById.get(row.project_id);
		const label = project
			? `${project.is_owner === false && project.owner_handle ? `@${project.owner_handle}/` : ""}${project.slug}`
			: row.project_id;
		console.log(
			`  ${mode}  ${label}  ${chalk.gray(`priority=${row.priority} project=${row.project_id.slice(0, 8)} id=${row.id.slice(0, 8)}…`)}`,
		);
	}
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
	console.log(`${chalk.green("✓")} Set primary project for ${agentId}.`);
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
	console.log(`${chalk.green("✓")} Added context project for ${agentId}.`);
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
		console.error(chalk.red("No matching context project binding found."));
		process.exitCode = 1;
		return;
	}
	if (matches.length > 1) {
		console.error(
			chalk.red("Multiple context bindings matched this project. Remove by binding id."),
		);
		process.exitCode = 1;
		return;
	}
	await authedJson<{ status: string }>(
		apiUrl,
		apiKey,
		`/api/agents/${encodeURIComponent(agentId)}/project-bindings/${encodeURIComponent(matches[0].id)}`,
		{ method: "DELETE" },
	);
	console.log(`${chalk.green("✓")} Removed context project from ${agentId}.`);
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
			throw new Error("--item must use <binding-id>:<priority> with priority >= 1.");
		}
		return { binding_id: bindingId, priority };
	});
	if (items.length === 0) {
		throw new Error("Pass at least one --item <binding-id>:<priority>.");
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
	console.log(`${chalk.green("✓")} Reordered context projects for ${agentId}.`);
}
