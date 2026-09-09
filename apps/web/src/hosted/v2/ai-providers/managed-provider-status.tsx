"use client";

import { type ApiErrorNormalizer, ApiErrorPanel } from "@/components/api-error-panel";
import { Spinner } from "@/components/ui/spinner";
import type { ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import { MANAGED_AI_CHOICE } from "@/hosted/v2/ai-providers/model-binding";

export function ManagedProviderStatus({
	managedModels,
	loading,
	error,
	errorNormalizer,
	onRetry,
	providerChoice,
}: {
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
				Configuring Clawdi AI…
			</div>
		);
	if (!managedModels.length)
		return (
			<ApiErrorPanel
				normalizer={errorNormalizer}
				error={error ?? new Error("Clawdi AI configuration is unavailable.")}
				onRetry={onRetry}
				title="Couldn't configure Clawdi AI"
			/>
		);
	return null;
}
