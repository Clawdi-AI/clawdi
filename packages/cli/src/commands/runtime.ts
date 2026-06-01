import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { getCodexHome } from "../adapters/paths";
import { aiProviderCatalogPath, readAiProviderCatalog } from "../lib/ai-provider-catalog";
import {
	buildRuntimeProjection,
	CODEX_PROFILE_NAME,
	RUNTIME_PROJECTION_CONTRACTS,
	type RuntimeEngine,
	type RuntimeProjection,
} from "../lib/ai-provider-projection";

interface RuntimeApplyOptions {
	engine?: string;
	dryRun?: boolean;
	json?: boolean;
}

interface RuntimeInspectOptions {
	json?: boolean;
}

interface RuntimeApplyWrite {
	path: string;
	mode: string;
	content: string;
}

interface RuntimeApplyCommand {
	command: string;
	args: string[];
	display: string;
}

interface RuntimeApplyPlan {
	engine: RuntimeEngine;
	contract: RuntimeProjection["contract"];
	writes: RuntimeApplyWrite[];
	commands: RuntimeApplyCommand[];
	next_steps: string[];
	warnings: string[];
}

export async function runtimeApplyCommand(opts: RuntimeApplyOptions = {}): Promise<void> {
	const engine = parseEngine(opts.engine);
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	validateRuntimeApply(engine, catalog);
	const projection = buildRuntimeProjection(engine, catalog);
	const plan = buildRuntimeApplyPlan(engine, catalog, projection);
	if (!opts.dryRun) applyRuntimePlan(plan);
	printRuntimeApplyPlan(plan, Boolean(opts.dryRun), Boolean(opts.json));
}

