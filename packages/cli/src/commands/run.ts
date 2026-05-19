import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { ApiClient, ApiError } from "../lib/api-client";
import type { VaultResolved } from "../lib/api-schemas";
import { isLoggedIn } from "../lib/config";
import { parseDotenv } from "../lib/dotenv";
import { errMessage } from "../lib/errors";
import { findProjectFolderLink } from "../lib/project-folders";
import { listProjects, resolveProjectId } from "../lib/project-resolver";
import {
	type ResolveReferenceOptions,
	replaceResolvedReferences,
	resolveReferenceMap,
	scanClawdiReferences,
} from "../lib/secret-references";
import { getEnvIdByAgent } from "../lib/select-adapter";

interface RunOpts {
	project?: string;
	agent?: string;
	projectFolder?: boolean;
	envFile?: string[];
	inheritEnv?: boolean;
	allVaultEnv?: boolean;
	allowConflicts?: boolean;
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

	const api = new ApiClient();
	const selectedProject = await selectProject(api, opts);
	let vaultEnv: VaultResolved = {};

	if (opts.allVaultEnv) {
		try {
			if (selectedProject) {
				console.log(
					chalk.green(`✓ Using Project ${selectedProject.label} for vault env injection.`),
				);
			}
			const resolved = await api.postJson<unknown>(
				"/api/vault/resolve",
				opts.agent
					? { agent_id: resolveAgentId(opts.agent), allow_conflicts: conflictQuery(opts) }
					: selectedProject
						? { project_id: selectedProject.projectId }
						: undefined,
			);
			vaultEnv = assertVaultResolved(resolved);
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
	}

	const baseEnv = opts.inheritEnv === false ? {} : { ...process.env };
	const envFileVars = loadEnvFiles(opts.envFile ?? []);
	const envWithReferences = { ...baseEnv, ...envFileVars };
	let referenceEnv: Record<string, string> = {};
	try {
		referenceEnv = await resolveEnvReferences(envWithReferences, {
			project: opts.project,
			projectId: opts.project || opts.agent ? undefined : selectedProject?.projectId,
			agent: opts.agent,
			allowConflicts: opts.allowConflicts,
		});
	} catch (e) {
		console.log(chalk.red(`Could not resolve clawdi references: ${errMessage(e)}`));
		process.exit(1);
	}

	// Spawn child process with injected env
	const [cmd, ...cmdArgs] = args;
	const child = spawnImpl(cmd, cmdArgs, {
		env: { ...envWithReferences, ...vaultEnv, ...referenceEnv },
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

function assertVaultResolved(value: unknown): VaultResolved {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("vault/resolve returned an invalid response");
	}
	for (const [key, val] of Object.entries(value)) {
		if (typeof val !== "string") {
			throw new Error(`vault/resolve returned a non-string value for ${key}`);
		}
	}
	return value as VaultResolved;
}

async function selectProject(api: ApiClient, opts: RunOpts): Promise<SelectedProject | null> {
	if (opts.agent) return null;
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

function resolveAgentId(agent: string): string {
	return getEnvIdByAgent(agent) ?? agent;
}

function conflictQuery(opts: RunOpts): string | undefined {
	return opts.allowConflicts ? "true" : undefined;
}

function loadEnvFiles(paths: string[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const path of paths) {
		const content = readFileSync(path, "utf8");
		for (const [key, value] of parseDotenv(content)) {
			values[key] = value;
		}
	}
	return values;
}

async function resolveEnvReferences(
	env: Record<string, string | undefined>,
	opts: ResolveReferenceOptions,
): Promise<Record<string, string>> {
	const refs = Object.values(env).flatMap((value) =>
		typeof value === "string" ? scanClawdiReferences(value) : [],
	);
	if (refs.length === 0) return {};
	const resolved = await resolveReferenceMap(refs, opts);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value !== "string" || scanClawdiReferences(value).length === 0) continue;
		out[key] = replaceResolvedReferences(value, resolved);
	}
	console.log(
		chalk.green(`✓ Resolved ${resolved.size} clawdi reference${resolved.size === 1 ? "" : "s"}`),
	);
	return out;
}
