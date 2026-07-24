"use client";

import { isFirstPartyManagedAiProvider } from "@clawdi/shared";
import { ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { ENTITY_CARD_BASE, ENTITY_GRID_CLASS, EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";
import { AddProviderDialog } from "@/hosted/v2/ai-providers/add-provider-dialog";
import {
	useAiProviders,
	useCheckProviderFields,
	useDeleteProvider,
} from "@/hosted/v2/ai-providers/ai-providers-hooks";
import {
	type ProviderUsage,
	providerRemovalImpact,
	providerUsage,
} from "@/hosted/v2/ai-providers/ai-providers-page.logic";
import { AuthBadge, ManagedProviderCard } from "@/hosted/v2/ai-providers/ai-providers-ui";
import {
	API_MODE_LABEL,
	type ApiMode,
	providerTypeMeta,
} from "@/hosted/v2/ai-providers/provider-types";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import { formatModelLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Choose how your agents reach a model.";
const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const PROVIDER_GRID_CLASS = ENTITY_GRID_CLASS;

export function AiProvidersPage() {
	const providers = useAiProviders();
	const inventory = useHostedDeploymentInventory();
	const [addOpen, setAddOpen] = useState(false);
	const [editing, setEditing] = useState<AiProvider | null>(null);

	const list = (providers.data?.providers ?? []).filter(
		(provider) => !isFirstPartyManagedAiProvider(provider),
	);

	return (
		<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
			<PageHeader title="Model Providers" description={DESCRIPTION} />

			<ListToolbar
				actions={
					<Button
						size="sm"
						disabled={!providers.isSuccess}
						onClick={() => {
							setEditing(null);
							setAddOpen(true);
						}}
					>
						<Plus />
						Add provider
					</Button>
				}
			/>

			<div className="flex flex-col gap-2">
				<SectionLabel>Managed default</SectionLabel>
				<ManagedProviderCard />
			</div>

			<div className="flex flex-col gap-2">
				<SectionLabel>Your providers</SectionLabel>
				{providers.error ? (
					<ApiErrorPanel
						error={providers.error}
						onRetry={() => providers.refetch()}
						title="Couldn’t load providers"
					/>
				) : providers.isLoading ? (
					<div className={PROVIDER_GRID_CLASS}>
						{[0, 1, 2].map((i) => (
							<ProviderCardSkeleton key={i} />
						))}
					</div>
				) : list.length === 0 ? (
					<EmptyState
						title="No custom providers"
						description="Add your own OpenAI, Anthropic, OpenRouter, Gemini, Mistral, or a custom OpenAI-compatible endpoint."
					/>
				) : (
					<div className={PROVIDER_GRID_CLASS}>
						{list.map((provider) => (
							<ProviderCard
								key={provider.provider_id}
								provider={provider}
								usage={providerUsage(provider.provider_id, inventory.deployments)}
								onEdit={() => {
									setEditing(provider);
									setAddOpen(true);
								}}
							/>
						))}
					</div>
				)}
			</div>

			<AddProviderDialog open={addOpen} onOpenChange={setAddOpen} editing={editing} />
		</div>
	);
}

function ProviderCard({
	provider,
	usage,
	onEdit,
}: {
	provider: AiProvider;
	usage: ProviderUsage;
	onEdit: () => void;
}) {
	const meta = providerTypeMeta(provider.type);
	const checkFields = useCheckProviderFields();
	const providerLabel = provider.label ?? provider.provider_id;
	const modelSummary = modelCatalogSummary(provider);

	function runCheckFields() {
		checkFields.mutate(provider.provider_id, {
			onSuccess: (result) => {
				if (result.valid) {
					toast.success("Saved fields are valid", {
						description: "This does not test endpoint connectivity or credentials.",
					});
				} else {
					toast.warning("Field check found issues", { description: result.errors.join(" · ") });
				}
			},
		});
	}

	return (
		<div className={cn(ENTITY_CARD_BASE, "flex h-full flex-col")}>
			<EntityHeader
				align="start"
				icon={<EntityIcon kind="provider" id={provider.type} label={providerLabel} />}
				title={providerLabel}
				titleAdornment={<AuthBadge auth={provider.auth} />}
				meta={[
					`${meta.label} · ${modelSummary}${
						provider.api_mode
							? ` · ${API_MODE_LABEL[provider.api_mode as ApiMode] ?? provider.api_mode}`
							: ""
					}`,
					<span key="base" className="font-mono">
						{provider.base_url}
						{provider.runtime_env_name ? ` · ${provider.runtime_env_name}` : ""}
					</span>,
				]}
			/>
			<div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
				<Button
					variant="ghost"
					size="sm"
					onClick={runCheckFields}
					disabled={checkFields.isPending}
					aria-label={`Check saved fields for ${providerLabel}`}
				>
					<ListChecks />
					Check fields
				</Button>
				<Button variant="outline" size="sm" onClick={onEdit} aria-label={`Edit ${providerLabel}`}>
					<Pencil />
					Edit
				</Button>
				<RemoveProviderAction provider={provider} usage={usage} />
			</div>
		</div>
	);
}

function RemoveProviderAction({ provider, usage }: { provider: AiProvider; usage: ProviderUsage }) {
	const del = useDeleteProvider();
	const [open, setOpen] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const providerLabel = provider.label ?? provider.provider_id;
	const impact = providerRemovalImpact(usage);
	const acknowledgementId = `remove-provider-ack-${provider.provider_id}`;

	function changeOpen(next: boolean) {
		if (del.isPending) return;
		setOpen(next);
		if (!next) setAcknowledged(false);
	}

	function removeProvider() {
		del.mutate(provider.provider_id, {
			onSuccess: () => {
				setOpen(false);
				setAcknowledged(false);
			},
		});
	}

	return (
		<AlertDialog open={open} onOpenChange={changeOpen}>
			<AlertDialogTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						className="ml-auto text-muted-foreground hover:text-destructive"
						disabled={del.isPending}
						aria-label={`Remove ${providerLabel}`}
					/>
				}
			>
				<Trash2 />
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove {providerLabel}?</AlertDialogTitle>
					<AlertDialogDescription render={<div className="space-y-3" />}>
						<p>{impact.warning}</p>
						{impact.acknowledgementRequired ? (
							<div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
								<Checkbox
									id={acknowledgementId}
									checked={acknowledged}
									onCheckedChange={(checked) => setAcknowledged(checked === true)}
								/>
								<Label htmlFor={acknowledgementId} className="text-sm font-normal leading-snug">
									I understand that affected agents will lose model access until reconfigured.
								</Label>
							</div>
						) : null}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={(event) => {
							event.preventDefault();
							removeProvider();
						}}
						disabled={del.isPending || (impact.acknowledgementRequired && !acknowledged)}
						variant="destructive"
					>
						{del.isPending ? <Spinner /> : null}
						Remove provider
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function modelCatalogSummary(provider: AiProvider): string {
	const modelIds = (provider.models ?? []).map((model) => model.id).filter(Boolean);
	if (modelIds.length === 0) return "No catalog models";
	const visible = modelIds.slice(0, 2).map(formatModelLabel).join(", ");
	return modelIds.length > 2 ? `${visible} +${modelIds.length - 2} more` : visible;
}

function ProviderCardSkeleton() {
	return (
		<div className={ENTITY_CARD_BASE}>
			<div className="flex items-start gap-3">
				<Skeleton className="size-10 shrink-0 rounded-lg" />
				<div className="min-w-0 flex-1">
					<Skeleton className="h-4 w-28" />
					<Skeleton className="mt-2 h-3 w-40" />
					<Skeleton className="mt-1.5 h-3 w-full max-w-56" />
				</div>
			</div>
			<div className="mt-3 flex items-center gap-2">
				<Skeleton className="h-8 w-20 rounded-md" />
				<Skeleton className="h-8 w-14 rounded-md" />
				<Skeleton className="ml-auto size-8 rounded-md" />
			</div>
		</div>
	);
}
