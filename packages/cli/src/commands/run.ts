import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { readAiProviderCatalog } from "../lib/ai-provider-catalog";
import { inspectAiProviderAuth } from "../lib/ai-provider-test";
import { ApiClient, ApiError } from "../lib/api-client";
import type { VaultResolved } from "../lib/api-schemas";
import { isLoggedIn } from "../lib/config";
import { parseDotenv } from "../lib/dotenv";
import { errMessage } from "../lib/errors";
import { findProjectFolderLink } from "../lib/project-folders";
import { listProjects, resolveProjectId } from "../lib/project-resolver";
import {
	type ClawdiReference,
	previewReferenceMap,
	type ResolveReferenceOptions,
	replaceResolvedReferences,
	resolveReferenceMap,
	scanClawdiReferences,
	type VaultReferencePreview,
} from "../lib/secret-references";
import { getEnvIdByAgent } from "../lib/select-adapter";
import {
	isVaultProjectNotFoundBody,
	VAULT_PROJECT_ACCESS_ERROR,
	VAULT_PROJECT_ACCESS_HINT,
} from "../lib/vault-errors";
import {
	type RuntimeMitmBroker,
	type RuntimeMitmBrokerFactory,
	shouldStartRuntimeMitmBroker,
	startRuntimeMitmBroker,
} from "../runtime/mitm-broker";
import {
	applyMitmBrokerRuntimeEnv,
	buildMitmBrokerEnv,
	stripMitmBrokerControlEnv,
} from "../runtime/mitm-env";
import { detectRuntimeMode, getRuntimePaths } from "../runtime/paths";
import {
	buildRuntimeRunInvocation,
	type RuntimeRunConfigRead,
	type RuntimeRunInvocation,
	readRuntimeRunConfigForCommand,
	runtimeCommandShimDir,
	withoutPathEntry,
} from "../runtime/run-config";

interface RunOpts {
	project?: string;
	agent?: string;
	projectFolder?: boolean;
	envFile?: string[];
	inheritEnv?: boolean;
	allVaultEnv?: boolean;
	allowConflicts?: boolean;
	dryRun?: boolean;
}

interface SelectedProject {
	projectId: string;
	label: string;
}

type SpawnFn = typeof spawn;

interface RuntimeChildSpawn {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd?: string;
}

interface RuntimeChildWrapOptions {
	isRoot?: boolean;
	commandExists?: (command: string) => boolean;
}

