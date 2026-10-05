"use client";

import { managedModelPickerClasses as styles } from "@clawdi/shared/ui";
import { managedModelPickerItems } from "@clawdi/shared/view";
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
			<div role="status" className={styles.loading}>
				<Spinner className={styles.icon} />
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
		<div className={styles.root}>
			<Label id={`${catalogInputId}-label`}>Main model</Label>
			<div className={styles.controls} data-testid="managed-model-controls">
				{compactManagedItems.featured.length > 0 ? (
					<fieldset
						id={catalogInputId}
						className={styles.choices}
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
								className={styles.choice}
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
							className={styles.trigger}
							aria-label="More managed models"
							data-testid="managed-model-overflow"
						>
							<SelectValue className={styles.value} placeholder="More models" />
						</SelectTrigger>
						<SelectContent className={styles.content}>
							<SelectGroup>
								{compactManagedItems.overflow.map((item) => (
									<SelectItem key={item.value} value={item.value} className={styles.item}>
										<span className={styles.itemContent}>
											<EntityIcon kind="provider" id={item.iconId} size="sm" />
											<span className={styles.itemCopy}>
												<span className={styles.itemTitle}>{item.label}</span>
												{item.description ? (
													<span className={styles.itemDescription}>{item.description}</span>
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
