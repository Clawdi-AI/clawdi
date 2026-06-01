import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AiProvider, AiProviderAuth, AiProviderCatalog } from "@clawdi/shared";
import {
	defaultAiProviderApiMode,
	defaultAiProviderBaseUrl,
	validateAiProviderCatalog,
} from "@clawdi/shared";
import { aiProviderCatalogPath } from "./ai-provider-catalog";
import { getClawdiDir } from "./config";

export type RuntimeEngine = "openclaw" | "hermes" | "codex";

export const CODEX_PROFILE_NAME = "clawdi-ai-provider";

export const RUNTIME_PROJECTION_CONTRACTS: Record<
	RuntimeEngine,
	{
		settingMethod: string;
		supportedVersionRange: string;
		status: "enabled" | "render-only" | "blocked";
	}
> = {
	codex: {
		settingMethod: "$CODEX_HOME/clawdi-ai-provider.config.toml selected with codex --profile",
		supportedVersionRange: "@openai/codex >=0.135.0 <0.136.0",
		status: "enabled",
	},
	hermes: {
		settingMethod: "hermes config set",
		supportedVersionRange: "Hermes Agent >=0.15.1 <0.16.0",
		status: "enabled",
	},
	openclaw: {
		settingMethod: "managed JSON projection; native activation blocked until fixture contract",
		supportedVersionRange: "unverified",
		status: "render-only",
	},
};

export interface ProjectionFile {
	path: string;
	content: string;
}

export interface RuntimeProjection {
	engine: RuntimeEngine;
	files: ProjectionFile[];
	warnings: string[];
	contract: (typeof RUNTIME_PROJECTION_CONTRACTS)[RuntimeEngine];
}

interface ProjectionProvider {
	id: string;
	type: AiProvider["type"];
	label?: string;
	base_url: string;
	default_model: string;
	api_mode?: AiProvider["api_mode"];
	env_name?: string;
	auth: AiProviderAuth;
	auth_type: AiProviderAuth["type"];
}

export function renderRuntimeProjection(
	engine: RuntimeEngine,
	catalog: AiProviderCatalog,
): RuntimeProjection {
	const validation = validateAiProviderCatalog(catalog);
	if (!validation.valid) {
		throw new Error(`AI Provider catalog is invalid:\n${validation.errors.join("\n")}`);
	}
	const providers = catalog.providers.map((provider) =>
		normalizeProjectionProvider(engine, provider),
	);
	if (providers.length === 0) {
		throw new Error("No AI Providers configured.");
	}
	const defaultProviderId = catalog.defaults?.chat_provider_id ?? providers[0]?.id;
	const defaultProvider = providers.find((provider) => provider.id === defaultProviderId);
	if (!defaultProvider) {
		throw new Error(`Default provider not found: ${defaultProviderId}`);
	}
	const warnings = validation.warnings;
	const projection =
		engine === "openclaw"
			? renderOpenClawProjection(providers, defaultProvider)
			: engine === "hermes"
				? renderHermesProjection(providers, defaultProvider)
				: renderCodexProjection(providers, defaultProvider);
	const extension = engine === "openclaw" ? "json" : engine === "hermes" ? "yaml" : "toml";
	return {
		engine,
		files: [
			{
				path: `ai-providers.${engine}.${extension}`,
				content: projection,
			},
		],
		warnings,
		contract: RUNTIME_PROJECTION_CONTRACTS[engine],
	};
}

export function runtimeProjectionDir(engine: RuntimeEngine): string {
	return join(getClawdiDir(), "runtime", engine);
}

