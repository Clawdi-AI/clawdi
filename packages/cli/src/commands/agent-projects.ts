import chalk from "chalk";
import { parsePositiveInteger } from "../lib/cli-options";
import { commandMessage, commandResult, emitJson } from "../lib/command-output";
import { authedJson, projectAlias, requireProjectAuth } from "../lib/project-command-utils";
import { listProjects, type ProjectBrief, resolveProjectId } from "../lib/project-resolver";
import { confirmOrRequireYes } from "../lib/prompts";
import { isInteractive } from "../lib/tty";

interface BindingRow {
	id: string;
	agent_id: string;
	project_id: string;
	binding_type: "primary" | "context";
	priority: number;
	default_write_enabled: boolean;
	created_at: string;
}

function parseOrder(raw: string | number, errorMessage: string): number {
	try {
		return parsePositiveInteger(raw);
	} catch {
		throw new Error(errorMessage);
	}
}

export async function agentProjectsListCommand(
	agentId: string,
	opts: { json?: boolean } = {},
): Promise<void> {
	const { apiUrl, apiKey } = await requireProjectAuth();
	const rows = await authedJson<BindingRow[]>(
		apiUrl,
		apiKey,
		`/v1/agents/${encodeURIComponent(agentId)}/project-bindings`,
	);
	const projectsById = new Map<string, ProjectBrief>();
	for (const project of await listProjects(apiUrl, apiKey).catch(() => [])) {
		projectsById.set(project.id, project);
	}
	if (opts.json) {
		emitJson({
			agent_id: agentId,
			bindings: rows.map((row) => ({
				...row,
				project: projectsById.get(row.project_id) ?? null,
			})),
		});
		return;
	}
	const primary = rows.find((row) => row.binding_type === "primary") ?? null;
	const contexts = rows
		.filter((row) => row.binding_type === "context")
		.sort((a, b) => a.priority - b.priority);
	console.log(chalk.bold(`Projects for ${agentId}`));
	console.log(chalk.gray("Vault resolution: workspace, then linked projects."));
	console.log();
	console.log(chalk.bold("Workspace"));
	if (primary) {
		console.log(`  ${formatBindingProject(primary, projectsById)}`);
	} else {
		console.log("  Workspace unavailable.");
	}
	console.log();
	console.log(chalk.bold(`Linked projects (${contexts.length})`));
	if (contexts.length === 0) {
		console.log("  None.");
		console.log(chalk.gray(`  Link: clawdi agent projects link ${agentId} --project <project>`));
		return;
	}
	for (const [index, row] of contexts.entries()) {
		console.log(`  ${index + 1}. ${formatBindingProject(row, projectsById)}`);
	}
	console.log();
	console.log(
		chalk.gray("Move:   ") +
			chalk.cyan(`clawdi agent projects move ${agentId} --item ${contexts[0].id}:1`),
	);
	console.log(
		chalk.gray("Unlink:  ") +
			chalk.cyan(`clawdi agent projects unlink ${agentId} --project <project>`),
	);
}

export async function agentProjectsAddContextCommand(
	agentId: string,
	opts: { project: string; order?: string | number; json?: boolean },
): Promise<void> {
	const { apiUrl, apiKey } = await requireProjectAuth();
	const projectId = await resolveProjectId(apiUrl, apiKey, opts.project);
	let priority: number | undefined;
	if (opts.order !== undefined) {
		priority = parseOrder(opts.order, "--order <order> must be an integer >= 1.");
	}
	const binding = await authedJson<BindingRow>(
		apiUrl,
		apiKey,
		`/v1/agents/${encodeURIComponent(agentId)}/project-bindings/context`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ project_id: projectId, priority }),
		},
	);
	commandMessage(opts.json, `${chalk.green("✓")} Linked to ${agentId}.`);
	commandMessage(opts.json, chalk.gray("  Vaults resolve after the workspace."));
	commandResult(opts.json, "clawdi.agentProjectsLink.v1", { ...binding });
}

