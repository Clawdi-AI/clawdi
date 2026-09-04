"use client";

import type { ApiErrorNormalizer } from "@/components/api-error-panel";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
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
	MANAGED_AI_CHOICE,
	managedModelPickerItems,
	modelPickerItems,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

export function ModelBindingPicker({
	idPrefix,
	providers,
	managedModels,
	managedModelsLoading,
	managedModelsError,
	managedModelsErrorNormalizer,
	onManagedModelsRetry,
	primaryProviderChoice,
	primaryModel,
	onPrimaryModelChange,
}: {
	idPrefix: string;
	providers: readonly AiProvider[];
	managedModels: readonly ManagedModelCatalogItem[];
	managedModelsLoading: boolean;
	managedModelsError: unknown;
	managedModelsErrorNormalizer: ApiErrorNormalizer;
	onManagedModelsRetry: () => void;
	primaryProviderChoice: string;
	primaryModel: string;
	onPrimaryModelChange: (model: string) => void;
}) {
	const catalogInputId = `${idPrefix}-catalog-model`;
	const modelInputId = `${idPrefix}-primary-model`;
	const modelListId = `${idPrefix}-model-options`;
	const isManaged = primaryProviderChoice === MANAGED_AI_CHOICE;
	const catalogModelItems = modelPickerItems(primaryProviderChoice, providers, managedModels);
	const compactManagedItems = managedModelPickerItems(managedModels);
	const hasCatalogModels = catalogModelItems.length > 0;
	const managedCatalogUnavailableError =
		isManaged && managedModels.length === 0 && !managedModelsLoading
			? (managedModelsError ?? new Error("The Clawdi AI model catalog returned no models."))
			: null;
	return (
		<div
			data-hosted="true"
			data-v2="true"
			data-testid="model-binding-picker"
			className="flex w-full min-w-0 flex-col gap-3"
		>
			{isManaged && managedModelsLoading ? (
				<div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
					<Spinner className="size-3.5" /> Loading Clawdi AI models…
				</div>
			) : managedCatalogUnavailableError ? (
				<ApiErrorPanel
					normalizer={managedModelsErrorNormalizer}
					error={managedCatalogUnavailableError}
					onRetry={onManagedModelsRetry}
					title="Couldn't load Clawdi AI models"
				/>
			) : isManaged && hasCatalogModels ? (
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
			) : !isManaged ? (
				<div className="flex max-w-md flex-col gap-1.5">
					<Label htmlFor={modelInputId}>Main model</Label>
					<Input
						id={modelInputId}
						list={hasCatalogModels ? modelListId : undefined}
						value={primaryModel}
						onChange={(event) => onPrimaryModelChange(event.target.value)}
						placeholder="model id"
						autoComplete="off"
						spellCheck={false}
					/>
					{hasCatalogModels ? (
						<datalist id={modelListId}>
							{catalogModelItems.map((item) => (
								<option key={item.value} value={item.value} label={item.label} />
							))}
						</datalist>
					) : null}
				</div>
			) : null}
		</div>
	);
}
