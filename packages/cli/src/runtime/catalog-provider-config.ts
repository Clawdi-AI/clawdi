import { join } from "node:path";
import { isClawdiManagedProviderId } from "@clawdi/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildAgentTargetProjection } from "../lib/ai-provider-projection";
import {
	getHermesRawConfigValue,
	getHermesResolvedConfigValue,
	type HermesConfigTransaction,
	reconcileHermesConfigValue,
} from "./hermes-config";
import type { HostedAiProviderProjectionInput } from "./hosted-provider-resolution";
import { isPlainRecord, recordValue } from "./manifest-shared";
import type { OpenClawHostedProviderPatch } from "./openclaw-provider-config";
import { runtimeImpactRevision } from "./runtime-impact-revision";
export interface CatalogProviderConfigurationResult {
	path: string | null;
	revision: string | null;
	providerIds: string[];
}
export function providerProjectionProgramImpact(
	runtime: "openclaw" | "hermes",
	patch: unknown,
	projectionInput: HostedAiProviderProjectionInput | null,
): unknown {
	const root = recordValue(patch);
	const managedProviderIds = new Set(
		(projectionInput?.catalog.providers ?? [])
			.filter((provider) => provider.managed_by === "clawdi")
			.map((provider) => provider.id),
	);
	if (!root || managedProviderIds.size === 0) return patch;

	const providerContainer = runtime === "openclaw" ? recordValue(root.models) : root;
	if (!providerContainer) return patch;
	const providers = recordValue(providerContainer.providers);
	if (!providers) return patch;
	const programProviders = Object.fromEntries(
		Object.entries(providers).map(([providerId, provider]) => {
			const providerConfig = recordValue(provider);
			if (!managedProviderIds.has(providerId) || !providerConfig) return [providerId, provider];
			const { models: _models, ...programConfig } = providerConfig;
			return [providerId, programConfig];
		}),
	);
	if (runtime === "openclaw") {
		return { ...root, models: { ...providerContainer, providers: programProviders } };
	}
	return { ...root, providers: programProviders };
}
export function applyHostedHermesAiProviderProjection(
	projectionInput: HostedAiProviderProjectionInput | null,
	previousProviderIds: readonly string[],
	home: string,
	config: HermesConfigTransaction | null,
	apply = true,
	preserveModelSelection = false,
): CatalogProviderConfigurationResult {
	const configPath = join(home, ".hermes", "config.yaml");
	if (!projectionInput) {
		const deletedProviderIds = staleProviderIds(new Set(previousProviderIds), new Set());
		if (apply && deletedProviderIds.length > 0) {
			if (!config) throw new Error("Hermes config command is unavailable");
			applyHermesProviderConfig(config, {}, deletedProviderIds, preserveModelSelection);
		}
		return {
			path: null,
			providerIds: [],
			revision: runtimeImpactRevision({
				hermesProviderProjection: "none",
				deletedProviderIds,
			}),
		};
	}

	const projection = buildAgentTargetProjection(
		"hermes",
		projectionInput.catalog,
		projectionInput.primaryModel,
		{ freezeManagedModelCatalog: true },
	);
	const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
	if (!file) throw new Error("Hermes projection did not include a config merge YAML file.");
	const activeProviderIds = [...providerIdsFromPatch("hermes", file.content)].sort();
	const deletedProviderIds = staleProviderIds(
		new Set(previousProviderIds),
		new Set(activeProviderIds),
	);
	const patchContent = mergeProviderDeletes("hermes", file.content, deletedProviderIds);
	if (apply) {
		if (!config) throw new Error("Hermes config command is unavailable");
		const patch = parseYaml(file.content) as unknown;
		const root = recordValue(patch);
		if (!root) throw new Error("Hermes projection patch must be a YAML object.");
		applyHermesProviderConfig(config, root, deletedProviderIds, preserveModelSelection);
	}
	return {
		path: configPath,
		providerIds: activeProviderIds,
		revision: runtimeImpactRevision({
			hermesProviderProjection: "yaml-merge",
			patch: providerProjectionProgramImpact("hermes", parseYaml(patchContent), projectionInput),
		}),
	};
}
export function buildOpenClawHostedProviderPatch(
	projectionInput: HostedAiProviderProjectionInput | null,
	previousProviderIds: readonly string[],
	mode: "merge" | "replace" = "replace",
): OpenClawHostedProviderPatch {
	if (!projectionInput) {
		const deleted = [...previousProviderIds].sort();
		return {
			apply: deleted.length > 0,
			content: mergeProviderDeletes("openclaw", "{}\n", deleted),
			providerIds: [],
		};
	}
	const projection = buildAgentTargetProjection(
		"openclaw",
		projectionInput.catalog,
		projectionInput.primaryModel,
	);
	const file = projection.files.find((entry) => entry.path.endsWith(".openclaw.json"));
	if (!file) throw new Error("OpenClaw projection did not include a config patch JSON file.");
	const providerIds = [...providerIdsFromPatch("openclaw", file.content)].sort();
	const deleted = staleProviderIds(new Set(previousProviderIds), new Set(providerIds));
	return {
		apply: true,
		content: mergeProviderDeletes(
			"openclaw",
			withOpenClawProviderMode(file.content, mode),
			deleted,
		),
		providerIds,
	};
}
type ProviderPatchRuntime = "hermes" | "openclaw";
function providerPatchRoot(
	runtime: ProviderPatchRuntime,
	content: string,
): Record<string, unknown> | null {
	if (runtime === "hermes" && !content.trim()) return null;
	return recordValue(runtime === "openclaw" ? JSON.parse(content) : parseYaml(content));
}
function providerPatchProviders(
	runtime: ProviderPatchRuntime,
	root: Record<string, unknown>,
): Record<string, unknown> | null {
	const container = runtime === "openclaw" ? recordValue(root.models) : root;
	return container ? recordValue(container.providers) : null;
}
function providerIdsFromPatch(runtime: ProviderPatchRuntime, content: string): Set<string> {
	const root = providerPatchRoot(runtime, content);
	const providers = root ? providerPatchProviders(runtime, root) : null;
	if (!providers) return new Set();
	return new Set(
		Object.entries(providers)
			.filter(([, value]) => value !== null)
			.map(([providerId]) => providerId),
	);
}
function withOpenClawProviderMode(patchContent: string, mode: "merge" | "replace"): string {
	const parsed = JSON.parse(patchContent) as unknown;
	const root = recordValue(parsed);
	if (!root) return patchContent;
	const patch = { ...root };
	const models = { ...(recordValue(patch.models) ?? {}), mode };
	patch.models = models;
	return `${JSON.stringify(patch, null, 2)}\n`;
}

