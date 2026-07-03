"use client";

import { isFirstPartyManagedAiProvider } from "@clawdi/shared";
import { BadgeCheck, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ENTITY_CARD_BASE, ENTITY_GRID_CLASS, EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { AddProviderDialog } from "@/hosted/v2/ai-providers/add-provider-dialog";
import {
	useAiProviders,
	useDeleteProvider,
	useValidateProvider,
} from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ManagedProviderCard } from "@/hosted/v2/ai-providers/ai-providers-ui";
import {
	API_MODE_LABEL,
	type ApiMode,
	providerTypeMeta,
} from "@/hosted/v2/ai-providers/provider-types";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import { ChannelError } from "@/hosted/v2/channels/channel-ui";
import { formatModelLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Choose how your agents reach a model.";
const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.wide, "flex flex-col gap-6 px-4 lg:px-6");
const PROVIDER_GRID_CLASS = ENTITY_GRID_CLASS;

export function AiProvidersPage() {
	const providers = useAiProviders();
	const [addOpen, setAddOpen] = useState(false);
	const [editing, setEditing] = useState<AiProvider | null>(null);

	const list = (providers.data?.providers ?? []).filter(
		(provider) => !isFirstPartyManagedAiProvider(provider),
	);

	return (
		<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
			<PageHeader
				title="Model Providers"
				description={DESCRIPTION}
				actions={
					<Button
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

			<ManagedProviderCard />

			<div className="flex flex-col gap-2">
				<SectionLabel>Your providers</SectionLabel>
				{providers.error ? (
					<ChannelError
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
						fillHeight={false}
						bordered
					/>
				) : (
					<div className={PROVIDER_GRID_CLASS}>
						{list.map((provider) => (
							<ProviderCard
								key={provider.provider_id}
								provider={provider}
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

function ProviderCard({ provider, onEdit }: { provider: AiProvider; onEdit: () => void }) {
	const meta = providerTypeMeta(provider.type);
	const del = useDeleteProvider();
	const validate = useValidateProvider();

	function runValidate() {
		validate.mutate(provider.provider_id, {
			onSuccess: (result) => {
				if (result.valid) toast.success("Configuration looks good");
				else toast.warning("Validation issues", { description: result.errors.join(" · ") });
			},
		});
	}

	return (
		<div className={cn(ENTITY_CARD_BASE, "flex h-full flex-col bg-card")}>
			<EntityHeader
				align="start"
				icon={
					<EntityIcon
						kind="provider"
						id={provider.type}
						label={provider.label ?? provider.provider_id}
					/>
				}
				title={provider.label ?? provider.provider_id}
				titleAdornment={<AuthBadge auth={provider.auth} />}
				meta={[
					`${meta.label}${provider.default_model ? ` · ${formatModelLabel(provider.default_model)}` : ""}${
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
				<Button variant="ghost" size="sm" onClick={runValidate} disabled={validate.isPending}>
					<BadgeCheck />
					Validate
				</Button>
				<Button variant="outline" size="sm" onClick={onEdit}>
					<Pencil />
					Edit
				</Button>
				<ConfirmAction
					title={`Remove ${provider.label ?? provider.provider_id}?`}
					description={
						<p>
							Agents using this provider fall back to the managed default. This can't be undone.
						</p>
					}
					confirmLabel="Remove provider"
					destructive
					onConfirm={() => del.mutate(provider.provider_id)}
				>
					<Button
						variant="ghost"
						size="icon-sm"
						className="ml-auto text-muted-foreground hover:text-destructive"
						disabled={del.isPending}
						aria-label={`Remove ${provider.label ?? provider.provider_id}`}
					>
						<Trash2 />
					</Button>
				</ConfirmAction>
			</div>
		</div>
	);
}

function ProviderCardSkeleton() {
	return (
		<div className={cn(ENTITY_CARD_BASE, "bg-card")}>
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