export async function runtimeInspectCommand(opts: RuntimeInspectOptions = {}): Promise<void> {
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const rows = catalog.providers.map((provider) => ({
		id: provider.id,
		type: provider.type,
		default_model: provider.default_model ?? null,
		auth: describeAuth(provider),
		runtime_env_name: provider.runtime_env_name ?? inferredEnvName(provider) ?? null,
	}));
	const runtimes = (["openclaw", "hermes", "codex"] as const).map((engine) =>
		inspectRuntime(engine),
	);
	const result = {
		catalog_path: aiProviderCatalogPath(),
		provider_count: catalog.providers.length,
		defaults: catalog.defaults ?? {},
		providers: rows,
		runtimes,
	};
	if (opts.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(chalk.bold("AI Provider runtime"));
	console.log(`Providers: ${rows.length}`);
	for (const row of rows) {
		console.log(
			`  ${row.id} (${row.type}) model=${row.default_model ?? "-"} auth=${row.auth} env=${row.runtime_env_name ?? "-"}`,
		);
	}
	for (const runtime of runtimes) {
		const state =
			runtime.applied === true
				? chalk.green("applied")
				: runtime.applied === false
					? chalk.gray("not applied")
					: chalk.gray(runtime.apply_status);
		console.log(`  ${runtime.engine}: ${state} ${chalk.gray(runtime.native_target)}`);
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
			buildRuntimeProjection(engine, catalog);
			checks.push({ name: `Runtime config: ${engine}`, ok: true });
		} catch (error) {
			checks.push({
				name: `Runtime config: ${engine}`,
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

function parseEngine(input: string | undefined): RuntimeEngine {
	if (input === "openclaw" || input === "hermes" || input === "codex") return input;
	throw new Error("--engine must be openclaw, hermes, or codex.");
}

function validateRuntimeApply(
	engine: RuntimeEngine,
	catalog: ReturnType<typeof readAiProviderCatalog>,
): void {
	if (engine === "openclaw") {
		throw new Error(
			"OpenClaw apply is not enabled until its provider config CLI or schema contract is pinned.",
		);
	}
	if (engine === "codex") return;
	for (const provider of catalog.providers) {
		if (provider.id.includes(".")) {
			throw new Error(
				`Hermes apply does not support provider id "${provider.id}" because dot-path escaping has not been verified. Rename the provider id before applying.`,
			);
		}
	}
}

function buildRuntimeApplyPlan(
	engine: RuntimeEngine,
	catalog: ReturnType<typeof readAiProviderCatalog>,
	projection: ReturnType<typeof buildRuntimeProjection>,
): RuntimeApplyPlan {
	if (engine === "codex") return buildCodexApplyPlan(projection);
	const defaultProviderId = catalog.defaults?.chat_provider_id ?? catalog.providers[0]?.id;
	const defaultProvider = catalog.providers.find((provider) => provider.id === defaultProviderId);
	if (!defaultProvider?.default_model) {
		throw new Error("Hermes apply requires a default provider with default_model.");
	}
	const commands: RuntimeApplyCommand[] = [];
	for (const provider of catalog.providers) {
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
		contract: projection.contract,
		writes: [],
		commands,
		next_steps: [],
		warnings: projection.warnings,
	};
}

function buildCodexApplyPlan(
	projection: ReturnType<typeof buildRuntimeProjection>,
): RuntimeApplyPlan {
	const file = projection.files.find((entry) => entry.path.endsWith(".codex.toml"));
	if (!file) throw new Error("Codex projection did not include a profile TOML file.");
	const profilePath = join(getCodexHome(), `${CODEX_PROFILE_NAME}.config.toml`);
	return {
		engine: "codex",
		contract: projection.contract,
		writes: [{ path: profilePath, mode: "0600", content: file.content }],
		commands: [],
		next_steps: [`codex --profile ${CODEX_PROFILE_NAME}`],
		warnings: projection.warnings,
	};
}

function buildHermesConfigCommand(key: string, value: string): RuntimeApplyCommand {
	return {
		command: "hermes",
		args: ["config", "set", key, value],
		display: `hermes config set ${key} ${value}`,
	};
}

function applyRuntimePlan(plan: RuntimeApplyPlan): void {
	for (const write of plan.writes) {
		mkdirSync(dirname(write.path), { recursive: true, mode: 0o700 });
		chmodRuntimePath(dirname(write.path), 0o700);
		writeFileSync(write.path, write.content, { mode: 0o600 });
		chmodRuntimePath(write.path, 0o600);
	}
	for (const command of plan.commands) {
		execFileSync(command.command, command.args, { stdio: "pipe", env: process.env });
	}
}

function printRuntimeApplyPlan(plan: RuntimeApplyPlan, dryRun: boolean, json: boolean): void {
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

function chmodRuntimePath(path: string, mode: number): void {
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
	const env = inferredEnvName(provider);
	if (provider.auth.type === "none") return "none";
	if (env) return `${provider.auth.type}:env:${env}`;
	return provider.auth.type;
}

function inferredEnvName(provider: {
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

function inspectRuntime(engine: RuntimeEngine): {
	engine: RuntimeEngine;
	contract: (typeof RUNTIME_PROJECTION_CONTRACTS)[RuntimeEngine];
	native_target: string;
	apply_status: string;
	applied: boolean | null;
} {
	if (engine === "codex") {
		const profilePath = join(getCodexHome(), `${CODEX_PROFILE_NAME}.config.toml`);
		const applied = existsSync(profilePath);
		return {
			engine,
			contract: RUNTIME_PROJECTION_CONTRACTS[engine],
			native_target: profilePath,
			apply_status: applied ? "applied" : "not applied",
			applied,
		};
	}
	if (engine === "hermes") {
		return {
			engine,
			contract: RUNTIME_PROJECTION_CONTRACTS[engine],
			native_target: "hermes config set",
			apply_status: "native config not inspected",
			applied: null,
		};
	}
	return {
		engine,
		contract: RUNTIME_PROJECTION_CONTRACTS[engine],
		native_target: "OpenClaw native config contract not pinned",
		apply_status: "apply blocked",
		applied: null,
	};
}
