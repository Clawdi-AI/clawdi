import type {
	AiProvider,
	AiProviderApiMode,
	AiProviderAuth,
	AiProviderCatalog,
	AiProviderModel,
} from "@clawdi/shared";
import {
	defaultAiProviderApiMode,
	defaultAiProviderBaseUrl,
	validateAiProviderCatalog,
} from "@clawdi/shared";

export type AgentTarget = "openclaw" | "hermes" | "codex";

export const CODEX_PROFILE_NAME = "clawdi-ai-provider";

export const AGENT_TARGET_CONTRACTS: Record<
	AgentTarget,
	{
		settingMethod: string;
		supportedVersionRange: string;
		status: "enabled" | "blocked";
	}
> = {
	codex: {
		settingMethod: "$CODEX_HOME/clawdi-ai-provider.config.toml selected with codex --profile",
		supportedVersionRange:
			"@openai/codex 0.134.0 through 0.142.4 with profile config, model_providers, and responses wire_api support",
		status: "enabled",
	},
	hermes: {
		settingMethod:
			"structured merge into $HERMES_HOME/config.yaml model/providers compatibility keys",
		supportedVersionRange: "Hermes Agent 0.18.x config.yaml compatibility readers",
		status: "enabled",
	},
	openclaw: {
		settingMethod: "openclaw config patch --stdin",
		supportedVersionRange:
			"openclaw 2026.5.12 through 2026.6.10 config patch contract and canonical openai auth-profiles",
		status: "enabled",
	},
};

export interface ProjectionFile {
	path: string;
	content: string;
}

export interface AgentTargetProjection {
	target: AgentTarget;
	files: ProjectionFile[];
	warnings: string[];
	contract: (typeof AGENT_TARGET_CONTRACTS)[AgentTarget];
	provider_ids: string[];
	default_provider_id: string;
	primary_model: AgentPrimaryModel;
}

export interface AgentPrimaryModel {
	provider_id: string;
	model: string;
}

interface ProjectionProvider {
	id: string;
	type: AiProvider["type"];
	label?: string;
	base_url: string;
	api_mode: AiProviderApiMode;
	managed_by?: AiProvider["managed_by"];
	models?: AiProvider["models"];
	env_name?: string;
	auth: AiProviderAuth;
}

const OPENCLAW_API_LABELS: Partial<Record<AiProviderApiMode, string>> = {
	openai_chat: "openai-completions",
	openai_responses: "openai-responses",
	anthropic_messages: "anthropic-messages",
	google_generate_content: "google-generative-ai",
};

const HERMES_TRANSPORT_LABELS: Partial<Record<AiProviderApiMode, string>> = {
	openai_chat: "chat_completions",
	// Hermes' current target-native label for the OpenAI Responses API.
	// This is not a Clawdi provider api_mode and must not appear in provider input.
	openai_responses: "codex_responses",
	anthropic_messages: "anthropic_messages",
};

const HERMES_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export function buildAgentTargetProjection(
	target: AgentTarget,
	catalog: AiProviderCatalog,
	primaryModel?: AgentPrimaryModel,
): AgentTargetProjection {
	const validation = validateAiProviderCatalog(catalog);
	if (!validation.valid) {
		throw new Error(`AI Provider catalog is invalid:\n${validation.errors.join("\n")}`);
	}
	const selection = selectProjectionProviders(target, catalog, primaryModel);
	const providers = selection.providers;
	const primaryProvider = selection.primaryProvider;
	const selectedPrimaryModel = selection.primaryModel;
	const warnings = [...validation.warnings, ...selection.warnings];
	const projection =
		target === "openclaw"
			? buildOpenClawProjection(providers, primaryProvider, selectedPrimaryModel)
			: target === "hermes"
				? buildHermesProjection(providers, primaryProvider, selectedPrimaryModel)
				: buildCodexProjection(providers, primaryProvider, selectedPrimaryModel);
	const extension = target === "openclaw" ? "json" : target === "hermes" ? "yaml" : "toml";
	return {
		target,
		files: [
			{
				path: `ai-providers.${target}.${extension}`,
				content: projection,
			},
		],
		warnings,
		contract: AGENT_TARGET_CONTRACTS[target],
		provider_ids: providers.map((provider) => provider.id),
		default_provider_id: primaryProvider.id,
		primary_model: selectedPrimaryModel,
	};
}

