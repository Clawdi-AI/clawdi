import { spawn } from "node:child_process";
import chalk from "chalk";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import type { VaultResolved } from "../lib/api-schemas";
import { isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { findProjectFolderLink } from "../lib/project-folders";
import { listProjects, resolveProjectId } from "../lib/project-resolver";

interface RunOpts {
	project?: string;
	projectFolder?: boolean;
}

interface SelectedProject {
	projectId: string;
	label: string;
}

type SpawnFn = typeof spawn;

export async function run(args: string[], opts: RunOpts = {}, spawnImpl: SpawnFn = spawn) {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}

	if (args.length === 0) {
		console.log(chalk.red("No command specified. Usage: clawdi run -- <command>"));
		process.exit(1);
	}

	// Fetch vault secrets
	const api = new ApiClient();
	const selectedProject = await selectProject(api, opts);
	let vaultEnv: VaultResolved = {};

	try {
		if (selectedProject) {
			console.log(chalk.green(`✓ Using Project ${selectedProject.label} for vault env injection.`));
		}
		vaultEnv = unwrap(
			await api.POST(
				"/api/vault/resolve",
				selectedProject ? { params: { query: { project_id: selectedProject.projectId } } } : {},
			),
		);
	} catch (e) {
		if (e instanceof ApiError && e.status === 403) {
			console.log(chalk.red("vault/resolve requires CLI authentication (ApiKey)."));
			process.exit(1);
		}
		console.log(chalk.yellow(`⚠ Could not fetch vault secrets: ${errMessage(e)}`));
		console.log(chalk.gray("  Running without vault injection."));
	}

	const injectedCount = Object.keys(vaultEnv).length;
	if (injectedCount > 0) {
		console.log(chalk.green(`✓ Injected ${injectedCount} vault secrets`));
	}

	// Spawn child process with injected env
	const [cmd, ...cmdArgs] = args;
	const child = spawnImpl(cmd, cmdArgs, {
		env: { ...process.env, ...vaultEnv },
		stdio: "inherit",
	});

	child.on("error", (err) => {
		console.log(chalk.red(`Failed to start: ${err.message}`));
		process.exit(1);
	});

	child.on("exit", (code) => {
		process.exit(code ?? 0);
	});
}

async function selectProject(api: ApiClient, opts: RunOpts): Promise<SelectedProject | null> {
	if (opts.project) {
		const projectId = await resolveProjectId(api.baseUrl, api.apiKey, opts.project);
		return {
			projectId,
			label: (await projectLabel(api, projectId).catch(() => null)) ?? opts.project,
		};
	}
	if (opts.projectFolder === false) return null;
	const match = findProjectFolderLink(process.cwd());
	if (!match) return null;
	return {
		projectId: match.link.project_id,
		label: match.link.project_label,
	};
}

async function projectLabel(api: ApiClient, projectId: string): Promise<string | null> {
	const projects = await listProjects(api.baseUrl, api.apiKey);
	const project = projects.find((item) => item.id === projectId);
	if (!project) return null;
	if (project.is_owner === false && project.owner_handle) {
		return `@${project.owner_handle}/${project.slug}`;
	}
	return project.slug;
}
