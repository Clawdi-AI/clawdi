import type { HostedDeployManagedModel as ManagedModelCatalogItem } from "../api";

type ManagedModelChoice = { value: string; label: string; iconId: string; description?: string };
type ManagedModelPickerItems = { featured: ManagedModelChoice[]; overflow: ManagedModelChoice[] };

export function managedModelPickerItems(
	managedModels: readonly ManagedModelCatalogItem[],
): ManagedModelPickerItems {
	const sections: ManagedModelPickerItems = { featured: [], overflow: [] };
	const seen = new Set<string>();
	for (const model of managedModels) {
		const modelId = model.id.trim();
		if (!modelId || seen.has(modelId)) continue;
		seen.add(modelId);
		const item = {
			value: modelId,
			iconId: managedModelBrandIconId(modelId, model.provider_id),
			// Managed display names are authoritative catalog data. Keep them
			// verbatim instead of deriving a friendlier label from the model id.
			label: model.display_name,
			...(model.description?.trim() ? { description: model.description.trim() } : {}),
		};
		sections[model.is_featured ? "featured" : "overflow"].push(item);
	}
	return sections;
}

function managedModelBrandIconId(modelId: string, providerId: string): string {
	const normalizedModelId = modelId.toLowerCase();
	const providerSeparator = normalizedModelId.indexOf("/");
	const modelName =
		providerSeparator === -1 ? normalizedModelId : normalizedModelId.slice(providerSeparator + 1);
	if (modelName.startsWith("deepseek-")) return "deepseek";
	if (modelName.startsWith("glm-")) return "zai";
	return providerId;
}