export async function run(
	args: string[],
	opts: RunOpts = {},
	spawnImpl: SpawnFn = spawn,
	brokerFactory: RuntimeMitmBrokerFactory = startRuntimeMitmBroker,
) {
	if (args.length === 0) {
		console.log(chalk.red("No command specified. Usage: clawdi run -- <command>"));
		process.exit(1);
	}

	const hostedRuntimeRun = hostedRuntimeRunConfig(args[0]);
	const baseProcessEnv = { ...process.env };
	const hostedGenericRun = hostedGenericRunInvocation(args, baseProcessEnv);
	if (hostedRuntimeRun.status === "ok" && !requiresCloudResolution(opts)) {
		const paths = getRuntimePaths({ mode: "hosted" });
		await spawnRuntimeInvocation(
			buildRuntimeRunInvocation(hostedRuntimeRun, args, baseProcessEnv, paths),
			spawnImpl,
			brokerFactory,
		);
		return;
	}
	if (
		hostedRuntimeRun.status !== "not-runtime" &&
		hostedRuntimeRun.status !== "ok" &&
		!requiresCloudResolution(opts)
	) {
		console.log(chalk.red(hostedRuntimeRunError(hostedRuntimeRun)));
		process.exit(1);
	}
	if (hostedGenericRun && !requiresCloudResolution(opts)) {
		await spawnRuntimeInvocation(hostedGenericRun, spawnImpl, brokerFactory);
		return;
	}
	if (!isLoggedIn()) {
		if (hostedRuntimeRun.status !== "not-runtime" && hostedRuntimeRun.status !== "ok") {
			console.log(chalk.red(hostedRuntimeRunError(hostedRuntimeRun)));
			process.exit(1);
		}
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}

	const api = new ApiClient();
	const selectedProject = await selectProject(api, opts);
	let vaultEnv: VaultResolved = {};

	if (opts.dryRun) {
		const baseEnv = opts.inheritEnv === false ? {} : { ...process.env };
		const envFileVars = loadEnvFiles(opts.envFile ?? []);
		const envWithReferences = { ...baseEnv, ...envFileVars };
		await previewRun(args, envWithReferences, selectedProject, opts);
		return;
	}

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
			if (e instanceof ApiError && e.status === 404 && isVaultProjectNotFoundBody(e.body)) {
				console.log(chalk.yellow(`⚠ Could not fetch vault secrets: ${VAULT_PROJECT_ACCESS_ERROR}`));
				console.log(chalk.gray(`  ${VAULT_PROJECT_ACCESS_HINT}`));
			} else {
				console.log(chalk.yellow(`⚠ Could not fetch vault secrets: ${errMessage(e)}`));
			}
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
	const spawnEnv = { ...envWithReferences, ...vaultEnv, ...referenceEnv };
	if (hostedRuntimeRun.status !== "not-runtime" && hostedRuntimeRun.status !== "ok") {
		console.log(chalk.red(hostedRuntimeRunError(hostedRuntimeRun)));
		process.exit(1);
	}

	const managedAiProviderEnv =
		detectRuntimeMode() === "hosted" ? {} : await resolveManagedAiProviderEnv(spawnEnv);
	const childEnv = { ...spawnEnv, ...managedAiProviderEnv };
	if (hostedRuntimeRun.status === "ok") {
		const paths = getRuntimePaths({ mode: "hosted" });
		await spawnRuntimeInvocation(
			buildRuntimeRunInvocation(hostedRuntimeRun, args, childEnv, paths),
			spawnImpl,
			brokerFactory,
		);
		return;
	}

	const hostedGenericLoggedInRun = hostedGenericRunInvocation(args, childEnv);
	if (hostedGenericLoggedInRun) {
		await spawnRuntimeInvocation(hostedGenericLoggedInRun, spawnImpl, brokerFactory);
		return;
	}

	const [cmd, ...cmdArgs] = args;
	const child = spawnImpl(cmd, cmdArgs, {
		env: childEnv,
		stdio: "inherit",
	});

	const code = await waitForChildExit(child, "command");
	process.exitCode = code;
}

async function resolveManagedAiProviderEnv(
	baseEnv: Record<string, string | undefined>,
): Promise<Record<string, string>> {
	let catalog: ReturnType<typeof readAiProviderCatalog>;
	try {
		catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	} catch (error) {
		console.log(chalk.yellow(`⚠ Could not read AI provider catalog: ${errMessage(error)}`));
		return {};
	}

	const injected: Record<string, string> = {};
	const env = { ...baseEnv };
	for (const provider of catalog.providers) {
		if (provider.auth.type !== "api_key" || provider.auth.source !== "managed") continue;
		const envName = provider.runtime_env_name;
		if (!envName || env[envName]) continue;
		const auth = await inspectAiProviderAuth(provider);
		if (auth.status !== "available" || !auth.value) {
			console.log(
				chalk.yellow(
					`⚠ Could not resolve AI provider key for ${provider.id}: ${auth.detail ?? auth.status}`,
				),
			);
			continue;
		}
		injected[envName] = auth.value;
		env[envName] = auth.value;
	}
	const count = Object.keys(injected).length;
	if (count > 0) {
		console.log(chalk.green(`✓ Resolved ${count} AI provider key${count === 1 ? "" : "s"}`));
	}
	return injected;
}

function requiresCloudResolution(opts: RunOpts): boolean {
	return Boolean(
		opts.project ||
			opts.agent ||
			opts.allVaultEnv ||
			opts.dryRun ||
			(opts.envFile && opts.envFile.length > 0),
	);
}

function hostedRuntimeRunConfig(command: string): RuntimeRunConfigRead {
	if (detectRuntimeMode() !== "hosted") return { status: "not-runtime", runtime: null };
	return readRuntimeRunConfigForCommand(command, getRuntimePaths({ mode: "hosted" }));
}

function hostedGenericRunInvocation(
	args: string[],
	baseEnv: NodeJS.ProcessEnv,
): RuntimeRunInvocation | null {
	if (detectRuntimeMode() !== "hosted") return null;
	const [command, ...commandArgs] = args;
	if (!command) return null;
	const paths = getRuntimePaths({ mode: "hosted" });
	const mitmProfileBundle = existsSync(paths.mitmProfileBundle) ? paths.mitmProfileBundle : null;
	return {
		runtime: "generic",
		command,
		args: commandArgs,
		cwd: process.cwd(),
		env: buildMitmBrokerEnv({
			env: {
				...baseEnv,
				PATH: withoutPathEntry(baseEnv.PATH ?? "", runtimeCommandShimDir(paths)),
			},
			profileBundlePath: mitmProfileBundle,
			secretFile: paths.managedSecretFile,
		}),
		configPath: mitmProfileBundle ?? paths.managedConfig,
	};
}