function selectProjectionProviders(
	target: AgentTarget,
	catalog: AiProviderCatalog,
	primaryModel: AgentPrimaryModel | undefined,
): {
	providers: ProjectionProvider[];
	primaryProvider: ProjectionProvider;
	primaryModel: AgentPrimaryModel;
	warnings: string[];
} {
	const warnings: string[] = [];
	const providers: ProjectionProvider[] = [];
	for (const provider of catalog.providers) {
		const result = normalizeProjectionProvider(target, provider);
		if (typeof result === "string") warnings.push(result);
		else providers.push(result);
	}
	if (providers.length === 0) {
		throw new Error(
			`No AI Providers can be applied to ${target}:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`,
		);
	}
	const selectedPrimaryModel = primaryModel ?? legacyCatalogPrimaryModel(catalog, providers);
	if (!selectedPrimaryModel) {
		throw new Error(
			`No primary model is configured for ${target}; pass agent primary_model {provider_id, model} before agent config apply.`,
		);
	}
	if (hasLegacyOpenAiCodexModelPrefix(selectedPrimaryModel.model)) {
		throw new Error(
			`Primary model for ${selectedPrimaryModel.provider_id} must use the OpenAI model id without the legacy openai-codex prefix.`,
		);
	}
	const primaryProvider = providers.find(
		(provider) => provider.id === selectedPrimaryModel.provider_id,
	);
	if (!primaryProvider) {
		throw new Error(
			`Primary model provider ${selectedPrimaryModel.provider_id} cannot be applied to ${target}.`,
		);
	}
	return { providers, primaryProvider, primaryModel: selectedPrimaryModel, warnings };
}

function normalizeProjectionProvider(
	target: AgentTarget,
	provider: AiProvider,
): ProjectionProvider | string {
	const legacyDefaultModel = legacyProviderDefaultModel(provider);
	if (legacyDefaultModel && hasLegacyOpenAiCodexModelPrefix(legacyDefaultModel)) {
		return `Provider ${provider.id} skipped for ${target}: legacy default_model must use the OpenAI model id without the legacy openai-codex prefix.`;
	}
	const legacyModel = provider.models?.find((model) => hasLegacyOpenAiCodexModelPrefix(model.id));
	if (legacyModel) {
		return `Provider ${provider.id} skipped for ${target}: model ${legacyModel.id} must use the OpenAI model id without the legacy openai-codex prefix.`;
	}
	if (provider.auth.type === "oauth_profile") {
		return `Provider ${provider.id} skipped for ${target}: uses oauth_profile auth, which does not have a verified agent config apply path yet.`;
	}
	if (provider.auth.type === "agent_profile" && !usesCodexNativeAuth(provider)) {
		return `Provider ${provider.id} skipped for ${target}: uses agent_profile auth for ${provider.auth.tool}; AI Provider apply only supports agent:codex/<profile> profiles.`;
	}
	const envName = authEnvName(provider);
	if (provider.auth.type !== "none" && !envName && !usesCodexNativeAuth(provider)) {
		return `Provider ${provider.id} skipped for ${target}: auth requires an agent env name (catalog runtime_env_name) or an env:<NAME> ref before agent config apply.`;
	}
	const apiMode = provider.api_mode ?? defaultAiProviderApiMode(provider.type);
	if (!apiMode) {
		return `Provider ${provider.id} skipped for ${target}: requires api_mode before agent config apply.`;
	}
	const projectionProvider = {
		id: provider.id,
		type: provider.type,
		label: provider.label,
		base_url: provider.base_url,
		api_mode: apiMode,
		managed_by: provider.managed_by,
		models: provider.models,
		env_name: envName,
		auth: provider.auth,
	};
	if (target === "codex") {
		const reason = codexProjectionSkipReason(projectionProvider);
		if (reason) return reason;
	}
	if (target === "hermes") {
		const reason = hermesProjectionSkipReason(projectionProvider);
		if (reason) return reason;
	}
	if (target === "openclaw") {
		const reason = openClawProjectionSkipReason(projectionProvider);
		if (reason) return reason;
	}
	return projectionProvider;
}

