import {
	type AiProviderCapabilities,
	type AiProviderModel,
	type AiProviderModelCost,
	isAiProviderApiMode,
} from "@clawdi/shared";

export function buildManagedModelsEndpoint(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export function extractManagedLiveModels(payload: unknown): AiProviderModel[] {
	if (!isPlainRecord(payload) || !Array.isArray(payload.data)) return [];
	const models: AiProviderModel[] = [];
	const seen = new Set<string>();
	for (const entry of payload.data) {
		const model = extractManagedLiveModel(entry);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

function extractManagedLiveModel(value: unknown): AiProviderModel | null {
	if (!isPlainRecord(value)) return null;
	const id = normalizeModelId(value.id);
	if (!id) return null;
	const model: AiProviderModel = { id };
	const label = normalizeModelId(value.label);
	if (label) model.label = label;
	const alias = normalizeModelId(value.alias);
	if (alias) model.alias = alias;
	if (typeof value.api_mode === "string" && isAiProviderApiMode(value.api_mode)) {
		model.api_mode = value.api_mode;
	}
	const inputModalities = managedInputModalities(value.input_modalities);
	if (inputModalities) model.input_modalities = inputModalities;
	for (const field of ["supports_vision", "supports_tools", "supports_reasoning"] as const) {
		if (typeof value[field] === "boolean") model[field] = value[field];
	}
	// context_window is canonical. The Sub2API metadata overlay exposes the
	// OpenAI-compatible context_length alias, so use it only when canonical data
	// is absent.
	const contextWindow =
		positiveInteger(value.context_window) ?? positiveInteger(value.context_length);
	if (contextWindow !== undefined) model.context_window = contextWindow;
	const maxInputTokens = positiveInteger(value.max_input_tokens);
	if (maxInputTokens !== undefined) model.max_input_tokens = maxInputTokens;
	// max_tokens is the canonical catalog output limit. Accept max_output_tokens
	// from OpenAI-compatible discovery as a wire alias without inferring a cap.
	const maxTokens = positiveInteger(value.max_tokens) ?? positiveInteger(value.max_output_tokens);
	if (maxTokens !== undefined) model.max_tokens = maxTokens;
	const cost = managedModelCost(value.cost);
	if (cost) model.cost = cost;
	const capabilities = managedModelCapabilities(value.capabilities);
	if (capabilities) model.capabilities = capabilities;
	return model;
}

function managedInputModalities(value: unknown): AiProviderModel["input_modalities"] {
	if (!Array.isArray(value)) return undefined;
	const modalities = value.filter(
		(entry): entry is NonNullable<AiProviderModel["input_modalities"]>[number] =>
			isManagedInputModality(entry),
	);
	return modalities.length > 0
		? modalities.filter((entry, index, entries) => entries.indexOf(entry) === index)
		: undefined;
}

function isManagedInputModality(
	value: unknown,
): value is NonNullable<AiProviderModel["input_modalities"]>[number] {
	return value === "text" || value === "image" || value === "video" || value === "audio";
}

function managedModelCost(value: unknown): AiProviderModelCost | undefined {
	if (!isPlainRecord(value)) return undefined;
	const input = nonNegativeNumber(value.input);
	const output = nonNegativeNumber(value.output);
	if (input === undefined || output === undefined) return undefined;
	const cacheRead = nonNegativeNumber(value.cache_read);
	const cacheWrite = nonNegativeNumber(value.cache_write);
	return {
		input,
		output,
		...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
		...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
	};
}

function managedModelCapabilities(value: unknown): AiProviderCapabilities | undefined {
	if (!isPlainRecord(value)) return undefined;
	const capabilities: AiProviderCapabilities = {};
	for (const field of [
		"chat",
		"responses",
		"tools",
		"vision",
		"embeddings",
		"image_generation",
	] as const) {
		if (typeof value[field] === "boolean") capabilities[field] = value[field];
	}
	return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeModelId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