function hostedRuntimeRunError(
	read: Exclude<RuntimeRunConfigRead, { status: "ok" | "not-runtime" }>,
): string {
	if (read.status === "missing") {
		return `No hosted run config for ${read.runtime}. Run \`clawdi runtime init --non-interactive\` first.`;
	}
	if (read.status === "disabled") {
		return `Runtime ${read.runtime} is disabled by the current hosted runtime manifest.`;
	}
	return `Invalid hosted run config for ${read.runtime} at ${read.path}: ${read.error}`;
}

async function spawnRuntimeInvocation(
	invocation: RuntimeRunInvocation,
	spawnImpl: SpawnFn,
	brokerFactory: RuntimeMitmBrokerFactory,
): Promise<void> {
	delete invocation.env.CLAWDI_AUTH_TOKEN;
	let broker: RuntimeMitmBroker | null = null;
	if (shouldStartRuntimeMitmBroker(invocation.env)) {
		try {
			broker = await brokerFactory({
				runtime: invocation.runtime,
				env: invocation.env,
				profileBundlePath: invocation.env.CLAWDI_MITM_PROFILE_BUNDLE ?? invocation.configPath,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.log(chalk.red(`Failed to start MITM broker for ${invocation.runtime}: ${message}`));
			process.exit(1);
		}
	}
	if (broker) {
		applyMitmBrokerRuntimeEnv(invocation.env, broker);
		stripMitmBrokerControlEnv(invocation.env);
	}
	let childSpawn: RuntimeChildSpawn;
	try {
		childSpawn = buildRuntimeChildSpawn(invocation);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(chalk.red(`Failed to prepare ${invocation.runtime}: ${message}`));
		await broker?.stop();
		process.exit(1);
	}
	const child = spawnImpl(childSpawn.command, childSpawn.args, {
		cwd: childSpawn.cwd,
		env: childSpawn.env,
		stdio: "inherit",
	});

	const code = await waitForChildExit(child, invocation.runtime);
	try {
		await broker?.stop();
	} finally {
		process.exitCode = code;
	}
}

export function buildRuntimeChildSpawn(
	invocation: RuntimeRunInvocation,
	options: RuntimeChildWrapOptions = {},
): RuntimeChildSpawn {
	const runtimeUser = invocation.env.CLAWDI_RUNTIME_USER?.trim();
	const isRoot = options.isRoot ?? runningAsRoot();
	const hasCommand = options.commandExists ?? commandExists;
	const childEnv = runtimeChildEnv(invocation.env, runtimeUser);
	if (!isRoot || !runtimeUser || runtimeUser === "root") {
		return {
			command: invocation.command,
			args: invocation.args,
			env: childEnv,
			cwd: invocation.cwd,
		};
	}
	if (hasCommand("gosu")) {
		return {
			command: "gosu",
			args: [runtimeUser, invocation.command, ...invocation.args],
			env: childEnv,
			cwd: invocation.cwd,
		};
	}
	if (hasCommand("runuser")) {
		return {
			command: "runuser",
			args: [
				"--preserve-environment",
				"-u",
				runtimeUser,
				"--",
				invocation.command,
				...invocation.args,
			],
			env: childEnv,
			cwd: invocation.cwd,
		};
	}
	throw new Error(
		`running as root with CLAWDI_RUNTIME_USER=${runtimeUser}, but neither gosu nor runuser is available`,
	);
}

function runtimeChildEnv(
	env: NodeJS.ProcessEnv,
	runtimeUser: string | undefined,
): NodeJS.ProcessEnv {
	const childEnv = { ...env };
	delete childEnv.CLAWDI_AUTH_TOKEN;
	delete childEnv.CLAWDI_MITM_SECRET_FILE;
	if (runtimeUser && runtimeUser !== "root") {
		childEnv.USER = runtimeUser;
		childEnv.LOGNAME = runtimeUser;
		childEnv.HOME ||= `/home/${runtimeUser}`;
	}
	return childEnv;
}

function runningAsRoot(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

function commandExists(command: string): boolean {
	const path = process.env.PATH ?? "";
	for (const dir of path.split(":")) {
		if (!dir) continue;
		try {
			accessSync(join(dir, command), constants.X_OK);
			return true;
		} catch {
			// Try the next PATH entry.
		}
	}
	return false;
}

const SIGNAL_EXIT_CODES: Record<string, number> = {
	SIGHUP: 129,
	SIGINT: 130,
	SIGQUIT: 131,
	SIGILL: 132,
	SIGTRAP: 133,
	SIGABRT: 134,
	SIGBUS: 135,
	SIGFPE: 136,
	SIGKILL: 137,
	SIGUSR1: 138,
	SIGSEGV: 139,
	SIGUSR2: 140,
	SIGPIPE: 141,
	SIGALRM: 142,
	SIGTERM: 143,
};

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
	if (!signal) return 1;
	return SIGNAL_EXIT_CODES[signal] ?? 1;
}

function waitForChildExit(child: ReturnType<SpawnFn>, label: string): Promise<number> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (code: number) => {
			if (settled) return;
			settled = true;
			resolve(code);
		};

		child.once("error", (err) => {
			console.log(chalk.red(`Failed to start ${label}: ${err.message}`));
			settle(1);
		});

		child.once("exit", (code, signal) => {
			settle(code ?? exitCodeForSignal(signal));
		});
	});
}