export async function agentProjectsRemoveContextCommand(
	agentId: string,
	opts: { project: string; yes?: boolean; json?: boolean },
): Promise<void> {
	const { apiUrl, apiKey } = await requireProjectAuth();
	const projectId = await resolveProjectId(apiUrl, apiKey, opts.project);
	const rows = await authedJson<BindingRow[]>(
		apiUrl,
		apiKey,
		`/v1/agents/${encodeURIComponent(agentId)}/project-bindings`,
	);
	const matches = rows.filter(
		(row) => row.binding_type === "context" && row.project_id === projectId,
	);
	if (matches.length === 0) {
		console.error(chalk.red("No matching linked project."));
		process.exitCode = 1;
		return;
	}
	if (matches.length > 1) {
		console.error(chalk.red("Multiple linked projects match. Unlink by relation ID."));
		process.exitCode = 1;
		return;
	}
	if (
		isInteractive() &&
		!(await confirmOrRequireYes(`Unlink project ${opts.project} from ${agentId}?`, {
			yes: opts.yes,
			action: "unlink this project",
		}))
	) {
		commandResult(opts.json, "clawdi.agentProjectsUnlink.v1", {
			agent_id: agentId,
			project_id: projectId,
			status: "cancelled",
		});
		return;
	}
	await authedJson<{ status: string }>(
		apiUrl,
		apiKey,
		`/v1/agents/${encodeURIComponent(agentId)}/project-bindings/${encodeURIComponent(matches[0].id)}`,
		{ method: "DELETE" },
	);
	commandMessage(opts.json, `${chalk.green("✓")} Unlinked from ${agentId}.`);
	commandMessage(opts.json, chalk.gray("  Project membership unchanged."));
	commandResult(opts.json, "clawdi.agentProjectsUnlink.v1", {
		agent_id: agentId,
		project_id: projectId,
		id: matches[0].id,
		status: "unlinked",
	});
}

export async function agentProjectsReorderCommand(
	agentId: string,
	opts: { item?: string[]; json?: boolean },
): Promise<void> {
	const { apiUrl, apiKey } = await requireProjectAuth();
	const itemError = "--item must use <id>:<order> with order >= 1.";
	const items = (opts.item ?? []).map((raw) => {
		const parts = raw.split(":");
		if (parts.length !== 2 || !parts[0]) {
			throw new Error(itemError);
		}
		const [bindingId, priorityRaw] = parts;
		const priority = parseOrder(priorityRaw, itemError);
		return { binding_id: bindingId, priority };
	});
	if (items.length === 0) {
		throw new Error("Pass at least one --item <id>:<order>.");
	}
	await authedJson<{ status: string }>(
		apiUrl,
		apiKey,
		`/v1/agents/${encodeURIComponent(agentId)}/project-bindings/context/reorder`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ items }),
		},
	);
	commandMessage(
		opts.json,
		`${chalk.green("✓")} Updated vault resolution priority for ${agentId}.`,
	);
	commandResult(opts.json, "clawdi.agentProjectsMove.v1", {
		agent_id: agentId,
		items,
		status: "updated",
	});
}

function formatBindingProject(row: BindingRow, projectsById: Map<string, ProjectBrief>): string {
	const project = projectsById.get(row.project_id);
	const alias = project ? projectAlias(project) : row.project_id;
	const ownership = project?.is_owner === false ? "viewer" : "owner";
	const name = project?.name && project.name !== project.slug ? ` ${chalk.dim(project.name)}` : "";
	const meta =
		row.binding_type === "context"
			? `id=${row.id} project=${row.project_id} vault_priority=${row.priority}`
			: `project=${row.project_id}`;
	return `${chalk.cyan(alias)} ${chalk.gray(ownership)}${name} ${chalk.gray(meta)}`;
}