const HERMES_DIRECT_MODEL_FIELDS = [
	"base_url",
	"api_key",
	"api",
	"key_env",
	"api_mode",
	"auth_mode",
] as const;
const HERMES_GENERATED_PROVIDER_FIELDS = [
	"name",
	"api",
	"url",
	"base_url",
	"default_model",
	"model",
	"models",
	"discover_models",
	"transport",
	"api_mode",
	"key_env",
	"api_key",
	"type",
	"auth_type",
] as const;
function applyHermesProviderConfig(
	context: HermesConfigTransaction,
	patch: Record<string, unknown>,
	deletedProviderIds: readonly string[],
	preserveModelSelection = false,
): void {
	const patchModel = recordValue(patch.model) ?? {};
	const modelKeys = new Set<string>([...HERMES_DIRECT_MODEL_FIELDS, ...Object.keys(patchModel)]);
	for (const key of preserveModelSelection ? [] : [...modelKeys].sort()) {
		const value = Object.hasOwn(patchModel, key) ? patchModel[key] : undefined;
		reconcileHermesConfigValue(context, `model.${key}`, value === null ? undefined : value);
	}
	if (
		!preserveModelSelection &&
		!Object.hasOwn(patchModel, "provider") &&
		deletedProviderIds.length > 0
	) {
		const currentProvider = getHermesResolvedConfigValue(context.context, "model.provider");
		if (currentProvider.exists && typeof currentProvider.value !== "string") {
			throw new Error("Hermes config field model.provider must be a string");
		}
		const managedSelectors = new Set(
			deletedProviderIds.flatMap((providerId) => [providerId, `custom:${providerId}`]),
		);
		if (currentProvider.exists && managedSelectors.has(currentProvider.value as string)) {
			reconcileHermesConfigValue(context, "model.provider", undefined);
			if (!Object.hasOwn(patchModel, "default")) {
				reconcileHermesConfigValue(context, "model.default", undefined);
			}
		}
	}

	const currentValue = getHermesRawConfigValue(context, "providers");
	if (currentValue.exists && !isPlainRecord(currentValue.value)) {
		throw new Error("Hermes config field providers must be an object");
	}
	const currentProviders: Record<string, unknown> =
		currentValue.exists && isPlainRecord(currentValue.value) ? currentValue.value : {};
	for (const [providerId, provider] of Object.entries(currentProviders)) {
		if (provider !== undefined && provider !== null && !isPlainRecord(provider)) {
			throw new Error(`Hermes provider ${providerId} must be an object`);
		}
	}
	const nextProviders: Record<string, unknown> = { ...currentProviders };
	for (const providerId of deletedProviderIds) delete nextProviders[providerId];

	const patchProviders = recordValue(patch.providers) ?? {};
	for (const [providerId, providerPatch] of Object.entries(patchProviders)) {
		if (providerPatch === null) {
			delete nextProviders[providerId];
			continue;
		}
		if (!isPlainRecord(providerPatch)) continue;
		const existingProvider = nextProviders[providerId];
		if (
			existingProvider !== undefined &&
			existingProvider !== null &&
			!isPlainRecord(existingProvider)
		) {
			throw new Error(`Hermes provider ${providerId} must be an object`);
		}
		const nextProvider: Record<string, unknown> = isPlainRecord(existingProvider)
			? { ...existingProvider }
			: {};
		for (const key of HERMES_GENERATED_PROVIDER_FIELDS) delete nextProvider[key];
		let wroteGeneratedField = false;
		for (const [key, value] of Object.entries(providerPatch)) {
			if (value === null) {
				delete nextProvider[key];
				continue;
			}
			nextProvider[key] = value;
			wroteGeneratedField = true;
		}
		const hasUserOwnedField = Object.keys(nextProvider).some(
			(key) => !(HERMES_GENERATED_PROVIDER_FIELDS as readonly string[]).includes(key),
		);
		if (wroteGeneratedField || hasUserOwnedField) nextProviders[providerId] = nextProvider;
		else delete nextProviders[providerId];
	}

	if (Object.keys(nextProviders).length === 0 && Object.keys(currentProviders).length === 0) return;
	reconcileHermesConfigValue(
		context,
		"providers",
		Object.keys(nextProviders).length > 0 ? nextProviders : undefined,
	);
}
function mergeProviderDeletes(
	runtime: ProviderPatchRuntime,
	patchContent: string,
	deletedProviderIds: readonly string[],
): string {
	if (deletedProviderIds.length === 0) return patchContent;
	const root = providerPatchRoot(runtime, patchContent);
	if (!root) return patchContent;
	const patch = { ...root };
	const container =
		runtime === "openclaw" ? { ...(recordValue(patch.models) ?? { mode: "merge" }) } : patch;
	const existingProviders = recordValue(container.providers);
	const providers = existingProviders ? { ...existingProviders } : {};
	for (const providerId of deletedProviderIds) {
		providers[providerId] = null;
	}
	container.providers = providers;
	if (runtime === "openclaw") {
		patch.models = container;
		if (deletedProviderIds.some(isClawdiManagedProviderId)) {
			const agents = { ...(recordValue(patch.agents) ?? {}) };
			const defaults = { ...(recordValue(agents.defaults) ?? {}) };
			defaults.memorySearch = null;
			agents.defaults = defaults;
			patch.agents = agents;
			const memory = { ...(recordValue(patch.memory) ?? {}) };
			const search = { ...(recordValue(memory.search) ?? {}) };
			if (!Object.hasOwn(search, "provider")) search.provider = null;
			if (!Object.hasOwn(search, "model")) search.model = null;
			memory.search = search;
			patch.memory = memory;
		}
	}
	return runtime === "openclaw"
		? `${JSON.stringify(patch, null, 2)}\n`
		: `${stringifyYaml(patch).trimEnd()}\n`;
}
function staleProviderIds(
	previousProviderIds: Set<string>,
	activeProviderIds: Set<string>,
): string[] {
	return [...previousProviderIds]
		.filter((providerId) => !activeProviderIds.has(providerId))
		.sort((left, right) => left.localeCompare(right));
}