function legacyCatalogPrimaryModel(
	catalog: AiProviderCatalog,
	providers: ProjectionProvider[],
): AgentPrimaryModel | undefined {
	const preferredProviderId = catalog.defaults?.chat_provider_id ?? catalog.providers[0]?.id;
	const preferredProvider =
		providers.find((provider) => provider.id === preferredProviderId) ?? providers[0];
	if (!preferredProvider) return undefined;
	const source = catalog.providers.find((provider) => provider.id === preferredProvider.id);
	const model = source ? (legacyProviderDefaultModel(source) ?? source.models?.[0]?.id) : undefined;
	if (!model) return undefined;
	return { provider_id: preferredProvider.id, model };
}

function legacyProviderDefaultModel(provider: AiProvider): string | undefined {
	const value = (provider as AiProvider & { default_model?: string }).default_model;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
	primaryProvider: ProjectionProvider,
	primaryModel: AgentPrimaryModel,
): string {
	const projectedProviders = Object.fromEntries(
		providers
			.filter((provider) => !usesNativeCodexOpenAiProvider(provider))
			.map((provider) => [
				openClawProjectedProviderId(provider),
				compactObject({
					baseUrl: openClawBaseUrlForProvider(provider),
					api: openClawApiLabel(provider.api_mode),
					apiKey: openClawApiKeyEnvForProvider(provider)
						? { source: "env", provider: "default", id: openClawApiKeyEnvForProvider(provider) }
						: undefined,
					models: openClawModels(
						provider,
						provider.id === primaryProvider.id ? primaryModel.model : undefined,
					),
				}),
			]),
	);
	const usesNativeCodex = providers.some(usesNativeCodexOpenAiProvider);
	const usesEnvSecrets = providers
		.filter((provider) => !usesNativeCodexOpenAiProvider(provider))
		.some((provider) => Boolean(openClawApiKeyEnvForProvider(provider)));
	const body = compactObject({
		plugins: usesNativeCodex ? { entries: { codex: { enabled: true } } } : undefined,
		secrets: usesEnvSecrets
			? {
					providers: {
						default: { source: "env" },
					},
					defaults: {
						env: "default",
					},
				}
			: undefined,
		agents: {
			defaults: {
				model: {
					primary: openClawDefaultModelRef(primaryProvider, primaryModel.model),
				},
			},
		},
		models:
			Object.keys(projectedProviders).length > 0
				? {
						mode: "merge",
						providers: projectedProviders,
					}
				: undefined,
	});
	return `${JSON.stringify(body, null, 2)}\n`;
}

function openClawModels(
	provider: ProjectionProvider,
	primaryModel?: string,
): Array<Record<string, unknown>> {
	const models = (provider.models ?? [])
		.map((model) => {
			const api = openClawApiLabel(model.api_mode ?? provider.api_mode);
			return compactObject({
				id: model.id,
				name: model.label ?? model.id,
				api,
				input: openClawInputModalities(model),
				reasoning: model.supports_reasoning,
				compat:
					model.supports_tools === undefined ? undefined : { supportsTools: model.supports_tools },
				contextWindow: positiveNumber(model.context_window),
				maxTokens: positiveNumber(model.max_tokens),
			});
		})
		.filter((model) => typeof model.id === "string" && model.id.length > 0)
		.filter(
			(model, index, entries) => entries.findIndex((entry) => entry.id === model.id) === index,
		);
	const api = openClawApiLabel(provider.api_mode);
	const defaultModelId = primaryModel;
	if (defaultModelId && !models.some((model) => model.id === defaultModelId)) {
		models.unshift(
			compactObject({
				id: defaultModelId,
				name: defaultModelId,
				api,
			}),
		);
	}
	return models;
}

function openClawInputModalities(model: AiProviderModel): AiProviderModel["input_modalities"] {
	if (model.input_modalities && model.input_modalities.length > 0) return model.input_modalities;
	if (model.supports_vision === true) return ["text", "image"];
	if (model.supports_vision === false) return ["text"];
	return undefined;
}