export function writeRuntimeProjection(projection: RuntimeProjection): string[] {
	const dir = runtimeProjectionDir(projection.engine);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodRuntimePath(dir, 0o700);
	const written: string[] = [];
	for (const file of projection.files) {
		const path = join(dir, file.path);
		writeFileSync(path, file.content, { mode: 0o600 });
		chmodRuntimePath(path, 0o600);
		written.push(path);
	}
	const metadataPath = join(dir, "clawdi-ai-provider.sidecar.json");
	writeFileSync(
		metadataPath,
		`${JSON.stringify(
			{
				engine: projection.engine,
				generated_at: new Date().toISOString(),
				catalog_path: aiProviderCatalogPath(),
				catalog_hash: catalogHash(),
				contract: projection.contract,
				files: projection.files.map((file) => file.path),
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	chmodRuntimePath(metadataPath, 0o600);
	written.push(metadataPath);
	return written;
}

function chmodRuntimePath(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Best effort on platforms without POSIX modes.
	}
}

function normalizeProjectionProvider(
	engine: RuntimeEngine,
	provider: AiProvider,
): ProjectionProvider {
	if (!provider.default_model) {
		throw new Error(`Provider ${provider.id} requires default_model for runtime projection.`);
	}
	if (
		engine !== "codex" &&
		(provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile")
	) {
		throw new Error(
			`Provider ${provider.id} uses ${provider.auth.type} auth, which does not have a verified runtime projection yet. Materialize the profile for its native tool or use env/Vault/managed API key auth for key-env runtimes.`,
		);
	}
	const envName = authEnvName(provider);
	if (provider.auth.type !== "none" && !envName && !usesCodexNativeAuth(provider)) {
		throw new Error(
			`Provider ${provider.id} auth requires runtime_env_name or an env:<NAME> ref for runtime projection.`,
		);
	}
	return {
		id: provider.id,
		type: provider.type,
		label: provider.label,
		base_url: provider.base_url,
		default_model: provider.default_model,
		api_mode: provider.api_mode,
		env_name: envName,
		auth: provider.auth,
		auth_type: provider.auth.type,
	};
}

function authEnvName(provider: AiProvider): string | undefined {
	const auth = provider.auth;
	if (auth.type === "none") return undefined;
	if (auth.type === "secret_ref" && auth.ref.startsWith("env:")) {
		return auth.ref.slice("env:".length);
	}
	if (auth.type === "api_key" && auth.source === "env" && auth.ref?.startsWith("env:")) {
		return auth.ref.slice("env:".length);
	}
	return provider.runtime_env_name;
}

function renderOpenClawProjection(
	providers: ProjectionProvider[],
	defaultProvider: ProjectionProvider,
): string {
	const body = {
		schema_version: 1,
		generated_by: "clawdi",
		models: {
			providers: Object.fromEntries(
				providers.map((provider) => [
					provider.id,
					compactObject({
						id: provider.id,
						type: provider.type,
						label: provider.label,
						baseUrl: provider.base_url,
						apiMode: provider.api_mode,
						keyEnv: provider.env_name,
						authType: provider.auth_type,
						models: [{ id: provider.default_model }],
					}),
				]),
			),
		},
		agents: {
			defaults: {
				model: `${defaultProvider.id}/${defaultProvider.default_model}`,
			},
		},
	};
	return `${JSON.stringify(body, null, 2)}\n`;
}

function renderHermesProjection(
	providers: ProjectionProvider[],
	defaultProvider: ProjectionProvider,
): string {
	const lines: string[] = [
		"# Generated by Clawdi. Do not put API keys in this file.",
		"model:",
		`  provider: ${quoteYaml(defaultProvider.id)}`,
		`  default: ${quoteYaml(defaultProvider.default_model)}`,
		"providers:",
	];
	for (const provider of providers) {
		lines.push(`  ${provider.id}:`);
		if (provider.label) lines.push(`    name: ${quoteYaml(provider.label)}`);
		lines.push(`    type: ${quoteYaml(provider.type)}`);
		lines.push(`    base_url: ${quoteYaml(provider.base_url)}`);
		if (provider.api_mode) lines.push(`    api_mode: ${quoteYaml(provider.api_mode)}`);
		lines.push(`    model: ${quoteYaml(provider.default_model)}`);
		if (provider.env_name) lines.push(`    key_env: ${quoteYaml(provider.env_name)}`);
		lines.push(`    auth_type: ${quoteYaml(provider.auth_type)}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderCodexProjection(
	providers: ProjectionProvider[],
	defaultProvider: ProjectionProvider,
): string {
	for (const provider of providers) validateCodexProjectionProvider(provider);
	const lines: string[] = [
		"# Generated by Clawdi. Do not put API keys in this file.",
		`# Contract: ${RUNTIME_PROJECTION_CONTRACTS.codex.supportedVersionRange}; ${RUNTIME_PROJECTION_CONTRACTS.codex.settingMethod}.`,
		`model = ${quoteTomlString(defaultProvider.default_model)}`,
		`model_provider = ${quoteTomlString(codexModelProviderId(defaultProvider))}`,
		"",
	];
	for (const provider of providers) {
		if (usesBuiltInCodexOpenAiProvider(provider)) continue;
		lines.push(`[model_providers.${quoteTomlKey(provider.id)}]`);
		lines.push(`name = ${quoteTomlString(provider.label ?? provider.id)}`);
		lines.push(`base_url = ${quoteTomlString(provider.base_url)}`);
		lines.push('wire_api = "responses"');
		if (usesCodexNativeAuth(provider)) {
			lines.push("requires_openai_auth = true");
		} else if (provider.env_name) {
			lines.push(`env_key = ${quoteTomlString(provider.env_name)}`);
		}
		lines.push("");
	}
	return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function validateCodexProjectionProvider(provider: ProjectionProvider): void {
	const apiMode = provider.api_mode ?? defaultAiProviderApiMode(provider.type);
	if (apiMode !== "openai_responses") {
		throw new Error(
			`Provider ${provider.id} cannot be projected to Codex: Codex provider config supports Responses-compatible providers only; got api_mode ${apiMode ?? "unknown"}.`,
		);
	}
	if (provider.auth.type === "oauth_profile") {
		throw new Error(
			`Provider ${provider.id} uses oauth_profile auth, which does not have a verified Codex config projection.`,
		);
	}
	if (provider.auth.type === "agent_profile" && !usesCodexNativeAuth(provider)) {
		throw new Error(
			`Provider ${provider.id} uses agent_profile auth for ${provider.auth.tool}; Codex projection only supports agent:codex/<profile>.`,
		);
	}
}

function codexModelProviderId(provider: ProjectionProvider): string {
	return usesBuiltInCodexOpenAiProvider(provider) ? "openai" : provider.id;
}

function usesBuiltInCodexOpenAiProvider(provider: ProjectionProvider): boolean {
	return (
		provider.type === "openai" &&
		usesCodexNativeAuth(provider) &&
		normalizeUrl(provider.base_url) === normalizeUrl(defaultAiProviderBaseUrl("openai") ?? "")
	);
}

function usesCodexNativeAuth(provider: Pick<ProjectionProvider, "auth">): boolean {
	return provider.auth.type === "agent_profile" && provider.auth.tool === "codex";
}

function normalizeUrl(input: string): string {
	return input.replace(/\/+$/, "");
}

function quoteYaml(value: string): string {
	return JSON.stringify(value);
}

function quoteTomlString(value: string): string {
	return JSON.stringify(value);
}

function quoteTomlKey(value: string): string {
	return JSON.stringify(value);
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function catalogHash(): string | null {
	const path = aiProviderCatalogPath();
	if (!existsSync(path)) return null;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
