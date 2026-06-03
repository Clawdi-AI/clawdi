import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { parseDocument, parse as parseYaml } from "yaml";
import { getCodexHome, getHermesHome } from "../adapters/paths";
import { aiProviderCatalogPath, readAiProviderCatalog } from "../lib/ai-provider-catalog";
import {
	AGENT_ENGINE_CONTRACTS,
	type AgentEngine,
	type AgentEngineProjection,
	buildAgentEngineProjection,
	CODEX_PROFILE_NAME,
} from "../lib/ai-provider-projection";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";

interface AiProviderApplyOptions {
	engine?: string;
	dryRun?: boolean;
	json?: boolean;
}

interface AiProviderStatusOptions {
	json?: boolean;
}

interface AiProviderApplyWrite {
	path: string;
	mode: string;
	content: string;
}

interface AiProviderApplyCommandStep {
	command: string;
	args: string[];
	display: string;
	stdin?: string;
}

interface AiProviderApplyMerge {
	path: string;
	mode: string;
	description: string;
	patch: string;
}

interface AiProviderApplyPlan {
	engine: AgentEngine;
	engine_contract: AgentEngineProjection["contract"];
	provider_ids: string[];
	default_provider_id: string;
	writes: AiProviderApplyWrite[];
	merges: AiProviderApplyMerge[];
	commands: AiProviderApplyCommandStep[];
	next_steps: string[];
	warnings: string[];
}

const HERMES_DIRECT_MODEL_FIELDS = [
	"base_url",
	"api_key",
	"api",
	"key_env",
	"api_mode",
	"auth_mode",
] as const;
const HERMES_GENERATED_PROVIDER_FIELDS = [
	"name",
	"api",
	"url",
	"base_url",
	"default_model",
	"model",
	"transport",
	"api_mode",
	"key_env",
	"api_key",
	"type",
	"auth_type",
] as const;

export async function aiProviderApplyCommand(opts: AiProviderApplyOptions = {}): Promise<void> {
	const engine = parseEngine(opts.engine);
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const projection = buildAgentEngineProjection(engine, catalog);
	const plan = buildAiProviderApplyPlan(engine, projection);
	if (!opts.dryRun) applyAiProviderPlan(plan);
	printAiProviderApplyPlan(plan, Boolean(opts.dryRun), Boolean(opts.json));
}

