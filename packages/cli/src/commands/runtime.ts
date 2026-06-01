import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { readAiProviderCatalog } from "../lib/ai-provider-catalog";
import {
	type RuntimeEngine,
	renderRuntimeProjection,
	runtimeProjectionDir,
	writeRuntimeProjection,
} from "../lib/ai-provider-projection";

interface RuntimeRenderOptions {
	engine?: string;
	write?: boolean;
	activate?: boolean;
	json?: boolean;
}

interface RuntimeInspectOptions {
	json?: boolean;
}

export async function runtimeRenderCommand(opts: RuntimeRenderOptions = {}): Promise<void> {
	const engine = parseEngine(opts.engine);
	if (opts.activate && !opts.write) {
		throw new Error("`runtime render --activate` requires --write.");
	}
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	if (opts.activate) validateRuntimeActivation(engine, catalog);
	const projection = renderRuntimeProjection(engine, catalog);
	if (opts.write) {
		const written = writeRuntimeProjection(projection);
		const activated = opts.activate ? activateRuntime(engine, catalog) : [];
		if (opts.json) {
			console.log(JSON.stringify({ engine, written, activated }, null, 2));
			return;
		}
		for (const path of written) {
			console.log(chalk.green(`✓ Wrote ${path}`));
		}
		for (const command of activated) console.log(chalk.green(`✓ Ran ${command}`));
		if (!opts.activate) {
			console.log(chalk.gray("Run again with --activate to connect a verified runtime CLI."));
		}
		return;
	}
	if (opts.json) {
		console.log(JSON.stringify(projection, null, 2));
		return;
	}
	for (const file of projection.files) {
		console.log(chalk.bold(`# ${file.path}`));
		process.stdout.write(file.content);
	}
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
	const projections = (["openclaw", "hermes"] as const).map((engine) => ({
		engine,
		dir: runtimeProjectionDir(engine),
		written: existsSync(join(runtimeProjectionDir(engine), "clawdi-ai-provider.sidecar.json")),
	}));
	const result = {
		catalog_path: "local",
		provider_count: catalog.providers.length,
		defaults: catalog.defaults ?? {},
		providers: rows,
		projections,
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
	for (const projection of projections) {
		const mark = projection.written ? chalk.green("written") : chalk.gray("not written");
		console.log(`  ${projection.engine}: ${mark} ${chalk.gray(projection.dir)}`);
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
	for (const engine of ["openclaw", "hermes"] as const) {
		try {
			renderRuntimeProjection(engine, catalog);
			checks.push({ name: `Projection: ${engine}`, ok: true });
		} catch (error) {
			checks.push({
				name: `Projection: ${engine}`,
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
	if (input === "openclaw" || input === "hermes") return input;
	throw new Error("--engine must be openclaw or hermes.");
}

function activateRuntime(
	engine: RuntimeEngine,
	catalog: ReturnType<typeof readAiProviderCatalog>,
): string[] {
	validateRuntimeActivation(engine, catalog);
	const defaultProviderId = catalog.defaults?.chat_provider_id ?? catalog.providers[0]?.id;
	const defaultProvider = catalog.providers.find((provider) => provider.id === defaultProviderId);
	if (!defaultProvider?.default_model) {
		throw new Error("Hermes activation requires a default provider with default_model.");
	}
	const commands: string[] = [];
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
			runHermesConfigSet(`providers.${provider.id}.${key}`, value);
			commands.push(
				`hermes config set providers.${provider.id}.${key} ${redactCommandValue(key, value)}`,
			);
		}
	}
	runHermesConfigSet("model.provider", defaultProvider.id);
	commands.push(`hermes config set model.provider ${defaultProvider.id}`);
	runHermesConfigSet("model.default", defaultProvider.default_model);
	commands.push(`hermes config set model.default ${defaultProvider.default_model}`);
	return commands;
}

function validateRuntimeActivation(
	engine: RuntimeEngine,
	catalog: ReturnType<typeof readAiProviderCatalog>,
): void {
	if (engine === "openclaw") {
		throw new Error(
			"OpenClaw activation is not enabled until its provider config CLI or schema contract is pinned.",
		);
	}
	for (const provider of catalog.providers) {
		if (provider.id.includes(".")) {
			throw new Error(
				`Hermes activation does not support provider id "${provider.id}" because dot-path escaping has not been verified. Use runtime render without --activate or rename the provider id.`,
			);
		}
	}
}

function runHermesConfigSet(key: string, value: string): void {
	execFileSync("hermes", ["config", "set", key, value], { stdio: "pipe", env: process.env });
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

function redactCommandValue(key: string, value: string): string {
	return key.includes("key") ? "<env>" : value;
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
