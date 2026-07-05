import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiProvider, AiProviderCatalog, AiProviderValidationOptions } from "@clawdi/shared";
import { validateAiProviderCatalog } from "@clawdi/shared";
import { getClawdiDir } from "./config";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "./private-file";

export function aiProviderCatalogPath(): string {
	return join(getClawdiDir(), "ai-providers", "catalog.json");
}

export function emptyAiProviderCatalog(): AiProviderCatalog {
	return { schema_version: 1, providers: [] };
}

export function readAiProviderCatalog(
	options: AiProviderValidationOptions = {},
): AiProviderCatalog {
	const path = aiProviderCatalogPath();
	if (!existsSync(path)) return emptyAiProviderCatalog();
	const raw = readFileSync(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`AI Provider catalog is not valid JSON: ${path}`);
	}
	const catalog = coerceAiProviderCatalog(parsed);
	const result = validateAiProviderCatalog(catalog, options);
	if (!result.valid) {
		throw new Error(`AI Provider catalog is invalid:\n${result.errors.join("\n")}`);
	}
	return catalog;
}

export function writeAiProviderCatalog(catalog: AiProviderCatalog): void {
	const result = validateAiProviderCatalog(catalog);
	if (!result.valid) {
		throw new Error(`Refusing to write invalid AI Provider catalog:\n${result.errors.join("\n")}`);
	}
	const path = aiProviderCatalogPath();
	writePrivateFileAtomic(path, `${JSON.stringify(catalog, null, 2)}\n`, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

export function upsertAiProvider(
	catalog: AiProviderCatalog,
	provider: AiProvider,
	replace: boolean,
): AiProviderCatalog {
	const index = catalog.providers.findIndex((entry) => entry.id === provider.id);
	if (index >= 0 && !replace) {
		throw new Error(`AI Provider already exists: ${provider.id}. Pass --replace to overwrite it.`);
	}
	const providers = [...catalog.providers];
	if (index >= 0) providers[index] = provider;
	else providers.push(provider);
	return { ...catalog, providers };
}

export function removeAiProvider(
	catalog: AiProviderCatalog,
	providerId: string,
	force: boolean,
): AiProviderCatalog {
	const exists = catalog.providers.some((entry) => entry.id === providerId);
	if (!exists) throw new Error(`AI Provider not found: ${providerId}`);
	if (
		!force &&
		(catalog.defaults?.chat_provider_id === providerId ||
			catalog.defaults?.embedding_provider_id === providerId)
	) {
		throw new Error(`AI Provider ${providerId} is still referenced by defaults. Pass --force.`);
	}
	const providers = catalog.providers.filter((entry) => entry.id !== providerId);
	const defaults = { ...catalog.defaults };
	if (defaults.chat_provider_id === providerId) delete defaults.chat_provider_id;
	if (defaults.embedding_provider_id === providerId) delete defaults.embedding_provider_id;
	return {
		...catalog,
		providers,
		defaults: Object.keys(defaults).length > 0 ? defaults : undefined,
	};
}

export function coerceAiProviderCatalog(input: unknown): AiProviderCatalog {
	const source =
		isRecord(input) && isRecord(input.ai_provider_catalog) ? input.ai_provider_catalog : input;
	if (!isRecord(source)) throw new Error("AI Provider catalog must be an object.");
	if (source.schema_version !== 1) {
		throw new Error("AI Provider catalog schema_version must be 1.");
	}
	if (!Array.isArray(source.providers)) {
		throw new Error("AI Provider catalog providers must be an array.");
	}
	return {
		schema_version: source.schema_version,
		providers: source.providers.map(coerceAiProvider),
		defaults: isRecord(source.defaults) ? source.defaults : undefined,
	};
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function coerceAiProvider(input: unknown): AiProvider {
	if (!isRecord(input)) return input as AiProvider;
	const { default_model: legacyDefaultModel, models: rawModels, ...rest } = input;
	const models = Array.isArray(rawModels) ? [...rawModels] : [];
	if (typeof legacyDefaultModel === "string" && legacyDefaultModel.trim()) {
		const modelId = legacyDefaultModel.trim();
		const hasModel = models.some((model) => {
			if (!isRecord(model)) return false;
			return model.id === modelId;
		});
		if (!hasModel) models.unshift({ id: modelId });
	}
	return {
		...rest,
		...(models.length > 0 ? { models } : {}),
	} as AiProvider;
}
