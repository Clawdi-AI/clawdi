import type {
	AiProvider,
	AiProviderApiMode,
	AiProviderAuth,
	AiProviderCatalog,
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
			"@openai/codex 0.134.0 through 0.136.0 with profile config, model_providers, and responses wire_api support",
		status: "enabled",
	},
	hermes: {
		settingMethod: "structured merge into $HERMES_HOME/config.yaml providers dict",
		supportedVersionRange: "Hermes Agent 0.13.0 through 0.15.2 with providers dict compatibility",
		status: "enabled",
	},
	openclaw: {
		settingMethod: "openclaw config patch --stdin",
		supportedVersionRange:
			"openclaw 2026.5.12 through 2026.6.1 config patch contract and canonical openai auth-profiles",
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
}

interface ProjectionProvider {
	id: string;
	type: AiProvider["type"];
	label?: string;
	base_url: string;
	default_model: string;
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
	openai_responses: "codex_responses",
	anthropic_messages: "anthropic_messages",
};

const HERMES_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const OPENCLAW_MANAGED_CODEX_PROVIDER_ID = "openai-codex";

export function buildAgentTargetProjection(
	target: AgentTarget,
	catalog: AiProviderCatalog,
): AgentTargetProjection {
	const validation = validateAiProviderCatalog(catalog);
	if (!validation.valid) {
		throw new Error(`AI Provider catalog is invalid:\n${validation.errors.join("\n")}`);
	}
	const selection = selectProjectionProviders(target, catalog);
	const providers = selection.providers;
	const defaultProvider = selection.defaultProvider;
	const warnings = [...validation.warnings, ...selection.warnings];
	const projection =
		target === "openclaw"
			? buildOpenClawProjection(providers, defaultProvider)
			: target === "hermes"
				? buildHermesProjection(providers, defaultProvider)
				: buildCodexProjection(providers, defaultProvider);
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
		default_provider_id: defaultProvider.id,
	};
}

function selectProjectionProviders(
	target: AgentTarget,
	catalog: AiProviderCatalog,
): { providers: ProjectionProvider[]; defaultProvider: ProjectionProvider; warnings: string[] } {
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
	const preferredDefaultId = catalog.defaults?.chat_provider_id ?? catalog.providers[0]?.id;
	const preferredDefault = providers.find((provider) => provider.id === preferredDefaultId);
	if (preferredDefault) {
		return { providers, defaultProvider: preferredDefault, warnings };
	}
	const defaultProvider = providers[0];
	if (preferredDefaultId) {
		warnings.push(
			`Default provider ${preferredDefaultId} cannot be applied to ${target}; using ${defaultProvider.id}.`,
		);
	}
	return { providers, defaultProvider, warnings };
}

