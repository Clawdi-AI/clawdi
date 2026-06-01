import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AiProvider, AiProviderCatalog, AiProviderValidationOptions } from "@clawdi/shared";
import { validateAiProviderCatalog } from "@clawdi/shared";
import { getClawdiDir } from "./config";

const CATALOG_MODE = 0o600;

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
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: CATALOG_MODE });
	try {
		chmodSync(path, CATALOG_MODE);
	} catch {
		// Best effort on platforms without POSIX modes.
	}
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
	if (!isRecord(input)) throw new Error("AI Provider catalog must be an object.");
	if (input.schema_version !== 1) {
		throw new Error("AI Provider catalog schema_version must be 1.");
	}
	if (!Array.isArray(input.providers)) {
		throw new Error("AI Provider catalog providers must be an array.");
	}
	return {
		schema_version: input.schema_version,
		providers: input.providers,
		defaults: isRecord(input.defaults) ? input.defaults : undefined,
	} as AiProviderCatalog;
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}
