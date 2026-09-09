"use client";

import { type ApiErrorNormalizer, ApiErrorPanel } from "@/components/api-error-panel";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import { MANAGED_AI_CHOICE } from "@/hosted/v2/ai-providers/model-binding";

export function ManagedModelPicker({
	idPrefix,
	primaryModel,
	onPrimaryModelChange,
	managedModels,
	loading,
	error,
	errorNormalizer,
	onRetry,
	providerChoice,
}: {
	idPrefix: string;
	primaryModel: string;
	onPrimaryModelChange: (model: string) => void;
	managedModels: readonly ManagedModelCatalogItem[];
	loading: boolean;
	error: unknown;
	errorNormalizer: ApiErrorNormalizer;
	onRetry: () => void;
	providerChoice: string;
}) {
	if (providerChoice !== MANAGED_AI_CHOICE) return null;
	if (loading)
		return (
			<div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
				<Spinner className="size-3.5" />
				Loading Clawdi AI models…
			</div>
		);
	if (!managedModels.length)
		return (
			<ApiErrorPanel
				normalizer={errorNormalizer}
				error={error ?? new Error("Clawdi AI models are unavailable.")}
				onRetry={onRetry}
				title="Couldn't load Clawdi AI models"
			/>
		);
	const catalogInputId = `${idPrefix}-catalog-model`;
	const compactManagedItems = managedModelPickerItems(managedModels);
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<Label id={`${catalogInputId}-label`}>Main model</Label>
			<div
				className="flex min-w-0 max-w-full flex-wrap items-start gap-2"
				data-testid="managed-model-controls"
			>
				{compactManagedItems.featured.length > 0 ? (
					<fieldset
						id={catalogInputId}
						className="m-0 grid w-full min-w-0 grid-cols-1 gap-2 border-0 p-0 @md/main:grid-cols-2 @4xl/main:grid-cols-4"
						aria-labelledby={`${catalogInputId}-label`}
						data-testid="managed-model-choices"
					>
						{compactManagedItems.featured.map((item) => (
							<EntityChoiceCard
								key={item.value}
								selected={primaryModel === item.value}
								onClick={() => onPrimaryModelChange(item.value)}
								icon={<EntityIcon kind="provider" id={item.iconId} size="sm" />}
								title={item.label}
								description={item.description}
								variant="compact"
								className="px-2.5 py-2"
							/>
						))}
					</fieldset>
				) : null}
				{compactManagedItems.overflow.length > 0 ? (
					<Select
						items={compactManagedItems.overflow}
						value={
							compactManagedItems.overflow.some((item) => item.value === primaryModel)
								? primaryModel
								: null
						}
						onValueChange={(value) => {
							if (value) onPrimaryModelChange(value);
						}}
					>
						<SelectTrigger
							id={compactManagedItems.featured.length === 0 ? catalogInputId : undefined}
							size="sm"
							className="max-w-full"
							aria-label="More managed models"
							data-testid="managed-model-overflow"
						>
							<SelectValue className="min-w-0" placeholder="More models" />
						</SelectTrigger>
						<SelectContent className="min-w-64">
							<SelectGroup>
								{compactManagedItems.overflow.map((item) => (
									<SelectItem key={item.value} value={item.value} className="items-start py-2">
										<span className="flex min-w-0 items-start gap-2 whitespace-normal">
											<EntityIcon kind="provider" id={item.iconId} size="sm" />
											<span className="flex min-w-0 flex-col items-start gap-0.5">
												<span className="font-medium">{item.label}</span>
												{item.description ? (
													<span className="text-xs leading-snug text-muted-foreground">
														{item.description}
													</span>
												) : null}
											</span>
										</span>
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				) : null}
			</div>
		</div>
	);
}

type ManagedModelChoice = { value: string; label: string; iconId: string; description?: string };
type ManagedModelPickerItems = { featured: ManagedModelChoice[]; overflow: ManagedModelChoice[] };

function managedModelPickerItems(
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