export async function aiProviderStatusCommand(opts: AiProviderStatusOptions = {}): Promise<void> {
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const rows = catalog.providers.map((provider) => ({
		id: provider.id,
		type: provider.type,
		default_model: provider.default_model ?? null,
		auth: describeAuth(provider),
		agent_env_name: provider.runtime_env_name ?? inferredAgentEnvName(provider) ?? null,
	}));
	const agents = (["openclaw", "hermes", "codex"] as const).map((engine) =>
		inspectAiProviderAgentApply(engine),
	);
	const result = {
		catalog_path: aiProviderCatalogPath(),
		provider_count: catalog.providers.length,
		defaults: catalog.defaults ?? {},
		providers: rows,
		agents,
	};
	if (opts.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(chalk.bold("AI Provider agents"));
	console.log(`Providers: ${rows.length}`);
	for (const row of rows) {
		console.log(
			`  ${row.id} (${row.type}) model=${row.default_model ?? "-"} auth=${row.auth} env=${row.agent_env_name ?? "-"}`,
		);
	}
	for (const agent of agents) {
		const state =
			agent.applied === true
				? chalk.green("applied")
				: agent.applied === false
					? chalk.gray("not applied")
					: chalk.gray(agent.apply_status);
		console.log(`  ${agent.engine}: ${state} ${chalk.gray(agent.apply_target)}`);
	}
}

export async function doctorAiProviderCommand(opts: { json?: boolean } = {}): Promise<void> {
	const checks = [];
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	checks.push({
		name: "AI Provider catalog",
		ok: catalog.providers.length > 0,
		detail: `${catalog.providers.length} provider(s)`,
	});
	for (const engine of ["openclaw", "hermes", "codex"] as const) {
		try {
			buildAgentEngineProjection(engine, catalog);
			checks.push({ name: `Agent config: ${engine}`, ok: true });
		} catch (error) {
			checks.push({
				name: `Agent config: ${engine}`,
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (opts.json) {
		console.log(JSON.stringify(checks, null, 2));
		return;
	}
	for (const check of checks) {
		const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
		const detail = check.detail ? chalk.gray(` — ${check.detail}`) : "";
		console.log(`  ${icon} ${check.name}${detail}`);
	}
	if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

function parseEngine(input: string | undefined): AgentEngine {
	if (input === "openclaw" || input === "hermes" || input === "codex") return input;
	throw new Error("--engine must be openclaw, hermes, or codex.");
}

function buildAiProviderApplyPlan(
	engine: AgentEngine,
	projection: AgentEngineProjection,
): AiProviderApplyPlan {
	if (engine === "openclaw") return buildOpenClawApplyPlan(projection);
	if (engine === "codex") return buildCodexApplyPlan(projection);
	const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
	if (!file) throw new Error("Hermes projection did not include a config merge YAML file.");
	const configPath = join(getHermesHome(), "config.yaml");
	return {
		engine,
		engine_contract: projection.contract,
		provider_ids: projection.provider_ids,
		default_provider_id: projection.default_provider_id,
		writes: [],
		merges: [
			{
				path: configPath,
				mode: "0600",
				description: "Hermes config.yaml provider merge",
				patch: file.content,
			},
		],
		commands: [],
		next_steps: [],
		warnings: projection.warnings,
	};
}

function buildOpenClawApplyPlan(projection: AgentEngineProjection): AiProviderApplyPlan {
	const file = projection.files.find((entry) => entry.path.endsWith(".openclaw.json"));
	if (!file) throw new Error("OpenClaw projection did not include a config patch JSON file.");
	return {
		engine: "openclaw",
		engine_contract: projection.contract,
		provider_ids: projection.provider_ids,
		default_provider_id: projection.default_provider_id,
		writes: [],
		merges: [],
		commands: [
			{
				command: "openclaw",
				args: ["config", "patch", "--stdin"],
				display: "openclaw config patch --stdin",
				stdin: file.content,
			},
		],
		next_steps: [],
		warnings: projection.warnings,
	};
}

function buildCodexApplyPlan(projection: AgentEngineProjection): AiProviderApplyPlan {
	const file = projection.files.find((entry) => entry.path.endsWith(".codex.toml"));
	if (!file) throw new Error("Codex projection did not include a profile TOML file.");
	const profilePath = join(getCodexHome(), `${CODEX_PROFILE_NAME}.config.toml`);
	return {
		engine: "codex",
		engine_contract: projection.contract,
		provider_ids: projection.provider_ids,
		default_provider_id: projection.default_provider_id,
		writes: [{ path: profilePath, mode: "0600", content: file.content }],
		merges: [],
		commands: [],
		next_steps: [`codex --profile ${CODEX_PROFILE_NAME}`],
		warnings: projection.warnings,
	};
}

function applyAiProviderPlan(plan: AiProviderApplyPlan): void {
	for (const write of plan.writes) {
		writeAiProviderFile(write.path, write.content);
	}
	for (const merge of plan.merges) {
		mergeHermesConfig(merge.path, merge.patch);
	}
	for (const command of plan.commands) {
		runAiProviderApplyCommand(command);
	}
}

function printAiProviderApplyPlan(plan: AiProviderApplyPlan, dryRun: boolean, json: boolean): void {
	if (json) {
		console.log(JSON.stringify({ ...plan, dry_run: dryRun }, null, 2));
		return;
	}
	for (const warning of plan.warnings) console.log(chalk.yellow(`! ${warning}`));
	const prefix = dryRun ? "Would" : "Applied";
	for (const write of plan.writes) {
		console.log(`${dryRun ? chalk.gray("•") : chalk.green("✓")} ${prefix} write ${write.path}`);
	}
	for (const merge of plan.merges) {
		console.log(
			`${dryRun ? chalk.gray("•") : chalk.green("✓")} ${prefix} merge ${merge.description} at ${merge.path}`,
		);
		if (dryRun) console.log(merge.patch.trimEnd());
	}
	for (const command of plan.commands) {
		console.log(`${dryRun ? chalk.gray("•") : chalk.green("✓")} ${prefix} run ${command.display}`);
		if (dryRun && command.stdin) console.log(command.stdin.trimEnd());
	}
	for (const next of plan.next_steps) {
		console.log(chalk.gray(`Next: ${next}`));
	}
}

function mergeHermesConfig(configPath: string, patchContent: string): void {
	const document = readHermesConfig(configPath);
	const patchConfig = readHermesPatch(patchContent);
	applyHermesProviderPatch(document, patchConfig);
	writeAiProviderFile(configPath, String(document));
}

function readHermesConfig(configPath: string): ReturnType<typeof parseDocument> {
	const content = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
	const document = parseDocument(content);
	if (document.errors.length > 0) {
		throw new Error(`Hermes config contains invalid YAML: ${document.errors[0]?.message}`);
	}
	const parsed = document.toJS();
	if (parsed === null || parsed === undefined) {
		if (document.contents) {
			throw new Error(`Hermes config must be a YAML object: ${configPath}`);
		}
		return document;
	}
	if (!isPlainRecord(parsed)) {
		throw new Error(`Hermes config must be a YAML object: ${configPath}`);
	}
	return document;
}

function readHermesPatch(patchContent: string): Record<string, unknown> {
	const parsed = parseYaml(patchContent);
	if (!isPlainRecord(parsed)) throw new Error("Hermes projection patch must be a YAML object.");
	return parsed;
}

function applyHermesProviderPatch(
	document: ReturnType<typeof parseDocument>,
	patchConfig: Record<string, unknown>,
): void {
	const existingConfig = document.toJS();
	const root = isPlainRecord(existingConfig) ? existingConfig : {};
	validateHermesMergeRoot(root);
	prepareHermesMergeRoot(document, root);
	const existingModel = isPlainRecord(root.model) ? root.model : {};
	const patchModel = isPlainRecord(patchConfig.model) ? patchConfig.model : {};
	removeHermesDirectModelFields(document, existingModel);
	for (const [key, value] of Object.entries(patchModel)) {
		document.setIn(["model", key], value);
	}

	const existingProviders = isPlainRecord(root.providers) ? root.providers : {};
	const patchProviders = isPlainRecord(patchConfig.providers) ? patchConfig.providers : {};
	for (const [providerId, patchValue] of Object.entries(patchProviders)) {
		if (!isPlainRecord(patchValue)) continue;
		const existingProvider = isPlainRecord(existingProviders[providerId])
			? existingProviders[providerId]
			: {};
		if (
			Object.hasOwn(existingProviders, providerId) &&
			(existingProviders[providerId] === null || existingProviders[providerId] === undefined)
		) {
			document.setIn(["providers", providerId], document.createNode({}));
		}
		removeHermesGeneratedProviderFields(document, providerId, existingProvider);
		for (const [key, value] of Object.entries(patchValue)) {
			document.setIn(["providers", providerId, key], value);
		}
	}
}

function validateHermesMergeRoot(root: Record<string, unknown>): void {
	const providers = root.providers;
	if (providers !== undefined && providers !== null && !isPlainRecord(providers)) {
		throw new Error("Hermes config field providers must be a YAML object.");
	}
	const providerMap = isPlainRecord(providers) ? providers : {};
	for (const [providerId, provider] of Object.entries(providerMap)) {
		if (provider !== undefined && provider !== null && !isPlainRecord(provider)) {
			throw new Error(`Hermes provider ${providerId} must be a YAML object.`);
		}
	}
}

function prepareHermesMergeRoot(
	document: ReturnType<typeof parseDocument>,
	root: Record<string, unknown>,
): void {
	if (Object.hasOwn(root, "model") && !isPlainRecord(root.model)) {
		document.set("model", document.createNode({}));
	}
	if (Object.hasOwn(root, "providers") && root.providers === null) {
		document.set("providers", document.createNode({}));
	}
}

function removeHermesDirectModelFields(
	document: ReturnType<typeof parseDocument>,
	input: Record<string, unknown>,
): void {
	for (const key of HERMES_DIRECT_MODEL_FIELDS) {
		if (Object.hasOwn(input, key)) document.deleteIn(["model", key]);
	}
}

function removeHermesGeneratedProviderFields(
	document: ReturnType<typeof parseDocument>,
	providerId: string,
	input: Record<string, unknown>,
): void {
	for (const key of HERMES_GENERATED_PROVIDER_FIELDS) {
		if (Object.hasOwn(input, key)) document.deleteIn(["providers", providerId, key]);
	}
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function writeAiProviderFile(path: string, content: string): void {
	writePrivateFileAtomic(path, content, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

function runAiProviderApplyCommand(command: AiProviderApplyCommandStep): void {
	try {
		execFileSync(command.command, command.args, {
			input: command.stdin,
			stdio: "pipe",
			env: process.env,
		});
	} catch (error) {
		throw new Error(
			`Failed to run ${command.display}${formatCommandStatus(error)}. Re-run with --dry-run to inspect the generated patch and verify the agent CLI is installed.`,
		);
	}
}

function formatCommandStatus(error: unknown): string {
	if (typeof error !== "object" || error === null || !("status" in error)) return "";
	const status = (error as { status?: unknown }).status;
	if (typeof status !== "number") return "";
	return ` (exit ${status})`;
}

function describeAuth(provider: { auth: { type: string }; runtime_env_name?: string }): string {
	const env = inferredAgentEnvName(provider);
	if (provider.auth.type === "none") return "none";
	if (env) return `${provider.auth.type}:env:${env}`;
	return provider.auth.type;
}

function inferredAgentEnvName(provider: {
	auth:
		| { type: string; ref?: string; source?: string }
		| { type: string; provider?: string; profile?: string }
		| { type: string; tool?: string; profile?: string };
	runtime_env_name?: string;
}): string | undefined {
	const auth = provider.auth;
	if ("ref" in auth && auth.ref?.startsWith("env:")) return auth.ref.slice("env:".length);
	return provider.runtime_env_name;
}

function inspectAiProviderAgentApply(engine: AgentEngine): {
	engine: AgentEngine;
	engine_contract: (typeof AGENT_ENGINE_CONTRACTS)[AgentEngine];
	apply_target: string;
	apply_status: string;
	applied: boolean | null;
} {
	if (engine === "codex") {
		const profilePath = join(getCodexHome(), `${CODEX_PROFILE_NAME}.config.toml`);
		const applied = existsSync(profilePath);
		return {
			engine,
			engine_contract: AGENT_ENGINE_CONTRACTS[engine],
			apply_target: profilePath,
			apply_status: applied ? "applied" : "not applied",
			applied,
		};
	}
	if (engine === "hermes") {
		const configPath = join(getHermesHome(), "config.yaml");
		const exists = existsSync(configPath);
		return {
			engine,
			engine_contract: AGENT_ENGINE_CONTRACTS[engine],
			apply_target: configPath,
			apply_status: exists
				? "config exists; generated provider entries not inspected"
				: "not applied",
			applied: null,
		};
	}
	return {
		engine,
		engine_contract: AGENT_ENGINE_CONTRACTS[engine],
		apply_target: "openclaw config patch --stdin",
		apply_status: "native config not inspected",
		applied: null,
	};
}
