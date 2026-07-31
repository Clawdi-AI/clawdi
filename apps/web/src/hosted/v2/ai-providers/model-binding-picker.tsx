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
	CUSTOM_MODEL_CHOICE,
	MANAGED_AI_CHOICE,
	type ModelBindingPickerItem,
	managedModelPickerItems,
	modelPickerItems,
	primaryProviderPickerItems,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import { cn } from "@/lib/utils";

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_048_576 && tokens % 1_048_576 === 0) {
		return `${tokens / 1_048_576}M`;
	}
	if (tokens >= 1_024 && tokens % 1_024 === 0) {
		return `${tokens / 1_024}K`;
	}
	return new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: tokens >= 1_000_000 ? 1 : 0,
	}).format(tokens);
}

function ManagedModelDetails({ model }: { model: ManagedModelCatalogItem }) {
	const conditionalContextLimit =
		model.capabilities.max_context_window !== null &&
		model.capabilities.max_context_window > model.capabilities.context_window
			? `Up to ${formatTokenCount(model.capabilities.max_context_window)}`
			: null;
	const capabilities = [
		`${formatTokenCount(model.capabilities.context_window)} context`,
		conditionalContextLimit,
		model.capabilities.supports_vision || model.capabilities.input_modalities.includes("image")
			? "Vision"
			: null,
		model.capabilities.supports_reasoning ? "Reasoning" : null,
		model.capabilities.supports_tools ? "Tools" : null,
	].filter((capability): capability is string => capability !== null);

	return (
		<section
			className="mt-1 grid min-w-0 gap-0.5 border-l border-primary/30 py-0.5 pl-3 text-xs"
			data-testid="managed-model-details"
			aria-label="Selected model details"
			aria-live="polite"
		>
			{model.summary ? (
				<p
					className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
					data-testid="managed-model-summary"
				>
					<span className="font-medium text-muted-foreground">Best for</span>
					<span className="min-w-0 break-words">{model.summary}</span>
				</p>
			) : null}
			<p
				className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
				data-testid="managed-model-capabilities"
			>
				<span className="font-medium text-muted-foreground">Capabilities</span>
				{capabilities.map((capability) => (
					<span key={capability}>{capability}</span>
				))}
			</p>
			{model.cost_hint ? (
				<p
					className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
					data-testid="managed-model-cost-hint"
				>
					<span className="font-medium text-muted-foreground">Cost guide</span>
					<span className="min-w-0 break-words">{model.cost_hint}</span>
				</p>
			) : null}
		</section>
	);
}

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
	compactManagedModelChoices = false,
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
	compactManagedModelChoices?: boolean;
	selectedProviderChoices: readonly string[];
	primaryProviderChoice: string;
	primaryModel: string;
	onPrimaryProviderChange: (choice: string) => void;
	onPrimaryModelChange: (model: string) => void;
}) {
	const providerInputId = `${idPrefix}-primary-provider`;
	const catalogInputId = `${idPrefix}-catalog-model`;
	const customInputId = `${idPrefix}-primary-model`;
	const isManaged = primaryProviderChoice === MANAGED_AI_CHOICE;
	const catalogModelItems = modelPickerItems(primaryProviderChoice, providers, managedModels);
	const compactManagedItems = managedModelPickerItems(managedModels);
	const selectedManagedModel = managedModels.find((model) => model.id === primaryModel);
	const hasCatalogModels = catalogModelItems.some((item) => item.value !== CUSTOM_MODEL_CHOICE);
	const modelChoice = catalogModelItems.some((item) => item.value === primaryModel)
		? primaryModel
		: CUSTOM_MODEL_CHOICE;
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
			<div className={cn("grid gap-3", showProviderSelect && "sm:grid-cols-2")}>
				{showProviderSelect ? (
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
				) : isManaged && compactManagedModelChoices && hasCatalogModels ? (
					<div className="flex min-w-0 flex-col gap-1.5">
						<Label id={`${catalogInputId}-label`}>Primary model</Label>
						<div
							className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
							data-testid="managed-model-controls"
						>
							{compactManagedItems.featured.length > 0 ? (
								<RadioGroup
									id={catalogInputId}
									value={modelChoice}
									onValueChange={(value) => {
										if (typeof value === "string") onPrimaryModelChange(value);
									}}
									className="flex min-w-0 max-w-full flex-wrap gap-1.5"
									aria-labelledby={`${catalogInputId}-label`}
									data-testid="managed-model-choices"
								>
									{compactManagedItems.featured.map((item) => (
										<Label
											key={item.value}
											className="h-8 min-w-0 max-w-full cursor-pointer gap-1.5 rounded-md border border-input bg-transparent px-2 shadow-xs transition-[color,box-shadow] hover:bg-muted has-data-checked:bg-muted"
										>
											<RadioGroupItem value={item.value} />
											<span className="truncate">{item.label}</span>
										</Label>
									))}
								</RadioGroup>
							) : null}
							{compactManagedItems.overflow.length > 0 ? (
								<Select
									items={compactManagedItems.overflow}
									value={
										compactManagedItems.overflow.some((item) => item.value === modelChoice)
											? modelChoice
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
									<SelectContent>
										<SelectGroup>
											{compactManagedItems.overflow.map((item) => (
												<SelectItem key={item.value} value={item.value}>
													{item.label}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							) : null}
						</div>
						{selectedManagedModel ? <ManagedModelDetails model={selectedManagedModel} /> : null}
					</div>
				) : hasCatalogModels ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={catalogInputId}>Primary model</Label>
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
						{hasCatalogModels ? "Custom model" : "Primary model"}
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
