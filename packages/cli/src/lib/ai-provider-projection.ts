import type { AiProvider, AiProviderAuth, AiProviderCatalog } from "@clawdi/shared";
import {
	defaultAiProviderApiMode,
	defaultAiProviderBaseUrl,
	validateAiProviderCatalog,
} from "@clawdi/shared";

export type AgentEngine = "openclaw" | "hermes" | "codex";

export const CODEX_PROFILE_NAME = "clawdi-ai-provider";

export const AGENT_ENGINE_CONTRACTS: Record<
	AgentEngine,
	{
		settingMethod: string;
		supportedVersionRange: string;
		status: "enabled" | "blocked";
	}
> = {
	codex: {
		settingMethod: "$CODEX_HOME/clawdi-ai-provider.config.toml selected with codex --profile",
		supportedVersionRange:
			"@openai/codex <1.0.0 with profile config, model_providers, and responses wire_api support",
		status: "enabled",
	},
	hermes: {
		settingMethod: "hermes config set",
		supportedVersionRange: "Hermes Agent >=0.15.1 <0.16.0",
		status: "enabled",
	},
	openclaw: {
		settingMethod: "native activation blocked until fixture contract",
		supportedVersionRange: "unverified",
		status: "blocked",
	},
};

export interface ProjectionFile {
	path: string;
	content: string;
}

export interface AgentEngineProjection {
	engine: AgentEngine;
	files: ProjectionFile[];
	warnings: string[];
	contract: (typeof AGENT_ENGINE_CONTRACTS)[AgentEngine];
	provider_ids: string[];
	default_provider_id: string;
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

export function buildAgentEngineProjection(
	engine: AgentEngine,
	catalog: AiProviderCatalog,
): AgentEngineProjection {
	const validation = validateAiProviderCatalog(catalog);
	if (!validation.valid) {
		throw new Error(`AI Provider catalog is invalid:\n${validation.errors.join("\n")}`);
	}
	const selection = selectProjectionProviders(engine, catalog);
	const providers = selection.providers;
	const defaultProvider = selection.defaultProvider;
	const warnings = [...validation.warnings, ...selection.warnings];
	const projection =
		engine === "openclaw"
			? buildOpenClawProjection(providers, defaultProvider)
			: engine === "hermes"
				? buildHermesProjection(providers, defaultProvider)
				: buildCodexProjection(providers, defaultProvider);
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
		contract: AGENT_ENGINE_CONTRACTS[engine],
		provider_ids: providers.map((provider) => provider.id),
		default_provider_id: defaultProvider.id,
	};
}

function selectProjectionProviders(
	engine: AgentEngine,
	catalog: AiProviderCatalog,
): { providers: ProjectionProvider[]; defaultProvider: ProjectionProvider; warnings: string[] } {
	const warnings: string[] = [];
	const providers: ProjectionProvider[] = [];
	for (const provider of catalog.providers) {
		const result = normalizeProjectionProvider(engine, provider);
		if (typeof result === "string") warnings.push(result);
		else providers.push(result);
	}
	if (providers.length === 0) {
		throw new Error(
			`No AI Providers can be applied to ${engine}:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`,
		);
	}
	const preferredDefaultId = catalog.defaults?.chat_provider_id ?? catalog.providers[0]?.id;
	const preferredDefault = providers.find((provider) => provider.id === preferredDefaultId);
	if (preferredDefault) {
		return { providers, defaultProvider: preferredDefault, warnings };
	}
	const defaultProvider = providers[0];
	if (preferredDefaultId) {
		warnings.push(
			`Default provider ${preferredDefaultId} cannot be applied to ${engine}; using ${defaultProvider.id}.`,
		);
	}
	return { providers, defaultProvider, warnings };
}

function normalizeProjectionProvider(
	engine: AgentEngine,
	provider: AiProvider,
): ProjectionProvider | string {
	if (engine === "hermes" && provider.id.includes(".")) {
		return `Provider ${provider.id} skipped for hermes: Hermes apply does not support provider id "${provider.id}" because dot-path escaping has not been verified. Rename the provider id before applying.`;
	}
	if (!provider.default_model) {
		return `Provider ${provider.id} skipped for ${engine}: requires default_model before agent config apply.`;
	}
	if (
		engine !== "codex" &&
		(provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile")
	) {
		return `Provider ${provider.id} skipped for ${engine}: uses ${provider.auth.type} auth, which does not have a verified agent config apply path yet. Materialize the profile for its native tool or use env/Vault/managed API key auth for key-env agents.`;
	}
	const envName = authEnvName(provider);
	if (provider.auth.type !== "none" && !envName && !usesCodexNativeAuth(provider)) {
		return `Provider ${provider.id} skipped for ${engine}: auth requires an agent env name (catalog runtime_env_name) or an env:<NAME> ref before agent config apply.`;
	}
	const projectionProvider = {
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
	if (engine === "codex") {
		const reason = codexProjectionSkipReason(projectionProvider);
		if (reason) return reason;
	}
	return projectionProvider;
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

function buildOpenClawProjection(
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

function buildHermesProjection(
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

function buildCodexProjection(
	providers: ProjectionProvider[],
	defaultProvider: ProjectionProvider,
): string {
	for (const provider of providers) validateCodexProjectionProvider(provider);
	const lines: string[] = [
		"# Generated by Clawdi. Do not put API keys in this file.",
		`# Contract: ${AGENT_ENGINE_CONTRACTS.codex.supportedVersionRange}; ${AGENT_ENGINE_CONTRACTS.codex.settingMethod}.`,
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
	const reason = codexProjectionSkipReason(provider);
	if (reason) throw new Error(reason);
}

function codexProjectionSkipReason(provider: ProjectionProvider): string | undefined {
	const apiMode = provider.api_mode ?? defaultAiProviderApiMode(provider.type);
	if (apiMode !== "openai_responses") {
		return `Provider ${provider.id} skipped for codex: Codex provider config supports Responses-compatible providers only; got api_mode ${apiMode ?? "unknown"}.`;
	}
	if (provider.auth.type === "oauth_profile") {
		return `Provider ${provider.id} skipped for codex: uses oauth_profile auth, which does not have a verified Codex config projection.`;
	}
	if (provider.auth.type === "agent_profile" && !usesCodexNativeAuth(provider)) {
		return `Provider ${provider.id} skipped for codex: uses agent_profile auth for ${provider.auth.tool}; Codex projection only supports agent:codex/<profile>.`;
	}
	return undefined;
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