function openClawApiLabel(apiMode: AiProviderApiMode): string | undefined {
	const label = OPENCLAW_API_LABELS[apiMode];
	return label === "openai-completions" ? undefined : label;
}

function openClawProjectionSkipReason(provider: ProjectionProvider): string | undefined {
	if (!usesCodexNativeAuth(provider)) return undefined;
	if (provider.api_mode !== "openai_responses") {
		return `Provider ${provider.id} skipped for openclaw: Codex OAuth native apply requires api_mode openai_responses.`;
	}
	if (!usesNativeCodexOpenAiProvider(provider)) {
		return `Provider ${provider.id} skipped for openclaw: Codex OAuth native apply requires an openai provider with the default OpenAI base_url.`;
	}
	return undefined;
}

function openClawDefaultModelRef(provider: ProjectionProvider, model: string): string {
	if (usesNativeCodexOpenAiProvider(provider)) {
		return `openai/${codexNativeModelId(model)}`;
	}
	return `${openClawProjectedProviderId(provider)}/${model}`;
}

function openClawProjectedProviderId(provider: ProjectionProvider): string {
	return provider.id;
}

function openClawBaseUrlForProvider(provider: ProjectionProvider): string {
	return provider.base_url;
}

function openClawApiKeyEnvForProvider(provider: ProjectionProvider): string | undefined {
	return provider.env_name;
}

function positiveNumber(input: number | undefined): number | undefined {
	return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : undefined;
}

function buildHermesProjection(
	providers: ProjectionProvider[],
	primaryProvider: ProjectionProvider,
	primaryModel: AgentPrimaryModel,
): string {
	const nativeCodexDefault = usesNativeCodexOpenAiProvider(primaryProvider);
	const customProviders = providers.filter((provider) => !usesNativeCodexOpenAiProvider(provider));
	const lines: string[] = [
		"# Generated by Clawdi. Merge this patch into Hermes config.yaml.",
		`# Contract: ${AGENT_TARGET_CONTRACTS.hermes.supportedVersionRange}; ${AGENT_TARGET_CONTRACTS.hermes.settingMethod}.`,
		"model:",
	];
	if (nativeCodexDefault) {
		lines.push('  provider: "openai-codex"');
		lines.push(`  default: ${quoteYaml(codexNativeModelId(primaryModel.model))}`);
		lines.push(`  base_url: ${quoteYaml(HERMES_CODEX_BASE_URL)}`);
	} else {
		lines.push(`  provider: ${quoteYaml(hermesProviderSelector(primaryProvider.id))}`);
		lines.push(`  default: ${quoteYaml(primaryModel.model)}`);
	}
	if (customProviders.length > 0) lines.push("providers:");
	for (const provider of customProviders) {
		const transport = hermesTransportLabel(provider.api_mode);
		if (!transport) {
			throw new Error(
				`Provider ${provider.id} cannot be projected to Hermes because its api_mode is not supported.`,
			);
		}
		lines.push(`  ${quoteYaml(provider.id)}:`);
		if (provider.label) lines.push(`    name: ${quoteYaml(provider.label)}`);
		lines.push(`    api: ${quoteYaml(hermesBaseUrlForProvider(provider))}`);
		lines.push(`    transport: ${quoteYaml(transport)}`);
		const envName = hermesKeyEnvForProvider(provider);
		if (envName) lines.push(`    key_env: ${quoteYaml(envName)}`);
		lines.push(...hermesModelLines(provider));
	}
	return `${lines.join("\n")}\n`;
}

function hermesModelLines(provider: ProjectionProvider): string[] {
	const models = hermesModels(provider);
	if (models.length === 0) return [];
	const lines = ["    models:"];
	for (const model of models) {
		lines.push(`      ${quoteYaml(model.id)}:`);
		if (model.context_length !== undefined) {
			lines.push(`        context_length: ${model.context_length}`);
		}
		if (model.max_tokens !== undefined) {
			lines.push(`        max_tokens: ${model.max_tokens}`);
		}
		if (model.supports_vision !== undefined) {
			lines.push(`        supports_vision: ${model.supports_vision}`);
		}
	}
	return lines;
}

