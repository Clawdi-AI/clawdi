"use client";

import type { ApiErrorNormalizer } from "@/components/api-error-panel";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Input } from "@/components/ui/input";
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
import {
	CUSTOM_MODEL_CHOICE,
	MANAGED_AI_CHOICE,
	type ModelBindingPickerItem,
	modelIdsForProvider,
	modelPickerItems,
	primaryModelPickerChoice,
	primaryProviderPickerItems,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import { cn } from "@/lib/utils";

export function ModelBindingPicker({
	idPrefix,
	className,
	providers,
	managedModels,
	managedModelsLoading,
	managedModelsError,
	managedModelsErrorNormalizer,
	onManagedModelsRetry,
	customProviders,
	additionalProviderItems = [],
	selectedProviderChoices,
	primaryProviderChoice,
	primaryModel,
	formatModel,
	onPrimaryProviderChange,
	onPrimaryModelChange,
}: {
	idPrefix: string;
	className?: string;
	providers: readonly AiProvider[];
	managedModels: readonly ManagedModelCatalogItem[];
	managedModelsLoading: boolean;
	managedModelsError: unknown;
	managedModelsErrorNormalizer: ApiErrorNormalizer;
	onManagedModelsRetry: () => void;
	customProviders: readonly AiProvider[];
	additionalProviderItems?: readonly ModelBindingPickerItem[];
	selectedProviderChoices: readonly string[];
	primaryProviderChoice: string;
	primaryModel: string;
	formatModel?: (modelId: string) => string;
	onPrimaryProviderChange: (choice: string) => void;
	onPrimaryModelChange: (model: string) => void;
}) {
	const providerInputId = `${idPrefix}-primary-provider`;
	const catalogInputId = `${idPrefix}-catalog-model`;
	const customInputId = `${idPrefix}-primary-model`;
	const isManaged = primaryProviderChoice === MANAGED_AI_CHOICE;
	const catalogModelIds = modelIdsForProvider(primaryProviderChoice, providers, managedModels);
	const modelChoice = primaryModelPickerChoice(primaryModel, catalogModelIds);
	const managedCatalogUnavailableError =
		isManaged && managedModels.length === 0 && !managedModelsLoading
			? (managedModelsError ?? new Error("The managed model catalog returned no models."))
			: null;
	const primaryProviderItems = primaryProviderPickerItems(
		selectedProviderChoices,
		customProviders,
		additionalProviderItems,
	);
	const catalogModelItems = modelPickerItems(
		primaryProviderChoice,
		providers,
		managedModels,
		formatModel,
	);

	return (
		<div
			data-hosted="true"
			data-v2="true"
			className={cn("flex max-w-2xl flex-col gap-3 rounded-lg border bg-muted/20 p-3", className)}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={providerInputId}>Primary provider</Label>
					<Select
						items={primaryProviderItems}
						value={primaryProviderChoice}
						onValueChange={(value) => {
							if (value) onPrimaryProviderChange(value);
						}}
					>
						<SelectTrigger id={providerInputId} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{primaryProviderItems.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>
				{isManaged && managedModelsLoading ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
						<Spinner className="size-3.5" /> Loading managed models…
					</div>
				) : managedCatalogUnavailableError ? (
					<ApiErrorPanel
						normalizer={managedModelsErrorNormalizer}
						error={managedCatalogUnavailableError}
						onRetry={onManagedModelsRetry}
						title="Couldn't load managed models"
					/>
				) : catalogModelIds.length > 0 ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={catalogInputId}>Catalog model</Label>
						<Select
							items={catalogModelItems}
							value={modelChoice}
							onValueChange={(value) => {
								if (!value) return;
								onPrimaryModelChange(value === CUSTOM_MODEL_CHOICE ? "" : value);
							}}
						>
							<SelectTrigger id={catalogInputId} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{catalogModelItems.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
				) : null}
			</div>
			{!isManaged && modelChoice === CUSTOM_MODEL_CHOICE ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={customInputId}>
						{catalogModelIds.length > 0 ? "Custom model" : "Primary model"}
					</Label>
					<Input
						id={customInputId}
						value={primaryModel}
						onChange={(event) => onPrimaryModelChange(event.target.value)}
						placeholder="model id"
						autoComplete="off"
						spellCheck={false}
					/>
				</div>
			) : null}
		</div>
	);
}
