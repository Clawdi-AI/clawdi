"use client";

import type { ApiErrorNormalizer } from "@/components/api-error-panel";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
	type ModelBindingPickerItem,
	managedModelPickerItems,
	modelPickerItems,
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
	showProviderSelect = true,
	selectedProviderChoices,
	primaryProviderChoice,
	primaryModel,
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
	showProviderSelect?: boolean;
	selectedProviderChoices: readonly string[];
	primaryProviderChoice: string;
	primaryModel: string;
	onPrimaryProviderChange: (choice: string) => void;
	onPrimaryModelChange: (model: string) => void;
}) {
	const providerInputId = `${idPrefix}-primary-provider`;
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
	const primaryProviderItems = primaryProviderPickerItems(
		selectedProviderChoices,
		customProviders,
		additionalProviderItems,
	);
	return (
		<div
			data-hosted="true"
			data-v2="true"
			className={cn("flex max-w-2xl flex-col gap-3 rounded-lg border bg-muted/20 p-3", className)}
		>
			{showProviderSelect ? (
				<div className="flex max-w-md flex-col gap-1.5">
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
			) : null}
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
				<div className="flex min-w-0 max-w-md flex-col gap-2">
					<Label id={`${catalogInputId}-label`}>Main model</Label>
					<div
						className="flex min-w-0 max-w-full flex-wrap items-start gap-2"
						data-testid="managed-model-controls"
					>
						{compactManagedItems.featured.length > 0 ? (
							<RadioGroup
								id={catalogInputId}
								value={primaryModel}
								onValueChange={(value) => {
									if (typeof value === "string") onPrimaryModelChange(value);
								}}
								className="grid w-full min-w-0 grid-cols-2 gap-2"
								aria-labelledby={`${catalogInputId}-label`}
								data-testid="managed-model-choices"
							>
								{compactManagedItems.featured.map((item, index) => {
									const titleId = `${catalogInputId}-featured-${index}-title`;
									const descriptionId = `${catalogInputId}-featured-${index}-description`;
									return (
										<Label
											key={item.value}
											className="w-full min-w-0 cursor-pointer items-start gap-2 rounded-md border border-border/70 bg-transparent px-2.5 py-2 shadow-xs transition-[color,box-shadow] hover:bg-muted/60 has-data-checked:border-primary/50 has-data-checked:bg-muted"
										>
											<RadioGroupItem
												value={item.value}
												aria-labelledby={titleId}
												aria-describedby={item.description ? descriptionId : undefined}
												className="mt-0.5"
											/>
											<span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
												<span id={titleId} className="truncate">
													{item.label}
												</span>
												{item.description ? (
													<span
														id={descriptionId}
														className="min-w-0 break-words text-xs leading-snug font-normal text-muted-foreground"
													>
														{item.description}
													</span>
												) : null}
											</span>
										</Label>
									);
								})}
							</RadioGroup>
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
												<span className="flex min-w-0 flex-col items-start gap-0.5 whitespace-normal">
													<span className="font-medium">{item.label}</span>
													{item.description ? (
														<span className="text-xs leading-snug text-muted-foreground">
															{item.description}
														</span>
													) : null}
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