function hermesModels(
	provider: ProjectionProvider,
): Array<{ id: string; context_length?: number; max_tokens?: number; supports_vision?: boolean }> {
	const seen = new Set<string>();
	const entries: Array<{
		id: string;
		context_length?: number;
		max_tokens?: number;
		supports_vision?: boolean;
	}> = [];
	for (const model of provider.models ?? []) {
		if (!model.id || seen.has(model.id)) continue;
		seen.add(model.id);
		const entry: {
			id: string;
			context_length?: number;
			max_tokens?: number;
			supports_vision?: boolean;
		} = { id: model.id };
		const contextLength = positiveNumber(model.context_window);
		if (contextLength !== undefined) entry.context_length = contextLength;
		const maxTokens = positiveNumber(model.max_tokens);
		if (maxTokens !== undefined) entry.max_tokens = maxTokens;
		const supportsVision = hermesSupportsVision(model);
		if (supportsVision !== undefined) entry.supports_vision = supportsVision;
		if (Object.keys(entry).length > 1) entries.push(entry);
	}
	return entries;
}

function hermesSupportsVision(model: AiProviderModel): boolean | undefined {
	if (typeof model.supports_vision === "boolean") return model.supports_vision;
	return model.input_modalities?.includes("image") ? true : undefined;
}

function hermesBaseUrlForProvider(provider: ProjectionProvider): string {
	return provider.base_url;
}

function hermesKeyEnvForProvider(provider: ProjectionProvider): string | undefined {
	return provider.env_name;
}

function hermesProjectionSkipReason(provider: ProjectionProvider): string | undefined {
	if (usesCodexNativeAuth(provider)) {
		if (provider.api_mode !== "openai_responses") {
			return `Provider ${provider.id} skipped for hermes: Codex OAuth native apply requires api_mode openai_responses.`;
		}
		if (!usesNativeCodexOpenAiProvider(provider)) {
			return `Provider ${provider.id} skipped for hermes: Codex OAuth native apply requires an openai provider with the default OpenAI base_url.`;
		}
		return undefined;
	}
	if (!hermesTransportLabel(provider.api_mode)) {
		return `Provider ${provider.id} skipped for hermes: api_mode ${provider.api_mode} does not map to a verified Hermes custom-provider transport.`;
	}
	return undefined;
}

function hermesTransportLabel(apiMode: AiProviderApiMode): string | undefined {
	return HERMES_TRANSPORT_LABELS[apiMode];
}

function hermesProviderSelector(providerId: string): string {
	return `custom:${providerId}`;
}

function buildCodexProjection(
	providers: ProjectionProvider[],
	primaryProvider: ProjectionProvider,
	primaryModel: AgentPrimaryModel,
): string {
	for (const provider of providers) validateCodexProjectionProvider(provider);
	const lines: string[] = [
		"# Generated by Clawdi. Do not put API keys in this file.",
		`# Contract: ${AGENT_TARGET_CONTRACTS.codex.supportedVersionRange}; ${AGENT_TARGET_CONTRACTS.codex.settingMethod}.`,
	];
	lines.push(`model = ${quoteTomlString(codexNativeModelId(primaryModel.model))}`);
	lines.push(`model_provider = ${quoteTomlString(codexModelProviderId(primaryProvider))}`, "");
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
	if (provider.api_mode !== "openai_responses") {
		return `Provider ${provider.id} skipped for codex: Codex provider config supports Responses-compatible providers only; got api_mode ${provider.api_mode}.`;
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
	return usesNativeCodexOpenAiProvider(provider);
}

function usesNativeCodexOpenAiProvider(provider: ProjectionProvider): boolean {
	return (
		provider.type === "openai" &&
		usesCodexNativeAuth(provider) &&
		normalizeUrl(provider.base_url) === normalizeUrl(defaultAiProviderBaseUrl("openai") ?? "")
	);
}

function usesCodexNativeAuth(provider: Pick<ProjectionProvider, "auth">): boolean {
	return provider.auth.type === "agent_profile" && provider.auth.tool === "codex";
}

function codexNativeModelId(model: string): string {
	const prefix = "openai/";
	if (model.startsWith(prefix)) return model.slice(prefix.length);
	return model;
}

function hasLegacyOpenAiCodexModelPrefix(model: string): boolean {
	return model.startsWith("openai-codex/");
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