function normalizeProjectionProvider(
	target: AgentTarget,
	provider: AiProvider,
): ProjectionProvider | string {
	if (!provider.default_model) {
		return `Provider ${provider.id} skipped for ${target}: requires default_model before agent config apply.`;
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
		default_model: provider.default_model,
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
	const projectedProviders = Object.fromEntries(
		providers
			.filter((provider) => !usesNativeCodexOpenAiProvider(provider))
			.map((provider) => [
				openClawProjectedProviderId(provider),
				compactObject({
					baseUrl: provider.base_url,
					api: openClawApiLabelForProvider(provider, provider.api_mode),
					agentRuntime: isClawdiManagedProvider(provider) ? { id: "pi" } : undefined,
					apiKey: provider.env_name
						? { source: "env", provider: "default", id: provider.env_name }
						: undefined,
					models: openClawModels(provider),
				}),
			]),
	);
	const usesNativeCodex = providers.some(usesNativeCodexOpenAiProvider);
	const body = compactObject({
		plugins: usesNativeCodex ? { entries: { codex: { enabled: true } } } : undefined,
		agents: {
			defaults: {
				model: {
					primary: openClawDefaultModelRef(defaultProvider),
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

function openClawModels(provider: ProjectionProvider): Array<Record<string, unknown>> {
	const models = (provider.models ?? [])
		.map((model) => {
			const api = openClawApiLabelForProvider(provider, model.api_mode ?? provider.api_mode);
			return compactObject({
				id: openClawModelId(provider, model.id),
				name: model.label ?? model.id,
				api,
				input: model.input_modalities,
				contextWindow: positiveNumber(model.context_window),
				maxTokens: positiveNumber(model.max_tokens),
			});
		})
		.filter((model) => typeof model.id === "string" && model.id.length > 0)
		.filter(
			(model, index, entries) => entries.findIndex((entry) => entry.id === model.id) === index,
		);
	const api = openClawApiLabelForProvider(provider, provider.api_mode);
	const defaultModelId = openClawModelId(provider, provider.default_model);
	if (!models.some((model) => model.id === defaultModelId)) {
		models.unshift({ id: defaultModelId, name: provider.default_model, api });
	}
	return models;
}

function openClawApiLabelForProvider(
	provider: ProjectionProvider,
	apiMode: AiProviderApiMode,
): string | undefined {
	if (apiMode === "openai_responses" && isClawdiManagedProvider(provider)) {
		return "openai-codex-responses";
	}
	return openClawApiLabel(apiMode);
}

function openClawApiLabel(apiMode: AiProviderApiMode): string | undefined {
	return OPENCLAW_API_LABELS[apiMode];
}

function isClawdiManagedProvider(provider: ProjectionProvider): boolean {
	return provider.managed_by === "clawdi" || provider.id === "clawdi-managed";
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

function openClawDefaultModelRef(provider: ProjectionProvider): string {
	if (usesNativeCodexOpenAiProvider(provider)) {
		return `openai/${codexNativeModelId(provider.default_model)}`;
	}
	return `${openClawProjectedProviderId(provider)}/${openClawModelId(provider, provider.default_model)}`;
}

function openClawProjectedProviderId(provider: ProjectionProvider): string {
	return isClawdiManagedProvider(provider) ? OPENCLAW_MANAGED_CODEX_PROVIDER_ID : provider.id;
}

function openClawModelId(provider: ProjectionProvider, modelId: string): string {
	return isClawdiManagedProvider(provider) ? codexNativeModelId(modelId) : modelId;
}

function positiveNumber(input: number | undefined): number | undefined {
	return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : undefined;
}

function buildHermesProjection(
	providers: ProjectionProvider[],
	defaultProvider: ProjectionProvider,
): string {
	const nativeCodexDefault = usesNativeCodexOpenAiProvider(defaultProvider);
	const customProviders = providers.filter((provider) => !usesNativeCodexOpenAiProvider(provider));
	const lines: string[] = [
		"# Generated by Clawdi. Merge this patch into Hermes config.yaml.",
		`# Contract: ${AGENT_TARGET_CONTRACTS.hermes.supportedVersionRange}; ${AGENT_TARGET_CONTRACTS.hermes.settingMethod}.`,
		"model:",
	];
	if (nativeCodexDefault) {
		lines.push('  provider: "openai-codex"');
		lines.push(`  default: ${quoteYaml(codexNativeModelId(defaultProvider.default_model))}`);
		lines.push(`  base_url: ${quoteYaml(HERMES_CODEX_BASE_URL)}`);
	} else {
		lines.push(`  provider: ${quoteYaml(hermesProviderSelector(defaultProvider.id))}`);
		lines.push(`  default: ${quoteYaml(defaultProvider.default_model)}`);
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
		lines.push(`    api: ${quoteYaml(provider.base_url)}`);
		lines.push(`    transport: ${quoteYaml(transport)}`);
		lines.push(`    default_model: ${quoteYaml(provider.default_model)}`);
		if (provider.env_name) lines.push(`    key_env: ${quoteYaml(provider.env_name)}`);
	}
	return `${lines.join("\n")}\n`;
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
	defaultProvider: ProjectionProvider,
): string {
	for (const provider of providers) validateCodexProjectionProvider(provider);
	const lines: string[] = [
		"# Generated by Clawdi. Do not put API keys in this file.",
		`# Contract: ${AGENT_TARGET_CONTRACTS.codex.supportedVersionRange}; ${AGENT_TARGET_CONTRACTS.codex.settingMethod}.`,
	];
	if (shouldWriteCodexModel(defaultProvider)) {
		lines.push(`model = ${quoteTomlString(defaultProvider.default_model)}`);
	}
	lines.push(`model_provider = ${quoteTomlString(codexModelProviderId(defaultProvider))}`, "");
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

function shouldWriteCodexModel(provider: ProjectionProvider): boolean {
	return Boolean(provider.default_model);
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
	for (const prefix of ["openai/", "openai-codex/"]) {
		if (model.startsWith(prefix)) return model.slice(prefix.length);
	}
	return model;
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