async function previewRun(
	args: string[],
	env: Record<string, string | undefined>,
	selectedProject: SelectedProject | null,
	opts: RunOpts,
): Promise<void> {
	const refs = scanEnvReferenceUses(env);
	const resolved = await previewReferenceMap(
		refs.map((entry) => entry.ref),
		{
			project: opts.project,
			projectId: opts.project || opts.agent ? undefined : selectedProject?.projectId,
			agent: opts.agent,
			allowConflicts: opts.allowConflicts,
		},
	);
	console.log(chalk.green("Dry run: command will not be launched."));
	console.log(chalk.gray(`  Command: ${args.join(" ")}`));
	if (opts.agent) {
		console.log(chalk.gray(`  Agent context: ${opts.agent}`));
	} else if (selectedProject) {
		console.log(chalk.gray(`  Project context: ${selectedProject.label}`));
	} else {
		console.log(chalk.gray("  Project context: default write project"));
	}
	if (opts.allVaultEnv) {
		console.log(
			chalk.yellow("  Legacy all-vault-env requested; broad env values were not fetched."),
		);
	}
	if (resolved.size === 0) {
		console.log(chalk.gray("  No clawdi references found in env input."));
		return;
	}
	console.log(
		chalk.green(
			`  Would resolve ${resolved.size} clawdi reference${resolved.size === 1 ? "" : "s"}:`,
		),
	);
	for (const hit of resolved.values()) {
		const envKeys = refs
			.filter((entry) => entry.ref.raw === hit.reference)
			.map((entry) => entry.envKey)
			.join(", ");
		console.log(chalk.gray(`    ${envKeys}: ${formatPreview(hit)}`));
	}
}

function formatPreview(hit: VaultReferencePreview): string {
	const path = [hit.vault_slug, hit.section, hit.item_name].filter(Boolean).join("/");
	const suffix = path ? ` ${path}` : "";
	return `${hit.reference} -> ${hit.source_alias}${suffix} (redacted)`;
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
	const uses = scanEnvReferenceUses(env);
	if (uses.length === 0) return {};
	const resolved = await resolveReferenceMap(
		uses.map((entry) => entry.ref),
		opts,
	);
	const envKeysWithReferences = new Set(uses.map((entry) => entry.envKey));
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value !== "string" || !envKeysWithReferences.has(key)) continue;
		out[key] = replaceResolvedReferences(value, resolved);
	}
	console.log(
		chalk.green(`✓ Resolved ${resolved.size} clawdi reference${resolved.size === 1 ? "" : "s"}`),
	);
	return out;
}

function scanEnvReferenceUses(
	env: Record<string, string | undefined>,
): Array<{ envKey: string; ref: ClawdiReference }> {
	const uses: Array<{ envKey: string; ref: ClawdiReference }> = [];
	for (const [envKey, value] of Object.entries(env)) {
		if (typeof value !== "string") continue;
		for (const ref of scanClawdiReferences(value)) {
			uses.push({ envKey, ref });
		}
	}
	return uses;
}
