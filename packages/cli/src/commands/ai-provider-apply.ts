import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { getCodexHome } from "../adapters/paths";
import { aiProviderCatalogPath, readAiProviderCatalog } from "../lib/ai-provider-catalog";
import {
	AGENT_ENGINE_CONTRACTS,
	type AgentEngine,
	type AgentEngineProjection,
	buildAgentEngineProjection,
	CODEX_PROFILE_NAME,
} from "../lib/ai-provider-projection";

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
}

interface AiProviderApplyPlan {
	engine: AgentEngine;
	engine_contract: AgentEngineProjection["contract"];
	provider_ids: string[];
	default_provider_id: string;
	writes: AiProviderApplyWrite[];
	commands: AiProviderApplyCommandStep[];
	next_steps: string[];
	warnings: string[];
}

export async function aiProviderApplyCommand(opts: AiProviderApplyOptions = {}): Promise<void> {
	const engine = parseEngine(opts.engine);
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	validateAiProviderApply(engine, catalog);
	const projection = buildAgentEngineProjection(engine, catalog);
	const plan = buildAiProviderApplyPlan(engine, catalog, projection);
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

function validateAiProviderApply(
	engine: AgentEngine,
	_catalog: ReturnType<typeof readAiProviderCatalog>,
): void {
	if (engine === "openclaw") {
		throw new Error(
			"OpenClaw apply is not enabled until its provider config CLI or schema contract is pinned.",
		);
	}
}

function buildAiProviderApplyPlan(
	engine: AgentEngine,
	catalog: ReturnType<typeof readAiProviderCatalog>,
	projection: ReturnType<typeof buildAgentEngineProjection>,
): AiProviderApplyPlan {
	if (engine === "codex") return buildCodexApplyPlan(projection);
	const projectedProviderIds = new Set(projection.provider_ids);
	const projectedProviders = catalog.providers.filter((provider) =>
		projectedProviderIds.has(provider.id),
	);
	const defaultProvider = projectedProviders.find(
		(provider) => provider.id === projection.default_provider_id,
	);
	if (!defaultProvider?.default_model) {
		throw new Error("Hermes apply requires a default provider with default_model.");
	}
	const commands: AiProviderApplyCommandStep[] = [];
	for (const provider of projectedProviders) {
		if (!provider.default_model) continue;
		const values: Record<string, string> = {
			type: provider.type,
			base_url: provider.base_url,
			model: provider.default_model,
			auth_type: provider.auth.type,
		};
		if (provider.label) values.name = provider.label;
		if (provider.api_mode) values.api_mode = provider.api_mode;
		const envName = providerEnvName(provider);
		if (envName) values.key_env = envName;
		for (const [key, value] of Object.entries(values)) {
			commands.push(buildHermesConfigCommand(`providers.${provider.id}.${key}`, value));
		}
	}
	commands.push(buildHermesConfigCommand("model.provider", defaultProvider.id));
	commands.push(buildHermesConfigCommand("model.default", defaultProvider.default_model));
	return {
		engine,
		engine_contract: projection.contract,
		provider_ids: projection.provider_ids,
		default_provider_id: projection.default_provider_id,
		writes: [],
		commands,
		next_steps: [],
		warnings: projection.warnings,
	};
}

function buildCodexApplyPlan(
	projection: ReturnType<typeof buildAgentEngineProjection>,
): AiProviderApplyPlan {
	const file = projection.files.find((entry) => entry.path.endsWith(".codex.toml"));
	if (!file) throw new Error("Codex projection did not include a profile TOML file.");
	const profilePath = join(getCodexHome(), `${CODEX_PROFILE_NAME}.config.toml`);
	return {
		engine: "codex",
		engine_contract: projection.contract,
		provider_ids: projection.provider_ids,
		default_provider_id: projection.default_provider_id,
		writes: [{ path: profilePath, mode: "0600", content: file.content }],
		commands: [],
		next_steps: [`codex --profile ${CODEX_PROFILE_NAME}`],
		warnings: projection.warnings,
	};
}

function buildHermesConfigCommand(key: string, value: string): AiProviderApplyCommandStep {
	return {
		command: "hermes",
		args: ["config", "set", key, value],
		display: `hermes config set ${key} ${value}`,
	};
}

function applyAiProviderPlan(plan: AiProviderApplyPlan): void {
	for (const write of plan.writes) {
		mkdirSync(dirname(write.path), { recursive: true, mode: 0o700 });
		chmodAiProviderPath(dirname(write.path), 0o700);
		writeFileSync(write.path, write.content, { mode: 0o600 });
		chmodAiProviderPath(write.path, 0o600);
	}
	for (const command of plan.commands) {
		execFileSync(command.command, command.args, { stdio: "pipe", env: process.env });
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
	for (const command of plan.commands) {
		console.log(`${dryRun ? chalk.gray("•") : chalk.green("✓")} ${prefix} run ${command.display}`);
	}
	for (const next of plan.next_steps) {
		console.log(chalk.gray(`Next: ${next}`));
	}
}

function chmodAiProviderPath(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Best effort on platforms without POSIX modes.
	}
}

function providerEnvName(
	provider: ReturnType<typeof readAiProviderCatalog>["providers"][number],
): string | undefined {
	const auth = provider.auth;
	if (auth.type === "secret_ref" && auth.ref.startsWith("env:"))
		return auth.ref.slice("env:".length);
	if (auth.type === "api_key" && auth.source === "env" && auth.ref?.startsWith("env:")) {
		return auth.ref.slice("env:".length);
	}
	return provider.runtime_env_name;
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
		return {
			engine,
			engine_contract: AGENT_ENGINE_CONTRACTS[engine],
			apply_target: "hermes config set",
			apply_status: "native config not inspected",
			applied: null,
		};
	}
	return {
		engine,
		engine_contract: AGENT_ENGINE_CONTRACTS[engine],
		apply_target: "OpenClaw native config contract not pinned",
		apply_status: "apply blocked",
		applied: null,
	};
}
