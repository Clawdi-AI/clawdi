import chalk from "chalk";
import { readJson } from "../lib/api-client";
import { projectAlias, requireProjectAuth } from "../lib/project-command-utils";
import {
	findProjectFolderLink,
	normalizeFolderPath,
	removeProjectFolderLink,
	setProjectFolderLink,
} from "../lib/project-folders";
import { listProjects, type ProjectBrief, resolveProjectId } from "../lib/project-resolver";

export async function projectFolderLinkCommand(
	folderPath: string | undefined,
	opts: { project: string },
): Promise<void> {
	const { apiUrl, apiKey } = requireProjectAuth();
	const projectId = await resolveProjectId(apiUrl, apiKey, opts.project);
	const project = await findVisibleProject(apiUrl, apiKey, projectId, opts.project);
	const label = projectAlias(project);
	const link = setProjectFolderLink(folderPath, {
		project_id: project.id,
		project_label: label,
		project_name: project.name,
		project_slug: project.slug,
		owner_handle: project.owner_handle ?? null,
		owner_display: project.owner_display ?? null,
	});

	console.log(`${chalk.green("✓")} Linked this folder to Project ${chalk.cyan(label)}.`);
	if (project.name && project.name !== project.slug) {
		console.log(chalk.gray(`  Project name: ${project.name}`));
	}
	console.log(chalk.gray(`  Folder: ${link.path}`));
	console.log(chalk.gray("  clawdi run/inject will use this Project for vault references."));
}

export async function projectFolderUnlinkCommand(folderPath: string | undefined): Promise<void> {
	const path = normalizeFolderPath(folderPath);
	const removed = removeProjectFolderLink(path);
	if (!removed) {
		console.log(`No linked Project folder found for ${chalk.cyan(path)}.`);
		const parent = findProjectFolderLink(path);
		if (parent) {
			console.log(
				chalk.gray(
					`  Parent link still applies: ${parent.link.path} -> Project ${parent.link.project_label}`,
				),
			);
			console.log(
				chalk.gray(`  Unlink that folder with: clawdi project folder unlink ${parent.link.path}`),
			);
		}
		return;
	}
	console.log(
		`${chalk.green("✓")} Unlinked this folder from Project ${chalk.cyan(removed.project_label)}.`,
	);
	console.log(chalk.gray(`  Folder: ${removed.path}`));
}

export async function projectFolderStatusCommand(folderPath: string | undefined): Promise<void> {
	const path = normalizeFolderPath(folderPath);
	const match = findProjectFolderLink(path);
	console.log(chalk.bold(`Project for ${path}`));
	if (match) {
		console.log(`  Project: ${chalk.cyan(match.link.project_label)}`);
		console.log(
			`  Source: ${match.source === "exact" ? "linked folder (exact)" : "linked folder (parent)"}`,
		);
		console.log(`  Folder: ${match.link.path}`);
		console.log(chalk.gray("  clawdi run/inject will use this Project for vault references."));
		return;
	}

	const fallback = await fetchDefaultProject().catch(() => null);
	if (fallback) {
		console.log(`  Project: ${chalk.cyan(projectAlias(fallback))}`);
		if (fallback.name && fallback.name !== fallback.slug) {
			console.log(chalk.gray(`  Project name: ${fallback.name}`));
		}
	} else {
		console.log("  Project: default Project");
	}
	console.log("  Source: default");
	console.log(chalk.gray("  Add a link: clawdi project folder link --project <project>"));
}

async function findVisibleProject(
	apiUrl: string,
	apiKey: string,
	projectId: string,
	projectArg: string,
): Promise<ProjectBrief> {
	const projects = await listProjects(apiUrl, apiKey);
	const project = projects.find((item) => item.id === projectId);
	if (!project) {
		throw new Error(`No visible Project matches '${projectArg}'. Try \`clawdi project list\`.`);
	}
	return project;
}

async function fetchDefaultProject(): Promise<ProjectBrief | null> {
	const { apiUrl, apiKey } = requireProjectAuth();
	const r = await fetch(`${apiUrl}/v1/projects/default`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!r.ok) return null;
	const body = await readJson<{ project_id: string }>(r, "/v1/projects/default");
	const projects = await listProjects(apiUrl, apiKey).catch(() => []);
	return projects.find((item) => item.id === body.project_id) ?? null;
}
